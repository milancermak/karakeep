use crate::{
    network::service_json,
    protocol::{Application, Job, string},
};
use anyhow::{Context, Result, ensure};
use base64::Engine;
use reqwest::{Client, Method};
use serde_json::{Value, json};
use std::time::Duration;

pub fn client() -> Result<Client> {
    let mut builder = Client::builder().timeout(Duration::from_secs(
        std::env::var("OPENAI_TIMEOUT_SEC")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(300),
    ));
    if let Ok(proxy) = std::env::var("OPENAI_PROXY_URL") {
        builder = builder.proxy(reqwest::Proxy::all(proxy)?);
    }
    Ok(builder.build()?)
}

async fn prompt(input: &Value) -> Result<String> {
    let template = string(input, "template")?.to_owned();
    let content = input["content"].as_str().unwrap_or("").to_owned();
    let budget = input["contextLength"].as_u64().unwrap_or(2048) as usize;
    tokio::task::spawn_blocking(move || {
        // Deliberately not the singleton: release tokenizer tables after the
        // operation rather than retaining them for the lifetime of the daemon.
        let tokenizer = tiktoken_rs::o200k_base()?;
        let template_tokens = tokenizer.encode_ordinary(&template.replace("{{CONTENT}}", ""));
        let available = budget.saturating_sub(template_tokens.len());
        let bounded: String = content.chars().take(available.saturating_mul(8)).collect();
        let mut tokens = tokenizer.encode_ordinary(&bounded);
        tokens.truncate(available);
        // Avoid a truncated UTF-8 code point at the final token boundary.
        let text = loop {
            match tokenizer.decode(tokens.clone()) {
                Ok(s) => break s,
                Err(_) if !tokens.is_empty() => {
                    tokens.pop();
                }
                Err(e) => return Err(e),
            }
        };
        Ok::<_, anyhow::Error>(template.replace("{{CONTENT}}", &text))
    })
    .await?
}

pub fn parse_tags(text: &str) -> Result<Vec<String>> {
    let first = text.find('{').context("tag response has no JSON object")?;
    let last = text
        .rfind('}')
        .context("tag response has no closing object")?;
    let value: Value = serde_json::from_str(&text[first..=last])?;
    let tags = value["tags"]
        .as_array()
        .context("tag response missing tags")?;
    tags.iter()
        .map(|t| {
            Ok(t.as_str()
                .context("tag must be a string")?
                .trim()
                .trim_start_matches('#')
                .trim()
                .to_owned())
        })
        .collect()
}

pub async fn execute(job: &Job, app: &Application) -> Result<Value> {
    if let Some(result) = job.checkpoint.as_ref().and_then(|v| v.get("result")) {
        return Ok(result.clone());
    }
    let input = &job.input;
    let operation = string(input, "operation")?;
    let embedding = operation == "embedding";
    let nonempty = |key: &str| std::env::var(key).is_ok_and(|s| !s.trim().is_empty());
    let ollama = !nonempty("OPENAI_API_KEY")
        && nonempty("OLLAMA_BASE_URL")
        && !(embedding
            && (nonempty("EMBEDDING_OPENAI_API_KEY") || nonempty("EMBEDDING_OPENAI_BASE_URL")));
    let model = string(input, "model")?;
    let http = client()?;
    let response = if embedding {
        let text = string(input, "text")?;
        if ollama {
            let base = std::env::var("OLLAMA_BASE_URL")?;
            service_json(
                &http,
                Method::POST,
                &format!("{}/api/embed", base.trim_end_matches('/')),
                None,
                Some(&json!({"model":model,"input":[text]})),
            )
            .await?
        } else {
            let base = std::env::var("EMBEDDING_OPENAI_BASE_URL")
                .or_else(|_| std::env::var("OPENAI_BASE_URL"))
                .unwrap_or_else(|_| "https://api.openai.com/v1".into());
            let key = std::env::var("EMBEDDING_OPENAI_API_KEY")
                .or_else(|_| std::env::var("OPENAI_API_KEY"))
                .unwrap_or_default();
            let mut body = json!({"model":model,"input":[text],"encoding_format":"float"});
            if let Some(d) = input["dimensionOverride"].as_u64() {
                body["dimensions"] = json!(d);
            }
            service_json(
                &http,
                Method::POST,
                &format!("{}/embeddings", base.trim_end_matches('/')),
                Some(&key),
                Some(&body),
            )
            .await?
        }
    } else {
        let prompt = prompt(input).await?;
        let image = if let Some(path) = input["imagePath"].as_str() {
            Some(base64::engine::general_purpose::STANDARD.encode(tokio::fs::read(path).await?))
        } else {
            None
        };
        if ollama {
            let base = std::env::var("OLLAMA_BASE_URL")?;
            let mut message = json!({"role":"user","content":prompt});
            if let Some(image) = image {
                message["images"] = json!([image]);
            }
            let mut body = json!({"model":model,"messages":[message],"stream":false});
            if operation == "tags" {
                body["format"] = json!("json");
            }
            if let Ok(keep) = std::env::var("OLLAMA_KEEP_ALIVE") {
                body["keep_alive"] = json!(keep);
            }
            service_json(
                &http,
                Method::POST,
                &format!("{}/api/chat", base.trim_end_matches('/')),
                None,
                Some(&body),
            )
            .await?
        } else {
            let base = std::env::var("OPENAI_BASE_URL")
                .unwrap_or_else(|_| "https://api.openai.com/v1".into());
            let key = std::env::var("OPENAI_API_KEY").unwrap_or_default();
            let content = if let Some(image) = image {
                json!([{"type":"text","text":prompt},{"type":"image_url","image_url":{"url":format!("data:{};base64,{}",input["imageContentType"].as_str().unwrap_or("image/png"),image)}}])
            } else {
                json!(prompt)
            };
            let mut body = json!({"model":model,"messages":[{"role":"user","content":content}]});
            let token_field = if input["useMaxCompletionTokens"].as_bool().unwrap_or(true) {
                "max_completion_tokens"
            } else {
                "max_tokens"
            };
            body[token_field] = input["maxOutputTokens"].clone();
            for (source, target) in [
                ("reasoningEffort", "reasoning_effort"),
                ("serviceTier", "service_tier"),
            ] {
                if !input[source].is_null() {
                    body[target] = input[source].clone();
                }
            }
            if operation == "tags" {
                match input["outputSchema"].as_str().unwrap_or("structured") {
                    "structured" => {
                        body["response_format"] = json!({"type":"json_schema","json_schema":{"name":"schema","strict":true,
                        "schema":{"type":"object","properties":{"tags":{"type":"array","items":{"type":"string"}}},"required":["tags"],"additionalProperties":false}}})
                    }
                    "json" => body["response_format"] = json!({"type":"json_object"}),
                    _ => {}
                }
            }
            service_json(
                &http,
                Method::POST,
                &format!("{}/chat/completions", base.trim_end_matches('/')),
                Some(&key),
                Some(&body),
            )
            .await?
        }
    };
    let result = if embedding {
        let vector = response
            .pointer("/data/0/embedding")
            .or_else(|| response.pointer("/embeddings/0"))
            .or_else(|| response.get("embedding"))
            .context("embedding missing")?;
        let vector = vector.as_array().context("embedding must be an array")?;
        ensure!(
            vector.len() == input["dimensions"].as_u64().unwrap_or(1536) as usize,
            "embedding dimensions mismatch"
        );
        ensure!(
            vector
                .iter()
                .all(|n| n.as_f64().is_some_and(f64::is_finite)),
            "embedding values must be finite numbers"
        );
        json!({"kind":"embedding","embedding":vector,"usage":response["usage"]})
    } else {
        let text = response
            .pointer("/choices/0/message/content")
            .or_else(|| response.pointer("/message/content"))
            .and_then(Value::as_str)
            .context("inference response is empty")?;
        if operation == "tags" {
            json!({"kind":"tags","tags":parse_tags(text)?,"usage":response["usage"]})
        } else {
            ensure!(!text.trim().is_empty(), "summary is empty");
            json!({"kind":"summary","summary":text,"usage":response["usage"]})
        }
    };
    app.checkpoint(job, json!({"result":result})).await?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_json_and_fenced_json_but_rejects_invalid_tags() {
        assert_eq!(
            parse_tags("```json\n{\"tags\":[\"#rust\",\" SQLite \"]}\n```").unwrap(),
            vec!["rust", "SQLite"]
        );
        assert!(parse_tags("{\"tags\":[1]}").is_err());
    }
}
