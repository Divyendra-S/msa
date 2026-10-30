// No console window behind the app on Windows, in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;

use std::sync::Mutex;

use rusqlite::Connection;
use tauri::Manager;

fn main() {
    let builder = tauri::Builder::default()
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let db = Connection::open(dir.join("notes.db"))?;
            db.execute_batch(commands::SCHEMA)?;
            app.manage(commands::Db(Mutex::new(db)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_notes,
            commands::create_note,
            commands::save_note,
            commands::delete_note,
        ]);
    let context = tauri::generate_context!();
    #[cfg(feature = "windtunnel")]
    windtunnel_tauri::run(builder, context);
    #[cfg(not(feature = "windtunnel"))]
    builder
        .run(context)
        .expect("error while running the notes app");
}
