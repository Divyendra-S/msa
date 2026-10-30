//! Runs a Tauri app for Wind Tunnel: in the background, never brought forward, with its frontend
//! served over HTTP to a test browser whose `invoke` calls reach the app's real commands. Does
//! nothing unless `WINDTUNNEL_PORT` is set. Build it into dev builds only, behind a cargo feature:
//!
//! ```ignore
//! let context = tauri::generate_context!();
//! #[cfg(feature = "windtunnel")]
//! windtunnel_tauri::run(builder, context);
//! #[cfg(not(feature = "windtunnel"))]
//! builder.run(context).expect("error while running tauri application");
//! ```
//!
//! The server listens on 127.0.0.1 only and answers anyone there: it is a test harness, not
//! something to ship.

use std::collections::HashSet;
use std::io::{Cursor, Write};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use tauri::http::{HeaderMap, HeaderName, HeaderValue};
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponse, InvokeResponseBody};
use tauri::webview::InvokeRequest;
use tauri::{AppHandle, Builder, Context, Listener, Manager, RunEvent, Runtime, Url, WebviewUrl};

/// A call to a command: `POST /__windtunnel/invoke/<command>` with the arguments as the body.
const INVOKE: &str = "/__windtunnel/invoke/";
/// The app's events, as a server-sent event stream.
const EVENTS: &str = "/__windtunnel/events";
/// Starts forwarding one event name to the stream.
const LISTEN: &str = "/__windtunnel/listen";
/// The page's stand-in for the scripts Tauri injects into its own web view.
const SCRIPT: &str = "/__windtunnel/tauri.js";
const COMMAND_TIMEOUT: Duration = Duration::from_secs(120);

/// Runs the app. Under Wind Tunnel its windows are hidden on a blank page and its calls are
/// served on `WINDTUNNEL_PORT`; otherwise this is `builder.run(context)`.
pub fn run<R: Runtime>(builder: Builder<R>, mut context: Context<R>) {
    let port = match std::env::var("WINDTUNNEL_PORT") {
        Ok(port) => port
            .parse::<u16>()
            .expect("WINDTUNNEL_PORT is not a port number"),
        Err(_) => {
            return builder
                .run(context)
                .expect("error while running tauri application")
        }
    };
    for window in &mut context.config_mut().app.windows {
        // The frontend runs in the test browser; the app's own windows stay hidden and empty.
        window.visible = false;
        window.focus = false;
        window.url = WebviewUrl::External("about:blank".parse().unwrap());
    }
    #[allow(unused_mut)]
    let mut app = builder
        .build(context)
        .expect("error while building tauri application");
    // Before launch, or macOS brings the app forward and takes the keyboard from whoever has it.
    #[cfg(target_os = "macos")]
    app.set_activation_policy(tauri::ActivationPolicy::Prohibited);
    app.run(move |handle, event| {
        if let RunEvent::Ready = event {
            serve(handle.clone(), port);
        }
    });
}

fn serve<R: Runtime>(app: AppHandle<R>, port: u16) {
    let server = tiny_http::Server::http(("127.0.0.1", port))
        .unwrap_or_else(|err| panic!("windtunnel: can't listen on port {port}: {err}"));
    let events = Arc::new(Events::default());
    thread::spawn(move || {
        for request in server.incoming_requests() {
            let (app, events) = (app.clone(), events.clone());
            thread::spawn(move || handle(&app, &events, request));
        }
    });
}

fn handle<R: Runtime>(app: &AppHandle<R>, events: &Arc<Events>, mut request: tiny_http::Request) {
    let path = request.url().split('?').next().unwrap_or("/").to_string();
    let reply = if let Some(command) = path.strip_prefix(INVOKE) {
        let mut body = Vec::new();
        let _ = request.as_reader().read_to_end(&mut body);
        invoke(
            app,
            percent_decode(command),
            body,
            header_map(request.headers()),
        )
    } else if path == EVENTS {
        return events.stream(request);
    } else if path == LISTEN {
        let mut body = Vec::new();
        let _ = request.as_reader().read_to_end(&mut body);
        match serde_json::from_slice::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v["event"].as_str().map(String::from))
        {
            Some(event) => {
                events.listen(app, event);
                Reply::new(204, "text/plain", Vec::new())
            }
            None => Reply::new(
                400,
                "text/plain",
                b"expected {\"event\": \"<name>\"}".to_vec(),
            ),
        }
    } else if path == SCRIPT {
        Reply::new(200, "text/javascript", page_script(app).into_bytes())
    } else {
        asset(app, &path)
    };
    let _ = request.respond(reply.into_response());
}

/// The window calls run in: the main one, or any.
fn target_webview<R: Runtime>(app: &AppHandle<R>) -> Option<tauri::WebviewWindow<R>> {
    app.get_webview_window("main")
        .or_else(|| app.webview_windows().into_values().next())
}

/// Hands a call to the app's IPC as if its own web view had sent it, and waits for the answer.
fn invoke<R: Runtime>(app: &AppHandle<R>, cmd: String, body: Vec<u8>, headers: HeaderMap) -> Reply {
    let Some(webview) = target_webview(app) else {
        return Reply::new(503, "text/plain", b"the app has no web view yet".to_vec());
    };
    let json = headers
        .get("content-type")
        .is_none_or(|value| value.as_bytes().starts_with(b"application/json"));
    let body = if !json {
        InvokeBody::Raw(body)
    } else if body.is_empty() {
        InvokeBody::Json(serde_json::Value::Object(Default::default()))
    } else {
        match serde_json::from_slice(&body) {
            Ok(value) => InvokeBody::Json(value),
            Err(err) => {
                return Reply::new(
                    400,
                    "text/plain",
                    format!("the call's body is not JSON: {err}").into_bytes(),
                )
            }
        }
    };
    let request = InvokeRequest {
        cmd,
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: local_url(),
        body,
        headers,
        invoke_key: app.invoke_key().to_string(),
    };
    let (answered, answer) = mpsc::channel();
    // On the main thread, like the app's own IPC: commands that aren't async run there.
    let dispatched = app.run_on_main_thread(move || {
        webview.on_message(
            request,
            Box::new(move |_, _, response, _, _| {
                let _ = answered.send(response);
            }),
        )
    });
    if dispatched.is_err() {
        return Reply::new(503, "text/plain", b"the app is shutting down".to_vec());
    }
    match answer.recv_timeout(COMMAND_TIMEOUT) {
        Ok(InvokeResponse::Ok(InvokeResponseBody::Json(json))) => {
            Reply::new(200, "application/json", json.into_bytes()).tauri("ok")
        }
        Ok(InvokeResponse::Ok(InvokeResponseBody::Raw(bytes))) => {
            Reply::new(200, "application/octet-stream", bytes).tauri("ok")
        }
        // A command that returned an error: the page's invoke() rejects with it.
        Ok(InvokeResponse::Err(err)) => Reply::new(
            400,
            "application/json",
            serde_json::to_vec(&err.0).unwrap_or_default(),
        )
        .tauri("error"),
        Err(RecvTimeoutError::Timeout) => Reply::new(
            504,
            "text/plain",
            b"the command did not answer in time".to_vec(),
        ),
        Err(RecvTimeoutError::Disconnected) => {
            Reply::new(500, "text/plain", b"the app dropped the call".to_vec())
        }
    }
}

/// The address Tauri's own pages have, so the app's permissions treat calls as local.
fn local_url() -> Url {
    let url = if cfg!(any(windows, target_os = "android")) {
        "http://tauri.localhost/"
    } else {
        "tauri://localhost/"
    };
    url.parse().unwrap()
}

fn asset<R: Runtime>(app: &AppHandle<R>, path: &str) -> Reply {
    let Some(asset) = app.asset_resolver().get(path.to_string()) else {
        return Reply::new(404, "text/plain", b"not found".to_vec());
    };
    // Served without the app's CSP, which names Tauri's own protocols and not this address.
    if asset.mime_type.starts_with("text/html") {
        return Reply::new(200, "text/html", with_script(&asset.bytes));
    }
    Reply::owned(200, asset.mime_type, asset.bytes)
}

/// The page with the stand-in script first in its head, before any of the app's own scripts.
fn with_script(html: &[u8]) -> Vec<u8> {
    let tag = format!("<script src=\"{SCRIPT}\"></script>");
    let text = String::from_utf8_lossy(html);
    let lower = text.to_ascii_lowercase();
    let at = lower
        .find("<head")
        .and_then(|start| lower[start..].find('>').map(|end| start + end + 1))
        .or_else(|| lower.find("<script"))
        .unwrap_or(0);
    format!("{}{tag}{}", &text[..at], &text[at..]).into_bytes()
}

fn page_script<R: Runtime>(app: &AppHandle<R>) -> String {
    let label = target_webview(app)
        .map(|w| w.label().to_string())
        .unwrap_or_else(|| "main".into());
    include_str!("tauri.js")
        .replace(
            "__WINDTUNNEL_LABEL__",
            &serde_json::to_string(&label).unwrap(),
        )
        .replace(
            "__WINDTUNNEL_GLOBAL_TAURI__",
            if app.config().app.with_global_tauri {
                "true"
            } else {
                "false"
            },
        )
}

/// Forwards the app's events to every open stream, by name, once a page listens for them.
#[derive(Default)]
struct Events {
    names: Mutex<HashSet<String>>,
    streams: Mutex<Vec<Sender<String>>>,
}

impl Events {
    fn listen<R: Runtime>(self: &Arc<Self>, app: &AppHandle<R>, name: String) {
        if !self.names.lock().unwrap().insert(name.clone()) {
            return;
        }
        let events = self.clone();
        let quoted = serde_json::to_string(&name).unwrap();
        app.listen_any(name, move |event| {
            let message = format!("{{\"event\":{quoted},\"payload\":{}}}", event.payload());
            events
                .streams
                .lock()
                .unwrap()
                .retain(|stream| stream.send(message.clone()).is_ok());
        });
    }

    fn stream(&self, request: tiny_http::Request) {
        let (sender, receiver) = mpsc::channel();
        self.streams.lock().unwrap().push(sender);
        let mut out = request.into_writer();
        let head = b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n";
        if out.write_all(head).and_then(|_| out.flush()).is_err() {
            return;
        }
        loop {
            let chunk = match receiver.recv_timeout(Duration::from_secs(15)) {
                Ok(message) => format!("data: {message}\n\n"),
                // A comment now and then finds out when the page has gone.
                Err(RecvTimeoutError::Timeout) => ":\n\n".to_string(),
                Err(RecvTimeoutError::Disconnected) => return,
            };
            if out
                .write_all(chunk.as_bytes())
                .and_then(|_| out.flush())
                .is_err()
            {
                return;
            }
        }
    }
}

struct Reply {
    status: u16,
    content_type: String,
    body: Vec<u8>,
    tauri: Option<&'static str>,
}

impl Reply {
    fn new(status: u16, content_type: &str, body: Vec<u8>) -> Self {
        Self::owned(status, content_type.to_string(), body)
    }

    fn owned(status: u16, content_type: String, body: Vec<u8>) -> Self {
        Reply {
            status,
            content_type,
            body,
            tauri: None,
        }
    }

    /// Marks a command's answer as Tauri's IPC does: `ok` or `error`.
    fn tauri(mut self, outcome: &'static str) -> Self {
        self.tauri = Some(outcome);
        self
    }

    fn into_response(self) -> tiny_http::Response<Cursor<Vec<u8>>> {
        let header = |name: &str, value: &str| tiny_http::Header::from_bytes(name, value).unwrap();
        let mut response = tiny_http::Response::from_data(self.body)
            .with_status_code(self.status)
            .with_header(header("Content-Type", &self.content_type))
            .with_header(header("Cache-Control", "no-store"));
        if let Some(outcome) = self.tauri {
            response.add_header(header("Tauri-Response", outcome));
        }
        response
    }
}

fn header_map(headers: &[tiny_http::Header]) -> HeaderMap {
    let mut map = HeaderMap::new();
    for header in headers {
        let name = header.field.as_str().as_str();
        if matches!(
            name.to_ascii_lowercase().as_str(),
            "host" | "connection" | "content-length"
        ) {
            continue;
        }
        if let (Ok(name), Ok(value)) = (
            HeaderName::from_bytes(name.as_bytes()),
            HeaderValue::from_bytes(header.value.as_bytes()),
        ) {
            map.append(name, value);
        }
    }
    map
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = bytes
            .get(i + 1..i + 3)
            .and_then(|h| std::str::from_utf8(h).ok())
            .and_then(|h| u8::from_str_radix(h, 16).ok());
        match (bytes[i], hex) {
            (b'%', Some(byte)) => {
                out.push(byte);
                i += 3;
            }
            (byte, _) => {
                out.push(byte);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_command_names() {
        assert_eq!(percent_decode("save_note"), "save_note");
        assert_eq!(percent_decode("plugin%3Aevent%7Cemit"), "plugin:event|emit");
        assert_eq!(percent_decode("bad%zz"), "bad%zz");
    }

    #[test]
    fn puts_the_script_first_in_the_head() {
        let page = String::from_utf8(with_script(b"<!doctype html><html><head><title>x</title><script src=\"a.js\"></script></head></html>")).unwrap();
        assert!(page.starts_with(
            "<!doctype html><html><head><script src=\"/__windtunnel/tauri.js\"></script><title>"
        ));
        let bare =
            String::from_utf8(with_script(b"<body><script src=\"a.js\"></script></body>")).unwrap();
        assert!(bare.starts_with(
            "<body><script src=\"/__windtunnel/tauri.js\"></script><script src=\"a.js\">"
        ));
    }
}
