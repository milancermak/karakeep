//! A tiny control process stays resident in the Chrome container. Chrome and
//! socat exist only while leased, plus a configurable idle reuse window.
use crate::process::{ProcessGroup, command};
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::Path,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    process::Child,
    sync::Mutex,
};

pub struct Lease {
    base: String,
    token: String,
    client: reqwest::Client,
}
impl Drop for Lease {
    fn drop(&mut self) {
        let (base, token, client) = (self.base.clone(), self.token.clone(), self.client.clone());
        tokio::spawn(async move {
            let _ = client.post(format!("{base}/release/{token}")).send().await;
        });
    }
}

pub async fn acquire() -> Result<Option<Lease>> {
    let Ok(base) = std::env::var("BROWSER_CONTROL_URL") else {
        return Ok(None);
    };
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()?;
    let response = client
        .post(format!("{}/acquire", base.trim_end_matches('/')))
        .send()
        .await?;
    ensure!(response.status().is_success(), "browser startup failed");
    let response: Value = response.json().await?;
    let token = response["token"]
        .as_str()
        .context("browser lease missing")?
        .to_owned();
    Ok(Some(Lease {
        base,
        token,
        client,
    }))
}

struct BrowserProcess {
    profile: String,
    chrome: Child,
    _chrome_group: ProcessGroup,
    forwarder: Child,
    _forwarder_group: ProcessGroup,
}
impl BrowserProcess {
    async fn stop(mut self) {
        let _ = self.chrome.start_kill();
        let _ = self.forwarder.start_kill();
        drop(self._chrome_group);
        drop(self._forwarder_group);
        let _ = self.chrome.wait().await;
        let _ = self.forwarder.wait().await;
        let _ = tokio::fs::remove_dir_all(&self.profile).await;
    }
}
struct State {
    process: Option<BrowserProcess>,
    leases: HashMap<String, Instant>,
    last_used: Instant,
}

async fn launch() -> Result<BrowserProcess> {
    let profile = format!("/tmp/karakeep-browser-{}", uuid::Uuid::new_v4());
    let args = vec![
        "--headless=new",
        "--no-sandbox",
        "--no-first-run",
        "--no-default-browser-check",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=9223",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--hide-scrollbars",
        "--disable-blink-features=AutomationControlled",
        "--window-size=1440,900",
    ];
    let mut args: Vec<String> = args.into_iter().map(str::to_owned).collect();
    args.push(format!("--user-data-dir={profile}"));
    let binary =
        std::env::var("KARAKEEP_BROWSER_BINARY").unwrap_or_else(|_| "karakeep-chrome".into());
    let mut chrome = command(&binary, &args, Path::new("/tmp"))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()?;
    let chrome_group = ProcessGroup(chrome.id().context("browser PID missing")?);
    let args = vec![
        "TCP4-LISTEN:9222,fork,reuseaddr".into(),
        "TCP4:127.0.0.1:9223".into(),
    ];
    let forwarder = command("socat", &args, Path::new("/tmp"))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()?;
    let forwarder_group = ProcessGroup(forwarder.id().context("forwarder PID missing")?);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(1))
        .build()?;
    for _ in 0..100 {
        if chrome.try_wait()?.is_some() {
            bail!("browser exited during startup");
        }
        if let Ok(response) = client
            .get("http://127.0.0.1:9223/json/version")
            .send()
            .await
            && response.status().is_success()
        {
            return Ok(BrowserProcess {
                profile,
                chrome,
                _chrome_group: chrome_group,
                forwarder,
                _forwarder_group: forwarder_group,
            });
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    bail!("browser startup timed out")
}

pub async fn host() -> Result<()> {
    let listener = TcpListener::bind("0.0.0.0:9224").await?;
    let state = Arc::new(Mutex::new(State {
        process: None,
        leases: HashMap::new(),
        last_used: Instant::now(),
    }));
    let idle = std::env::var("KARAKEEP_BROWSER_IDLE_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(60);
    let ttl = std::env::var("KARAKEEP_BROWSER_LEASE_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(300);
    let timer_state = state.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        loop {
            interval.tick().await;
            let mut state = timer_state.lock().await;
            state
                .leases
                .retain(|_, t| t.elapsed() < Duration::from_secs(ttl));
            if state.leases.is_empty()
                && state.last_used.elapsed() >= Duration::from_secs(idle)
                && let Some(process) = state.process.take()
            {
                process.stop().await;
                tracing::info!("idle browser stopped");
            }
        }
    });
    let shutdown = tokio_util::sync::CancellationToken::new();
    let signal = shutdown.clone();
    tokio::spawn(async move {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("SIGTERM handler");
        tokio::select! {_=term.recv()=>{},_=tokio::signal::ctrl_c()=>{}}
        signal.cancel();
    });
    tracing::info!("browser host ready; Chrome starts on demand");
    loop {
        let (mut stream, _) =
            tokio::select! {v=listener.accept()=>v?,_=shutdown.cancelled()=>break};
        let state = state.clone();
        tokio::spawn(async move {
            // This private control protocol has no request bodies. Bound the
            // header and connection time; it is never exposed through Tailscale.
            let request = tokio::time::timeout(Duration::from_secs(5), async {
                let mut bytes = Vec::new();
                loop {
                    let mut b = [0u8; 512];
                    let n = stream.read(&mut b).await?;
                    if n == 0 {
                        bail!("closed request");
                    }
                    bytes.extend_from_slice(&b[..n]);
                    ensure!(bytes.len() <= 8192, "header too large");
                    if bytes.windows(4).any(|v| v == b"\r\n\r\n") {
                        break;
                    }
                }
                let line = std::str::from_utf8(&bytes)?
                    .lines()
                    .next()
                    .context("request missing")?;
                let mut parts = line.split_whitespace();
                Ok::<_, anyhow::Error>((
                    parts.next().unwrap_or("").to_owned(),
                    parts.next().unwrap_or("").to_owned(),
                ))
            })
            .await;
            let result = async {
                let (method, path) = request??;
                let mut state = state.lock().await;
                if method == "GET" && path == "/health" {
                    return Ok(
                        json!({"running":state.process.is_some(),"leases":state.leases.len()}),
                    );
                }
                ensure!(method == "POST", "method not allowed");
                if path == "/acquire" {
                    if let Some(process) = state.process.as_mut()
                        && process.chrome.try_wait()?.is_some()
                        && let Some(p) = state.process.take()
                    {
                        p.stop().await;
                    }
                    if state.process.is_none() {
                        state.process = Some(launch().await?);
                    }
                    let token = uuid::Uuid::new_v4().to_string();
                    state.leases.insert(token.clone(), Instant::now());
                    state.last_used = Instant::now();
                    return Ok(json!({"token":token}));
                }
                if let Some(token) = path.strip_prefix("/release/") {
                    state.leases.remove(token);
                    state.last_used = Instant::now();
                    return Ok(json!({"ok":true}));
                }
                if let Some(token) = path.strip_prefix("/renew/") {
                    let lease = state.leases.get_mut(token).context("lease missing")?;
                    *lease = Instant::now();
                    return Ok(json!({"ok":true}));
                }
                bail!("unknown operation")
            }
            .await as Result<Value>;
            let (status, body) = match result {
                Ok(v) => ("200 OK", v),
                Err(_) => ("400 Bad Request", json!({"error":"browser request failed"})),
            };
            let body = body.to_string();
            let header = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(header.as_bytes()).await;
            let _ = stream.write_all(body.as_bytes()).await;
            let _ = stream.shutdown().await;
        });
    }
    if let Some(process) = state.lock().await.process.take() {
        process.stop().await;
    }
    Ok(())
}
