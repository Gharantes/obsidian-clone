use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::cmp::Ordering;

// Folders carry `note` when they have a folder note ("X/X.md"); that note is left out of `children`.
#[derive(Serialize, Debug, PartialEq)]
pub struct Entry {
    pub path: String,
    pub name: String,
    pub folder: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<Entry>>,
}

// Case-insensitive name order with numbers compared by value ("note 2" before "note 10").
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (mut x, mut y) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (x.peek().copied(), y.peek().copied()) {
            (None, None) => return a.cmp(b),
            (None, _) => return Ordering::Less,
            (_, None) => return Ordering::Greater,
            (Some(c), Some(d)) if c.is_ascii_digit() && d.is_ascii_digit() => {
                let take = |it: &mut std::iter::Peekable<std::str::Chars>| {
                    let mut s = String::new();
                    while let Some(c) = it.peek().filter(|c| c.is_ascii_digit()) {
                        s.push(*c);
                        it.next();
                    }
                    s.trim_start_matches('0').to_string()
                };
                let (m, n) = (take(&mut x), take(&mut y));
                let ord = m.len().cmp(&n.len()).then_with(|| m.cmp(&n));
                if ord != Ordering::Equal {
                    return ord;
                }
            }
            (Some(c), Some(d)) => {
                let ord = c.to_lowercase().cmp(d.to_lowercase());
                if ord != Ordering::Equal {
                    return ord;
                }
                x.next();
                y.next();
            }
        }
    }
}

pub fn base_name(rel: &str) -> &str {
    &rel[rel.rfind('/').map_or(0, |i| i + 1)..]
}

pub fn parent_of(rel: &str) -> &str {
    &rel[..rel.rfind('/').unwrap_or(0)]
}

pub fn join_rel(dir: &str, name: &str) -> String {
    if dir.is_empty() { name.to_string() } else { format!("{dir}/{name}") }
}

// Path of a folder's folder note: "A/B" -> "A/B/B.md".
pub fn folder_note_path(folder: &str) -> String {
    format!("{folder}/{}.md", base_name(folder))
}

pub fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

// Matches an entry (?2) and everything under it, in book ?1.
const SUBTREE: &str = "book = ?1 AND (path = ?2 OR substr(path, 1, length(?2) + 1) = ?2 || '/')";

// Lists a book's entries as a tree; paths are book-relative with '/'.
pub fn list_tree(db: &Connection, book: &str) -> Result<Vec<Entry>, String> {
    let mut stmt = db.prepare("SELECT path, text IS NULL FROM entries WHERE book = ?1").map_err(err)?;
    let rows = stmt.query_map([book], |r| Ok((r.get(0)?, r.get(1)?))).map_err(err)?.collect::<Result<Vec<_>, _>>().map_err(err)?;
    Ok(tree(&rows, ""))
}

fn tree(rows: &[(String, bool)], dir: &str) -> Vec<Entry> {
    let mut entries = Vec::new();
    for (path, folder) in rows.iter().filter(|(p, _)| parent_of(p) == dir) {
        let (path, name) = (path.clone(), base_name(path).to_string());
        if !folder {
            entries.push(Entry { path, name, folder: false, note: None, children: None });
            continue;
        }
        let mut children = tree(rows, &path);
        let note = children
            .iter()
            .position(|c| !c.folder && c.name == format!("{name}.md"))
            .map(|i| children.remove(i).path);
        entries.push(Entry { path, name, folder: true, note, children: Some(children) });
    }
    entries.sort_by(|a, b| b.folder.cmp(&a.folder).then_with(|| natural_cmp(&a.name, &b.name)));
    entries
}

// Refuses the book root and paths with empty, "." or ".." parts.
pub fn check(rel: &str) -> Result<(), String> {
    if rel.split('/').any(|p| p.is_empty() || p == "." || p == "..") {
        return Err(format!("Invalid path: {rel}"));
    }
    Ok(())
}

// Some(true) for a folder, Some(false) for a note, None when missing.
fn kind(db: &Connection, book: &str, rel: &str) -> Result<Option<bool>, String> {
    db.query_row("SELECT text IS NULL FROM entries WHERE book = ?1 AND path = ?2", params![book, rel], |r| r.get(0)).optional().map_err(err)
}

fn exists(db: &Connection, book: &str, rel: &str) -> Result<bool, String> {
    Ok(kind(db, book, rel)?.is_some())
}

fn is_folder(db: &Connection, book: &str, rel: &str) -> Result<bool, String> {
    Ok(rel.is_empty() || kind(db, book, rel)? == Some(true))
}

// Adds a note (or a folder when `text` is None) inside an existing folder.
fn insert(db: &Connection, book: &str, rel: &str, text: Option<&str>) -> Result<(), String> {
    check(rel)?;
    if !is_folder(db, book, parent_of(rel))? {
        return Err(format!("Folder not found: {}", parent_of(rel)));
    }
    db.execute("INSERT INTO entries (book, path, text) VALUES (?1, ?2, ?3)", params![book, rel, text]).map_err(err)?;
    Ok(())
}

// Moves an entry and everything under it.
fn relocate(db: &Connection, book: &str, from: &str, to: &str) -> Result<(), String> {
    db.execute(&format!("UPDATE entries SET path = ?3 || substr(path, length(?2) + 1) WHERE {SUBTREE}"), params![book, from, to]).map_err(err)?;
    Ok(())
}

pub fn read(db: &Connection, book: &str, rel: &str) -> Result<String, String> {
    db.query_row("SELECT text FROM entries WHERE book = ?1 AND path = ?2 AND text IS NOT NULL", params![book, rel], |r| r.get(0))
        .optional()
        .map_err(err)?
        .ok_or_else(|| format!("Note not found: {rel}"))
}

// Saves a note, creating it if its folder exists.
pub fn write(db: &Connection, book: &str, rel: &str, text: &str) -> Result<(), String> {
    let n = db.execute("UPDATE entries SET text = ?3 WHERE book = ?1 AND path = ?2 AND text IS NOT NULL", params![book, rel, text]).map_err(err)?;
    if n == 0 { insert(db, book, rel, Some(text)) } else { Ok(()) }
}

// Deletes an entry and everything under it.
pub fn remove(db: &Connection, book: &str, rel: &str) -> Result<(), String> {
    check(rel)?;
    db.execute(&format!("DELETE FROM entries WHERE {SUBTREE}"), params![book, rel]).map_err(err)?;
    Ok(())
}

// First free "base.ext", "base 1.ext", ... (ext "" for folders), as a book-relative path.
pub fn available_path(db: &Connection, book: &str, base: &str, ext: &str) -> Result<String, String> {
    let name = |n: u32| {
        let stem = if n > 0 { format!("{base} {n}") } else { base.to_string() };
        if ext.is_empty() { stem } else { format!("{stem}.{ext}") }
    };
    let mut n = 0;
    while exists(db, book, &name(n))? {
        n += 1;
    }
    Ok(name(n))
}

// Error message for a file or folder name that can't be used, or None.
pub fn bad_name(name: &str) -> Option<String> {
    if name.is_empty() || name.starts_with('.') || name.contains(['\\', '/', ':', '*', '?', '"', '<', '>', '|']) {
        return Some(r#"Names cannot be empty, start with "." or contain \ / : * ? " < > |"#.to_string());
    }
    None
}

// Creates "Untitled" in `parent` ("" = root). Folders get a folder note. Returns the new path.
pub fn create_entry(db: &Connection, book: &str, parent: &str, folder: bool) -> Result<String, String> {
    let path = available_path(db, book, &join_rel(parent, "Untitled"), if folder { "" } else { "md" })?;
    if folder {
        insert(db, book, &path, None)?;
        insert(db, book, &folder_note_path(&path), Some(""))?;
    } else {
        insert(db, book, &path, Some(""))?;
    }
    Ok(path)
}

// Renames an entry inside its folder; returns the new book-relative path or an error message.
// Renaming a folder renames its folder note along with it.
pub fn rename_entry(db: &Connection, book: &str, rel: &str, new_name: &str) -> Result<String, String> {
    let new_name = new_name.trim();
    if let Some(bad) = bad_name(new_name) {
        return Err(bad);
    }
    check(rel)?;
    let path = join_rel(parent_of(rel), new_name);
    if path == rel {
        return Ok(path);
    }
    if exists(db, book, &path)? {
        return Err(format!("\"{new_name}\" already exists"));
    }
    relocate(db, book, rel, &path)?;
    let old_note = format!("{path}/{}.md", base_name(rel));
    if exists(db, book, &old_note)? && !exists(db, book, &folder_note_path(&path))? {
        relocate(db, book, &old_note, &folder_note_path(&path))?;
    }
    Ok(path)
}

// Turns note "A/B.md" into the folder note "A/B/B.md" so notes can go inside it. Returns its new path.
pub fn nest_note(db: &Connection, book: &str, rel: &str) -> Result<String, String> {
    let Some(folder) = rel.strip_suffix(".md") else {
        return Err("Only notes can hold other notes".to_string());
    };
    if base_name(parent_of(rel)) == base_name(folder) {
        return Ok(rel.to_string()); // already a folder note
    }
    let target = folder_note_path(folder);
    if exists(db, book, &target)? {
        return Err(format!("\"{target}\" already exists"));
    }
    if !exists(db, book, folder)? {
        insert(db, book, folder, None)?;
    }
    relocate(db, book, rel, &target)?;
    Ok(target)
}

// Moves an entry into `dest` ("" = root). Returns the new path or an error message.
pub fn move_entry(db: &Connection, book: &str, rel: &str, dest: &str) -> Result<String, String> {
    if dest == rel || dest.starts_with(&format!("{rel}/")) {
        return Err("Cannot move a folder into itself".to_string());
    }
    check(rel)?;
    if !is_folder(db, book, dest)? {
        return Err(format!("Folder not found: {dest}"));
    }
    let path = join_rel(dest, base_name(rel));
    if path == rel {
        return Ok(path);
    }
    if exists(db, book, &path)? {
        return Err(format!("\"{}\" already exists there", base_name(rel)));
    }
    relocate(db, book, rel, &path)?;
    Ok(path)
}

#[cfg(test)]
pub mod tests {
    use super::*;

    // An in-memory database with one empty book "b".
    pub fn test_db() -> Connection {
        let db = crate::books::open_db(std::path::Path::new(":memory:")).unwrap();
        db.execute("INSERT INTO books (id, title, color, ts) VALUES ('b', 'Book', '#000', 0)", []).unwrap();
        db
    }

    fn paths(tree: &[Entry]) -> Vec<&str> {
        tree.iter().map(|e| e.path.as_str()).collect()
    }

    #[test]
    fn book_files() {
        let db = &test_db();
        for d in ["b", "a"] {
            insert(db, "b", d, None).unwrap();
        }
        for f in ["note 10.md", "note 2.md", "a/inner.md"] {
            write(db, "b", f, "").unwrap();
        }
        assert!(write(db, "b", "missing/x.md", "").is_err(), "needs its folder");

        let tree = list_tree(db, "b").unwrap();
        assert_eq!(paths(&tree), ["a", "b", "note 2.md", "note 10.md"], "folders first, numeric order");
        assert_eq!(
            tree[0].children.as_deref().unwrap(),
            [Entry { path: "a/inner.md".into(), name: "inner.md".into(), folder: false, note: None, children: None }]
        );

        assert!(check("../escape.md").is_err());
        assert!(check("").is_err());

        write(db, "b", "Untitled.md", "").unwrap();
        assert_eq!(available_path(db, "b", "Untitled", "md").unwrap(), "Untitled 1.md");
        assert_eq!(available_path(db, "b", "a/Untitled", "md").unwrap(), "a/Untitled.md");

        write(db, "b", "a/inner.md", "text").unwrap();
        assert_eq!(rename_entry(db, "b", "a/inner.md", "moved.md"), Ok("a/moved.md".into()));
        assert_eq!(read(db, "b", "a/moved.md").unwrap(), "text");
        assert!(rename_entry(db, "b", "note 2.md", "note 10.md").is_err(), "refuses to overwrite");
        assert!(rename_entry(db, "b", "note 2.md", "../x.md").is_err(), "refuses path separators");
        assert!(rename_entry(db, "b", "note 2.md", "what?.md").is_err(), "refuses characters Windows forbids");

        remove(db, "b", "a").unwrap();
        assert!(read(db, "b", "a/moved.md").is_err(), "removes the folder's contents");
        assert!(exists(db, "b", "note 2.md").unwrap());
    }

    #[test]
    fn folder_notes() {
        let db = &test_db();

        // New folders come with a folder note, which the tree reports on the folder, not as a child.
        assert_eq!(create_entry(db, "b", "", true).unwrap(), "Untitled");
        assert!(exists(db, "b", "Untitled/Untitled.md").unwrap());
        assert_eq!(create_entry(db, "b", "Untitled", false).unwrap(), "Untitled/Untitled 1.md");
        let tree = list_tree(db, "b").unwrap();
        assert_eq!(tree.len(), 1);
        assert_eq!(tree[0].note.as_deref(), Some("Untitled/Untitled.md"));
        assert_eq!(paths(tree[0].children.as_deref().unwrap()), ["Untitled/Untitled 1.md"]);

        // Renaming the folder renames its note.
        assert_eq!(rename_entry(db, "b", "Untitled", "Chapter 1"), Ok("Chapter 1".into()));
        assert!(exists(db, "b", "Chapter 1/Chapter 1.md").unwrap());

        // A note becomes a folder note so notes can be nested under it.
        write(db, "b", "Chapter 1/Scene.md", "text").unwrap();
        assert_eq!(nest_note(db, "b", "Chapter 1/Scene.md"), Ok("Chapter 1/Scene/Scene.md".into()));
        assert_eq!(nest_note(db, "b", "Chapter 1/Scene/Scene.md"), Ok("Chapter 1/Scene/Scene.md".into()), "already nested");
        let tree = list_tree(db, "b").unwrap();
        assert_eq!(tree[0].children.as_ref().unwrap()[0].note.as_deref(), Some("Chapter 1/Scene/Scene.md"));

        // Moving.
        assert_eq!(move_entry(db, "b", "Chapter 1/Scene", ""), Ok("Scene".into()));
        assert_eq!(read(db, "b", "Scene/Scene.md").unwrap(), "text");
        assert!(move_entry(db, "b", "Chapter 1", "Chapter 1").is_err(), "not into itself");
        write(db, "b", "Scene.md", "").unwrap();
        assert!(move_entry(db, "b", "Scene.md", "Scene").is_err(), "no overwriting");
        assert!(move_entry(db, "b", "Scene.md", "Nowhere").is_err(), "needs an existing folder");

        // "Chapter 1x" shares a prefix with "Chapter 1" but isn't inside it.
        insert(db, "b", "Chapter 1x", None).unwrap();
        rename_entry(db, "b", "Chapter 1", "Part").unwrap();
        assert!(exists(db, "b", "Chapter 1x").unwrap());
    }
}
