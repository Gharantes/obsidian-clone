use crate::files::{bad_name, err, join_rel, parent_of};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::Path;
use zip::write::SimpleFileOptions;

// Cover settings file in exported zips; the import reads it back.
const META: &str = ".book.json";

pub const COVERS: [&str; 10] =
    ["#7c4dff", "#e5484d", "#f76b15", "#ffc53d", "#30a46c", "#12a594", "#0090ff", "#3e63dd", "#d6409f", "#6f6e77"];

#[derive(Serialize, Debug, PartialEq)]
pub struct Book {
    pub id: String,
    pub title: String,
    pub color: String,
    pub ts: i64,
    pub notes: i64,
}

// Opens the database holding every book and note, creating its tables if needed.
pub fn open_db(file: &Path) -> rusqlite::Result<Connection> {
    let db = Connection::open(file)?;
    db.execute_batch(
        "PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS books (
            id TEXT PRIMARY KEY, title TEXT NOT NULL, color TEXT NOT NULL, ts INTEGER NOT NULL, open INTEGER NOT NULL DEFAULT 0
        );
        -- Folders are rows without text; every entry's parent folder has a row.
        CREATE TABLE IF NOT EXISTS entries (
            book TEXT NOT NULL REFERENCES books ON DELETE CASCADE, path TEXT NOT NULL, text TEXT, PRIMARY KEY (book, path)
        );",
    )?;
    Ok(db)
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

fn random(n: u64) -> u64 {
    use std::hash::{BuildHasher, RandomState};
    RandomState::new().hash_one(0) % n
}

// Most recently opened first.
pub fn list(db: &Connection) -> Result<Vec<Book>, String> {
    let mut stmt = db
        .prepare("SELECT id, title, color, ts, (SELECT count(*) FROM entries WHERE book = id AND text IS NOT NULL) FROM books ORDER BY ts DESC")
        .map_err(err)?;
    let rows = stmt.query_map([], |r| Ok(Book { id: r.get(0)?, title: r.get(1)?, color: r.get(2)?, ts: r.get(3)?, notes: r.get(4)? }));
    let books = rows.map_err(err)?.collect::<Result<_, _>>().map_err(err);
    books
}

pub fn title(db: &Connection, id: &str) -> Result<String, String> {
    db.query_row("SELECT title FROM books WHERE id = ?1", [id], |r| r.get(0)).optional().map_err(err)?.ok_or_else(|| "Book not found".into())
}

// Ids of the books that were open in a window when the app last quit.
pub fn open_ids(db: &Connection) -> rusqlite::Result<Vec<String>> {
    db.prepare("SELECT id FROM books WHERE open")?.query_map([], |r| r.get(0))?.collect()
}

// Marks a book as shown in a window; opening it also makes it the most recent.
pub fn set_open(db: &Connection, id: &str, open: bool) -> Result<(), String> {
    db.execute("UPDATE books SET open = ?2, ts = CASE WHEN ?2 THEN ?3 ELSE ts END WHERE id = ?1", params![id, open, now_ms()]).map_err(err)?;
    Ok(())
}

// Creates an empty book; returns its id or an error message.
pub fn create(db: &Connection, title: &str, color: Option<&str>) -> Result<String, String> {
    let title = title.trim();
    if let Some(bad) = bad_name(title) {
        return Err(bad);
    }
    let id = format!("{:016x}", random(u64::MAX));
    let color = color.unwrap_or(COVERS[random(COVERS.len() as u64) as usize]);
    db.execute("INSERT INTO books (id, title, color, ts) VALUES (?1, ?2, ?3, ?4)", params![id, title, color, now_ms()]).map_err(err)?;
    Ok(id)
}

pub fn rename(db: &Connection, id: &str, title: &str) -> Result<(), String> {
    let title = title.trim();
    if let Some(bad) = bad_name(title) {
        return Err(bad);
    }
    db.execute("UPDATE books SET title = ?2 WHERE id = ?1", params![id, title]).map_err(err)?;
    Ok(())
}

pub fn set_color(db: &Connection, id: &str, color: &str) -> Result<(), String> {
    db.execute("UPDATE books SET color = ?2 WHERE id = ?1", params![id, color]).map_err(err)?;
    Ok(())
}

// Deletes a book and all its notes.
pub fn remove(db: &Connection, id: &str) -> Result<(), String> {
    db.execute("DELETE FROM books WHERE id = ?1", [id]).map_err(err)?;
    Ok(())
}

// Paths are book-relative; folders have no text.
type Entries = Vec<(String, Option<String>)>;

fn color_of(meta: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(meta).ok()?["color"].as_str().map(String::from)
}

// Creates a book from imported entries, adding any missing parent folders. Returns its id.
fn import(db: &Connection, title: &str, color: Option<String>, entries: Entries) -> Result<String, String> {
    let tx = db.unchecked_transaction().map_err(err)?;
    let id = create(&tx, title, color.as_deref())?;
    let mut add = tx.prepare("INSERT OR IGNORE INTO entries (book, path, text) VALUES (?1, ?2, ?3)").map_err(err)?;
    for (path, text) in &entries {
        let mut dir = parent_of(path);
        let mut parents = Vec::new();
        while !dir.is_empty() {
            parents.push(dir);
            dir = parent_of(dir);
        }
        for p in parents.iter().rev() {
            add.execute(params![id, p, None::<String>]).map_err(err)?;
        }
        add.execute(params![id, path, text]).map_err(err)?;
    }
    drop(add);
    tx.commit().map_err(err)?;
    Ok(id)
}

// shortcut: only folders and .md notes are imported (images and other files are skipped).
fn walk(root: &Path, dir: &str, out: &mut Entries) -> std::io::Result<()> {
    for d in fs::read_dir(root.join(dir))? {
        let d = d?;
        let name = d.file_name().to_string_lossy().into_owned();
        let path = join_rel(dir, &name);
        if name.starts_with('.') {
            continue;
        }
        if d.file_type()?.is_dir() {
            out.push((path.clone(), None));
            walk(root, &path, out)?;
        } else if let Some(text) = name.ends_with(".md").then(|| fs::read_to_string(d.path()).ok()).flatten() {
            out.push((path, Some(text)));
        }
    }
    Ok(())
}

// Copies a folder's notes into a new book named after the folder. Returns its id.
pub fn import_folder(db: &Connection, dir: &Path) -> Result<String, String> {
    let mut entries = Vec::new();
    walk(dir, "", &mut entries).map_err(err)?;
    let color = fs::read_to_string(dir.join(META)).ok().and_then(|m| color_of(&m));
    let title = dir.file_name().map_or("Imported".into(), |n| n.to_string_lossy());
    import(db, &title, color, entries)
}

// Same as import_folder for a .zip (e.g. one made by export_zip).
pub fn import_zip(db: &Connection, file: &Path) -> Result<String, String> {
    let mut zip = zip::ZipArchive::new(File::open(file).map_err(err)?).map_err(err)?;
    let (mut entries, mut color) = (Vec::new(), None);
    for i in 0..zip.len() {
        let mut f = zip.by_index(i).map_err(err)?;
        let Some(name) = f.enclosed_name() else { continue };
        let path = name.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/");
        let mut text = String::new();
        if path == META {
            color = f.read_to_string(&mut text).ok().and_then(|_| color_of(&text));
        } else if path.is_empty() || path.split('/').any(|p| p.starts_with('.')) {
            continue;
        } else if f.is_dir() {
            entries.push((path, None));
        } else if path.ends_with(".md") && f.read_to_string(&mut text).is_ok() {
            entries.push((path, Some(text)));
        }
    }
    let title = file.file_stem().map_or("Imported".into(), |n| n.to_string_lossy());
    import(db, &title, color, entries)
}

// Writes a book as a .zip of its folders and .md notes, plus its cover color in .book.json.
pub fn export_zip(db: &Connection, id: &str, file: &Path) -> Result<(), String> {
    let color: String = db.query_row("SELECT color FROM books WHERE id = ?1", [id], |r| r.get(0)).map_err(err)?;
    let mut stmt = db.prepare("SELECT path, text FROM entries WHERE book = ?1 ORDER BY path").map_err(err)?;
    let entries: Entries = stmt.query_map([id], |r| Ok((r.get(0)?, r.get(1)?))).map_err(err)?.collect::<Result<_, _>>().map_err(err)?;

    let mut zip = zip::ZipWriter::new(File::create(file).map_err(err)?);
    let opts = SimpleFileOptions::default();
    zip.start_file(META, opts).map_err(err)?;
    zip.write_all(serde_json::json!({ "color": color }).to_string().as_bytes()).map_err(err)?;
    for (path, text) in entries {
        match text {
            None => zip.add_directory(path, opts).map_err(err)?,
            Some(t) => {
                zip.start_file(path, opts).map_err(err)?;
                zip.write_all(t.as_bytes()).map_err(err)?;
            }
        }
    }
    zip.finish().map_err(err)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::files::{self, tests::test_db};

    fn temp_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("books-{:016x}", random(u64::MAX)));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn books() {
        let db = &test_db();
        let id = create(db, "  My Novel ", Some("#123456")).unwrap();
        assert!(create(db, "a/b", None).is_err(), "no path separators");
        assert_eq!(title(db, &id).unwrap(), "My Novel");

        rename(db, &id, "Saga").unwrap();
        set_color(db, &id, "#abcdef").unwrap();
        set_open(db, &id, true).unwrap();
        assert_eq!(open_ids(db).unwrap(), [id.clone()]);
        files::write(db, &id, "Intro.md", "hi").unwrap();
        let first = &list(db).unwrap()[0];
        assert_eq!((first.title.as_str(), first.color.as_str(), first.notes), ("Saga", "#abcdef", 1), "most recently opened first");

        remove(db, &id).unwrap();
        assert!(title(db, &id).is_err());
        assert!(files::read(db, &id, "Intro.md").is_err(), "notes go with the book");
    }

    #[test]
    fn import_and_export() {
        let db = &test_db();
        let dir = temp_dir().join("Old Book");
        fs::create_dir_all(dir.join("Part 1/Scenes")).unwrap();
        fs::write(dir.join(META), r##"{"color":"#123456"}"##).unwrap();
        for f in ["Part 1/Part 1.md", "Part 1/Scenes/Scene.md", "Intro.md", "image.png", ".hidden.md"] {
            fs::write(dir.join(f), f).unwrap();
        }

        let id = import_folder(db, &dir).unwrap();
        let book = list(db).unwrap().into_iter().find(|b| b.id == id).unwrap();
        assert_eq!((book.title.as_str(), book.color.as_str(), book.notes), ("Old Book", "#123456", 3), "skips images and dot-files");

        let zip = dir.with_extension("zip");
        export_zip(db, &id, &zip).unwrap();
        let copy = import_zip(db, &zip).unwrap();
        assert_eq!(files::list_tree(db, &copy), files::list_tree(db, &id), "round-trips the tree");
        assert_eq!(files::read(db, &copy, "Part 1/Scenes/Scene.md").unwrap(), "Part 1/Scenes/Scene.md");
        assert_eq!(title(db, &copy).unwrap(), "Old Book");
    }
}
