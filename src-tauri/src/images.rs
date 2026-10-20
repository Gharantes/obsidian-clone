use crate::files::err;
use crate::settings::Image;
use base64::Engine;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

// Extension and MIME type of image bytes, or None when they aren't an image.
pub fn kind(data: &[u8]) -> Option<(&'static str, &'static str)> {
    match data {
        [0x89, b'P', b'N', b'G', ..] => Some(("png", "image/png")),
        [0xFF, 0xD8, ..] => Some(("jpg", "image/jpeg")),
        [b'G', b'I', b'F', b'8', ..] => Some(("gif", "image/gif")),
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => Some(("webp", "image/webp")),
        _ => None,
    }
}

// File names imported as images.
pub fn is_image_name(name: &str) -> bool {
    name.rsplit_once('.').is_some_and(|(_, ext)| ["png", "jpg", "jpeg", "gif", "webp"].contains(&ext.to_ascii_lowercase().as_str()))
}

pub fn get(db: &Connection, book: &str, name: &str) -> Result<Option<Vec<u8>>, String> {
    db.query_row("SELECT data FROM images WHERE book = ?1 AND name = ?2", params![book, name], |r| r.get(0)).optional().map_err(err)
}

// Adds an image unless one with that name exists.
pub fn add(db: &Connection, book: &str, name: &str, data: &[u8]) -> Result<(), String> {
    db.execute("INSERT OR IGNORE INTO images (book, name, data) VALUES (?1, ?2, ?3)", params![book, name, data]).map_err(err)?;
    Ok(())
}

pub fn all(db: &Connection, book: &str) -> Result<Vec<(String, Vec<u8>)>, String> {
    let mut stmt = db.prepare("SELECT name, data FROM images WHERE book = ?1 ORDER BY name").map_err(err)?;
    let rows = stmt.query_map([book], |r| Ok((r.get(0)?, r.get(1)?))).map_err(err)?.collect::<Result<_, _>>().map_err(err);
    rows
}

// Sends a request, giving up when cancelled; returns the body of a successful response.
async fn fetch(req: reqwest::RequestBuilder, cancel: &CancellationToken) -> Result<Vec<u8>, String> {
    let stopped = || "Stopped".to_string();
    let req = req.header("user-agent", concat!("obsidian-clone/", env!("CARGO_PKG_VERSION"))).timeout(std::time::Duration::from_secs(180));
    let res = tokio::select! {
        _ = cancel.cancelled() => return Err(stopped()),
        r = req.send() => r.map_err(|e| {
            let why = std::error::Error::source(&e).map_or(e.to_string(), |s| s.to_string());
            format!("Could not reach the image server ({why})")
        })?,
    };
    let status = res.status();
    let body = tokio::select! {
        _ = cancel.cancelled() => return Err(stopped()),
        b = res.bytes() => b.map_err(err)?,
    };
    if !status.is_success() {
        let json: Value = serde_json::from_slice(&body).unwrap_or_default();
        if let Some(msg) = json["error"]["message"].as_str() {
            return Err(msg.to_string());
        }
        return Err(format!("{status}: {}", String::from_utf8_lossy(&body).chars().take(500).collect::<String>()));
    }
    Ok(body.to_vec())
}

// Reads `data[0].b64_json` from an OpenAI-style images response.
pub fn parse_b64(body: &[u8]) -> Result<Vec<u8>, String> {
    let json: Value = serde_json::from_slice(body).map_err(|_| "The image server did not return JSON")?;
    if !json["error"].is_null() {
        return Err(json["error"]["message"].as_str().map_or(json["error"].to_string(), String::from));
    }
    let b64 = json["data"][0]["b64_json"].as_str().ok_or("The image server returned no b64_json image")?;
    base64::engine::general_purpose::STANDARD.decode(b64).map_err(err)
}

// Generates an image with the configured provider; returns its bytes.
pub async fn generate(cfg: &Image, prompt: &str, width: u32, height: u32, cancel: &CancellationToken) -> Result<Vec<u8>, String> {
    let client = reqwest::Client::new();
    let data = if cfg.provider == "openai" {
        let o = &cfg.openai;
        let mut body = json!({ "prompt": prompt, "n": 1, "size": format!("{width}x{height}"), "response_format": "b64_json" });
        if !o.model.is_empty() {
            body["model"] = json!(o.model);
        }
        let mut req = client
            .post(format!("{}/images/generations", o.base_url.trim_end_matches('/')))
            .header("content-type", "application/json")
            .body(body.to_string());
        if !o.api_key.is_empty() {
            req = req.bearer_auth(&o.api_key);
        }
        parse_b64(&fetch(req, cancel).await?)?
    } else {
        // Pollinations' anonymous endpoint; a random seed so the same prompt gives a new picture.
        let mut url = reqwest::Url::parse("https://image.pollinations.ai/prompt/").map_err(err)?;
        url.path_segments_mut().map_err(|_| "bad url")?.pop_if_empty().push(prompt);
        let seed = crate::books::random(1 << 31).to_string();
        url.query_pairs_mut()
            .append_pair("width", &width.to_string())
            .append_pair("height", &height.to_string())
            .append_pair("nologo", "true")
            .append_pair("seed", &seed);
        fetch(client.get(url), cancel).await?
    };
    kind(&data).ok_or("The image server did not return an image")?;
    Ok(data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_images_and_reads_b64() {
        assert_eq!(kind(b"\x89PNG\r\n\x1a\n").unwrap().0, "png");
        assert_eq!(kind(b"RIFF1234WEBPVP8 ").unwrap().1, "image/webp");
        assert_eq!(kind(b"<html>"), None);
        assert!(is_image_name("Map.JPG") && !is_image_name("png") && !is_image_name("note.md"));

        let ok = json!({ "data": [{ "b64_json": "iVBORw==" }] }).to_string();
        assert_eq!(parse_b64(ok.as_bytes()).unwrap(), b"\x89PNG");
        let bad = json!({ "error": { "message": "no model loaded" } }).to_string();
        assert_eq!(parse_b64(bad.as_bytes()).unwrap_err(), "no model loaded");
    }
}
