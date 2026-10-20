use crate::files::bad_name;
use serde_json::{Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

// A book is a vault folder; its cover settings live in a dot-file the file tree skips.
const META: &str = ".book.json";

pub const COVERS: [&str; 10] =
    ["#7c4dff", "#e5484d", "#f76b15", "#ffc53d", "#30a46c", "#12a594", "#0090ff", "#3e63dd", "#d6409f", "#6f6e77"];

pub fn read_meta(dir: &Path) -> Map<String, Value> {
    fs::read_to_string(dir.join(META))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn write_meta(dir: &Path, meta: &Map<String, Value>) -> std::io::Result<()> {
    fs::write(dir.join(META), serde_json::to_string(meta)?)
}

fn random_cover() -> &'static str {
    use std::hash::{BuildHasher, RandomState};
    COVERS[(RandomState::new().hash_one(0) % COVERS.len() as u64) as usize]
}

// Creates a book folder inside the library; returns its full path or an error message.
pub fn create_book(library: &Path, title: &str, color: Option<&str>) -> Result<PathBuf, String> {
    let title = title.trim();
    if let Some(bad) = bad_name(title) {
        return Err(bad);
    }
    let path = library.join(title);
    if path.exists() {
        return Err(format!("A book called \"{title}\" already exists"));
    }
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    let mut meta = Map::new();
    meta.insert("color".into(), color.unwrap_or_else(|| random_cover()).into());
    write_meta(&path, &meta).map_err(|e| e.to_string())?;
    Ok(path)
}

// Number of Markdown notes in a folder tree (dot-files skipped).
pub fn count_notes(dir: &Path) -> usize {
    let Ok(entries) = fs::read_dir(dir) else { return 0 };
    entries
        .flatten()
        .map(|d| {
            let name = d.file_name().to_string_lossy().into_owned();
            match d.file_type() {
                _ if name.starts_with('.') => 0,
                Ok(t) if t.is_dir() => count_notes(&d.path()),
                _ if name.ends_with(".md") => 1,
                _ => 0,
            }
        })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::files::tests::temp_dir;

    #[test]
    fn books() {
        let library = temp_dir("lib-").join("Books"); // created on demand

        let book = create_book(&library, "  My Novel ", Some("#123456")).unwrap();
        assert_eq!(book, library.join("My Novel"));
        assert_eq!(read_meta(&book)["color"], "#123456");
        assert!(create_book(&library, "My Novel", None).is_err(), "no duplicates");
        assert!(create_book(&library, "a/b", None).is_err(), "no path separators");

        let mut meta = Map::new();
        meta.insert("color".into(), "#abcdef".into());
        write_meta(&book, &meta).unwrap();
        assert_eq!(read_meta(&book)["color"], "#abcdef");
        assert!(read_meta(&library.join("missing")).is_empty());

        fs::create_dir(book.join("Part 1")).unwrap();
        for f in ["Part 1/Part 1.md", "Part 1/Scene.md", "Intro.md", "image.png", ".hidden.md"] {
            fs::write(book.join(f), "").unwrap();
        }
        assert_eq!(count_notes(&book), 3);
    }
}
