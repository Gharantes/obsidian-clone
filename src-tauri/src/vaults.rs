use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Vault {
    pub path: PathBuf,
    pub ts: u64,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub open: bool,
}

pub type Registry = HashMap<String, Vault>;

#[derive(Serialize, Deserialize, Default)]
struct File {
    #[serde(default)]
    vaults: Registry,
}

// Reads the vault registry; a missing or broken file means no vaults.
pub fn load_registry(file: &Path) -> Registry {
    fs::read_to_string(file)
        .ok()
        .and_then(|s| serde_json::from_str::<File>(&s).ok())
        .map(|f| f.vaults)
        .unwrap_or_default()
}

pub fn save_registry(file: &Path, vaults: &Registry) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir)?;
    }
    fs::write(file, serde_json::to_string(&File { vaults: vaults.clone() })?)
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

fn random_id() -> String {
    use std::hash::{BuildHasher, RandomState};
    format!("{:016x}", RandomState::new().hash_one(now_ms()))
}

// Registers a folder as a vault (reusing its id if known) and returns the id or an error message.
pub fn add_vault(vaults: &mut Registry, dir: &Path) -> Result<String, String> {
    let dir = std::path::absolute(dir).map_err(|e| e.to_string())?;
    if !dir.is_dir() {
        return Err("Folder not found".into());
    }
    if fs::read_dir(&dir).is_err() || dir.metadata().is_ok_and(|m| m.permissions().readonly()) {
        return Err("No permission to access folder".into());
    }
    let id = vaults.iter().find(|(_, v)| v.path == dir).map(|(k, _)| k.clone()).unwrap_or_else(random_id);
    let open = vaults.get(&id).is_some_and(|v| v.open);
    vaults.insert(id.clone(), Vault { path: dir, ts: now_ms(), open });
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::files::tests::temp_dir;

    #[test]
    fn vault_registry() {
        let dir = temp_dir("vault-");
        let file = dir.join("file.md");
        fs::write(&file, "").unwrap();
        let mut vaults = Registry::new();

        assert_eq!(add_vault(&mut vaults, &dir.join("missing")), Err("Folder not found".into()));
        assert_eq!(add_vault(&mut vaults, &file), Err("Folder not found".into()));

        let first = add_vault(&mut vaults, &dir).unwrap();
        assert_eq!(first.len(), 16);
        assert_eq!(add_vault(&mut vaults, &dir.join(".")), Ok(first), "same folder keeps its id");

        let registry = dir.join("vaults.json");
        save_registry(&registry, &vaults).unwrap();
        assert_eq!(load_registry(&registry), vaults);
        assert!(load_registry(&dir.join("nope.json")).is_empty());
    }
}
