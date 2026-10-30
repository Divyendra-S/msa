# Bug Zoo notes app

A small Tauri v2 notes app for testing Wind Tunnel on desktop apps. It has a list of notes, an
editor that saves 400 ms after you stop typing, Save, Delete, and New note. The data is SQLite
through rusqlite, in `app_data_dir()`. The frontend is plain JavaScript in `src/` with no build
step, type-checked through JSDoc. The Rust side is four `#[tauri::command]`s in
`src-tauri/src/commands.rs`.

The clean app passes every experiment. Each case in `cases/` is a patch that plants one bug:

| Case | What goes wrong | Experiment | Rule it breaks |
|---|---|---|---|
| 01-double-new-note | `create_note` no longer reopens the empty note, so a double click makes two | `new-note-double-click`, `new-note-two-windows` | `one-blank-note` |
| 02-autosave-lost-edit | The frontend's save queue is gone, so Save and the autosave start from the same revision | `autosave-and-save` | `no-lost-edit` |
| 03-delete-brings-note-back | `save_note` is an upsert, so an autosave that lands after Delete brings the note back | `delete-during-autosave` | `deleted-notes-stay-deleted` |

```sh
pnpm zoo:verify:notes                          # the clean app and every case, 3 runs each
pnpm wt --cwd zoo/notes run delete-during-autosave --patch zoo/notes/cases/03-delete-brings-note-back/bug.patch
pnpm wt --cwd zoo/notes map                    # the commands, what each does, who invokes it
```

Runs need Rust (cargo) and Playwright's WebKit (`npx playwright install webkit`). The first
build compiles Tauri, which takes a minute or two; after that a version builds in a few seconds.
Nothing appears on screen: the app runs with its window hidden and never comes to the front
(see [`crates/windtunnel-tauri`](../../crates/windtunnel-tauri/README.md)).

The seed is SQL (`schema.sql`, then `seed.sql`) run by the `sqlite3` that comes with macOS.
The app runs the same `schema.sql` at every start.
