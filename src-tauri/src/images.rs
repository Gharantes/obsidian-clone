use crate::files::{bad_name, base_name, err, join_rel, parent_of};
use crate::settings::Image;
use base64::Engine;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use tokio_util::sync::CancellationToken;

// Images are known by their path in the Assets folders: "Maps/Map.png", or just "Map.png" at the
// top level. Names are unique within a folder only, and notes embed images by path (![[Maps/Map.png]]).

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

pub fn get(db: &Connection, book: &str, path: &str) -> Result<Option<Vec<u8>>, String> {
    db.query_row("SELECT data FROM images WHERE book = ?1 AND folder = ?2 AND name = ?3", params![book, parent_of(path), base_name(path)], |r| r.get(0))
        .optional()
        .map_err(err)
}

// Adds an image to a folder ("" = top level; made if missing) unless the folder has one with that name.
pub fn add(db: &Connection, book: &str, folder: &str, name: &str, data: &[u8]) -> Result<(), String> {
    add_folder(db, book, folder)?;
    db.execute("INSERT OR IGNORE INTO images (book, name, folder, data) VALUES (?1, ?2, ?3, ?4)", params![book, name, folder, data]).map_err(err)?;
    Ok(())
}

// `name`, or "Map 1.png", "Map 2.png"... when the folder already has an image with it.
fn free_name(db: &Connection, book: &str, folder: &str, name: &str) -> Result<String, String> {
    let (stem, ext) = name.rsplit_once('.').map_or((name, String::new()), |(s, e)| (s, format!(".{e}")));
    let mut candidate = name.to_string();
    for i in 1.. {
        if get(db, book, &join_rel(folder, &candidate))?.is_none() {
            break;
        }
        candidate = format!("{stem} {i}{ext}");
    }
    Ok(candidate)
}

// Adds an image file's bytes to a folder under a name free there; returns the image's path.
pub fn import(db: &Connection, book: &str, folder: &str, file_name: &str, data: &[u8]) -> Result<String, String> {
    let (ext, _) = kind(data).ok_or(format!("\"{file_name}\" is not a PNG, JPEG, GIF or WebP image"))?;
    let name = if is_image_name(file_name) { file_name.to_string() } else { format!("{file_name}.{ext}") };
    if !folder_exists(db, book, folder)? {
        return Err(format!("\"{folder}\" no longer exists"));
    }
    let name = free_name(db, book, folder, &name)?;
    add(db, book, folder, &name, data)?;
    Ok(join_rel(folder, &name))
}

// Adds downloaded images to `folder`/`sub` (made if missing) under their own names, skipping ones
// already there, so importing the same pixiv artwork again doesn't duplicate it; returns the
// images' paths, both new and already present.
pub fn import_into(db: &Connection, book: &str, folder: &str, sub: &str, files: &[(String, Vec<u8>)]) -> Result<Vec<String>, String> {
    if !folder_exists(db, book, folder)? {
        return Err(format!("\"{folder}\" no longer exists"));
    }
    let dest = join_rel(folder, sub);
    add_folder(db, book, &dest)?;
    let mut paths = Vec::new();
    for (name, data) in files {
        let path = join_rel(&dest, name);
        if get(db, book, &path)?.is_none() {
            import(db, book, &dest, name, data)?;
        }
        paths.push(path);
    }
    Ok(paths)
}

// Image folders only organize images (no notes or sections); every folder's parent has a row too.
pub fn add_folder(db: &Connection, book: &str, path: &str) -> Result<(), String> {
    let mut dir = path;
    while !dir.is_empty() {
        db.execute("INSERT OR IGNORE INTO image_folders (book, path) VALUES (?1, ?2)", params![book, dir]).map_err(err)?;
        dir = parent_of(dir);
    }
    Ok(())
}

fn folder_exists(db: &Connection, book: &str, path: &str) -> Result<bool, String> {
    let found = db.query_row("SELECT 1 FROM image_folders WHERE book = ?1 AND path = ?2", params![book, path], |_| Ok(())).optional().map_err(err)?;
    Ok(path.is_empty() || found.is_some())
}

// SQL matching a folder `?2` and everything under it, in column `col`.
fn under(col: &str) -> String {
    format!("({col} = ?2 OR substr({col}, 1, length(?2) + 1) = ?2 || '/')")
}

#[derive(serde::Serialize, Debug, PartialEq)]
pub struct Listing {
    // Folder paths ("A/B"), sorted.
    pub folders: Vec<String>,
    // (name, folder) of every image, sorted by name.
    pub images: Vec<(String, String)>,
}

pub fn list(db: &Connection, book: &str) -> Result<Listing, String> {
    let mut stmt = db.prepare("SELECT path FROM image_folders WHERE book = ?1 ORDER BY path COLLATE NOCASE").map_err(err)?;
    let folders = stmt.query_map([book], |r| r.get(0)).map_err(err)?.collect::<Result<_, _>>().map_err(err)?;
    let mut stmt = db.prepare("SELECT name, folder FROM images WHERE book = ?1 ORDER BY name COLLATE NOCASE, folder").map_err(err)?;
    let images = stmt.query_map([book], |r| Ok((r.get(0)?, r.get(1)?))).map_err(err)?.collect::<Result<_, _>>().map_err(err)?;
    Ok(Listing { folders, images })
}

// Points the embeds in a note's text (![[path]] or ![[path|alt]]) at other images: `map` gives an
// embedded path's replacement, if any. None when nothing changed.
pub fn repoint_text(text: &str, map: &dyn Fn(&str) -> Option<String>) -> Option<String> {
    let (mut out, mut rest, mut changed) = (String::new(), text, false);
    while let Some(i) = rest.find("![[") {
        let body = &rest[i + 3..];
        let Some(end) = body.find("]]") else { break };
        let target = &body[..body[..end].find('|').unwrap_or(end)];
        out.push_str(&rest[..i + 3]);
        match map(target) {
            Some(to) => {
                out.push_str(&to);
                changed = true;
            }
            None => out.push_str(target),
        }
        rest = &body[target.len()..];
    }
    out.push_str(rest);
    changed.then_some(out)
}

// Points the book's notes and cover at images' new paths (old path -> new path), after they moved
// or were renamed.
fn repoint(db: &Connection, book: &str, moves: &HashMap<String, String>) -> Result<(), String> {
    if moves.is_empty() {
        return Ok(());
    }
    let map = |p: &str| moves.get(p).cloned();
    let notes: Vec<(String, String)> = {
        let mut stmt = db.prepare("SELECT path, text FROM entries WHERE book = ?1 AND instr(text, '![[') > 0").map_err(err)?;
        let rows = stmt.query_map([book], |r| Ok((r.get(0)?, r.get(1)?))).map_err(err)?.collect::<Result<_, _>>().map_err(err)?;
        rows
    };
    for (path, text) in notes {
        if let Some(text) = repoint_text(&text, &map) {
            db.execute("UPDATE entries SET text = ?3 WHERE book = ?1 AND path = ?2", params![book, path, text]).map_err(err)?;
        }
    }
    let cover: Option<String> = db.query_row("SELECT cover FROM books WHERE id = ?1", [book], |r| r.get(0)).optional().map_err(err)?.flatten();
    if let Some(to) = cover.as_deref().and_then(map) {
        db.execute("UPDATE books SET cover = ?2 WHERE id = ?1", params![book, to]).map_err(err)?;
    }
    Ok(())
}

// Points embeds and the cover that name an image without its folder (in books made before images
// were known by path, or imported from Obsidian) at the image's path. When several folders have an
// image with that name, the first folder in alphabetical order wins.
pub fn resolve_names(db: &Connection, book: &str) -> Result<(), String> {
    let mut by_name = HashMap::new();
    let mut paths = HashSet::new();
    let mut stmt = db.prepare("SELECT name, folder FROM images WHERE book = ?1 ORDER BY folder DESC").map_err(err)?;
    for row in stmt.query_map([book], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).map_err(err)? {
        let (name, folder) = row.map_err(err)?;
        let path = join_rel(&folder, &name);
        paths.insert(path.clone());
        by_name.insert(name, path);
    }
    drop(stmt);
    let moves = by_name.into_iter().filter(|(name, path)| name != path && !paths.contains(name)).collect();
    repoint(db, book, &moves)
}

// Deletes an image, and the book cover if it was that image.
pub fn remove(db: &Connection, book: &str, path: &str) -> Result<(), String> {
    db.execute("DELETE FROM images WHERE book = ?1 AND folder = ?2 AND name = ?3", params![book, parent_of(path), base_name(path)]).map_err(err)?;
    db.execute("UPDATE books SET cover = NULL WHERE id = ?1 AND cover = ?2", params![book, path]).map_err(err)?;
    Ok(())
}

// Moves an image into an existing folder ("" = top level), renamed "Map 1.png"... when the folder
// has an image with its name. Points notes and the cover at it; returns its new path.
pub fn move_to(db: &Connection, book: &str, path: &str, folder: &str) -> Result<String, String> {
    if !folder_exists(db, book, folder)? {
        return Err(format!("\"{folder}\" no longer exists"));
    }
    if parent_of(path) == folder {
        return Ok(path.to_string());
    }
    let name = free_name(db, book, folder, base_name(path))?;
    let tx = db.unchecked_transaction().map_err(err)?;
    let n = tx
        .execute("UPDATE images SET folder = ?4, name = ?5 WHERE book = ?1 AND folder = ?2 AND name = ?3", params![book, parent_of(path), base_name(path), folder, name])
        .map_err(err)?;
    if n == 0 {
        return Err(format!("\"{path}\" no longer exists"));
    }
    let to = join_rel(folder, &name);
    repoint(&tx, book, &HashMap::from([(path.to_string(), to.clone())]))?;
    tx.commit().map_err(err)?;
    Ok(to)
}

// Makes folder `name` in `parent`; returns its path.
pub fn create_folder(db: &Connection, book: &str, parent: &str, name: &str) -> Result<String, String> {
    move_folder(db, book, None, parent, name)
}

// Moves and/or renames folder `path` (with everything in it) to `parent`/`name`, pointing notes
// and the cover at its images' new paths, or with `path` None makes a new folder there. Returns
// the folder's new path.
pub fn move_folder(db: &Connection, book: &str, path: Option<&str>, parent: &str, name: &str) -> Result<String, String> {
    let name = name.trim();
    if let Some(bad) = bad_name(name) {
        return Err(bad);
    }
    let to = join_rel(parent, name);
    if path == Some(to.as_str()) {
        return Ok(to);
    }
    if path.is_some_and(|p| parent == p || parent.starts_with(&format!("{p}/"))) {
        return Err("A folder can't go inside itself".into());
    }
    if !folder_exists(db, book, parent)? {
        return Err(format!("\"{parent}\" no longer exists"));
    }
    // Case-insensitive, since exported folders land on disk (renaming "maps" to "Maps" is fine).
    let taken = db
        .query_row("SELECT 1 FROM image_folders WHERE book = ?1 AND path = ?2 COLLATE NOCASE AND path != ?3", params![book, to, path.unwrap_or("")], |_| Ok(()))
        .optional()
        .map_err(err)?;
    if taken.is_some() {
        return Err(format!("\"{name}\" already exists"));
    }
    let Some(from) = path else {
        add_folder(db, book, &to)?;
        return Ok(to);
    };
    let tx = db.unchecked_transaction().map_err(err)?;
    let moves: HashMap<String, String> = {
        let mut stmt = tx.prepare(&format!("SELECT folder, name FROM images WHERE book = ?1 AND {}", under("folder"))).map_err(err)?;
        let rows = stmt.query_map(params![book, from], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).map_err(err)?;
        rows.map(|r| r.map(|(f, n)| (join_rel(&f, &n), join_rel(&format!("{to}{}", &f[from.len()..]), &n))))
            .collect::<Result<_, _>>()
            .map_err(err)?
    };
    let sql = |table: &str, col: &str| format!("UPDATE {table} SET {col} = ?3 || substr({col}, length(?2) + 1) WHERE book = ?1 AND {}", under(col));
    tx.execute(&sql("image_folders", "path"), params![book, from, to]).map_err(err)?;
    tx.execute(&sql("images", "folder"), params![book, from, to]).map_err(err)?;
    repoint(&tx, book, &moves)?;
    tx.commit().map_err(err)?;
    Ok(to)
}

// Deletes a folder, its subfolders and their images; returns the deleted images' paths.
pub fn remove_folder(db: &Connection, book: &str, path: &str) -> Result<Vec<String>, String> {
    let tx = db.unchecked_transaction().map_err(err)?;
    let paths: Vec<String> = {
        let mut stmt = tx.prepare(&format!("SELECT folder, name FROM images WHERE book = ?1 AND {} ORDER BY folder, name", under("folder"))).map_err(err)?;
        let rows = stmt.query_map(params![book, path], |r| Ok(join_rel(&r.get::<_, String>(0)?, &r.get::<_, String>(1)?))).map_err(err)?;
        rows.collect::<Result<_, _>>().map_err(err)?
    };
    for p in &paths {
        remove(&tx, book, p)?;
    }
    tx.execute(&format!("DELETE FROM image_folders WHERE book = ?1 AND {}", under("path")), params![book, path]).map_err(err)?;
    tx.commit().map_err(err)?;
    Ok(paths)
}

// Renames an image within its folder, keeping its extension when the new name has none, and
// points the notes that embed it and the book cover at it. Returns its new path.
pub fn rename(db: &Connection, book: &str, path: &str, new_name: &str) -> Result<String, String> {
    let (folder, name) = (parent_of(path), base_name(path));
    let mut new_name = new_name.trim().to_string();
    if let Some(bad) = bad_name(&new_name) {
        return Err(bad);
    }
    if !is_image_name(&new_name) {
        if let Some((_, ext)) = name.rsplit_once('.') {
            new_name = format!("{new_name}.{ext}");
        }
    }
    let to = join_rel(folder, &new_name);
    if new_name == name {
        return Ok(to);
    }
    if get(db, book, &to)?.is_some() {
        return Err(format!("\"{new_name}\" already exists in this folder"));
    }
    let tx = db.unchecked_transaction().map_err(err)?;
    if tx.execute("UPDATE images SET name = ?4 WHERE book = ?1 AND folder = ?2 AND name = ?3", params![book, folder, name, new_name]).map_err(err)? == 0 {
        return Err(format!("\"{path}\" no longer exists"));
    }
    repoint(&tx, book, &HashMap::from([(path.to_string(), to.clone())]))?;
    tx.commit().map_err(err)?;
    Ok(to)
}

// (folder, name, bytes) of every image.
pub fn all(db: &Connection, book: &str) -> Result<Vec<(String, String, Vec<u8>)>, String> {
    let mut stmt = db.prepare("SELECT folder, name, data FROM images WHERE book = ?1 ORDER BY folder, name").map_err(err)?;
    let rows = stmt.query_map([book], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).map_err(err)?.collect::<Result<_, _>>().map_err(err);
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
        // OpenAI-style {"error": {...}}, or Cloudflare's {"errors": [...]}.
        if let Some(msg) = json["error"]["message"].as_str().or(json["errors"][0]["message"].as_str()) {
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

// Reads `result.image` (base64) from a Workers AI response.
pub fn parse_cloudflare(body: &[u8]) -> Result<Vec<u8>, String> {
    let json: Value = serde_json::from_slice(body).map_err(|_| "Cloudflare did not return JSON")?;
    let b64 = json["result"]["image"].as_str().ok_or("Cloudflare returned no image")?;
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
    } else if cfg.provider == "cloudflare" {
        let c = &cfg.cloudflare;
        if c.account_id.is_empty() || c.api_token.is_empty() {
            return Err("Add your Cloudflare account ID and API token in Settings → Images".into());
        }
        // FLUX.2 [klein] takes form fields; sides must be 256-1920.
        let side = |n: u32| n.clamp(256, 1920).to_string();
        let form = reqwest::multipart::Form::new().text("prompt", prompt.to_string()).text("width", side(width)).text("height", side(height));
        let req = client
            .post(format!("https://api.cloudflare.com/client/v4/accounts/{}/ai/run/@cf/black-forest-labs/flux-2-klein-4b", c.account_id))
            .bearer_auth(&c.api_token)
            .multipart(form);
        parse_cloudflare(&fetch(req, cancel).await?)?
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
    fn rename_updates_embeds_and_cover() {
        let db = &crate::files::tests::test_db();
        add(db, "b", "Maps", "Map.png", b"\x89PNG").unwrap();
        add(db, "b", "Maps", "Other.png", b"\x89PNG").unwrap();
        add(db, "b", "", "Map.png", b"\x89PNG").unwrap();
        crate::books::set_cover(db, "b", Some("Maps/Map.png")).unwrap();
        crate::files::write(db, "b", "Note.md", "![[Maps/Map.png]] and ![[Maps/Map.png|alt]], not ![[Map.png]] or ![[Maps/Map.png.png]]").unwrap();

        assert_eq!(rename(db, "b", "Maps/Map.png", "World").unwrap(), "Maps/World.png", "keeps the extension and folder");
        assert_eq!(crate::files::read(db, "b", "Note.md").unwrap(), "![[Maps/World.png]] and ![[Maps/World.png|alt]], not ![[Map.png]] or ![[Maps/Map.png.png]]");
        assert_eq!(crate::books::list(db).unwrap()[0].cover.as_deref(), Some("Maps/World.png"));
        assert!(rename(db, "b", "Maps/World.png", "Other.png").unwrap_err().contains("already exists"));
        assert_eq!(rename(db, "b", "Map.png", "World.png").unwrap(), "World.png", "only the same folder clashes");
        assert!(rename(db, "b", "World.png", "a/b").is_err());
    }

    #[test]
    fn folders() {
        let db = &crate::files::tests::test_db();
        let png = b"\x89PNG";
        let folders = |db| list(db, "b").unwrap().folders;
        let images = |db| list(db, "b").unwrap().images.into_iter().map(|(n, f)| join_rel(&f, &n)).collect::<Vec<_>>();

        assert_eq!(import(db, "b", "", "Map.png", png).unwrap(), "Map.png");
        assert_eq!(import(db, "b", "", "Map.png", png).unwrap(), "Map 1.png", "names stay unique in a folder");
        assert_eq!(import(db, "b", "", "photo", png).unwrap(), "photo.png");
        assert!(import(db, "b", "", "notes.png", b"hello").is_err(), "checks the bytes");
        assert!(import(db, "b", "Nope", "x.png", png).is_err());

        assert_eq!(create_folder(db, "b", "", "Maps").unwrap(), "Maps");
        assert_eq!(create_folder(db, "b", "Maps", "Old").unwrap(), "Maps/Old");
        assert!(create_folder(db, "b", "", "maps").unwrap_err().contains("already exists"));
        assert!(create_folder(db, "b", "", "a/b").is_err());
        assert_eq!(import(db, "b", "Maps/Old", "Map.png", png).unwrap(), "Maps/Old/Map.png", "other folders may have the name");
        crate::files::write(db, "b", "Note.md", "![[Map.png]] ![[Maps/Old/Map.png|x]]").unwrap();
        assert_eq!(move_to(db, "b", "Map.png", "Maps/Old").unwrap(), "Maps/Old/Map 1.png", "renamed when the folder has the name");
        assert_eq!(crate::files::read(db, "b", "Note.md").unwrap(), "![[Maps/Old/Map 1.png]] ![[Maps/Old/Map.png|x]]");
        assert!(move_to(db, "b", "Map 1.png", "Nope").is_err());
        assert_eq!(images(db), ["Map 1.png", "Maps/Old/Map 1.png", "Maps/Old/Map.png", "photo.png"]);

        assert!(move_folder(db, "b", Some("Maps"), "Maps/Old", "Maps").is_err(), "not into itself");
        assert_eq!(move_folder(db, "b", Some("Maps/Old"), "", "Archive").unwrap(), "Archive");
        assert_eq!(crate::files::read(db, "b", "Note.md").unwrap(), "![[Archive/Map 1.png]] ![[Archive/Map.png|x]]", "embeds follow the folder");
        assert_eq!(move_folder(db, "b", Some("Maps"), "Archive", "Maps").unwrap(), "Archive/Maps");
        assert_eq!(folders(db), ["Archive", "Archive/Maps"]);
        assert_eq!(images(db), ["Map 1.png", "Archive/Map 1.png", "Archive/Map.png", "photo.png"]);

        crate::books::set_cover(db, "b", Some("Archive/Map.png")).unwrap();
        assert_eq!(remove_folder(db, "b", "Archive").unwrap(), ["Archive/Map 1.png", "Archive/Map.png"]);
        assert!(folders(db).is_empty());
        assert_eq!(crate::books::list(db).unwrap()[0].cover, None, "the cover went with it");
        remove(db, "b", "photo.png").unwrap();
        assert_eq!(images(db), ["Map 1.png"]);
    }

    #[test]
    fn imports_into_a_subfolder_once() {
        let db = &crate::files::tests::test_db();
        let files = [("1_p0.png".to_string(), b"\x89PNG".to_vec()), ("1_p1.jpg".to_string(), b"\xFF\xD8".to_vec())];
        assert_eq!(import_into(db, "b", "", "1", &files).unwrap(), ["1/1_p0.png", "1/1_p1.jpg"]);
        assert_eq!(import_into(db, "b", "", "1", &files).unwrap(), ["1/1_p0.png", "1/1_p1.jpg"], "no duplicates the second time");
        assert_eq!(list(db, "b").unwrap().images.len(), 2);
        create_folder(db, "b", "", "Art").unwrap();
        assert_eq!(import_into(db, "b", "Art", "1", &files[..1]).unwrap(), ["Art/1/1_p0.png"]);
        assert!(import_into(db, "b", "Nope", "1", &files).is_err());
    }

    #[test]
    fn points_names_at_paths() {
        let db = &crate::files::tests::test_db();
        add(db, "b", "Naruto", "page1.PNG", b"\x89PNG").unwrap();
        add(db, "b", "B", "same.png", b"\x89PNG").unwrap();
        add(db, "b", "A", "same.png", b"\x89PNG").unwrap();
        add(db, "b", "", "top.png", b"\x89PNG").unwrap();
        crate::books::set_cover(db, "b", Some("page1.PNG")).unwrap();
        crate::files::write(db, "b", "Note.md", "![[page1.PNG]] ![[page1.PNG|alt]] ![[same.png]] ![[top.png]] ![[gone.png]] ![[unclosed").unwrap();
        resolve_names(db, "b").unwrap();
        assert_eq!(crate::files::read(db, "b", "Note.md").unwrap(), "![[Naruto/page1.PNG]] ![[Naruto/page1.PNG|alt]] ![[A/same.png]] ![[top.png]] ![[gone.png]] ![[unclosed");
        assert_eq!(crate::books::list(db).unwrap()[0].cover.as_deref(), Some("Naruto/page1.PNG"));
    }

    #[test]
    fn migrates_name_keyed_images() {
        let file = std::env::temp_dir().join(format!("images-migrate-{}.db", crate::books::random(1 << 40)));
        {
            let db = Connection::open(&file).unwrap();
            db.execute_batch(
                "CREATE TABLE books (id TEXT PRIMARY KEY, title TEXT NOT NULL, color TEXT NOT NULL, ts INTEGER NOT NULL, open INTEGER NOT NULL DEFAULT 0, cover TEXT, summary TEXT NOT NULL DEFAULT '');
                CREATE TABLE entries (book TEXT NOT NULL REFERENCES books ON DELETE CASCADE, path TEXT NOT NULL, text TEXT, PRIMARY KEY (book, path));
                CREATE TABLE images (book TEXT NOT NULL REFERENCES books ON DELETE CASCADE, name TEXT NOT NULL, folder TEXT NOT NULL DEFAULT '', data BLOB NOT NULL, PRIMARY KEY (book, name));
                INSERT INTO books VALUES ('b', 'Saga', '#fff', 0, 0, 'page1.PNG', '');
                INSERT INTO entries VALUES ('b', 'Note.md', '![[page1.PNG]]');
                INSERT INTO images VALUES ('b', 'page1.PNG', 'Naruto', X'89504E47');",
            )
            .unwrap();
        }
        let db = &crate::books::open_db(&file).unwrap();
        assert_eq!(crate::files::read(db, "b", "Note.md").unwrap(), "![[Naruto/page1.PNG]]");
        assert_eq!(crate::books::list(db).unwrap()[0].cover.as_deref(), Some("Naruto/page1.PNG"));
        add(db, "b", "", "page1.PNG", b"\x89PNG").unwrap();
        assert_eq!(list(db, "b").unwrap().images.len(), 2, "names now repeat across folders");
        drop(crate::books::open_db(&file).unwrap());
        let _ = std::fs::remove_file(&file);
    }

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

        let cf = json!({ "result": { "image": "iVBORw==" }, "success": true, "errors": [] }).to_string();
        assert_eq!(parse_cloudflare(cf.as_bytes()).unwrap(), b"\x89PNG");
    }
}
