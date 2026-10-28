mod ai;
mod browser;
mod feed;
mod ingest;
mod media;
mod network;
mod process;
mod projection;
mod protocol;

use anyhow::{Result, bail, ensure};
use protocol::{Application, Job, string};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

async fn webhook(job: &Job, app: &Application) -> Result<Value> {
    let mut delivered = job
        .checkpoint
        .as_ref()
        .and_then(|c| c["delivered"].as_array())
        .cloned()
        .unwrap_or_default();
    for delivery in job.input["deliveries"].as_array().into_iter().flatten() {
        if delivered.contains(&delivery["id"]) {
            continue;
        }
        let url = string(delivery, "url")?;
        let destination = url::Url::parse(url)?;
        let client =
            network::client_for(&destination, job.input["timeoutSecs"].as_u64().unwrap_or(5))
                .await?;
        let mut request = client.post(destination);
        if let Some(token) = delivery["token"].as_str().filter(|v| !v.is_empty()) {
            request = request.bearer_auth(token);
        }
        let response = request
            .header(
                "Idempotency-Key",
                format!("{}:{}", job.id, delivery["id"].as_str().unwrap_or("")),
            )
            .json(&delivery["body"])
            .send()
            .await?;
        ensure!(response.status().is_success(), "webhook delivery failed");
        delivered.push(delivery["id"].clone());
        app.checkpoint(job, json!({"delivered":delivered})).await?;
    }
    Ok(json!({"kind":"done"}))
}

async fn execute(job: &Job, app: &Application) -> Result<Value> {
    match string(&job.input, "operation")? {
        "noop" => Ok(json!({"kind":"done","skipped":true})),
        "domain" => Ok(json!({"kind":"done"})),
        "ingest" => ingest::execute(job, app).await,
        "archive" => ingest::archive(job).await,
        "asset" => {
            media::extract(
                job,
                app,
                Path::new(string(&job.input, "assetPath")?),
                string(&job.input, "assetType")?,
            )
            .await
        }
        "embedding" | "tags" | "summary" => ai::execute(job, app).await,
        "searchIndex" | "searchDelete" | "vectorIndex" | "vectorDelete" => {
            projection::execute(job, app).await
        }
        "feed" => ingest::feed(job).await,
        "video" => media::video(job).await,
        "export" => media::export(job).await,
        "webhook" => webhook(job, app).await,
        _ => bail!("unsupported execution operation"),
    }
}

async fn run_job(job: Job, app: Application, cancel: CancellationToken) {
    let future = async {
        let result =
            tokio::time::timeout(Duration::from_secs(job.timeout_secs), execute(&job, &app))
                .await??;
        // Keep the result and retry acknowledgements, rather than repeat the
        // external work after a transient application connection failure.
        for attempt in 0..4 {
            match app
                .call(
                    "complete",
                    json!({"id":job.id,"token":job.token,"result":result}),
                )
                .await
            {
                Ok(Value::Bool(true)) => return Ok(()),
                Ok(_) => bail!("result lease lost"),
                Err(e) if attempt == 3 => return Err(e),
                Err(_) => tokio::time::sleep(Duration::from_millis(250 * (1 << attempt))).await,
            }
        }
        Ok::<_, anyhow::Error>(())
    };
    tokio::pin!(future);
    let mut renew = tokio::time::interval(Duration::from_secs(30));
    renew.tick().await;
    let outcome = loop {
        tokio::select! {
            result=&mut future=>break result,
            _=cancel.cancelled()=>break Err(anyhow::anyhow!("engine shutting down")),
            _=renew.tick()=>{
                match app.call("renew",json!({"id":job.id,"token":job.token})).await {
                    Ok(Value::Bool(true))=>{},
                    _=>break Err(anyhow::anyhow!("job lease could not be renewed")),
                }
            }
        }
    };
    match outcome {
        Ok(()) => tracing::info!(job=%job.id,kind=%job.kind,"completed"),
        Err(error) => {
            // Error messages are deliberately generic; provider response bodies
            // and prepared content never enter the engine's logs.
            tracing::warn!(job=%job.id,kind=%job.kind,error=%error,"attempt failed");
            let _ = app
                .call(
                    "fail",
                    json!({"id":job.id,"token":job.token,"error":error.to_string()}),
                )
                .await;
        }
    }
}

fn trim_heap() {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    unsafe {
        libc::malloc_trim(0);
    }
}

fn data_dir() -> PathBuf {
    PathBuf::from(std::env::var("DATA_DIR").unwrap_or_else(|_| ".".into()))
}

async fn heartbeat() -> Result<()> {
    let file = data_dir().join("engine-health.json");
    let temp = file.with_extension("tmp");
    tokio::fs::write(
        &temp,
        json!({"version":1,"pid":std::process::id(),"lastSeen":chrono::Utc::now().timestamp()})
            .to_string(),
    )
    .await?;
    tokio::fs::rename(temp, file).await?;
    Ok(())
}

async fn engine(drain: bool) -> Result<()> {
    let socket = std::env::var("KARAKEEP_WORK_SOCKET")
        .map(PathBuf::from)
        .unwrap_or_else(|_| data_dir().join("engine.sock"));
    let app = Application::new(&socket)?;
    let cancel = CancellationToken::new();
    let signal = cancel.clone();
    tokio::spawn(async move {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("SIGTERM handler");
        tokio::select! {_=term.recv()=>{},_=tokio::signal::ctrl_c()=>{}}
        signal.cancel();
    });
    let mut tasks = JoinSet::new();
    let mut running: HashMap<String, usize> = HashMap::new();
    let limits = [
        (
            "ingest",
            std::env::var("CRAWLER_NUM_WORKERS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(1usize)
                .max(1),
        ),
        ("asset", 1),
        ("ai", 2),
        ("embedding", 1),
        ("publish", 2),
        ("feed", 1),
        ("video", 1),
        ("webhook", 1),
        ("export", 1),
        ("import", 1),
        ("rules", 1),
        ("maintenance", 1),
    ];
    let global_limit = std::env::var("KARAKEEP_ENGINE_CONCURRENCY")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(4usize)
        .max(1);
    tracing::info!("Rust engine ready (protocol 1)");
    loop {
        if cancel.is_cancelled() {
            break;
        }
        let _ = heartbeat().await;
        while let Some(result) = tasks.try_join_next() {
            if let Ok(kind) = result
                && let Some(n) = running.get_mut(&kind)
            {
                *n = n.saturating_sub(1);
            }
        }
        if tasks.is_empty() {
            trim_heap();
        }
        let kinds: Vec<_> = limits
            .iter()
            .filter(|(k, n)| running.get(*k).copied().unwrap_or(0) < *n)
            .map(|(k, _)| *k)
            .collect();
        if tasks.len() < global_limit && !kinds.is_empty() {
            let claim = app.call(
                "claim",
                json!({"kinds":kinds,"waitMs":if drain || !tasks.is_empty(){0}else{30_000}}),
            );
            let response = tokio::select! {v=claim=>v,_=cancel.cancelled()=>break};
            match response {
                Ok(value) if !value.is_null() => {
                    let job: Job = serde_json::from_value(value)?;
                    ensure!(
                        job.version == protocol::VERSION,
                        "incompatible work protocol"
                    );
                    *running.entry(job.kind.clone()).or_default() += 1;
                    let (app, cancel) = (app.clone(), cancel.child_token());
                    tasks.spawn(async move {
                        let kind = job.kind.clone();
                        run_job(job, app, cancel).await;
                        kind
                    });
                    continue;
                }
                Ok(_) => {
                    if drain && tasks.is_empty() {
                        break;
                    }
                }
                Err(_) => {
                    tracing::warn!("application unavailable; durable work remains queued");
                    tokio::select! {_=tokio::time::sleep(Duration::from_secs(2))=>{},_=cancel.cancelled()=>break}
                }
            }
        }
        if !tasks.is_empty() {
            tokio::select! {
                result=tasks.join_next()=>{if let Some(Ok(kind))=result&& let Some(n)=running.get_mut(&kind){*n=n.saturating_sub(1);}},
                _=tokio::time::sleep(Duration::from_millis(250))=>{},
                _=cancel.cancelled()=>break,
            }
        }
    }
    cancel.cancel();
    if tokio::time::timeout(Duration::from_secs(10), async {
        while tasks.join_next().await.is_some() {}
    })
    .await
    .is_err()
    {
        tasks.abort_all();
    }
    let _ = tokio::fs::remove_file(data_dir().join("engine-health.json")).await;
    Ok(())
}

#[tokio::main(worker_threads = 2)]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .json()
        .with_target(false)
        .init();
    let args: Vec<_> = std::env::args().collect();
    if args.get(1).is_some_and(|a| a == "browser-host") {
        return browser::host().await;
    }
    if args.get(1).is_some_and(|a| a == "browser-health") {
        reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(2))
            .build()?
            .get("http://127.0.0.1:9224/health")
            .send()
            .await?
            .error_for_status()?;
        return Ok(());
    }
    if args.get(1).is_some_and(|a| a == "health") {
        let value: Value =
            serde_json::from_slice(&tokio::fs::read(data_dir().join("engine-health.json")).await?)?;
        ensure!(
            chrono::Utc::now().timestamp() - value["lastSeen"].as_i64().unwrap_or(0) < 120,
            "engine heartbeat stale"
        );
        return Ok(());
    }
    engine(args.iter().any(|a| a == "--drain")).await
}
