use crate::files::{bad_name, base_name, err, join_rel, parent_of};
use crate::images;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::Path;
use zip::write::SimpleFileOptions;

// Cover settings file in exported zips; the import reads it back.
const META: &str = ".book.json";
// Folder that holds a book's images in exported zips.
const ATTACHMENTS: &str = "attachments";

pub const COVERS: [&str; 10] =
    ["#7c4dff", "#e5484d", "#f76b15", "#ffc53d", "#30a46c", "#12a594", "#0090ff", "#3e63dd", "#d6409f", "#6f6e77"];

#[derive(Serialize, Debug, PartialEq)]
pub struct Book {
    pub id: String,
    pub title: String,
    pub color: String,
    pub ts: i64,
    pub notes: i64,
    // Path of the cover image, if the book has one.
    pub cover: Option<String>,
    pub summary: String,
    // The Tags page's list, in the order it was made.
    pub tags: Vec<Tag>,
    // The library section the book is in; None for the top of the library.
    pub section: Option<String>,
}

// A named group of books in the library.
#[derive(Serialize, Debug, PartialEq)]
pub struct Section {
    pub id: String,
    pub title: String,
}

#[derive(Serialize, Deserialize, Debug, PartialEq, Clone)]
pub struct Tag {
    pub name: String,
    // One of COVERS.
    pub color: String,
}

// Reads a JSON list of tags. Tags saved before they had colors were plain names; those get the
// palette's colors in turn.
fn parse_tags(json: &serde_json::Value) -> Vec<Tag> {
    let Some(list) = json.as_array() else { return Vec::new() };
    list.iter()
        .enumerate()
        .filter_map(|(i, t)| match t.as_str() {
            Some(name) => Some(Tag { name: name.into(), color: COVERS[i % COVERS.len()].into() }),
            None => serde_json::from_value(t.clone()).ok(),
        })
        .collect()
}

// Opens the database holding every book and note, creating its tables if needed.
pub fn open_db(file: &Path) -> rusqlite::Result<Connection> {
    let db = Connection::open(file)?;
    db.execute_batch(
        "PRAGMA foreign_keys = ON;
        -- Named groups of books in the library, in `pos` order.
        CREATE TABLE IF NOT EXISTS sections (id TEXT PRIMARY KEY, title TEXT NOT NULL, pos INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS books (
            id TEXT PRIMARY KEY, title TEXT NOT NULL, color TEXT NOT NULL, ts INTEGER NOT NULL, open INTEGER NOT NULL DEFAULT 0
        );
        -- Folders are rows without text; every entry's parent folder has a row.
        CREATE TABLE IF NOT EXISTS entries (
            book TEXT NOT NULL REFERENCES books ON DELETE CASCADE, path TEXT NOT NULL, text TEXT, PRIMARY KEY (book, path)
        );
        -- Images embedded in notes as ![[folder/name]], and book covers. `folder` is a row of
        -- image_folders, or '' for the top level.
        CREATE TABLE IF NOT EXISTS images (
            book TEXT NOT NULL REFERENCES books ON DELETE CASCADE, name TEXT NOT NULL, folder TEXT NOT NULL DEFAULT '', data BLOB NOT NULL,
            PRIMARY KEY (book, folder, name)
        );
        -- Folders that organize images, apart from the notes' folders; every folder's parent has a row.
        CREATE TABLE IF NOT EXISTS image_folders (
            book TEXT NOT NULL REFERENCES books ON DELETE CASCADE, path TEXT NOT NULL, PRIMARY KEY (book, path)
        );
        -- AI chats; `turns` is the JSON list of messages.
        CREATE TABLE IF NOT EXISTS chats (
            book TEXT NOT NULL REFERENCES books ON DELETE CASCADE, id TEXT NOT NULL, title TEXT NOT NULL, ts INTEGER NOT NULL,
            turns TEXT NOT NULL, PRIMARY KEY (book, id)
        );",
    )?;
    // Databases made before covers lack the column.
    if db.prepare("SELECT cover FROM books LIMIT 0").is_err() {
        db.execute_batch("ALTER TABLE books ADD COLUMN cover TEXT")?;
    }
    // And before summaries.
    if db.prepare("SELECT summary FROM books LIMIT 0").is_err() {
        db.execute_batch("ALTER TABLE books ADD COLUMN summary TEXT NOT NULL DEFAULT ''")?;
    }
    // And before tags (a JSON list; see parse_tags).
    if db.prepare("SELECT tags FROM books LIMIT 0").is_err() {
        db.execute_batch("ALTER TABLE books ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'")?;
    }
    // And before the library's order, which was most recently opened first.
    if db.prepare("SELECT pos FROM books LIMIT 0").is_err() {
        db.execute_batch(
            "ALTER TABLE books ADD COLUMN pos INTEGER NOT NULL DEFAULT 0;
            UPDATE books SET pos = (SELECT COUNT(*) FROM books AS b WHERE b.ts > books.ts OR (b.ts = books.ts AND b.id < books.id));",
        )?;
    }
    // And before sections.
    if db.prepare("SELECT section FROM books LIMIT 0").is_err() {
        db.execute_batch("ALTER TABLE books ADD COLUMN section TEXT REFERENCES sections ON DELETE SET NULL")?;
    }
    // And before image folders.
    if db.prepare("SELECT folder FROM images LIMIT 0").is_err() {
        db.execute_batch("ALTER TABLE images ADD COLUMN folder TEXT NOT NULL DEFAULT ''")?;
    }
    // And before images were known by path: names were unique across folders, and notes and covers
    // named images without their folder.
    let keyed: i64 = db.query_row("SELECT pk FROM pragma_table_info('images') WHERE name = 'folder'", [], |r| r.get(0))?;
    if keyed == 0 {
        let tx = db.unchecked_transaction()?;
        tx.execute_batch(
            "CREATE TABLE images_by_path (
                book TEXT NOT NULL REFERENCES books ON DELETE CASCADE, name TEXT NOT NULL, folder TEXT NOT NULL DEFAULT '', data BLOB NOT NULL,
                PRIMARY KEY (book, folder, name)
            );
            INSERT INTO images_by_path SELECT book, name, folder, data FROM images;
            DROP TABLE images;
            ALTER TABLE images_by_path RENAME TO images;",
        )?;
        let ids: Vec<String> = tx.prepare("SELECT id FROM books")?.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
        for id in ids {
            images::resolve_names(&tx, &id).map_err(|e| rusqlite::Error::ToSqlConversionFailure(e.into()))?;
        }
        tx.commit()?;
    }
    // Folders used to come with a folder note ("A/A.md") that opened as a page of sections. Now
    // folders only organize notes: the empty folder notes every folder got go, and those with text
    // stay as ordinary notes, without the section marker lines.
    if db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))? < 1 {
        let tx = db.unchecked_transaction()?;
        let notes: Vec<(String, String, String)> = tx
            .prepare("SELECT book, path, text FROM entries WHERE text IS NOT NULL")?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<rusqlite::Result<_>>()?;
        for (book, path, text) in notes {
            let folder = parent_of(&path);
            if folder.is_empty() || base_name(&path) != format!("{}.md", base_name(folder)) {
                continue;
            }
            let text = strip_section_markers(&text);
            if text.trim().is_empty() {
                tx.execute("DELETE FROM entries WHERE book = ?1 AND path = ?2", params![book, path])?;
            } else {
                tx.execute("UPDATE entries SET text = ?3 WHERE book = ?1 AND path = ?2", params![book, path, text])?;
            }
        }
        tx.execute_batch("PRAGMA user_version = 1")?;
        tx.commit()?;
    }
    Ok(db)
}

// A folder note's text without its "<!-- section: text -->" / "<!-- section: index -->" lines.
fn strip_section_markers(text: &str) -> String {
    let marker = |l: &str| l == "<!-- section: text -->" || l == "<!-- section: index -->";
    text.split('\n').filter(|l| !marker(l)).collect::<Vec<_>>().join("\n").trim_start_matches('\n').to_string()
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

pub fn random(n: u64) -> u64 {
    use std::hash::{BuildHasher, RandomState};
    RandomState::new().hash_one(0) % n
}

const SELECT_BOOK: &str = "SELECT id, title, color, ts, (SELECT count(*) FROM entries WHERE book = id AND text IS NOT NULL), cover, summary, tags, section FROM books";

fn book_row(r: &rusqlite::Row) -> rusqlite::Result<Book> {
    Ok(Book { id: r.get(0)?, title: r.get(1)?, color: r.get(2)?, ts: r.get(3)?, notes: r.get(4)?, cover: r.get(5)?, summary: r.get(6)?, tags: parse_tags(&serde_json::from_str(&r.get::<_, String>(7)?).unwrap_or_default()), section: r.get(8)? })
}

// In the library's order (see reorder); new books come first.
pub fn list(db: &Connection) -> Result<Vec<Book>, String> {
    let mut stmt = db.prepare(&format!("{SELECT_BOOK} ORDER BY pos, ts DESC")).map_err(err)?;
    let books = stmt.query_map([], book_row).map_err(err)?.collect::<Result<_, _>>().map_err(err);
    books
}

pub fn get(db: &Connection, id: &str) -> Result<Book, String> {
    db.query_row(&format!("{SELECT_BOOK} WHERE id = ?1"), [id], book_row).optional().map_err(err)?.ok_or_else(|| "Book not found".into())
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
    db.execute(
        "INSERT INTO books (id, title, color, ts, pos) VALUES (?1, ?2, ?3, ?4, (SELECT COALESCE(MIN(pos), 0) - 1 FROM books))",
        params![id, title, color, now_ms()],
    )
    .map_err(err)?;
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

pub fn set_summary(db: &Connection, id: &str, summary: &str) -> Result<(), String> {
    db.execute("UPDATE books SET summary = ?2 WHERE id = ?1", params![id, summary]).map_err(err)?;
    Ok(())
}

pub fn set_tags(db: &Connection, id: &str, tags: &[Tag]) -> Result<(), String> {
    db.execute("UPDATE books SET tags = ?2 WHERE id = ?1", params![id, serde_json::to_string(tags).map_err(err)?]).map_err(err)?;
    Ok(())
}

// Sets the cover image (the path of one of the book's images), or None for the plain color cover.
pub fn set_cover(db: &Connection, id: &str, name: Option<&str>) -> Result<(), String> {
    db.execute("UPDATE books SET cover = ?2 WHERE id = ?1", params![id, name]).map_err(err)?;
    Ok(())
}

// Puts `ids` in `section` (None: the top of the library) in that order, first to last; other books
// keep their places after them.
pub fn reorder(db: &Connection, section: Option<&str>, ids: &[String]) -> Result<(), String> {
    let tx = db.unchecked_transaction().map_err(err)?;
    let n = ids.len() as i64;
    tx.execute("UPDATE books SET pos = pos + ?1", [n]).map_err(err)?;
    for (i, id) in ids.iter().enumerate() {
        tx.execute("UPDATE books SET pos = ?2, section = ?3 WHERE id = ?1", params![id, i as i64, section]).map_err(err)?;
    }
    tx.commit().map_err(err)
}

pub fn sections(db: &Connection) -> Result<Vec<Section>, String> {
    let mut stmt = db.prepare("SELECT id, title FROM sections ORDER BY pos").map_err(err)?;
    let sections = stmt.query_map([], |r| Ok(Section { id: r.get(0)?, title: r.get(1)? })).map_err(err)?.collect::<Result<_, _>>().map_err(err);
    sections
}

fn section_title(title: &str) -> Result<&str, String> {
    let title = title.trim();
    if title.is_empty() { Err("Give the section a name".into()) } else { Ok(title) }
}

// Adds an empty section after the others; returns its id.
pub fn create_section(db: &Connection, title: &str) -> Result<String, String> {
    let title = section_title(title)?;
    let id = format!("{:016x}", random(u64::MAX));
    db.execute("INSERT INTO sections (id, title, pos) VALUES (?1, ?2, (SELECT COALESCE(MAX(pos), 0) + 1 FROM sections))", params![id, title]).map_err(err)?;
    Ok(id)
}

pub fn rename_section(db: &Connection, id: &str, title: &str) -> Result<(), String> {
    db.execute("UPDATE sections SET title = ?2 WHERE id = ?1", params![id, section_title(title)?]).map_err(err)?;
    Ok(())
}

// Deletes a section; its books go back to the top of the library.
pub fn remove_section(db: &Connection, id: &str) -> Result<(), String> {
    db.execute("DELETE FROM sections WHERE id = ?1", [id]).map_err(err)?;
    Ok(())
}

// Deletes a book and all its notes.
pub fn remove(db: &Connection, id: &str) -> Result<(), String> {
    db.execute("DELETE FROM books WHERE id = ?1", [id]).map_err(err)?;
    Ok(())
}

// Paths are book-relative; folders have no text.
type Entries = Vec<(String, Option<String>)>;
// Image file path and bytes.
type Images = Vec<(String, Vec<u8>)>;

// The image folder for a folder of the imported files: "attachments/Maps" (as exported) is
// "Maps", "attachments" the top level; None for other folders.
fn attachments_folder(dir: &str) -> Option<&str> {
    if dir == ATTACHMENTS { Some("") } else { dir.strip_prefix(ATTACHMENTS).and_then(|d| d.strip_prefix('/')) }
}

// Settings kept in .book.json.
#[derive(Default)]
struct Meta {
    color: Option<String>,
    // Cover image path (just its name in books exported before images were known by path).
    cover: Option<String>,
    summary: Option<String>,
    tags: Vec<Tag>,
}

fn read_meta(meta: &str) -> Meta {
    let json = serde_json::from_str::<serde_json::Value>(meta).unwrap_or_default();
    let get = |k: &str| json[k].as_str().map(String::from);
    let tags = parse_tags(&json["tags"]);
    Meta { color: get("color"), cover: get("cover"), summary: get("summary"), tags }
}

// Creates a book from imported entries, adding any missing parent folders. Returns its id.
// Images keep the folder they were in (see attachments_folder), and folders under attachments/
// become image folders rather than notes' folders. Embeds that name an image without its folder
// (as in Obsidian) are pointed at its path.
fn import(db: &Connection, title: &str, Meta { color, cover, summary, tags }: Meta, entries: Entries, imgs: Images) -> Result<String, String> {
    let tx = db.unchecked_transaction().map_err(err)?;
    let id = create(&tx, title, color.as_deref())?;
    set_summary(&tx, &id, summary.as_deref().unwrap_or(""))?;
    set_tags(&tx, &id, &tags)?;
    let mut paths = Vec::new();
    for (path, data) in &imgs {
        let dir = parent_of(path);
        let folder = attachments_folder(dir).unwrap_or(dir);
        images::add(&tx, &id, folder, base_name(path), data)?;
        paths.push(join_rel(folder, base_name(path)));
    }
    if let Some(cover) = cover.filter(|c| paths.iter().any(|p| p == c || base_name(p) == c)) {
        set_cover(&tx, &id, Some(&cover))?;
    }
    let mut add = tx.prepare("INSERT OR IGNORE INTO entries (book, path, text) VALUES (?1, ?2, ?3)").map_err(err)?;
    for (path, text) in &entries {
        if let (None, Some(folder)) = (text, attachments_folder(path)) {
            images::add_folder(&tx, &id, folder)?;
            continue;
        }
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
    images::resolve_names(&tx, &id)?;
    tx.commit().map_err(err)?;
    Ok(id)
}

// Collects folders, .md notes and images; other files are skipped.
fn walk(root: &Path, dir: &str, out: &mut Entries, imgs: &mut Images) -> std::io::Result<()> {
    for d in fs::read_dir(root.join(dir))? {
        let d = d?;
        let name = d.file_name().to_string_lossy().into_owned();
        let path = join_rel(dir, &name);
        if name.starts_with('.') {
            continue;
        }
        if d.file_type()?.is_dir() {
            out.push((path.clone(), None));
            walk(root, &path, out, imgs)?;
        } else if images::is_image_name(&name) {
            imgs.push((path, fs::read(d.path())?));
        } else if let Some(text) = name.ends_with(".md").then(|| fs::read_to_string(d.path()).ok()).flatten() {
            out.push((path, Some(text)));
        }
    }
    Ok(())
}

// Copies a folder's notes into a new book named after the folder. Returns its id.
pub fn import_folder(db: &Connection, dir: &Path) -> Result<String, String> {
    let (mut entries, mut imgs) = (Vec::new(), Vec::new());
    walk(dir, "", &mut entries, &mut imgs).map_err(err)?;
    let meta = read_meta(&fs::read_to_string(dir.join(META)).unwrap_or_default());
    let title = dir.file_name().map_or("Imported".into(), |n| n.to_string_lossy());
    import(db, &title, meta, entries, imgs)
}

// Same as import_folder for a .zip (e.g. one made by export_zip).
pub fn import_zip(db: &Connection, file: &Path) -> Result<String, String> {
    let mut zip = zip::ZipArchive::new(File::open(file).map_err(err)?).map_err(err)?;
    let (mut entries, mut imgs, mut meta) = (Vec::new(), Vec::new(), Meta::default());
    for i in 0..zip.len() {
        let mut f = zip.by_index(i).map_err(err)?;
        let Some(name) = f.enclosed_name() else { continue };
        let path = name.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/");
        let mut text = String::new();
        if path == META {
            meta = f.read_to_string(&mut text).map_or_else(|_| Meta::default(), |_| read_meta(&text));
        } else if path.is_empty() || path.split('/').any(|p| p.starts_with('.')) {
            continue;
        } else if f.is_dir() {
            entries.push((path, None));
        } else if images::is_image_name(&path) {
            let mut data = Vec::new();
            f.read_to_end(&mut data).map_err(err)?;
            imgs.push((path, data));
        } else if path.ends_with(".md") && f.read_to_string(&mut text).is_ok() {
            entries.push((path, Some(text)));
        }
    }
    let title = file.file_stem().map_or("Imported".into(), |n| n.to_string_lossy());
    import(db, &title, meta, entries, imgs)
}

// Writes a book as a .zip of its folders, .md notes and attachments/ images, plus its cover and
// summary and tags in .book.json.
pub fn export_zip(db: &Connection, id: &str, file: &Path) -> Result<(), String> {
    let Book { color, cover, summary, tags, .. } = get(db, id)?;
    let mut stmt = db.prepare("SELECT path, text FROM entries WHERE book = ?1 ORDER BY path").map_err(err)?;
    let entries: Entries = stmt.query_map([id], |r| Ok((r.get(0)?, r.get(1)?))).map_err(err)?.collect::<Result<_, _>>().map_err(err)?;

    let mut zip = zip::ZipWriter::new(File::create(file).map_err(err)?);
    let opts = SimpleFileOptions::default();
    zip.start_file(META, opts).map_err(err)?;
    zip.write_all(serde_json::json!({ "color": color, "cover": cover, "summary": summary, "tags": tags }).to_string().as_bytes()).map_err(err)?;
    // Image folders as attachments/ subfolders, so empty ones are kept too.
    for folder in images::list(db, id)?.folders {
        zip.add_directory(format!("{ATTACHMENTS}/{folder}"), opts).map_err(err)?;
    }
    for (folder, name, data) in images::all(db, id)? {
        zip.start_file(join_rel(&join_rel(ATTACHMENTS, &folder), &name), opts).map_err(err)?;
        zip.write_all(&data).map_err(err)?;
    }
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
        set_summary(db, &id, "A long tale.").unwrap();
        assert_eq!(get(db, &id).unwrap().summary, "A long tale.");
        assert!(get(db, &id).unwrap().tags.is_empty());
        let tags = [Tag { name: "Hero".into(), color: "#30a46c".into() }, Tag { name: "Villain".into(), color: "#e5484d".into() }];
        set_tags(db, &id, &tags).unwrap();
        assert_eq!(get(db, &id).unwrap().tags, tags);
        set_open(db, &id, true).unwrap();
        assert_eq!(open_ids(db).unwrap(), [id.clone()]);
        files::write(db, &id, "Intro.md", "hi").unwrap();
        let first = &list(db).unwrap()[0];
        assert_eq!((first.title.as_str(), first.color.as_str(), first.notes), ("Saga", "#abcdef", 1));

        let other = create(db, "Sequel", None).unwrap();
        let order = |db| list(db).unwrap().into_iter().map(|b| b.id).take(2).collect::<Vec<_>>();
        assert_eq!(order(db), [other.clone(), id.clone()], "new books come first");
        reorder(db, None, &[id.clone(), other.clone()]).unwrap();
        set_open(db, &other, true).unwrap();
        assert_eq!(order(db), [id.clone(), other.clone()], "the order stays when a book is opened");

        assert!(create_section(db, "  ").is_err());
        let shelf = create_section(db, "Shelf").unwrap();
        let later = create_section(db, "Later").unwrap();
        rename_section(db, &shelf, " Favorites ").unwrap();
        assert_eq!(sections(db).unwrap(), [Section { id: shelf.clone(), title: "Favorites".into() }, Section { id: later.clone(), title: "Later".into() }]);
        reorder(db, Some(&shelf), &[other.clone()]).unwrap();
        assert_eq!(get(db, &other).unwrap().section.as_deref(), Some(shelf.as_str()));
        assert_eq!(get(db, &id).unwrap().section, None, "other books stay where they are");
        remove_section(db, &shelf).unwrap();
        assert_eq!(get(db, &other).unwrap().section, None, "a deleted section's books go back to the top");
        remove(db, &other).unwrap();

        remove(db, &id).unwrap();
        assert!(title(db, &id).is_err());
        assert!(files::read(db, &id, "Intro.md").is_err(), "notes go with the book");
    }

    #[test]
    fn folder_notes_become_ordinary_notes() {
        let file = temp_dir().join("db.sqlite");
        {
            let db = open_db(&file).unwrap();
            db.execute("INSERT INTO books (id, title, color, ts) VALUES ('b', 'Book', '#000', 0)", []).unwrap();
            for (path, text) in [
                ("A", None),
                ("A/A.md", Some("")),
                ("B", None),
                ("B/B.md", Some("<!-- section: text -->\nIntro\n<!-- section: index -->")),
                ("B/Scene.md", Some("<!-- section: text -->")),
                ("C.md", Some(""))
            ] {
                db.execute("INSERT INTO entries (book, path, text) VALUES ('b', ?1, ?2)", params![path, text]).unwrap();
            }
            db.execute_batch("PRAGMA user_version = 0").unwrap(); // as before the migration
        }
        let db = open_db(&file).unwrap();
        assert!(files::read(&db, "b", "A/A.md").is_err(), "empty folder notes go");
        assert_eq!(files::read(&db, "b", "B/B.md").unwrap(), "Intro", "others lose their section markers");
        assert_eq!(files::read(&db, "b", "B/Scene.md").unwrap(), "<!-- section: text -->", "other notes are left alone");
        assert_eq!(files::read(&db, "b", "C.md").unwrap(), "");
        // It runs once: a note named like its folder made afterwards stays.
        files::write(&db, "b", "A/A.md", "").unwrap();
        drop(db);
        assert!(files::read(&open_db(&file).unwrap(), "b", "A/A.md").is_ok());
    }

    #[test]
    fn import_and_export() {
        let db = &test_db();
        let dir = temp_dir().join("Old Book");
        fs::create_dir_all(dir.join("Part 1/Scenes")).unwrap();
        fs::write(dir.join(META), r##"{"color":"#123456","cover":"Map.png","summary":"Old tale.","tags":["Magic",{"name":"War","color":"#0090ff"}]}"##).unwrap();
        for f in ["Part 1/Part 1.md", "Part 1/Scenes/Scene.md", "Intro.md", "notes.txt", ".hidden.md"] {
            fs::write(dir.join(f), f).unwrap();
        }
        fs::write(dir.join("Part 1/Map.png"), b"\x89PNG").unwrap();
        fs::write(dir.join("Intro.md"), "![[Map.png]]").unwrap();

        let id = import_folder(db, &dir).unwrap();
        let book = list(db).unwrap().into_iter().find(|b| b.id == id).unwrap();
        assert_eq!((book.title.as_str(), book.color.as_str(), book.notes), ("Old Book", "#123456", 3), "skips other files and dot-files");
        assert_eq!(book.summary, "Old tale.");
        let tags = [Tag { name: "Magic".into(), color: COVERS[0].into() }, Tag { name: "War".into(), color: "#0090ff".into() }];
        assert_eq!(book.tags, tags, "plain names (tags saved before colors) get a palette color");
        assert_eq!(book.cover.as_deref(), Some("Part 1/Map.png"), "a cover named without its folder is pointed at its path");
        assert_eq!(images::get(db, &id, "Part 1/Map.png").unwrap().as_deref(), Some(&b"\x89PNG"[..]), "images are known by path");
        assert_eq!(images::list(db, &id).unwrap().images, [("Map.png".into(), "Part 1".into())], "keeps the image's folder");
        images::create_folder(db, &id, "Part 1", "Empty").unwrap();

        let zip = dir.with_extension("zip");
        export_zip(db, &id, &zip).unwrap();
        let copy = import_zip(db, &zip).unwrap();
        assert_eq!(files::list_tree(db, &copy), files::list_tree(db, &id), "round-trips the tree");
        assert_eq!(files::read(db, &copy, "Part 1/Scenes/Scene.md").unwrap(), "Part 1/Scenes/Scene.md");
        assert_eq!(files::read(db, &id, "Intro.md").unwrap(), "![[Part 1/Map.png]]", "Obsidian-style embeds get the folder");
        assert_eq!(files::read(db, &copy, "Intro.md").unwrap(), "![[Part 1/Map.png]]");
        assert_eq!((title(db, &copy).unwrap().as_str(), get(db, &copy).unwrap().summary.as_str()), ("Old Book", "Old tale."));
        assert_eq!(get(db, &copy).unwrap().tags, tags, "round-trips tags");
        assert_eq!(images::all(db, &copy).unwrap(), images::all(db, &id).unwrap(), "round-trips images");
        assert_eq!(images::list(db, &copy).unwrap(), images::list(db, &id).unwrap(), "and their folders");
        assert_eq!(list(db).unwrap().into_iter().find(|b| b.id == copy).unwrap().cover.as_deref(), Some("Part 1/Map.png"));
    }
}
