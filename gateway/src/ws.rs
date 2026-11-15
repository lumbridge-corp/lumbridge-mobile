//! One WebSocket = one `hc connect` child; one WebSocket message = one core frame.
//! The JSON-RPC allowlist lives here. Who may connect is `auth`'s job.

use crate::{auth, hc, AppState};
use axum::{
    extract::{
        ws::{Message, WebSocket},
        ConnectInfo, State, WebSocketUpgrade,
    },
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{
    net::SocketAddr,
    process::Stdio,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

const CORE_DOWN: &str = r#"{"error":"core_down"}"#;
const HEADER: usize = 9;
const DATA: u8 = 0;
const MAX_FROM_CORE: usize = 16 * 1024 * 1024;
const MAX_FROM_CLIENT: usize = 1024 * 1024;
/// A core that took the connection and then says nothing is hung. The client retries; nothing may pile up meanwhile.
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
/// A client that has stopped reading is gone, whatever TCP thinks.
const SEND_TIMEOUT: Duration = Duration::from_secs(30);

/// Everything else (terminal.run, machine.exec, file.*, server.stop, ...) is refused.
const ALLOWED: &[&str] = &[
    "terminal.list",
    "terminal.get",
    "terminal.read",
    "terminal.attach",
    "terminal.send",
    "terminal.keys",
    "terminal.interrupt",
    "terminal.label",
    "events.subscribe",
    "machine.list",
];

/// The one document the app may read: the desktop's layout (machine, space, tab, panes), for the Panes screen.
/// `doc.get` is otherwise refused, because other documents may hold anything, and `doc.set` always is.
const READABLE_DOC: &str = "lumbridge-app";

fn frame(channel: u32, kind: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(HEADER + payload.len());
    out.extend_from_slice(&channel.to_le_bytes());
    out.push(kind);
    out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    out.extend_from_slice(payload);
    out
}

/// What the keepalive does after this long without a word from the client. A live client is always talking: core's 15 s
/// heartbeat comes back as CREDIT. So a ping only goes out once that has stopped, and adds no traffic while it's working.
/// A phone that has gone to sleep can't answer and is hung up on, which ends the heartbeat too, so nothing keeps waking its
/// radio; it reconnects when it's opened (`checkAlive` in web/src/main.ts).
#[derive(Debug, PartialEq)]
enum Keepalive {
    Quiet,
    Ping,
    Dead,
}

fn keepalive(heard_ago: Duration, dead_after: Duration) -> Keepalive {
    if heard_ago >= dead_after {
        Keepalive::Dead
    } else if heard_ago >= dead_after / 3 {
        Keepalive::Ping
    } else {
        Keepalive::Quiet
    }
}

enum Verdict {
    /// Pass the client's bytes through.
    Forward,
    /// Pass these bytes instead: what the check read, rebuilt, so core can't read the client's bytes differently.
    Rewrite(Vec<u8>),
    Refuse(Vec<u8>),
    Drop,
}

/// `doc.get` of the layout, on this core or a named machine, and nothing else. Exactly `name`, optionally `on`, both strings.
/// A repeated key reads as its last value here, as it does in core, and the call is rebuilt from what was read
/// (`Verdict::Rewrite`), so a repeat, an extra top-level key or an escape can't reach core at all.
fn layout_read(call: &Value) -> Option<Vec<u8>> {
    let params = call["params"].as_object()?;
    if params.keys().any(|k| k != "name" && k != "on") || params.get("name")?.as_str()? != READABLE_DOC {
        return None;
    }
    let mut clean = json!({"name": READABLE_DOC});
    if let Some(on) = params.get("on") {
        // Null means "this core" to core. Say that by leaving it out, so only one spelling gets through.
        if !on.is_null() {
            let on = on.as_str().filter(|m| !m.is_empty())?;
            clean["on"] = json!(on);
        }
    }
    let rebuilt = json!({"jsonrpc": "2.0", "id": call["id"], "method": "doc.get", "params": clean});
    Some(frame(0, DATA, rebuilt.to_string().as_bytes()))
}

/// What to do with one frame from the client. Streams are the core's to police;
/// channel 0 is the API, and only allowed calls reach it.
fn inspect(msg: &[u8]) -> Verdict {
    if msg.len() < HEADER {
        return Verdict::Drop;
    }
    let channel = u32::from_le_bytes(msg[0..4].try_into().unwrap());
    let kind = msg[4];
    let len = u32::from_le_bytes(msg[5..9].try_into().unwrap()) as usize;
    if msg.len() != HEADER + len {
        return Verdict::Drop;
    }
    if channel != 0 {
        return Verdict::Forward;
    }
    if kind != DATA {
        return Verdict::Drop;
    }
    let Ok(call) = serde_json::from_slice::<Value>(&msg[HEADER..]) else {
        return Verdict::Drop;
    };
    let method = call["method"].as_str().unwrap_or("");
    if ALLOWED.contains(&method) {
        return Verdict::Forward;
    }
    if method == "doc.get" {
        if let Some(rebuilt) = layout_read(&call) {
            return Verdict::Rewrite(rebuilt);
        }
    }
    let reply = json!({
        "jsonrpc": "2.0",
        "id": call["id"],
        "error": {"code": -32000, "message": format!("{method} is not allowed from Lumbridge"),
                  "data": {"kind": "not_allowed"}}
    });
    Verdict::Refuse(frame(0, DATA, reply.to_string().as_bytes()))
}

pub async fn ws(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    if let Err(why) = auth::admit(&state, &headers, peer).await {
        eprintln!("refused: {why}");
        return StatusCode::FORBIDDEN.into_response();
    }
    upgrade
        .max_message_size(MAX_FROM_CLIENT)
        .on_upgrade(move |socket| async move {
            if let Err(e) = session(socket, state, peer).await {
                eprintln!("session ended: {e}");
            }
        })
}

async fn session(mut socket: WebSocket, state: Arc<AppState>, peer: SocketAddr) -> Result<(), String> {
    // The browser can't set headers on a WebSocket, so the token is the first message.
    let first = tokio::time::timeout(Duration::from_secs(5), socket.recv())
        .await
        .map_err(|_| "no token in time")?;
    let Some(Ok(Message::Text(token))) = first else {
        return Err("expected a token".into());
    };
    match auth::check_token(&state, peer.ip(), token.as_str()) {
        // An agent never gets a terminal: /ws isn't on its list, and this token never passed the gate's check of it.
        auth::TokenCheck::Good
            if state.auth.devices.check_device(token.as_str()).is_some_and(|(_, role)| role == crate::devices::Role::Agent)
                && !auth::agent_may(&axum::http::Method::GET, "/ws", None) =>
        {
            let _ = socket.send(Message::Text(r#"{"error":"agent_not_allowed"}"#.into())).await;
            return Err("an agent device asked for /ws".into());
        }
        auth::TokenCheck::Good => {}
        auth::TokenCheck::Bad => {
            let _ = socket.send(Message::Text(r#"{"error":"bad_token"}"#.into())).await;
            return Err("bad token".into());
        }
        // Not the same thing to the client: this one passes, so it keeps retrying rather than asking to pair again.
        auth::TokenCheck::TooManyFailures => {
            let _ = socket.send(Message::Text(r#"{"error":"rate_limited"}"#.into())).await;
            return Err("too many failed attempts".into());
        }
    }

    // `hc connect` would start a core if there isn't one, and that isn't ours to do (see `hc`). Not an error: the client
    // keeps trying quietly, and the desktop session brings core up.
    if !hc::running().await {
        let _ = socket.send(Message::Text(CORE_DOWN.into())).await;
        return Ok(());
    }

    let mut child = hc::connect(&state.cfg.hc)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("hc connect: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let mut stdout = BufReader::new(child.stdout.take().ok_or("no stdout")?);

    // Plain-mode handshake; everything after its reply is frames.
    let hello = json!({"jsonrpc":"2.0","id":0,"method":"hello","params":{"framed":true}});
    stdin
        .write_all(format!("{hello}\n").as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    let mut line = String::new();
    let answered = tokio::time::timeout(HELLO_TIMEOUT, stdout.read_line(&mut line)).await;
    let framed = match answered {
        Ok(Ok(_)) => serde_json::from_str::<Value>(&line).is_ok_and(|reply| reply["result"]["framed"] == true),
        _ => false,
    };
    if !framed {
        let _ = socket.send(Message::Text(CORE_DOWN.into())).await;
        return Err("core didn't answer hello".into());
    }
    socket
        .send(Message::Text(line.trim().to_string()))
        .await
        .map_err(|e| e.to_string())?;

    let (mut tx, mut rx) = socket.split();
    let (out, mut out_rx) = tokio::sync::mpsc::channel::<Message>(64);
    let heard = Arc::new(Mutex::new(Instant::now()));
    let dead_after = state.cfg.ws_dead_after;

    let keep_alive = {
        let out = out.clone();
        let heard = heard.clone();
        async move {
            let mut tick = tokio::time::interval((dead_after / 9).max(Duration::from_millis(100)));
            loop {
                tick.tick().await;
                let ago = heard.lock().unwrap().elapsed();
                match keepalive(ago, dead_after) {
                    Keepalive::Quiet => {}
                    // Full means the client isn't reading, which SEND_TIMEOUT is about to deal with.
                    Keepalive::Ping => drop(out.try_send(Message::Ping(Vec::new()))),
                    Keepalive::Dead => return Err::<(), String>("client went quiet".into()),
                }
            }
        }
    };

    let from_core = {
        let out = out.clone();
        async move {
            loop {
                let mut msg = vec![0u8; HEADER];
                stdout.read_exact(&mut msg).await.map_err(|e| format!("core: {e}"))?;
                let len = u32::from_le_bytes(msg[5..9].try_into().unwrap()) as usize;
                if len > MAX_FROM_CORE {
                    return Err::<(), String>("oversized frame from core".into());
                }
                msg.resize(HEADER + len, 0);
                stdout.read_exact(&mut msg[HEADER..]).await.map_err(|e| format!("core: {e}"))?;
                if out.send(Message::Binary(msg)).await.is_err() {
                    return Ok(());
                }
            }
        }
    };
    let from_client = async move {
        while let Some(msg) = rx.next().await {
            let msg = msg.map_err(|e| e.to_string())?;
            *heard.lock().unwrap() = Instant::now();
            let Message::Binary(bytes) = msg else {
                continue;
            };
            match inspect(&bytes) {
                Verdict::Forward => stdin.write_all(&bytes).await.map_err(|e| e.to_string())?,
                Verdict::Rewrite(rebuilt) => stdin.write_all(&rebuilt).await.map_err(|e| e.to_string())?,
                Verdict::Refuse(reply) => {
                    if out.send(Message::Binary(reply)).await.is_err() {
                        break;
                    }
                }
                Verdict::Drop => {}
            }
        }
        Ok::<(), String>(())
    };
    let to_client = async move {
        while let Some(msg) = out_rx.recv().await {
            match tokio::time::timeout(SEND_TIMEOUT, tx.send(msg)).await {
                Ok(sent) => sent.map_err(|e| e.to_string())?,
                Err(_) => return Err("client stopped reading".into()),
            }
        }
        Ok::<(), String>(())
    };

    // Whichever side ends first ends the session; dropping `child` kills it. So does revoking the device.
    tokio::select! {
        () = auth::until_revoked(&state, token.as_str()) => Err("device revoked".into()),
        r = from_core => r,
        r = from_client => r,
        r = to_client => r,
        r = keep_alive => r,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(method: &str) -> Vec<u8> {
        frame(0, DATA, json!({"jsonrpc":"2.0","id":7,"method":method,"params":{}}).to_string().as_bytes())
    }

    #[test]
    fn only_allowed_methods_reach_the_core() {
        assert!(matches!(inspect(&call("terminal.list")), Verdict::Forward));
        for bad in ["terminal.run", "machine.exec", "file.write", "server.stop", "hello", "terminal.kill"] {
            assert!(matches!(inspect(&call(bad)), Verdict::Refuse(_)), "{bad}");
        }
    }

    /// A call written out by hand, so a test can say things `json!` can't, like the same key twice.
    fn raw(text: &str) -> Vec<u8> {
        frame(0, DATA, text.as_bytes())
    }
    fn doc_get(params: &str) -> Vec<u8> {
        raw(&format!(r#"{{"jsonrpc":"2.0","id":9,"method":"doc.get","params":{params}}}"#))
    }
    fn refused(msg: &[u8]) -> bool {
        match inspect(msg) {
            Verdict::Refuse(reply) => {
                let reply: Value = serde_json::from_slice(&reply[HEADER..]).unwrap();
                reply["error"]["data"]["kind"] == "not_allowed" && reply["id"] == 9
            }
            _ => false,
        }
    }
    /// What core would receive, parsed.
    fn forwarded(msg: &[u8]) -> Value {
        match inspect(msg) {
            Verdict::Rewrite(out) => {
                let len = u32::from_le_bytes(out[5..9].try_into().unwrap()) as usize;
                assert_eq!(out.len(), HEADER + len, "a well-formed frame");
                assert_eq!(&out[0..5], &[0, 0, 0, 0, DATA], "channel 0, data");
                serde_json::from_slice(&out[HEADER..]).unwrap()
            }
            _ => panic!("expected the call to be forwarded"),
        }
    }

    #[test]
    fn the_layout_document_can_be_read_here_and_on_a_machine() {
        let here = forwarded(&doc_get(r#"{"name":"lumbridge-app"}"#));
        assert_eq!(here["method"], "doc.get");
        assert_eq!(here["id"], 9);
        assert_eq!(here["params"], json!({"name":"lumbridge-app"}));
        let there = forwarded(&doc_get(r#"{"name":"lumbridge-app","on":"gpu"}"#));
        assert_eq!(there["params"], json!({"name":"lumbridge-app","on":"gpu"}));
        let null = forwarded(&doc_get(r#"{"name":"lumbridge-app","on":null}"#));
        assert_eq!(null["params"], json!({"name":"lumbridge-app"}));
    }

    #[test]
    fn no_other_document_can_be_read() {
        for params in [
            r#"{"name":"secret"}"#,
            r#"{"name":"lumbridge-app2"}"#,
            r#"{"name":"lumbridge-app "}"#,
            r#"{"name":"LUMBRIDGE-APP"}"#,
            r#"{"name":"secret","on":"build-box"}"#,
            r#"{"on":"build-box"}"#,
            r#"{}"#,
            r#"{"name":null}"#,
            r#"{"name":["lumbridge-app"]}"#,
            r#"{"name":{"name":"lumbridge-app"}}"#,
            r#"["lumbridge-app"]"#,
            r#""lumbridge-app""#,
            r#"null"#,
        ] {
            assert!(refused(&doc_get(params)), "{params}");
        }
        assert!(refused(&raw(r#"{"jsonrpc":"2.0","id":9,"method":"doc.get"}"#)), "no params at all");
    }

    #[test]
    fn the_layout_read_takes_no_other_params() {
        for params in [
            r#"{"name":"lumbridge-app","value":1}"#,
            r#"{"name":"lumbridge-app","version":0}"#,
            r#"{"name":"lumbridge-app","on":"gpu","extra":true}"#,
            r#"{"name":"lumbridge-app","on":7}"#,
            r#"{"name":"lumbridge-app","on":""}"#,
            r#"{"name":"lumbridge-app","on":["gpu"]}"#,
        ] {
            assert!(refused(&doc_get(params)), "{params}");
        }
    }

    #[test]
    fn a_repeated_key_means_what_it_means_to_core_and_only_that_is_sent() {
        // serde_json keeps the last one, here and in core, and core gets only what was checked.
        let last_wins = doc_get(r#"{"name":"secret","name":"lumbridge-app"}"#);
        let sent = forwarded(&last_wins);
        assert_eq!(sent["params"], json!({"name":"lumbridge-app"}));
        match inspect(&last_wins) {
            Verdict::Rewrite(out) => assert!(!String::from_utf8_lossy(&out).contains("secret")),
            _ => panic!("expected a rewrite"),
        }
        assert!(refused(&doc_get(r#"{"name":"lumbridge-app","name":"secret"}"#)));
        assert_eq!(forwarded(&doc_get(r#"{"name":"lumbridge-app","on":"a","on":"b"}"#))["params"]["on"], "b");
        // The same goes for the call around the params, and for spelling the key with an escape.
        assert!(refused(&raw(r#"{"id":9,"method":"doc.get","method":"doc.set","params":{"name":"lumbridge-app","value":1,"version":0}}"#)));
        let methods = raw(r#"{"id":9,"method":"doc.set","method":"doc.get","params":{"name":"lumbridge-app"}}"#);
        assert_eq!(forwarded(&methods)["method"], "doc.get");
        let two_params = raw(r#"{"id":9,"method":"doc.get","params":{"name":"secret"},"params":{"name":"lumbridge-app"}}"#);
        assert_eq!(forwarded(&two_params)["params"], json!({"name":"lumbridge-app"}));
        let top_level_extra = raw(r#"{"id":9,"method":"doc.get","params":{"name":"lumbridge-app"},"on":"gpu","name":"secret"}"#);
        assert_eq!(forwarded(&top_level_extra), json!({"jsonrpc":"2.0","id":9,"method":"doc.get","params":{"name":"lumbridge-app"}}));
        assert!(refused(&doc_get(r#"{"n\u0061me":"secret"}"#)));
        assert_eq!(forwarded(&doc_get(r#"{"n\u0061me":"lumbridge-app"}"#))["params"], json!({"name":"lumbridge-app"}));
    }

    #[test]
    fn documents_stay_unwritable() {
        for params in [
            r#"{"name":"lumbridge-app","value":{"spaces":[]},"version":1}"#,
            r#"{"name":"lumbridge-app","value":null,"version":1}"#,
            r#"{"name":"lumbridge-app","on":"gpu","value":{},"version":1}"#,
        ] {
            let call = raw(&format!(r#"{{"jsonrpc":"2.0","id":9,"method":"doc.set","params":{params}}}"#));
            assert!(refused(&call), "{params}");
        }
    }

    #[test]
    fn malformed_frames_are_dropped() {
        assert!(matches!(inspect(&[1, 2, 3]), Verdict::Drop));
        let mut short = call("terminal.list");
        short.pop();
        assert!(matches!(inspect(&short), Verdict::Drop));
        assert!(matches!(inspect(&frame(0, DATA, b"not json")), Verdict::Drop));
        assert!(matches!(inspect(&frame(0, 3, &[0; 4])), Verdict::Drop));
    }

    #[test]
    fn keepalive_only_pings_a_client_that_has_gone_quiet() {
        let dead = Duration::from_secs(90);
        let at = |s| keepalive(Duration::from_secs(s), dead);
        assert_eq!(at(0), Keepalive::Quiet);
        assert_eq!(at(29), Keepalive::Quiet, "core's 15 s heartbeat brings CREDIT back well inside this");
        assert_eq!(at(30), Keepalive::Ping);
        assert_eq!(at(89), Keepalive::Ping);
        assert_eq!(at(90), Keepalive::Dead);
    }

    #[test]
    fn stream_frames_pass_through() {
        assert!(matches!(inspect(&frame(5, DATA, b"hi")), Verdict::Forward));
    }
}
