use serde::Serialize;
use std::cmp::Ordering;
use std::fs;
use std::path::{Component, Path, PathBuf};

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

fn base_name(rel: &str) -> &str {
    &rel[rel.rfind('/').map_or(0, |i| i + 1)..]
}

fn parent_of(rel: &str) -> &str {
    &rel[..rel.rfind('/').unwrap_or(0)]
}

fn join_rel(dir: &str, name: &str) -> String {
    if dir.is_empty() { name.to_string() } else { format!("{dir}/{name}") }
}

// Path of a folder's folder note: "A/B" -> "A/B/B.md".
pub fn folder_note_path(folder: &str) -> String {
    format!("{folder}/{}.md", base_name(folder))
}

// Lists a vault folder recursively, skipping dot-files; paths are vault-relative with '/'.
pub fn list_tree(root: &Path, dir: &str) -> std::io::Result<Vec<Entry>> {
    let mut entries = Vec::new();
    for d in fs::read_dir(root.join(dir))? {
        let d = d?;
        let name = d.file_name().to_string_lossy().into_owned();
        let kind = d.file_type()?;
        if name.starts_with('.') || !(kind.is_dir() || kind.is_file()) {
            continue;
        }
        let path = join_rel(dir, &name);
        if !kind.is_dir() {
            entries.push(Entry { path, name, folder: false, note: None, children: None });
            continue;
        }
        let mut children = list_tree(root, &path)?;
        let note = children
            .iter()
            .position(|c| !c.folder && c.name == format!("{name}.md"))
            .map(|i| children.remove(i).path);
        entries.push(Entry { path, name, folder: true, note, children: Some(children) });
    }
    entries.sort_by(|a, b| b.folder.cmp(&a.folder).then_with(|| natural_cmp(&a.name, &b.name)));
    Ok(entries)
}

// Resolves a vault-relative path, refusing the vault root and anything outside it.
pub fn in_vault(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let outside = || format!("Path outside vault: {rel}");
    let mut parts: Vec<&std::ffi::OsStr> = Vec::new();
    for c in Path::new(rel).components() {
        match c {
            Component::Normal(p) => parts.push(p),
            Component::CurDir => {}
            Component::ParentDir => {
                parts.pop().ok_or_else(outside)?;
            }
            Component::RootDir | Component::Prefix(_) => return Err(outside()),
        }
    }
    if parts.is_empty() {
        return Err(outside());
    }
    Ok(parts.iter().fold(root.to_path_buf(), |p, part| p.join(part)))
}

fn exists(root: &Path, rel: &str) -> Result<bool, String> {
    Ok(in_vault(root, rel)?.exists())
}

// First free "base.ext", "base 1.ext", ... (ext "" for folders), as a vault-relative path.
pub fn available_path(root: &Path, base: &str, ext: &str) -> Result<String, String> {
    let name = |n: u32| {
        let stem = if n > 0 { format!("{base} {n}") } else { base.to_string() };
        if ext.is_empty() { stem } else { format!("{stem}.{ext}") }
    };
    let mut n = 0;
    while exists(root, &name(n))? {
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

fn io(e: std::io::Error) -> String {
    e.to_string()
}

// Creates "Untitled" in `parent` ("" = root). Folders get a folder note. Returns the new path.
pub fn create_entry(root: &Path, parent: &str, folder: bool) -> Result<String, String> {
    let path = available_path(root, &join_rel(parent, "Untitled"), if folder { "" } else { "md" })?;
    if folder {
        fs::create_dir(in_vault(root, &path)?).map_err(io)?;
        fs::write(in_vault(root, &folder_note_path(&path))?, "").map_err(io)?;
    } else {
        fs::write(in_vault(root, &path)?, "").map_err(io)?;
    }
    Ok(path)
}

// Renames an entry inside its folder; returns the new vault-relative path or an error message.
// Renaming a folder renames its folder note along with it.
pub fn rename_entry(root: &Path, rel: &str, new_name: &str) -> Result<String, String> {
    let new_name = new_name.trim();
    if let Some(bad) = bad_name(new_name) {
        return Err(bad);
    }
    let path = join_rel(parent_of(rel), new_name);
    if path == rel {
        return Ok(path);
    }
    // A case-only rename finds the old entry on case-insensitive filesystems; that's fine.
    if path.to_lowercase() != rel.to_lowercase() && exists(root, &path)? {
        return Err(format!("\"{new_name}\" already exists"));
    }
    fs::rename(in_vault(root, rel)?, in_vault(root, &path)?).map_err(io)?;
    let old_note = format!("{path}/{}.md", base_name(rel));
    if exists(root, &old_note)? && !exists(root, &folder_note_path(&path))? {
        fs::rename(in_vault(root, &old_note)?, in_vault(root, &folder_note_path(&path))?).map_err(io)?;
    }
    Ok(path)
}

// Turns note "A/B.md" into the folder note "A/B/B.md" so notes can go inside it. Returns its new path.
pub fn nest_note(root: &Path, rel: &str) -> Result<String, String> {
    let Some(folder) = rel.strip_suffix(".md") else {
        return Err("Only notes can hold other notes".to_string());
    };
    if base_name(parent_of(rel)) == base_name(folder) {
        return Ok(rel.to_string()); // already a folder note
    }
    let target = folder_note_path(folder);
    if exists(root, &target)? {
        return Err(format!("\"{target}\" already exists"));
    }
    fs::create_dir_all(in_vault(root, folder)?).map_err(io)?;
    fs::rename(in_vault(root, rel)?, in_vault(root, &target)?).map_err(io)?;
    Ok(target)
}

// Moves an entry into `dest` ("" = root). Returns the new path or an error message.
pub fn move_entry(root: &Path, rel: &str, dest: &str) -> Result<String, String> {
    if dest == rel || dest.starts_with(&format!("{rel}/")) {
        return Err("Cannot move a folder into itself".to_string());
    }
    let path = join_rel(dest, base_name(rel));
    if path == rel {
        return Ok(path);
    }
    if exists(root, &path)? {
        return Err(format!("\"{}\" already exists there", base_name(rel)));
    }
    fs::rename(in_vault(root, rel)?, in_vault(root, &path)?).map_err(io)?;
    Ok(path)
}

#[cfg(test)]
pub mod tests {
    use super::*;

    // A fresh empty folder under the system temp dir.
    pub fn temp_dir(prefix: &str) -> PathBuf {
        use std::hash::{BuildHasher, RandomState};
        let dir = std::env::temp_dir().join(format!("{prefix}{:016x}", RandomState::new().hash_one(0)));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn paths(tree: &[Entry]) -> Vec<&str> {
        tree.iter().map(|e| e.path.as_str()).collect()
    }

    #[test]
    fn vault_files() {
        let root = temp_dir("vault-");
        for d in ["b", "a", ".obsidian"] {
            fs::create_dir(root.join(d)).unwrap();
        }
        for f in ["note 10.md", "note 2.md", "a/inner.md", ".hidden.md"] {
            fs::write(root.join(f), "").unwrap();
        }

        let tree = list_tree(&root, "").unwrap();
        assert_eq!(paths(&tree), ["a", "b", "note 2.md", "note 10.md"], "folders first, numeric order, no dot-files");
        assert_eq!(
            tree[0].children.as_deref().unwrap(),
            [Entry { path: "a/inner.md".into(), name: "inner.md".into(), folder: false, note: None, children: None }]
        );

        assert!(in_vault(&root, "../escape.md").is_err());
        assert!(in_vault(&root, "").is_err());

        fs::write(root.join("Untitled.md"), "").unwrap();
        assert_eq!(available_path(&root, "Untitled", "md").unwrap(), "Untitled 1.md");
        assert_eq!(available_path(&root, "a/Untitled", "md").unwrap(), "a/Untitled.md");

        assert_eq!(rename_entry(&root, "a/inner.md", "moved.md"), Ok("a/moved.md".into()));
        assert!(root.join("a/moved.md").exists());
        assert!(rename_entry(&root, "note 2.md", "note 10.md").is_err(), "refuses to overwrite");
        assert!(rename_entry(&root, "note 2.md", "../x.md").is_err(), "refuses path separators");
        assert!(rename_entry(&root, "note 2.md", "what?.md").is_err(), "refuses characters Windows forbids");
    }

    #[test]
    fn folder_notes() {
        let root = temp_dir("vault-");

        // New folders come with a folder note, which the tree reports on the folder, not as a child.
        assert_eq!(create_entry(&root, "", true).unwrap(), "Untitled");
        assert!(root.join("Untitled/Untitled.md").exists());
        assert_eq!(create_entry(&root, "Untitled", false).unwrap(), "Untitled/Untitled 1.md");
        let tree = list_tree(&root, "").unwrap();
        assert_eq!(tree.len(), 1);
        assert_eq!(tree[0].note.as_deref(), Some("Untitled/Untitled.md"));
        assert_eq!(paths(tree[0].children.as_deref().unwrap()), ["Untitled/Untitled 1.md"]);

        // Renaming the folder renames its note.
        assert_eq!(rename_entry(&root, "Untitled", "Chapter 1"), Ok("Chapter 1".into()));
        assert!(root.join("Chapter 1/Chapter 1.md").exists());

        // A note becomes a folder note so notes can be nested under it.
        fs::write(root.join("Chapter 1/Scene.md"), "text").unwrap();
        assert_eq!(nest_note(&root, "Chapter 1/Scene.md"), Ok("Chapter 1/Scene/Scene.md".into()));
        assert_eq!(nest_note(&root, "Chapter 1/Scene/Scene.md"), Ok("Chapter 1/Scene/Scene.md".into()), "already nested");
        let tree = list_tree(&root, "").unwrap();
        assert_eq!(tree[0].children.as_ref().unwrap()[0].note.as_deref(), Some("Chapter 1/Scene/Scene.md"));

        // Moving.
        assert_eq!(move_entry(&root, "Chapter 1/Scene", ""), Ok("Scene".into()));
        assert!(root.join("Scene/Scene.md").exists());
        assert!(move_entry(&root, "Chapter 1", "Chapter 1").is_err(), "not into itself");
        fs::write(root.join("Scene.md"), "").unwrap();
        assert!(move_entry(&root, "Scene.md", "Scene").is_err(), "no overwriting");
    }
}
