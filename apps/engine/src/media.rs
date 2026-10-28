use crate::{
    network, process,
    protocol::{Application, Job, string},
};
use anyhow::Result;
use serde_json::{Value, json};
use std::path::Path;

pub async fn extract(
    job: &Job,
    app: &Application,
    input_path: &Path,
    asset_type: &str,
) -> Result<Value> {
    let dir = Path::new(&job.work_dir);
    let mut artifacts = vec![];
    let mut metadata = json!({});
    let text = if asset_type == "pdf" {
        process::run(
            "pdftotext",
            &[
                "-layout".into(),
                input_path.to_string_lossy().into(),
                dir.join("text.txt").to_string_lossy().into(),
            ],
            dir,
            None,
            1024,
        )
        .await?;
        if let Ok(info) = process::run(
            "pdfinfo",
            &[input_path.to_string_lossy().into()],
            dir,
            None,
            64 * 1024,
        )
        .await
        {
            for line in String::from_utf8_lossy(&info).lines() {
                if let Some((key, value)) = line.split_once(':') {
                    metadata[key.trim()] = json!(value.trim());
                }
            }
        }
        // Preview failure should not discard successfully extracted PDF text.
        if process::run(
            "pdftoppm",
            &[
                "-f".into(),
                "1".into(),
                "-singlefile".into(),
                "-scale-to".into(),
                "1600".into(),
                "-png".into(),
                input_path.to_string_lossy().into(),
                dir.join("preview").to_string_lossy().into(),
            ],
            dir,
            None,
            1024,
        )
        .await
        .is_ok()
        {
            artifacts.push(
                json!({"path":"preview.png","role":"assetScreenshot","contentType":"image/png"}),
            );
        }
        tokio::fs::read_to_string(dir.join("text.txt")).await?
    } else if job.input["ocrUseLLM"] == true {
        let mut ai_job = job.clone();
        ai_job.input = json!({"operation":"ocr","template":"Extract all readable text from this image. Return only the extracted text, preserving paragraphs and structure.",
            "content":"","contextLength":2048,"maxOutputTokens":4096,"useMaxCompletionTokens":true,
            "model":std::env::var("INFERENCE_IMAGE_MODEL").unwrap_or_else(|_|"gpt-4o-mini".into()),
            "imagePath":input_path.to_string_lossy(),"imageContentType":job.input["contentType"]});
        crate::ai::execute(&ai_job, app).await?["summary"]
            .as_str()
            .unwrap_or("")
            .to_owned()
    } else {
        let langs = job.input["ocrLangs"]
            .as_array()
            .map(|l| {
                l.iter()
                    .filter_map(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>()
                    .join("+")
            })
            .unwrap_or_else(|| {
                std::env::var("OCR_LANGS")
                    .unwrap_or_else(|_| "eng".into())
                    .replace(',', "+")
            });
        if langs.is_empty() || job.input["contentType"] == "image/gif" {
            String::new()
        } else {
            let prefix = dir.join("ocr");
            process::run(
                "tesseract",
                &[
                    input_path.to_string_lossy().into(),
                    prefix.to_string_lossy().into(),
                    "-l".into(),
                    langs,
                    "txt".into(),
                    "tsv".into(),
                ],
                dir,
                None,
                1024,
            )
            .await?;
            let tsv = tokio::fs::read_to_string(prefix.with_extension("tsv")).await?;
            let confidence: Vec<f64> = tsv
                .lines()
                .skip(1)
                .filter_map(|l| l.split('\t').nth(10)?.parse::<f64>().ok())
                .filter(|v| *v >= 0.0)
                .collect();
            let mean = if confidence.is_empty() {
                0.0
            } else {
                confidence.iter().sum::<f64>() / confidence.len() as f64
            };
            metadata["ocrConfidence"] = json!(mean);
            if mean >= job.input["ocrConfidence"].as_f64().unwrap_or(50.0) {
                tokio::fs::read_to_string(prefix.with_extension("txt")).await?
            } else {
                String::new()
            }
        }
    };
    tokio::fs::write(dir.join("text.txt"), &text).await?;
    Ok(
        json!({"kind":"document","plainTextPath":"text.txt","metadata":metadata,"artifacts":artifacts}),
    )
}

pub async fn video(job: &Job) -> Result<Value> {
    let dir = Path::new(&job.work_dir);
    let url = string(&job.input, "url")?;
    let (resolved, response) = network::fetch(url, 30).await?;
    drop(response);
    let mut args = vec![
        "--no-playlist".into(),
        "--no-progress".into(),
        "--merge-output-format".into(),
        "mp4".into(),
        "--remux-video".into(),
        "mp4".into(),
        "-o".into(),
        dir.join("video.%(ext)s").to_string_lossy().into(),
    ];
    if let Some(size) = job.input["maxSizeMb"].as_i64().filter(|s| *s > 0) {
        args.extend(["--max-filesize".into(), format!("{size}M")]);
    }
    if let Some(extra) = job.input["args"].as_array() {
        args.extend(extra.iter().filter_map(Value::as_str).map(str::to_owned));
    }
    args.push(resolved.to_string());
    if let Err(error) = process::run("yt-dlp", &args, dir, None, 1024 * 1024).await {
        let log = tokio::fs::read_to_string(dir.join("helper.stderr.log"))
            .await
            .unwrap_or_default();
        if log.contains("Unsupported URL") || log.contains("No media found") {
            return Ok(json!({"kind":"done","skipped":true}));
        }
        return Err(error);
    }
    if !dir.join("video.mp4").exists() {
        return Ok(json!({"kind":"done","skipped":true}));
    }
    Ok(
        json!({"kind":"artifacts","artifacts":[{"path":"video.mp4","role":"linkVideo","contentType":"video/mp4"}]}),
    )
}

pub async fn export(job: &Job) -> Result<Value> {
    let input = string(&job.input, "jsonPath")?.to_owned();
    let dir = job.work_dir.clone();
    tokio::task::spawn_blocking(move || {
        use std::io::Write;
        let file = std::fs::File::create(Path::new(&dir).join("backup.zip"))?;
        let mut archive = zip::ZipWriter::new(file);
        archive.start_file(
            format!(
                "karakeep-backup-{}.json",
                chrono::Utc::now().format("%Y%m%dT%H%M%SZ")
            ),
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated),
        )?;
        let mut source = std::fs::File::open(input)?;
        std::io::copy(&mut source, &mut archive)?;
        archive.flush()?;
        archive.finish()?.sync_all()?;
        Ok::<_, anyhow::Error>(())
    })
    .await??;
    Ok(
        json!({"kind":"artifacts","bookmarkCount":job.input["bookmarkCount"],
        "artifacts":[{"path":"backup.zip","role":"backup","contentType":"application/zip","fileName":"karakeep-backup.zip"}]}),
    )
}
