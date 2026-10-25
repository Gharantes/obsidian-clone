use crate::books::now_ms;
use crate::files::err;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;

#[derive(Serialize, Debug, PartialEq)]
pub struct Chat {
    pub id: String,
    pub title: String,
    pub ts: i64,
}

// A book's AI chats, most recent first.
pub fn list(db: &Connection, book: &str) -> Result<Vec<Chat>, String> {
    let mut stmt = db.prepare("SELECT id, title, ts FROM chats WHERE book = ?1 ORDER BY ts DESC").map_err(err)?;
    let rows = stmt.query_map([book], |r| Ok(Chat { id: r.get(0)?, title: r.get(1)?, ts: r.get(2)? })).map_err(err)?.collect::<Result<_, _>>().map_err(err);
    rows
}

// The chat's messages as stored by the renderer.
pub fn get(db: &Connection, book: &str, id: &str) -> Result<Option<Value>, String> {
    let turns: Option<String> = db.query_row("SELECT turns FROM chats WHERE book = ?1 AND id = ?2", params![book, id], |r| r.get(0)).optional().map_err(err)?;
    Ok(turns.map(|t| serde_json::from_str(&t).unwrap_or_default()))
}

// Creates or replaces a chat, marking it as the most recent.
pub fn save(db: &Connection, book: &str, id: &str, title: &str, turns: &Value) -> Result<(), String> {
    db.execute(
        "INSERT OR REPLACE INTO chats (book, id, title, ts, turns) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![book, id, title, now_ms(), turns.to_string()],
    )
    .map_err(err)?;
    Ok(())
}

pub fn remove(db: &Connection, book: &str, id: &str) -> Result<(), String> {
    db.execute("DELETE FROM chats WHERE book = ?1 AND id = ?2", params![book, id]).map_err(err)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::files::tests::test_db;
    use serde_json::json;

    #[test]
    fn chats() {
        let db = &test_db();
        let turns = json!([{ "role": "user", "text": "hi" }]);
        save(db, "b", "c1", "First", &turns).unwrap();
        save(db, "b", "c2", "Second", &json!([])).unwrap();
        assert_eq!(get(db, "b", "c1").unwrap(), Some(turns));
        assert_eq!(get(db, "b", "nope").unwrap(), None);
        let ids: Vec<_> = list(db, "b").unwrap().into_iter().map(|c| c.id).collect();
        assert!(ids == ["c2", "c1"] || ids == ["c1", "c2"], "same-millisecond saves may tie");
        save(db, "b", "c1", "First again", &json!([])).unwrap();
        assert_eq!(list(db, "b").unwrap().len(), 2, "saving again replaces");
        remove(db, "b", "c1").unwrap();
        assert_eq!(list(db, "b").unwrap().iter().map(|c| c.title.as_str()).collect::<Vec<_>>(), ["Second"]);
        db.execute("DELETE FROM books WHERE id = 'b'", []).unwrap();
        assert!(list(db, "b").unwrap().is_empty(), "deleting the book deletes its chats");
    }
}
