use crate::{
    browser, media, network, process,
    protocol::{Application, Job, string},
};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::path::Path;

fn merge_metadata(probe: &Value, render: &Value, blocked: bool) -> Value {
    let mut out = render.clone();
    if !out.is_object() {
        out = json!({});
    }
    for field in [
        "title",
        "description",
        "image",
        "logo",
        "author",
        "publisher",
        "datePublished",
        "dateModified",
    ] {
        let (primary, fallback) = if blocked {
            (&probe[field], &render[field])
        } else {
            (&render[field], &probe[field])
        };
        out[field] = if primary.as_str().is_some_and(|s| !s.is_empty()) {
            primary.clone()
        } else {
            fallback.clone()
        };
    }
    out
}

pub async fn execute(job: &Job, app: &Application) -> Result<Value> {
    let input = &job.input;
    let dir = Path::new(&job.work_dir);
    let mut source_url = string(input, "url")?.to_owned();
    let mut status = 200;
    let mut charset = None;
    let mut raw = if let Some(path) = input["htmlPath"].as_str() {
        tokio::fs::read(path).await?
    } else {
        let (url, response) = network::fetch(&source_url, 30).await?;
        source_url = url.to_string();
        status = response.status().as_u16();
        charset = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| {
                v.split(';').find_map(|s| {
                    s.trim()
                        .split_once('=')
                        .filter(|(key, _)| key.eq_ignore_ascii_case("charset"))
                        .map(|(_, label)| label.to_owned())
                })
            });
        ensure!(
            status != 404 && status != 410,
            "source returned HTTP {status}"
        );
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .split(';')
            .next()
            .unwrap_or("")
            .to_owned();
        let file = dir.join("download.bin");
        network::download(
            response,
            &file,
            input["maxBytes"].as_u64().unwrap_or(50 * 1024 * 1024),
        )
        .await?;
        let bytes = tokio::fs::read(&file).await?;
        let pdf = content_type == "application/pdf" || bytes.starts_with(b"%PDF-");
        let image = content_type.starts_with("image/");
        if pdf || image {
            ensure!(status < 400, "asset fetch failed with HTTP {status}");
            let mut asset_job = job.clone();
            asset_job.input["contentType"] = json!(content_type);
            let mut result =
                media::extract(&asset_job, app, &file, if pdf { "pdf" } else { "image" }).await?;
            result["assetType"] = json!(if pdf { "pdf" } else { "image" });
            result["sourceUrl"] = json!(source_url);
            let filename = url::Url::parse(&source_url)?
                .path_segments()
                .and_then(|mut s| s.next_back())
                .unwrap_or("download")
                .to_owned();
            result["artifacts"].as_array_mut().context("artifact array missing")?.push(json!({
                "path":"download.bin","role":"bookmarkAsset","fileName":filename,"contentType":if pdf{"application/pdf"}else{&content_type}}));
            return Ok(result);
        }
        bytes
    };
    tokio::fs::write(dir.join("source.html"), &raw).await?;
    raw = decode_document(&raw, charset.as_deref());
    // Parsing sees a UTF-8 document. The browser path handles legacy page
    // encodings when rendering is needed; original bytes remain preserved.
    let probe = dir.join("probe.html");
    tokio::fs::write(&probe, String::from_utf8_lossy(&raw).as_bytes()).await?;
    let mut parsed = process::node_helper(
        "parseHtmlSubprocess",
        &json!({"htmlPath":probe,"url":source_url,"jobId":job.id}),
        dir,
    )
    .await?;
    if parsed["blocked"] != true && status < 400 {
        app.checkpoint(job, json!({"probe":parsed["metadata"],"statusCode":status}))
            .await?;
    }
    let mut artifacts = vec![];
    let policy = std::env::var("CRAWLER_RENDER_POLICY").unwrap_or_else(|_| "auto".into());
    let readable = parsed["readerViewAssessment"]["status"] == "readable";
    let render = input["headless"] == true
        && policy != "never"
        && (policy == "always"
            || !readable
            || input["storePdf"] == true
            || input["htmlPath"].is_string());
    if render {
        let _lease = browser::acquire().await?;
        let mut request = input.clone();
        request["url"] = json!(source_url);
        request["jobId"] = json!(job.id);
        request["workDir"] = json!(job.work_dir);
        match process::node_helper("renderPage", &request, dir).await {
            Ok(rendered) => {
                let file = dir.join(string(&rendered, "htmlPath")?);
                let result = process::node_helper(
                    "parseHtmlSubprocess",
                    &json!({"htmlPath":file,"url":rendered["url"],"jobId":job.id}),
                    dir,
                )
                .await?;
                let blocked = rendered["blocked"] == true;
                let metadata = merge_metadata(&parsed["metadata"], &result["metadata"], blocked);
                if !blocked {
                    parsed = result;
                    raw = tokio::fs::read(file).await?;
                    status = rendered["statusCode"].as_u64().unwrap_or(200) as u16;
                }
                parsed["metadata"] = metadata;
                if let Some(values) = rendered["artifacts"].as_array() {
                    artifacts.extend(values.iter().cloned());
                }
            }
            Err(error) => {
                if input["storePdf"] == true || !readable && status >= 400 {
                    return Err(error);
                }
                tracing::warn!(job=%job.id,"renderer failed; retaining extracted HTTP content");
            }
        }
    }
    ensure!(
        status < 400 && parsed["blocked"] != true,
        "page remained unavailable after extraction"
    );
    artifacts.push(json!({"path":"source.html","role":"linkRawHtml","contentType":"text/html","fileName":"source.html"}));
    let article = parsed["readableContent"]["content"].as_str().unwrap_or("");
    if !article.is_empty() {
        tokio::fs::write(dir.join("article.html"), article).await?;
        artifacts.push(
            json!({"path":"article.html","role":"linkHtmlContent","contentType":"text/html"}),
        );
    }
    let text = html2text::from_read(
        if article.is_empty() {
            raw.as_slice()
        } else {
            article.as_bytes()
        },
        100_000,
    )?;
    tokio::fs::write(dir.join("text.txt"), text).await?;
    if input["downloadBanner"] == true
        && let Some(image) = parsed["metadata"]["image"].as_str()
        && let Ok((_, response)) = network::fetch(image, 10).await
    {
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .split(';')
            .next()
            .unwrap_or("")
            .to_owned();
        if content_type.starts_with("image/")
            && network::download(response, &dir.join("banner.bin"), 10 * 1024 * 1024)
                .await
                .is_ok()
        {
            artifacts.push(
                json!({"path":"banner.bin","role":"linkBannerImage","contentType":content_type}),
            );
        }
    }
    if input["fullPageArchive"] == true {
        let mut args = vec![
            source_url.clone(),
            "-o".into(),
            dir.join("archive.html").to_string_lossy().into(),
        ];
        args.extend(
            std::env::var("CRAWLER_MONOLITH_ARGS")
                .unwrap_or_default()
                .split("%%")
                .filter(|a| !a.is_empty())
                .map(str::to_owned),
        );
        process::run("monolith", &args, dir, None, 1024 * 1024).await?;
        artifacts.push(
            json!({"path":"archive.html","role":"linkFullPageArchive","contentType":"text/html"}),
        );
    }
    Ok(
        json!({"kind":"document","sourceUrl":source_url,"statusCode":status,
        "metadata":parsed["metadata"],"assessment":parsed["readerViewAssessment"],"plainTextPath":"text.txt","artifacts":artifacts}),
    )
}

pub async fn feed(job: &Job) -> Result<Value> {
    let dir = Path::new(&job.work_dir);
    let (_, response) = network::fetch(string(&job.input, "url")?, 30).await?;
    ensure!(response.status().is_success(), "feed fetch failed");
    let file = dir.join("feed.xml");
    network::download(response, &file, 16 * 1024 * 1024).await?;
    let bytes = tokio::fs::read(file).await?;
    let original = crate::feed::original_urls(&bytes)?;
    let feed = feed_rs::parser::parse(bytes.as_slice())?;
    let items: Vec<_> = feed
        .entries
        .into_iter()
        .filter_map(|entry| {
            let link = entry
                .links
                .iter()
                .find(|l| l.rel.as_deref() == Some("alternate"))
                .or_else(|| entry.links.first())?
                .href
                .clone();
            let link = original.get(&link).cloned().unwrap_or(link);
            let guid = original.get(&entry.id).cloned().unwrap_or(entry.id);
            let mut item = json!({"guid":if guid.is_empty(){link.clone()}else{guid},"link":link,
            "categories":entry.categories.into_iter().map(|c|c.term).collect::<Vec<_>>()});
            if let Some(title) = entry.title {
                item["title"] = json!(title.content);
            }
            Some(item)
        })
        .collect();
    Ok(json!({"kind":"feed","items":items}))
}

fn decode_document(bytes: &[u8], charset: Option<&str>) -> Vec<u8> {
    let encoding = charset
        .and_then(|label| {
            encoding_rs::Encoding::for_label(label.trim_matches(['"', char::from(39)]).as_bytes())
        })
        .or_else(|| encoding_rs::Encoding::for_bom(bytes).map(|(encoding, _)| encoding))
        .unwrap_or(encoding_rs::UTF_8);
    encoding.decode(bytes).0.into_owned().into_bytes()
}

pub async fn archive(job: &Job) -> Result<Value> {
    let dir = Path::new(&job.work_dir);
    let url = string(&job.input, "url")?;
    network::validated(&url::Url::parse(url)?).await?;
    let mut args = vec![
        url.to_owned(),
        "-o".into(),
        dir.join("archive.html").to_string_lossy().into(),
    ];
    args.extend(
        std::env::var("CRAWLER_MONOLITH_ARGS")
            .unwrap_or_default()
            .split("%%")
            .filter(|v| !v.is_empty())
            .map(str::to_owned),
    );
    let timeout = std::env::var("CRAWLER_MONOLITH_TIMEOUT_SEC")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(5);
    tokio::time::timeout(
        std::time::Duration::from_secs(timeout),
        process::run("monolith", &args, dir, None, 1024 * 1024),
    )
    .await??;
    let limit = std::env::var("CRAWLER_FULL_PAGE_ARCHIVE_MAX_SIZE_MB")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);
    if limit > 0 {
        ensure!(
            tokio::fs::metadata(dir.join("archive.html")).await?.len() <= limit * 1024 * 1024,
            "archive exceeds size limit"
        );
    }
    Ok(
        json!({"kind":"artifacts","artifacts":[{"path":"archive.html","role":"linkFullPageArchive","contentType":"text/html"}]}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn decodes_legacy_http_charsets_without_corrupting_utf8() {
        assert_eq!(
            decode_document(b"Caf\xe9", Some("windows-1252")),
            "Café".as_bytes()
        );
        assert_eq!(
            decode_document("Příliš".as_bytes(), None),
            "Příliš".as_bytes()
        );
    }
}
