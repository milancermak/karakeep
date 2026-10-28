use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::Path;
use std::time::Duration;

pub const VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub version: u32,
    pub id: String,
    pub token: String,
    pub kind: String,
    pub fingerprint: Option<String>,
    pub timeout_secs: u64,
    pub input: Value,
    pub checkpoint: Option<Value>,
    pub work_dir: String,
}

#[derive(Clone)]
pub struct Application {
    client: reqwest::Client,
}

impl Application {
    pub fn new(socket: &Path) -> Result<Self> {
        Ok(Self {
            client: reqwest::Client::builder()
                .unix_socket(socket)
                .timeout(Duration::from_secs(90))
                .build()?,
        })
    }

    pub async fn call(&self, method: &str, params: Value) -> Result<Value> {
        let response = self
            .client
            .post("http://localhost/v1/work")
            .json(&json!({"version": VERSION, "method": method, "params": params}))
            .send()
            .await
            .context("application connection")?;
        let status = response.status();
        let body: Value = response.json().await.context("application response")?;
        if !status.is_success() || body.get("error").is_some() {
            bail!(
                "application {method}: {}",
                body.get("error").unwrap_or(&json!(status.as_u16()))
            );
        }
        Ok(body["result"].clone())
    }

    pub async fn checkpoint(&self, job: &Job, value: Value) -> Result<()> {
        let ok = self
            .call(
                "checkpoint",
                json!({"id":job.id,"token":job.token,"value":value}),
            )
            .await?;
        if ok != true {
            bail!("lease lost")
        }
        Ok(())
    }
}

pub fn string<'a>(value: &'a Value, field: &str) -> Result<&'a str> {
    value[field]
        .as_str()
        .with_context(|| format!("missing {field}"))
}
