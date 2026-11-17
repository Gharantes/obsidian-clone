use crate::files::err;
use serde_json::Value;
use std::time::Duration;

// Downloads a Reddit post's images (a single image, a gallery, or images inline in a text post)
// through the post's .json view. Reddit blocks logged-out requests from scripts ("blocked by
// network security") and hides NSFW posts from them, so this sends the reddit_session cookie of
// the user's account.

// Reddit turns away clients that don't look like a browser.
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

// The post id in a Reddit link ("https://www.reddit.com/r/pics/comments/1urq4lt/some_title/",
// "https://redd.it/1urq4lt") or on its own ("1urq4lt"). Share links ("/r/pics/s/AbC123") carry
// no id; `download` follows them first.
pub fn post_id(link: &str) -> Option<String> {
    let link = link.trim();
    let id = |s: &str| {
        let d: String = s.chars().take_while(char::is_ascii_alphanumeric).collect();
        (!d.is_empty()).then(|| d.to_ascii_lowercase())
    };
    if (5..=10).contains(&link.len()) && link.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Some(link.to_ascii_lowercase());
    }
    if let Some((_, rest)) = link.split_once("redd.it/") {
        return id(rest);
    }
    if !link.contains("reddit.com") {
        return None;
    }
    link.split_once("/comments/").and_then(|(_, rest)| id(rest))
}

fn is_share_link(link: &str) -> bool {
    link.contains("reddit.com/") && link.contains("/s/")
}

// The value for the Cookie header from what the user pasted: the bare reddit_session value, or a
// whole cookie string ("reddit_session=...; token_v2=..."), sent as it is. None when empty.
pub fn cookie(session: &str) -> Option<String> {
    let s = session.trim().trim_start_matches("Cookie:").trim();
    if s.is_empty() {
        None
    } else if s.contains('=') {
        Some(s.to_string())
    } else {
        Some(format!("reddit_session={s}"))
    }
}

// The extension for a media_metadata "m" type ("image/jpg" -> "jpg").
fn ext_of(mime: &str) -> Option<&str> {
    match mime.strip_prefix("image/")? {
        "jpg" | "jpeg" => Some("jpg"),
        e @ ("png" | "gif" | "webp") => Some(e),
        _ => None,
    }
}

// The original-size i.redd.it URL of a media_metadata entry, or None for videos and failed uploads.
fn media_url(meta: &Value, media_id: &str) -> Option<String> {
    if meta["status"].as_str().is_some_and(|s| s != "valid") {
        return None;
    }
    let ext = ext_of(meta["m"].as_str()?)?;
    Some(format!("https://i.redd.it/{media_id}.{ext}"))
}

fn is_image_url(url: &str) -> bool {
    let path = url.split(['?', '#']).next().unwrap_or_default().to_ascii_lowercase();
    crate::images::IMAGE_EXTS.iter().any(|e| path.ends_with(&format!(".{e}")))
}

// The image URLs of a post from its .json response, in the post's order.
pub fn image_urls(body: &[u8], logged_in: bool) -> Result<Vec<String>, String> {
    let blocked = || {
        if logged_in {
            "Reddit didn't return the post. Check that the session in Settings → Reddit hasn't expired (log in again and paste a new one).".to_string()
        } else {
            "Reddit blocks downloads without a login. Add your Reddit session in Settings → Reddit.".to_string()
        }
    };
    let json: Value = serde_json::from_slice(body).map_err(|_| blocked())?;
    let mut post = &json[0]["data"]["children"][0]["data"];
    if post.is_null() {
        return Err(json["message"].as_str().map_or_else(|| "Reddit didn't return the post (the link may be wrong)".into(), |m| format!("Reddit answered: {m}")));
    }
    // A crosspost's images are on the original post.
    if let Some(original) = post["crosspost_parent_list"].as_array().and_then(|l| l.first()) {
        post = original;
    }
    let meta = &post["media_metadata"];
    let mut urls: Vec<String> = Vec::new();
    if let Some(items) = post["gallery_data"]["items"].as_array() {
        urls.extend(items.iter().filter_map(|i| i["media_id"].as_str()).filter_map(|id| media_url(&meta[id], id)));
    } else if let Some(all) = meta.as_object() {
        // Images inline in a text post: ordered by where they appear in its text.
        let text = post["selftext"].as_str().unwrap_or_default();
        let mut found: Vec<(usize, String)> = all.iter().filter_map(|(id, m)| media_url(m, id).map(|u| (text.find(id.as_str()).unwrap_or(usize::MAX), u))).collect();
        found.sort();
        urls.extend(found.into_iter().map(|(_, u)| u));
    }
    if urls.is_empty() {
        let url = post["url_overridden_by_dest"].as_str().or(post["url"].as_str()).unwrap_or_default();
        if is_image_url(url) {
            urls.push(url.to_string());
        }
    }
    if urls.is_empty() {
        return Err(if post["is_video"].as_bool() == Some(true) {
            "This is a Reddit video post; only images can be downloaded.".into()
        } else if let Some(domain) = post["domain"].as_str().filter(|d| !d.starts_with("self.") && !d.contains("redd")) {
            format!("This post links to {domain}, which isn't a Reddit-hosted image.")
        } else {
            "This post has no images.".into()
        });
    }
    Ok(urls)
}

fn send_error(e: reqwest::Error) -> String {
    let why = std::error::Error::source(&e).map_or(e.to_string(), |s| s.to_string());
    format!("Could not reach Reddit ({why})")
}

// A post's images as (file name, bytes), in order; `failed` lists images that didn't download.
pub struct Post {
    pub id: String,
    pub images: Vec<(String, Vec<u8>)>,
    pub failed: Vec<String>,
}

pub async fn download(link: &str, session: &str) -> Result<Post, String> {
    let client = reqwest::Client::builder().user_agent(USER_AGENT).build().map_err(err)?;
    let cookie = cookie(session);
    let with_cookie = |req: reqwest::RequestBuilder| match &cookie {
        Some(c) => req.header("cookie", c),
        None => req,
    };
    let id = match post_id(link) {
        Some(id) => id,
        None if is_share_link(link) => {
            let res = with_cookie(client.get(link.trim())).timeout(Duration::from_secs(30)).send().await.map_err(send_error)?;
            post_id(res.url().as_str()).ok_or("Couldn't follow that Reddit share link; open it in the browser and copy the post's full link instead")?
        }
        None => return Err("That isn't a Reddit post link, like https://www.reddit.com/r/pics/comments/1urq4lt/".into()),
    };
    let url = format!("https://www.reddit.com/comments/{id}.json?raw_json=1");
    let res = with_cookie(client.get(&url)).header("accept", "application/json").timeout(Duration::from_secs(60)).send().await.map_err(send_error)?;
    let status = res.status();
    let body = res.bytes().await.map_err(err)?;
    if status == reqwest::StatusCode::NOT_FOUND && !body.starts_with(b"[") {
        return Err("Reddit has no post with that link (it may have been deleted)".into());
    }
    let urls = image_urls(&body, cookie.is_some())?;
    let width = urls.len().to_string().len().max(2);
    let (mut images, mut failed) = (Vec::new(), Vec::new());
    for (i, url) in urls.iter().enumerate() {
        let ext = url.split(['?', '#']).next().unwrap_or_default().rsplit('.').next().unwrap_or("jpg").to_ascii_lowercase();
        let name = format!("{id}_{:0width$}.{ext}", i + 1);
        // i.redd.it answers browsers asking for HTML with a page around the image, so ask for the image.
        let got = async {
            let res = client.get(url).header("accept", "image/*").timeout(Duration::from_secs(120)).send().await.map_err(send_error)?;
            let status = res.status();
            let data = res.bytes().await.map_err(err)?;
            if !status.is_success() {
                return Err(format!("Reddit answered {status}"));
            }
            if crate::images::kind(&data).is_none() {
                return Err("Reddit didn't send an image".to_string());
            }
            Ok(data.to_vec())
        };
        match got.await {
            Ok(data) => images.push((name, data)),
            Err(e) => failed.push(format!("\"{name}\": {e}")),
        }
    }
    Ok(Post { id, images, failed })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_post_ids() {
        assert_eq!(post_id("https://www.reddit.com/r/pics/comments/1urq4lt/some_title/").as_deref(), Some("1urq4lt"));
        assert_eq!(post_id("https://old.reddit.com/r/pics/comments/1urq4lt").as_deref(), Some("1urq4lt"));
        assert_eq!(post_id("reddit.com/comments/1urq4lt/?utm_source=share").as_deref(), Some("1urq4lt"));
        assert_eq!(post_id("https://redd.it/1urq4lt").as_deref(), Some("1urq4lt"));
        assert_eq!(post_id(" 1urq4lt ").as_deref(), Some("1urq4lt"));
        assert_eq!(post_id("https://www.reddit.com/r/pics/s/AbC123"), None);
        assert!(is_share_link("https://www.reddit.com/r/pics/s/AbC123"));
        assert_eq!(post_id("https://www.reddit.com/r/pics/"), None);
        assert_eq!(post_id("https://example.com/comments/1urq4lt"), None);
        assert_eq!(post_id(""), None);
    }

    #[test]
    fn builds_the_cookie() {
        assert_eq!(cookie("eyJhbGc.x").as_deref(), Some("reddit_session=eyJhbGc.x"));
        assert_eq!(cookie(" reddit_session=abc; token_v2=def ").as_deref(), Some("reddit_session=abc; token_v2=def"));
        assert_eq!(cookie("Cookie: a=1").as_deref(), Some("a=1"));
        assert_eq!(cookie("  "), None);
    }

    fn listing(post: &str) -> Vec<u8> {
        format!(r#"[{{"kind":"Listing","data":{{"children":[{{"kind":"t3","data":{post}}}]}}}},{{"kind":"Listing","data":{{"children":[]}}}}]"#).into_bytes()
    }

    #[test]
    fn reads_galleries_in_order() {
        let post = r#"{"is_gallery":true,"gallery_data":{"items":[{"media_id":"bbb","id":1},{"media_id":"aaa","id":2},{"media_id":"vid","id":3}]},
            "media_metadata":{"aaa":{"status":"valid","e":"Image","m":"image/png"},"bbb":{"status":"valid","e":"Image","m":"image/jpg"},
            "vid":{"status":"valid","e":"RedditVideo"}}}"#;
        assert_eq!(image_urls(&listing(post), true).unwrap(), ["https://i.redd.it/bbb.jpg", "https://i.redd.it/aaa.png"]);
    }

    #[test]
    fn reads_inline_images_in_text_order() {
        let post = r#"{"selftext":"first ![img](zzz) then ![img](aaa)","media_metadata":{"aaa":{"status":"valid","m":"image/gif"},"zzz":{"status":"valid","m":"image/webp"}}}"#;
        assert_eq!(image_urls(&listing(post), true).unwrap(), ["https://i.redd.it/zzz.webp", "https://i.redd.it/aaa.gif"]);
    }

    #[test]
    fn reads_single_images_and_crossposts() {
        assert_eq!(image_urls(&listing(r#"{"url_overridden_by_dest":"https://i.redd.it/abc.jpeg","domain":"i.redd.it"}"#), true).unwrap(), ["https://i.redd.it/abc.jpeg"]);
        let cross = r#"{"url":"https://www.reddit.com/r/a/comments/x/","crosspost_parent_list":[{"url":"https://i.redd.it/orig.png"}]}"#;
        assert_eq!(image_urls(&listing(cross), true).unwrap(), ["https://i.redd.it/orig.png"]);
    }

    #[test]
    fn explains_posts_without_images() {
        assert!(image_urls(&listing(r#"{"is_video":true,"domain":"v.redd.it"}"#), true).unwrap_err().contains("video"));
        assert!(image_urls(&listing(r#"{"url":"https://youtube.com/watch?v=1","domain":"youtube.com"}"#), true).unwrap_err().contains("youtube.com"));
        assert!(image_urls(&listing(r#"{"domain":"self.pics","selftext":"hi"}"#), true).unwrap_err().contains("no images"));
        assert!(image_urls(b"<body>blocked by network security</body>", false).unwrap_err().contains("Settings → Reddit"));
        assert!(image_urls(b"<html>", true).unwrap_err().contains("expired"));
    }

    // Talks to Reddit: REDDIT_SESSION=... REDDIT_POST=<link> cargo test -- --ignored reddit
    #[tokio::test]
    #[ignore]
    async fn downloads_a_post() {
        let post = download(&std::env::var("REDDIT_POST").expect("set REDDIT_POST"), &std::env::var("REDDIT_SESSION").expect("set REDDIT_SESSION")).await.unwrap();
        assert!(post.failed.is_empty(), "{:?}", post.failed);
        assert!(!post.images.is_empty());
        for (name, data) in &post.images {
            assert!(crate::images::kind(data).is_some(), "{name} is an image");
        }
    }
}
