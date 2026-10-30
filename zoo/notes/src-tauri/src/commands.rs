use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

pub const SCHEMA: &str = include_str!("../../schema.sql");

pub struct Db(pub Mutex<Connection>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    id: i64,
    body: String,
    rev: i64,
    updated_at: String,
}

type Result<T> = std::result::Result<T, String>;

const COLUMNS: &str = "id, body, rev, updated_at";

fn note(row: &Row) -> rusqlite::Result<Note> {
    Ok(Note {
        id: row.get(0)?,
        body: row.get(1)?,
        rev: row.get(2)?,
        updated_at: row.get(3)?,
    })
}

fn get(db: &Connection, id: i64) -> rusqlite::Result<Note> {
    db.query_row(
        &format!("SELECT {COLUMNS} FROM notes WHERE id = ?1"),
        [id],
        note,
    )
}

fn failed(err: rusqlite::Error) -> String {
    err.to_string()
}

/// Every note, the most recently changed first.
#[tauri::command]
pub fn list_notes(db: State<Db>) -> Result<Vec<Note>> {
    let db = db.0.lock().unwrap();
    let mut query = db
        .prepare(&format!(
            "SELECT {COLUMNS} FROM notes ORDER BY updated_at DESC, id DESC"
        ))
        .map_err(failed)?;
    let notes = query
        .query_map([], note)
        .map_err(failed)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(failed)?;
    Ok(notes)
}

/// A new, empty note.
#[tauri::command]
pub fn create_note(app: AppHandle, db: State<Db>) -> Result<Note> {
    let db = db.0.lock().unwrap();
    // The empty note there is, if any: New note never leaves blank notes behind.
    let blank = db
        .query_row(
            &format!("SELECT {COLUMNS} FROM notes WHERE body = '' LIMIT 1"),
            [],
            note,
        )
        .optional()
        .map_err(failed)?;
    if let Some(blank) = blank {
        return Ok(blank);
    }
    db.execute("INSERT INTO notes (body) VALUES ('')", [])
        .map_err(failed)?;
    let created = get(&db, db.last_insert_rowid()).map_err(failed)?;
    let _ = app.emit("notes-changed", ());
    Ok(created)
}

/// Saves a note's text as a new revision on top of `base_rev`, the one the editor started from.
#[tauri::command]
pub fn save_note(db: State<Db>, id: i64, body: String, base_rev: i64) -> Result<Note> {
    let db = db.0.lock().unwrap();
    let changed = db
        .execute(
            "UPDATE notes SET body = ?2, rev = rev + 1, updated_at = datetime('now') WHERE id = ?1",
            params![id, body],
        )
        .map_err(failed)?;
    if changed == 0 {
        return Err("This note was deleted.".into());
    }
    let saved = get(&db, id).map_err(failed)?;
    db.execute(
        "INSERT INTO revisions (note_id, rev, base_rev, body) VALUES (?1, ?2, ?3, ?4)",
        params![id, saved.rev, base_rev, body],
    )
    .map_err(failed)?;
    Ok(saved)
}

/// Moves a note to the trash.
#[tauri::command]
pub fn delete_note(app: AppHandle, db: State<Db>, id: i64) -> Result<()> {
    let mut db = db.0.lock().unwrap();
    let tx = db.transaction().map_err(failed)?;
    tx.execute(
        "INSERT INTO trash (id, body) SELECT id, body FROM notes WHERE id = ?1",
        [id],
    )
    .map_err(failed)?;
    tx.execute("DELETE FROM notes WHERE id = ?1", [id])
        .map_err(failed)?;
    tx.commit().map_err(failed)?;
    let _ = app.emit("notes-changed", ());
    Ok(())
}
