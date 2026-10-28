use crate::{
    network::service_json,
    protocol::{Application, Job, string},
};
use anyhow::{Context, Result, bail};
use reqwest::{Client, Method};
use serde_json::{Value, json};
use std::time::Duration;

async fn wait_task(client: &Client, base: &str, key: &str, uid: u64) -> Result<()> {
    loop {
        let task = service_json(
            client,
            Method::GET,
            &format!("{base}/tasks/{uid}"),
            Some(key),
            None,
        )
        .await?;
        match task["status"].as_str() {
            Some("succeeded") => return Ok(()),
            Some("failed" | "canceled") => bail!("Meilisearch task failed"),
            _ => tokio::time::sleep(Duration::from_millis(200)).await,
        }
    }
}

async fn configure(
    client: &Client,
    base: &str,
    key: &str,
    index: &str,
    vector: bool,
) -> Result<()> {
    let response = client
        .get(format!("{base}/indexes/{index}"))
        .bearer_auth(key)
        .send()
        .await?;
    if response.status() == 404 {
        let task = service_json(
            client,
            Method::POST,
            &format!("{base}/indexes"),
            Some(key),
            Some(&json!({"uid":index,"primaryKey":"id"})),
        )
        .await?;
        wait_task(
            client,
            base,
            key,
            task["taskUid"].as_u64().context("index task missing")?,
        )
        .await?;
    } else {
        response.error_for_status()?;
    }
    let settings = service_json(
        client,
        Method::GET,
        &format!("{base}/indexes/{index}/settings"),
        Some(key),
        None,
    )
    .await?;
    let dimensions = std::env::var("EMBEDDING_DIMENSIONS")
        .ok()
        .and_then(|d| d.parse::<u64>().ok())
        .unwrap_or(1536);
    let filter = settings["filterableAttributes"]
        .as_array()
        .is_some_and(|v| v.contains(&json!("userId")) && v.contains(&json!("id")));
    let ready = filter
        && if vector {
            settings["embedders"]["default"]["source"] == "userProvided"
                && settings["embedders"]["default"]["dimensions"] == dimensions
        } else {
            settings["sortableAttributes"]
                .as_array()
                .is_some_and(|v| v.contains(&json!("createdAt")))
        };
    if !ready {
        let mut desired = json!({"filterableAttributes":["id","userId"]});
        if vector {
            desired["embedders"] =
                json!({"default":{"source":"userProvided","dimensions":dimensions}});
        } else {
            desired["sortableAttributes"] = json!(["createdAt"]);
        }
        let task = service_json(
            client,
            Method::PATCH,
            &format!("{base}/indexes/{index}/settings"),
            Some(key),
            Some(&desired),
        )
        .await?;
        wait_task(
            client,
            base,
            key,
            task["taskUid"].as_u64().context("settings task missing")?,
        )
        .await?;
    }
    Ok(())
}

pub async fn execute(job: &Job, app: &Application) -> Result<Value> {
    let input = &job.input;
    let operation = string(input, "operation")?;
    let vector = operation.starts_with("vector");
    let base = if vector {
        std::env::var("MEILI_VECTOR_ADDR").or_else(|_| std::env::var("MEILI_ADDR"))
    } else {
        std::env::var("MEILI_ADDR")
    };
    let Ok(base) = base else {
        return Ok(json!({"kind":"done","skipped":true}));
    };
    let base = base.trim_end_matches('/');
    let key = if vector {
        std::env::var("MEILI_VECTOR_MASTER_KEY").or_else(|_| std::env::var("MEILI_MASTER_KEY"))
    } else {
        std::env::var("MEILI_MASTER_KEY")
    }
    .unwrap_or_default();
    let index = if vector {
        "bookmarks_vectors"
    } else {
        "bookmarks"
    };
    let client = Client::builder().timeout(Duration::from_secs(30)).build()?;
    configure(&client, base, &key, index, vector).await?;
    if let Some(uid) = job.checkpoint.as_ref().and_then(|c| c["taskUid"].as_u64()) {
        if wait_task(&client, base, &key, uid).await.is_ok() {
            return Ok(json!({"kind":"done"}));
        }
        app.checkpoint(job, json!({})).await?;
    }
    if app
        .call("validate", json!({"id":job.id,"token":job.token}))
        .await?
        != true
    {
        return Ok(json!({"kind":"done","skipped":true}));
    }
    let task = if operation.ends_with("Delete") {
        service_json(
            &client,
            Method::POST,
            &format!("{base}/indexes/{index}/documents/delete-batch"),
            Some(&key),
            Some(&json!([input["bookmarkId"]])),
        )
        .await?
    } else {
        let document = if vector {
            json!({"id":input["bookmarkId"],"userId":input["userId"],"_vectors":{"default":input["embedding"]}})
        } else {
            input["document"].clone()
        };
        service_json(
            &client,
            Method::POST,
            &format!("{base}/indexes/{index}/documents?primaryKey=id"),
            Some(&key),
            Some(&json!([document])),
        )
        .await?
    };
    let uid = task["taskUid"]
        .as_u64()
        .context("publication task missing")?;
    app.checkpoint(job, json!({"taskUid":uid})).await?;
    if let Err(e) = wait_task(&client, base, &key, uid).await {
        app.checkpoint(job, json!({})).await?;
        return Err(e);
    }
    Ok(json!({"kind":"done"}))
}
