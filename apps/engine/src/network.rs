use anyhow::{Context, Result, bail, ensure};
use futures_util::StreamExt;
use reqwest::{Client, Method, Response, redirect::Policy};
use serde_json::Value;
use std::{
    net::{IpAddr, SocketAddr},
    time::Duration,
};
use tokio::io::AsyncWriteExt;
use url::Url;

pub fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            let [a, b, _, _] = v.octets();
            !(v.is_private()
                || v.is_loopback()
                || v.is_link_local()
                || v.is_multicast()
                || v.is_unspecified()
                || v.is_documentation()
                || a == 0
                || a >= 240
                || (a == 100 && (64..=127).contains(&b))
                || (a == 192 && b == 0)
                || (a == 198 && (b == 18 || b == 19)))
        }
        IpAddr::V6(v) => {
            if let Some(v4) = v.to_ipv4_mapped() {
                return public_ip(IpAddr::V4(v4));
            }
            let s = v.segments();
            !(v.is_loopback()
                || v.is_unspecified()
                || v.is_multicast()
                || s[0] & 0xfe00 == 0xfc00
                || s[0] & 0xffc0 == 0xfe80
                || s[0] & 0xffc0 == 0xfec0
                || s[0] == 0x2002
                || s[0] == 0x2001 && (s[1] == 0 || s[1] == 2)
                || s[0] == 0x100 && s[1..4] == [0, 0, 0]
                || s[0] == 0x2001 && s[1] == 0xdb8)
        }
    }
}

fn allowed(host: &str) -> bool {
    std::env::var("CRAWLER_ALLOWED_INTERNAL_HOSTNAMES")
        .unwrap_or_default()
        .split(',')
        .map(|v| v.trim().to_lowercase())
        .any(|v| {
            v == "."
                || v == host.to_lowercase()
                || !v.is_empty()
                    && host
                        .to_lowercase()
                        .ends_with(&format!(".{}", v.trim_start_matches('.')))
        })
}

pub async fn validated(url: &Url) -> Result<Vec<SocketAddr>> {
    ensure!(
        matches!(url.scheme(), "http" | "https"),
        "unsupported URL scheme"
    );
    ensure!(
        url.username().is_empty() && url.password().is_none(),
        "URL credentials are unsupported"
    );
    let host = url
        .host_str()
        .context("URL hostname missing")?
        .trim_matches(['[', ']']);
    let port = url.port_or_known_default().context("URL port missing")?;
    let addresses: Vec<_> = tokio::time::timeout(
        Duration::from_secs(3),
        tokio::net::lookup_host((host, port)),
    )
    .await??
    .collect();
    ensure!(!addresses.is_empty(), "DNS returned no addresses");
    ensure!(
        allowed(host) || addresses.iter().all(|a| public_ip(a.ip())),
        "private destination blocked"
    );
    Ok(addresses)
}

pub async fn client_for(url: &Url, timeout_secs: u64) -> Result<Client> {
    let addresses = validated(url).await?;
    let host = url
        .host_str()
        .context("hostname missing")?
        .trim_matches(['[', ']']);
    let mut builder = Client::builder()
        .redirect(Policy::none())
        .no_proxy()
        .timeout(Duration::from_secs(timeout_secs))
        .resolve_to_addrs(host, &addresses)
        .user_agent(
            std::env::var("CRAWLER_PREFLIGHT_USER_AGENT")
                .unwrap_or_else(|_| "Mozilla/5.0 (compatible; Karakeep/1.0)".into()),
        );
    let bypass = std::env::var("CRAWLER_NO_PROXY")
        .or_else(|_| std::env::var("NO_PROXY"))
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .any(|h| {
            h == "*"
                || !h.is_empty()
                    && (host == h || host.ends_with(&format!(".{}", h.trim_start_matches('.'))))
        });
    if !bypass {
        let proxy = if url.scheme() == "https" {
            std::env::var("CRAWLER_HTTPS_PROXY")
                .or_else(|_| std::env::var("HTTPS_PROXY"))
                .or_else(|_| std::env::var("CRAWLER_HTTP_PROXY"))
                .or_else(|_| std::env::var("HTTP_PROXY"))
        } else {
            std::env::var("CRAWLER_HTTP_PROXY").or_else(|_| std::env::var("HTTP_PROXY"))
        };
        if let Ok(proxy) = proxy
            && let Some(first) = proxy.split(',').map(str::trim).find(|v| !v.is_empty())
        {
            builder = builder.proxy(reqwest::Proxy::all(first)?);
        }
    }
    Ok(builder.build()?)
}

/// Validate every redirect and pin the checked addresses to the actual connection.
pub async fn fetch(url: &str, timeout_secs: u64) -> Result<(Url, Response)> {
    let mut url = Url::parse(url)?;
    for _ in 0..=10 {
        let response = client_for(&url, timeout_secs)
            .await?
            .get(url.clone())
            .send()
            .await?;
        if response.status().is_redirection() {
            let location = response
                .headers()
                .get("location")
                .context("redirect missing location")?
                .to_str()?;
            url = url.join(location)?;
            continue;
        }
        return Ok((url, response));
    }
    bail!("too many redirects")
}

pub async fn download(response: Response, path: &std::path::Path, limit: u64) -> Result<u64> {
    if let Some(size) = response.content_length() {
        ensure!(size <= limit, "download exceeds size limit");
    }
    let mut file = tokio::fs::File::create(path).await?;
    let mut stream = response.bytes_stream();
    let mut size = 0;
    while let Some(bytes) = stream.next().await {
        let bytes = bytes?;
        size += bytes.len() as u64;
        ensure!(size <= limit, "download exceeds size limit");
        file.write_all(&bytes).await?;
    }
    file.sync_all().await?;
    Ok(size)
}

pub async fn service_json(
    client: &Client,
    method: Method,
    url: &str,
    key: Option<&str>,
    body: Option<&Value>,
) -> Result<Value> {
    let mut request = client.request(method, url);
    if let Some(key) = key.filter(|k| !k.is_empty()) {
        request = request.bearer_auth(key);
    }
    if let Some(body) = body {
        request = request.json(body);
    }
    let response = request.send().await?;
    let status = response.status();
    // Never include provider bodies in errors: they can echo private content.
    ensure!(
        status.is_success(),
        "service returned HTTP {}",
        status.as_u16()
    );
    Ok(response.json().await?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};
    #[test]
    fn rejects_internal_addresses_including_mapped_ipv6() {
        for s in [
            "127.0.0.1",
            "10.0.1.2",
            "169.254.169.254",
            "100.64.1.1",
            "::1",
            "fc00::1",
            "fe80::1",
            "::ffff:127.0.0.1",
        ] {
            assert!(!public_ip(s.parse().unwrap()), "{s}");
        }
        assert!(public_ip(IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1))));
        assert!(public_ip(IpAddr::V6(
            "2606:4700:4700::1111".parse::<Ipv6Addr>().unwrap()
        )));
    }
}
