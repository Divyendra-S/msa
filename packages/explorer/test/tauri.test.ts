// Reading a Tauri app: its commands, what each does, who invokes it; and the map built from them.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Project } from "@windtunnel/core";
import { buildAppMap, formatAppMap } from "../src/map.ts";
import { findTauriApp } from "../src/tauri.ts";

const COMMANDS = `use tauri::{AppHandle, Emitter, State};

const SCHEMA: &str = r#"CREATE TABLE IF NOT EXISTS todos (id INTEGER PRIMARY KEY, done INTEGER)"#;

fn get(db: &Connection, id: i64) -> rusqlite::Result<Todo> {
    db.query_row("SELECT id, title FROM todos WHERE id = ?1", [id], todo)
}

/// Every todo.
/// Newest first.
#[tauri::command]
pub fn list_todos(db: State<'_, Db>) -> Result<Vec<Todo>, String> {
    // A brace in a comment: {
    let text = "}";
    let c = '{';
    query(&db, "SELECT id, title FROM todos ORDER BY id DESC")
}

/// Adds a todo; a double click adds two.
#[tauri::command]
pub async fn add_todo(app: AppHandle, db: State<'_, Db>, title: String) -> Result<Todo, String> {
    db.execute("INSERT INTO todos (title) VALUES (?1)", [title]).map_err(failed)?;
    let _ = app.emit("todos-changed", ());
    get(&db, 1).map_err(failed)
}

#[tauri::command(rename_all = "snake_case")]
pub fn save_todo(db: State<'_, Db>, id: i64, title: String) -> Result<(), String> {
    db.execute(
        "INSERT INTO todos (id, title) VALUES (?1, ?2)
         ON CONFLICT (id) DO UPDATE SET title = excluded.title",
        params![id, title],
    )
    .map_err(failed)?;
    Ok(())
}

#[tauri::command]
pub fn clear_done(db: State<'_, Db>) -> Result<(), String> {
    let tx = db.transaction().map_err(failed)?;
    tx.execute("INSERT INTO archive SELECT * FROM todos WHERE done = 1", []).map_err(failed)?;
    tx.execute("DELETE FROM todos WHERE done = 1", []).map_err(failed)?;
    tx.commit().map_err(failed)
}
`;

const FILES: Record<string, string> = {
  "src-tauri/tauri.conf.json": "{}",
  "src-tauri/Cargo.toml": '[dependencies]\ntauri = { version = "2.12", features = [] }\n',
  "src-tauri/src/commands.rs": COMMANDS,
  "src-tauri/target/debug/build/x/out.rs": '#[tauri::command] fn generated() { "DELETE FROM todos" }',
  "index.html": '<button id="add">Add todo</button><input aria-label="Title"><p id="empty">Nothing to do.</p>',
  "src/main.ts": `import { invoke } from "@tauri-apps/api/core";
const todos = await invoke<Todo[]>("list_todos");
await invoke("add_todo", { title });
function show(text: string) {}
show("Added");
await invoke('clear_done');
`,
};

describe("a Tauri app's commands", () => {
  let root: string;
  before(async () => {
    root = await mkdtemp(join(tmpdir(), "wt-tauri-"));
    for (const [path, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text);
    }
  });
  after(() => rm(root, { recursive: true, force: true }));

  it("finds each #[tauri::command] with its SQL, helpers, events and callers", async () => {
    const app = (await findTauriApp(root))!;
    assert.equal(app.framework, "Tauri 2.12");
    assert.deepEqual(app.commands.map((c) => c.name), ["list_todos", "add_todo", "save_todo", "clear_done"]);
    const [list, add, save, clear] = app.commands;
    assert.equal(list!.comment, "Every todo.");
    assert.equal(list!.async, false);
    assert.equal(list!.file, join("src-tauri", "src", "commands.rs"));
    assert.equal(list!.line, 12);
    assert.deepEqual(list!.callers, [join("src", "main.ts") + ":2"]);
    assert.deepEqual(list!.effects.map((e) => e.kind === "sql" && `${e.op} ${e.tables}`), ["SELECT todos"]);

    assert.equal(add!.async, true);
    assert.deepEqual(add!.emits, ["todos-changed"]);
    assert.deepEqual(
      add!.effects.map((e) => (e.kind === "sql" ? `${e.op} ${e.tables}` : e.kind === "call" ? `${e.name}→${e.effects.length}` : e.kind)),
      ["INSERT todos", "get→1"],
    );
    assert.equal(save!.callers.length, 0);
    assert.equal(clear!.effects.at(-1)!.kind, "tx");
    assert.deepEqual(clear!.callers, [join("src", "main.ts") + ":6"]);
  });

  it("maps commands as INVOKE routes with their hints, and the page from its HTML", async () => {
    const project = { root, repoRoot: root, appSubdir: "", stateDir: join(root, ".windtunnel"), config: { users: {} } } as unknown as Project;
    const map = await buildAppMap(project);
    const save = map.routes.find((r) => r.path === "save_todo")!;
    assert.equal(save.method, "INVOKE");
    assert.ok(save.flags.includes("upsert todos: writes the row whether or not it still exists"), save.flags.join("; "));
    assert.ok(!map.routes.some((r) => r.flags.some((f) => f.startsWith("no auth"))), "desktop commands have no login to check");
    const add = map.routes.find((r) => r.path === "add_todo")!;
    assert.ok(add.notes.includes("async: calls can overlap"));
    assert.ok(add.flags.some((f) => f.startsWith("INSERT todos: no ON CONFLICT")));
    assert.deepEqual(map.pages[0]!.ui.buttons, ["Add todo"]);
    assert.deepEqual(map.pages[0]!.ui.fields, ["Title"]);
    assert.ok(map.pages[0]!.ui.texts.includes("Added"));
    const text = formatAppMap(map);
    assert.match(text, /^App map: Tauri 2\.12/);
    assert.match(text, /Commands \(4\)/);
    assert.match(text, /INVOKE clear_done .*\n {2}tx\{ INSERT archive · DELETE FROM todos WHERE done = 1 \}/);
  });

  it("is not a Tauri app without tauri.conf.json", async () => {
    assert.equal(await findTauriApp(join(root, "src")), undefined);
  });
});
