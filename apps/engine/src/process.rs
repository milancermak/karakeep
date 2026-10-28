use anyhow::{Context, Result, ensure};
use serde_json::Value;
use std::{path::Path, process::Stdio};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
};

pub struct ProcessGroup(pub u32);
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        #[cfg(unix)]
        // Each child is started in its own process group. Killing the entire
        // group also handles grandchildren when a job is canceled or times out.
        unsafe {
            libc::kill(-(self.0 as i32), libc::SIGKILL);
        }
    }
}

pub fn command(program: &str, args: &[String], dir: &Path) -> Command {
    let mut c = Command::new(program);
    c.args(args).current_dir(dir).kill_on_drop(true);
    if program == "node" {
        c.env("BROWSER_CONNECT_ONDEMAND", "true");
    }
    #[cfg(unix)]
    {
        c.process_group(0);
    }
    c
}

pub async fn run(
    program: &str,
    args: &[String],
    dir: &Path,
    input: Option<&Value>,
    limit: usize,
) -> Result<Vec<u8>> {
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("helper.stderr.log"))?;
    let mut child = command(program, args, dir)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::from(log))
        .spawn()
        .context("starting execution tool")?;
    let _group = ProcessGroup(child.id().context("child PID missing")?);
    if let Some(input) = input {
        let mut stdin = child.stdin.take().context("child stdin missing")?;
        stdin.write_all(&serde_json::to_vec(input)?).await?;
        stdin.shutdown().await?;
    }
    let mut output = Vec::new();
    child
        .stdout
        .take()
        .context("child stdout missing")?
        .take(limit as u64 + 1)
        .read_to_end(&mut output)
        .await?;
    ensure!(
        output.len() <= limit,
        "execution tool exceeded output limit"
    );
    let status = child.wait().await?;
    ensure!(
        status.success(),
        "execution tool failed ({})",
        status.code().unwrap_or(-1)
    );
    Ok(output)
}

pub async fn node_helper(name: &str, input: &Value, dir: &Path) -> Result<Value> {
    let root = std::env::var("KARAKEEP_HELPER_DIR")
        .unwrap_or_else(|_| "/app/apps/workers/dist/scripts".into());
    let script = Path::new(&root).join(format!("{name}.js"));
    let memory = std::env::var("CRAWLER_PARSER_MEM_LIMIT_MB").unwrap_or_else(|_| "512".into());
    let args = vec![
        format!("--max-old-space-size={memory}"),
        script.to_string_lossy().into_owned(),
    ];
    let output = run("node", &args, dir, Some(input), 64 * 1024 * 1024).await?;
    let value: Value = serde_json::from_slice(&output).context("invalid helper response")?;
    ensure!(value.get("error").is_none(), "execution helper failed");
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn canceling_a_tool_kills_its_grandchildren() {
        let dir =
            std::env::temp_dir().join(format!("karakeep-engine-test-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir(&dir).await.unwrap();
        let args = vec!["-c".into(), "sleep 60 & echo $! > child.pid; wait".into()];
        assert!(
            tokio::time::timeout(
                std::time::Duration::from_millis(150),
                run("sh", &args, &dir, None, 1024)
            )
            .await
            .is_err()
        );
        let pid = tokio::fs::read_to_string(dir.join("child.pid"))
            .await
            .unwrap();
        let stat = tokio::fs::read_to_string(format!("/proc/{}/stat", pid.trim())).await;
        if let Ok(stat) = stat {
            assert!(
                stat.split_whitespace().nth(2) == Some("Z"),
                "child survived cancellation"
            );
        }
        tokio::fs::remove_dir_all(dir).await.unwrap();
    }
}
