# windtunnel-tauri

Runs a Tauri v2 app for Wind Tunnel, in the background:

- Its windows are created hidden, on a blank page, and macOS never brings the app forward.
  There's no Dock icon, and the keyboard stays with whoever has it.
- Its frontend is served on `127.0.0.1:$WINDTUNNEL_PORT`, with a small script in place of the
  ones Tauri injects into its own web view. Headless WebKit loads it from there.
- Each `invoke("save_note", …)` from that page is a `POST /__windtunnel/invoke/save_note`. The
  plugin hands it to the app's IPC as if its own window had sent it, on the main thread like
  Tauri does. So it runs the real command, with the app's real state, permissions and plugins.
  Wind Tunnel's seam sits on that request: it can hold it, delay it, repeat it or reorder it.
- The app's events reach the page as a server-sent event stream.

None of this happens unless `WINDTUNNEL_PORT` is set. Build the crate into dev builds only,
behind a cargo feature. The server answers anyone on 127.0.0.1, so it is a test harness, not
something to ship.

## Add it to an app

`src-tauri/Cargo.toml`:

```toml
[dependencies]
windtunnel-tauri = { path = "<path to this folder>", optional = true }

[features]
windtunnel = ["dep:windtunnel-tauri"]
```

Where the app runs (usually `main.rs` or `lib.rs`), replace `builder.run(context)`:

```rust
let context = tauri::generate_context!();
#[cfg(feature = "windtunnel")]
windtunnel_tauri::run(builder, context);
#[cfg(not(feature = "windtunnel"))]
builder.run(context).expect("error while running tauri application");
```

The change has to be at the app's `run`, not in a plugin. Tauri's window library brings the app
forward when it launches, before any plugin or `setup` hook runs, so the activation policy has
to be set between `build()` and `run()`.

`windtunnel.config.yaml` at the app's root:

```yaml
app:
  kind: tauri
  build: >-
    cargo build --quiet --manifest-path src-tauri/Cargo.toml --features windtunnel &&
    cp "$CARGO_TARGET_DIR/debug/<binary>" windtunnel-app
  start: ./windtunnel-app
db:
  kind: sqlite
  file: Library/Application Support/<identifier>/<file>.db   # where app_data_dir() puts it, under the run's HOME
  seed: <command that fills $DATABASE_PATH>
```

Wind Tunnel sets `$CARGO_TARGET_DIR` to one build folder per project, so a new code version
recompiles only the app's own crates. Each version copies its binary out of that folder. Add
a frontend build before `cargo build` if the app has one. Each run's `$HOME` is its own data
folder, so `app_data_dir()` starts empty or from the seed snapshot.

## Not yet

- `Channel` arguments: messages a command sends through a channel go to the hidden window, not
  the page.
- `convertFileSrc` and the asset protocol.
- An event emitted to one window reaches every page.
- Windows the app creates in code, after launch, are hidden only if the app creates them with
  `visible(false)`.
