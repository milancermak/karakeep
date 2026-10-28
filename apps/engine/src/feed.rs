use anyhow::Result;
use quick_xml::{Reader, events::Event};
use std::collections::HashMap;
use url::Url;

/// feed-rs resolves/normalizes URLs. Retain the feed's original absolute URL
/// spelling for stored links and GUIDs, preserving existing deduplication keys.
pub fn original_urls(xml: &[u8]) -> Result<HashMap<String, String>> {
    let mut reader = Reader::from_reader(xml);
    reader.config_mut().trim_text(true);
    let mut urls = HashMap::new();
    let mut field = String::new();
    let mut text = String::new();
    let mut in_entry = false;
    let mut insert = |s: &str| {
        if let Ok(url) = Url::parse(s) {
            urls.entry(url.to_string()).or_insert_with(|| s.to_owned());
        }
    };
    loop {
        match reader.read_event()? {
            Event::Start(e) => {
                let name = String::from_utf8_lossy(e.local_name().as_ref()).into_owned();
                if name == "item" || name == "entry" {
                    in_entry = true;
                }
                if in_entry && matches!(name.as_str(), "link" | "guid" | "id") {
                    field = name.clone();
                    text.clear();
                }
                if in_entry && name == "link" {
                    for attribute in e.attributes().flatten() {
                        if attribute.key.local_name().as_ref() == b"href" {
                            insert(&attribute.decoded_and_normalized_value(
                                quick_xml::XmlVersion::Implicit1_0,
                                reader.decoder(),
                            )?);
                        }
                    }
                }
            }
            Event::Empty(e) => {
                if in_entry && e.local_name().as_ref() == b"link" {
                    for attribute in e.attributes().flatten() {
                        if attribute.key.local_name().as_ref() == b"href" {
                            insert(&attribute.decoded_and_normalized_value(
                                quick_xml::XmlVersion::Implicit1_0,
                                reader.decoder(),
                            )?);
                        }
                    }
                }
            }
            Event::Text(e) if !field.is_empty() => text.push_str(&e.decode()?),
            Event::CData(e) if !field.is_empty() => text.push_str(&e.decode()?),
            Event::GeneralRef(e) if !field.is_empty() => {
                text.push_str(&quick_xml::escape::unescape(&format!("&{};", e.decode()?))?)
            }
            Event::End(e) => {
                let name = e.local_name();
                if name.as_ref() == field.as_bytes() {
                    insert(&text);
                    field.clear();
                    text.clear();
                }
                if name.as_ref() == b"item" || name.as_ref() == b"entry" {
                    in_entry = false;
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(urls)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_explicit_ports_and_xml_entities_for_rss_and_atom() {
        let xml=br#"<rss><channel><item><link>http://example.test:80/page?a=1&amp;b=2</link><guid>http://example.test:80/id</guid></item></channel></rss>"#;
        let urls = original_urls(xml).unwrap();
        assert_eq!(
            urls["http://example.test/page?a=1&b=2"],
            "http://example.test:80/page?a=1&b=2"
        );
        let atom = br#"<feed><entry><link href="http://example.test:80/page"/></entry></feed>"#;
        assert_eq!(
            original_urls(atom).unwrap()["http://example.test/page"],
            "http://example.test:80/page"
        );
    }
}
