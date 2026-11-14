use crate::files::err;
use serde_json::Value;
use std::time::Duration;

// Downloads a pixiv artwork's images through the JSON endpoint pixiv's own site uses. Image
// requests need pixiv's Referer (i.pximg.net answers 403 without it), which is why this runs here
// and not in the webview. R-18 works need the PHPSESSID cookie of an account that has R-18
// viewing turned on.

const REFERER: &str = "https://www.pixiv.net/";
// pixiv turns away clients that don't look like a browser.
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

// The artwork id in a pixiv link ("https://www.pixiv.net/en/artworks/141886602",
// "member_illust.php?illust_id=141886602") or on its own ("141886602").
pub fn artwork_id(link: &str) -> Option<String> {
    let link = link.trim();
    let digits = |s: &str| {
        let d: String = s.chars().take_while(char::is_ascii_digit).collect();
        (!d.is_empty()).then_some(d)
    };
    if !link.is_empty() && link.chars().all(|c| c.is_ascii_digit()) {
        return Some(link.to_string());
    }
    if !link.contains("pixiv.net") {
        return None;
    }
    if let Some((_, rest)) = link.split_once("/artworks/") {
        return digits(rest);
    }
    link.split_once("illust_id=").and_then(|(_, rest)| digits(rest))
}

// The value for the Cookie header from what the user pasted: the bare PHPSESSID value, or
// "PHPSESSID=..." (with or without other cookies around it). None when empty.
pub fn cookie(session: &str) -> Option<String> {
    let s = session.trim();
    let value = s.split(';').map(str::trim).find_map(|p| p.strip_prefix("PHPSESSID=")).unwrap_or(s);
    (!value.is_empty()).then(|| format!("PHPSESSID={value}"))
}

// The original-size image URLs from a /ajax/illust/<id>/pages response, in page order.
pub fn page_urls(body: &[u8], logged_in: bool) -> Result<Vec<String>, String> {
    let json: Value = serde_json::from_slice(body).map_err(|_| "pixiv did not return JSON (the link may be wrong, or pixiv changed its site)")?;
    // A missing work comes with a message; an R-18 one, when pixiv won't show it, with an empty one.
    if let Some(msg) = json["message"].as_str().filter(|m| !m.is_empty() && json["error"].as_bool() == Some(true)) {
        return Err(msg.to_string());
    }
    let urls: Vec<String> = json["body"].as_array().into_iter().flatten().filter_map(|p| p["urls"]["original"].as_str().map(String::from)).collect();
    if urls.is_empty() {
        return Err(if logged_in {
            "pixiv returned no images. If this is an R-18 work, check that R-18 viewing is turned on for your pixiv account and that the session in Settings → pixiv hasn't expired.".into()
        } else {
            "pixiv returned no images. If this is an R-18 work, add your pixiv session in Settings → pixiv.".into()
        });
    }
    Ok(urls)
}

// The file name an image URL ends in ("141886602_p0.png").
pub fn file_name(url: &str) -> String {
    url.rsplit('/').next().unwrap_or(url).split('?').next().unwrap_or_default().to_string()
}

async fn get(client: &reqwest::Client, url: &str, cookie: Option<&str>) -> Result<Vec<u8>, String> {
    let mut req = client.get(url).header("referer", REFERER).timeout(Duration::from_secs(120));
    if let Some(c) = cookie {
        req = req.header("cookie", c);
    }
    let res = req.send().await.map_err(|e| {
        let why = std::error::Error::source(&e).map_or(e.to_string(), |s| s.to_string());
        format!("Could not reach pixiv ({why})")
    })?;
    let status = res.status();
    let body = res.bytes().await.map_err(err)?;
    // The pages endpoint reports errors as JSON with an error status; let page_urls read them.
    if !status.is_success() && !(url.contains("/ajax/") && body.starts_with(b"{")) {
        return Err(format!("pixiv answered {status}"));
    }
    Ok(body.to_vec())
}

// An artwork's images as (file name, bytes), in page order; `failed` lists pages that didn't download.
pub struct Artwork {
    pub images: Vec<(String, Vec<u8>)>,
    pub failed: Vec<String>,
}

pub async fn download(id: &str, session: &str) -> Result<Artwork, String> {
    let client = reqwest::Client::builder().user_agent(USER_AGENT).build().map_err(err)?;
    let cookie = cookie(session);
    let body = get(&client, &format!("https://www.pixiv.net/ajax/illust/{id}/pages?lang=en"), cookie.as_deref()).await?;
    let urls = page_urls(&body, cookie.is_some())?;
    let (mut images, mut failed) = (Vec::new(), Vec::new());
    for url in urls {
        let name = file_name(&url);
        match get(&client, &url, cookie.as_deref()).await {
            Ok(data) => images.push((name, data)),
            Err(e) => failed.push(format!("\"{name}\": {e}")),
        }
    }
    Ok(Artwork { images, failed })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_artwork_ids() {
        assert_eq!(artwork_id("https://www.pixiv.net/en/artworks/141886602").as_deref(), Some("141886602"));
        assert_eq!(artwork_id("https://www.pixiv.net/artworks/141886602#manga").as_deref(), Some("141886602"));
        assert_eq!(artwork_id("pixiv.net/en/artworks/141886602?foo=1").as_deref(), Some("141886602"));
        assert_eq!(artwork_id("https://www.pixiv.net/member_illust.php?mode=medium&illust_id=123").as_deref(), Some("123"));
        assert_eq!(artwork_id(" 141886602 ").as_deref(), Some("141886602"));
        assert_eq!(artwork_id("https://www.pixiv.net/en/users/123"), None);
        assert_eq!(artwork_id("https://example.com/artworks/1"), None);
        assert_eq!(artwork_id(""), None);
    }

    #[test]
    fn builds_the_cookie() {
        assert_eq!(cookie("abc_123").as_deref(), Some("PHPSESSID=abc_123"));
        assert_eq!(cookie(" PHPSESSID=abc_123 ").as_deref(), Some("PHPSESSID=abc_123"));
        assert_eq!(cookie("first=1; PHPSESSID=abc_123; other=2").as_deref(), Some("PHPSESSID=abc_123"));
        assert_eq!(cookie("  "), None);
    }

    // These talk to pixiv: cargo test -- --ignored pixiv
    async fn check_download(id: &str, session: &str) {
        let art = download(id, session).await.unwrap();
        assert!(art.failed.is_empty(), "{:?}", art.failed);
        assert!(!art.images.is_empty());
        for (name, data) in &art.images {
            assert!(name.starts_with(&format!("{id}_p")), "{name}");
            assert!(crate::images::kind(data).is_some(), "{name} is an image");
        }
    }

    #[tokio::test]
    #[ignore]
    async fn downloads_a_public_artwork() {
        check_download("149419985", "").await;
        // R-18, so logged out pixiv hides it.
        assert!(download("141886602", "").await.err().unwrap().contains("Settings → pixiv"));
    }

    // Needs PIXIV_SESSION set to the PHPSESSID of an account with R-18 viewing on.
    #[tokio::test]
    #[ignore]
    async fn downloads_an_r18_artwork() {
        check_download("141886602", &std::env::var("PIXIV_SESSION").expect("set PIXIV_SESSION")).await;
    }

    #[test]
    fn reads_pages() {
        let body = br#"{"error":false,"message":"","body":[
            {"urls":{"original":"https://i.pximg.net/img-original/img/2026/01/01/00/00/00/141886602_p0.png"}},
            {"urls":{"original":"https://i.pximg.net/img-original/img/2026/01/01/00/00/00/141886602_p1.jpg"}}]}"#;
        let urls = page_urls(body, false).unwrap();
        assert_eq!(urls.len(), 2);
        assert_eq!(file_name(&urls[0]), "141886602_p0.png");
        assert_eq!(file_name(&urls[1]), "141886602_p1.jpg");

        let missing = br#"{"error":true,"message":"Work has been deleted or the ID does not exist.","body":[]}"#;
        assert_eq!(page_urls(missing, false).unwrap_err(), "Work has been deleted or the ID does not exist.");
        assert!(page_urls(br#"{"error":false,"body":[]}"#, false).unwrap_err().contains("Settings → pixiv"));
        let hidden = br#"{"error":true,"message":"","body":[]}"#;
        assert!(page_urls(hidden, false).unwrap_err().contains("add your pixiv session"), "logged out, R-18 works come back like this");
        assert!(page_urls(hidden, true).unwrap_err().contains("hasn't expired"));
        assert!(page_urls(b"<html>", false).is_err());
    }
}
