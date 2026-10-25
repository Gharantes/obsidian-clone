use crate::files::{bad_name, err, join_rel, parent_of};
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

// Adds an image to a folder ("" = top level; made if missing) unless one with that name exists.
// Names are unique across folders, so notes embed images by name alone.
pub fn add(db: &Connection, book: &str, folder: &str, name: &str, data: &[u8]) -> Result<(), String> {
    add_folder(db, book, folder)?;
    db.execute("INSERT OR IGNORE INTO images (book, name, folder, data) VALUES (?1, ?2, ?3, ?4)", params![book, name, folder, data]).map_err(err)?;
    Ok(())
}

// `name`, or "Map 1.png", "Map 2.png"... when an image already has it.
fn free_name(db: &Connection, book: &str, name: &str) -> Result<String, String> {
    let (stem, ext) = name.rsplit_once('.').map_or((name, String::new()), |(s, e)| (s, format!(".{e}")));
    let mut candidate = name.to_string();
    for i in 1.. {
        if get(db, book, &candidate)?.is_none() {
            break;
        }
        candidate = format!("{stem} {i}{ext}");
    }
    Ok(candidate)
}

// Adds an image file's bytes to a folder under a free name; returns the name.
pub fn import(db: &Connection, book: &str, folder: &str, file_name: &str, data: &[u8]) -> Result<String, String> {
    let (ext, _) = kind(data).ok_or(format!("\"{file_name}\" is not a PNG, JPEG, GIF or WebP image"))?;
    let name = if is_image_name(file_name) { file_name.to_string() } else { format!("{file_name}.{ext}") };
    let name = free_name(db, book, &name)?;
    if !folder_exists(db, book, folder)? {
        return Err(format!("\"{folder}\" no longer exists"));
    }
    add(db, book, folder, &name, data)?;
    Ok(name)
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
    let mut stmt = db.prepare("SELECT name, folder FROM images WHERE book = ?1 ORDER BY name COLLATE NOCASE").map_err(err)?;
    let images = stmt.query_map([book], |r| Ok((r.get(0)?, r.get(1)?))).map_err(err)?.collect::<Result<_, _>>().map_err(err)?;
    Ok(Listing { folders, images })
}

// Deletes an image, and the book cover if it was that image.
pub fn remove(db: &Connection, book: &str, name: &str) -> Result<(), String> {
    db.execute("DELETE FROM images WHERE book = ?1 AND name = ?2", params![book, name]).map_err(err)?;
    db.execute("UPDATE books SET cover = NULL WHERE id = ?1 AND cover = ?2", params![book, name]).map_err(err)?;
    Ok(())
}

// Moves an image into an existing folder ("" = top level).
pub fn move_to(db: &Connection, book: &str, name: &str, folder: &str) -> Result<(), String> {
    if !folder_exists(db, book, folder)? {
        return Err(format!("\"{folder}\" no longer exists"));
    }
    db.execute("UPDATE images SET folder = ?3 WHERE book = ?1 AND name = ?2", params![book, name, folder]).map_err(err)?;
    Ok(())
}

// Makes folder `name` in `parent`; returns its path.
pub fn create_folder(db: &Connection, book: &str, parent: &str, name: &str) -> Result<String, String> {
    move_folder(db, book, None, parent, name)
}

// Moves and/or renames folder `path` (with everything in it) to `parent`/`name`, or with `path`
// None makes a new folder there. Returns the folder's new path.
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
    let sql = |table: &str, col: &str| format!("UPDATE {table} SET {col} = ?3 || substr({col}, length(?2) + 1) WHERE book = ?1 AND {}", under(col));
    tx.execute(&sql("image_folders", "path"), params![book, from, to]).map_err(err)?;
    tx.execute(&sql("images", "folder"), params![book, from, to]).map_err(err)?;
    tx.commit().map_err(err)?;
    Ok(to)
}

// Deletes a folder, its subfolders and their images; returns the deleted images' names.
pub fn remove_folder(db: &Connection, book: &str, path: &str) -> Result<Vec<String>, String> {
    let tx = db.unchecked_transaction().map_err(err)?;
    let names: Vec<String> = {
        let mut stmt = tx.prepare(&format!("SELECT name FROM images WHERE book = ?1 AND {}", under("folder"))).map_err(err)?;
        let rows = stmt.query_map(params![book, path], |r| r.get(0)).map_err(err)?.collect::<Result<_, _>>().map_err(err)?;
        rows
    };
    for n in &names {
        remove(&tx, book, n)?;
    }
    tx.execute(&format!("DELETE FROM image_folders WHERE book = ?1 AND {}", under("path")), params![book, path]).map_err(err)?;
    tx.commit().map_err(err)?;
    Ok(names)
}

// Renames an image, keeping its extension when the new name has none, and points the notes that
// embed it (![[name]] or ![[name|alt]]) and the book cover at the new name. Returns the new name.
pub fn rename(db: &Connection, book: &str, name: &str, new_name: &str) -> Result<String, String> {
    let mut new_name = new_name.trim().to_string();
    if let Some(bad) = bad_name(&new_name) {
        return Err(bad);
    }
    if !is_image_name(&new_name) {
        if let Some((_, ext)) = name.rsplit_once('.') {
            new_name = format!("{new_name}.{ext}");
        }
    }
    if new_name == name {
        return Ok(new_name);
    }
    if get(db, book, &new_name)?.is_some() {
        return Err(format!("\"{new_name}\" already exists"));
    }
    let tx = db.unchecked_transaction().map_err(err)?;
    if tx.execute("UPDATE images SET name = ?3 WHERE book = ?1 AND name = ?2", params![book, name, new_name]).map_err(err)? == 0 {
        return Err(format!("\"{name}\" no longer exists"));
    }
    tx.execute("UPDATE books SET cover = ?2 WHERE id = ?1 AND cover = ?3", params![book, new_name, name]).map_err(err)?;
    let notes: Vec<(String, String)> = {
        let mut stmt = tx.prepare("SELECT path, text FROM entries WHERE book = ?1 AND text LIKE '%' || ?2 || '%'").map_err(err)?;
        let rows = stmt.query_map(params![book, format!("![[{name}")], |r| Ok((r.get(0)?, r.get(1)?))).map_err(err)?.collect::<Result<_, _>>().map_err(err)?;
        rows
    };
    for (path, text) in notes {
        let text = text.replace(&format!("![[{name}]]"), &format!("![[{new_name}]]")).replace(&format!("![[{name}|"), &format!("![[{new_name}|"));
        tx.execute("UPDATE entries SET text = ?3 WHERE book = ?1 AND path = ?2", params![book, path, text]).map_err(err)?;
    }
    tx.commit().map_err(err)?;
    Ok(new_name)
}

// (folder, name, bytes) of every image.
pub fn all(db: &Connection, book: &str) -> Result<Vec<(String, String, Vec<u8>)>, String> {
    let mut stmt = db.prepare("SELECT folder, name, data FROM images WHERE book = ?1 ORDER BY name").map_err(err)?;
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
    fn rename_updates_embeds_and_cover() {
        let db = &crate::files::tests::test_db();
        add(db, "b", "", "Map.png", b"\x89PNG").unwrap();
        add(db, "b", "", "Other.png", b"\x89PNG").unwrap();
        crate::books::set_cover(db, "b", Some("Map.png")).unwrap();
        crate::files::write(db, "b", "Note.md", "![[Map.png]] and ![[Map.png|alt]], not ![[Map.png.png]]").unwrap();

        assert_eq!(rename(db, "b", "Map.png", "World").unwrap(), "World.png", "keeps the extension");
        assert_eq!(list(db, "b").unwrap().images, [("Other.png".into(), "".into()), ("World.png".into(), "".into())]);
        assert_eq!(crate::files::read(db, "b", "Note.md").unwrap(), "![[World.png]] and ![[World.png|alt]], not ![[Map.png.png]]");
        assert_eq!(crate::books::list(db).unwrap()[0].cover.as_deref(), Some("World.png"));
        assert!(rename(db, "b", "World.png", "Other.png").unwrap_err().contains("already exists"));
        assert!(rename(db, "b", "World.png", "a/b").is_err());
    }

    #[test]
    fn folders() {
        let db = &crate::files::tests::test_db();
        let png = b"\x89PNG";
        let folders = |db| list(db, "b").unwrap().folders;
        let images = |db| list(db, "b").unwrap().images.into_iter().map(|(n, f)| format!("{f}:{n}")).collect::<Vec<_>>();

        assert_eq!(import(db, "b", "", "Map.png", png).unwrap(), "Map.png");
        assert_eq!(import(db, "b", "", "Map.png", png).unwrap(), "Map 1.png", "names stay unique");
        assert_eq!(import(db, "b", "", "photo", png).unwrap(), "photo.png");
        assert!(import(db, "b", "", "notes.png", b"hello").is_err(), "checks the bytes");
        assert!(import(db, "b", "Nope", "x.png", png).is_err());

        assert_eq!(create_folder(db, "b", "", "Maps").unwrap(), "Maps");
        assert_eq!(create_folder(db, "b", "Maps", "Old").unwrap(), "Maps/Old");
        assert!(create_folder(db, "b", "", "maps").unwrap_err().contains("already exists"));
        assert!(create_folder(db, "b", "", "a/b").is_err());
        move_to(db, "b", "Map.png", "Maps/Old").unwrap();
        assert!(move_to(db, "b", "Map 1.png", "Nope").is_err());
        assert_eq!(images(db), [":Map 1.png", "Maps/Old:Map.png", ":photo.png"]);

        assert!(move_folder(db, "b", Some("Maps"), "Maps/Old", "Maps").is_err(), "not into itself");
        assert_eq!(move_folder(db, "b", Some("Maps/Old"), "", "Archive").unwrap(), "Archive");
        assert_eq!(move_folder(db, "b", Some("Maps"), "Archive", "Maps").unwrap(), "Archive/Maps");
        assert_eq!(folders(db), ["Archive", "Archive/Maps"]);
        assert_eq!(images(db), [":Map 1.png", "Archive:Map.png", ":photo.png"]);

        crate::books::set_cover(db, "b", Some("Map.png")).unwrap();
        assert_eq!(remove_folder(db, "b", "Archive").unwrap(), ["Map.png"]);
        assert!(folders(db).is_empty());
        assert_eq!(crate::books::list(db).unwrap()[0].cover, None, "the cover went with it");
        remove(db, "b", "photo.png").unwrap();
        assert_eq!(images(db), [":Map 1.png"]);
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
    }
}
