//! `POST /mcp`: the owner's notes as MCP tools, for Claude Code on any of the owner's machines and any agent device:
//!   claude mcp add --transport http lumbridge-notes https://mobile.example.com/mcp --header "Authorization: Bearer <token>"
//!
//! MCP's streamable HTTP transport with JSON answers only: no event stream, no sessions. A request gets its answer as the response
//! body; a notification gets 202 and nothing. Every other method on /mcp is the router's 405, which a client takes to mean "no
//! stream here". The device token is the same as everywhere, and the gate holds an agent device to `auth::agent_may`, so these
//! tools are all an agent can do: search and read notes, propose one, and see what became of its own proposals.

use crate::{
    auth::Caller,
    data::{
        notes,
        proposals::{self, Fail, NewProposal},
        search_terms, ApiError,
    },
    AppState,
};
use axum::{
    body::Bytes,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use uuid::Uuid;

/// Newest first. A client asking for one of these gets it; any other gets the newest.
const PROTOCOL_VERSIONS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_SEARCH: i64 = 20;

const PARSE_ERROR: i64 = -32700;
const INVALID_REQUEST: i64 = -32600;
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;
const INTERNAL_ERROR: i64 = -32603;
/// Server errors: what was asked for isn't there, or isn't allowed now.
const NOT_FOUND: i64 = -32001;
const REFUSED: i64 = -32002;

const INSTRUCTIONS: &str = "The owner's notes, from Lumbridge. They are the owner's: what they wrote down, about things that have \
already happened. Search them before you ask the owner something they may have written down. You can't change a note. If \
something is worth keeping, propose it with note_propose: it waits in the owner's For you list and does nothing unless they keep it.";

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/mcp", post(mcp))
}

type RpcError = (i64, String);

fn reply(id: Value, result: Result<Value, RpcError>) -> Value {
    match result {
        Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
        Err((code, message)) => json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}}),
    }
}

async fn mcp(c: Caller, State(state): State<Arc<AppState>>, body: Bytes) -> Response {
    let Ok(msg) = serde_json::from_slice::<Value>(&body) else {
        let err = reply(Value::Null, Err((PARSE_ERROR, "Parse error: the body isn't JSON".into())));
        return (StatusCode::BAD_REQUEST, Json(err)).into_response();
    };
    let answers = match msg {
        // A batch, as the 2025-03-26 transport allows.
        Value::Array(items) if !items.is_empty() => {
            let mut out = Vec::new();
            for item in items {
                out.extend(one(&state, &c, item).await);
            }
            if out.is_empty() {
                return StatusCode::ACCEPTED.into_response();
            }
            Value::Array(out)
        }
        Value::Array(_) => reply(Value::Null, Err((INVALID_REQUEST, "Invalid Request: an empty batch".into()))),
        item => match one(&state, &c, item).await {
            Some(answer) => answer,
            None => return StatusCode::ACCEPTED.into_response(),
        },
    };
    Json(answers).into_response()
}

/// One message's answer, or None for a notification or a client's response, which get none.
async fn one(state: &AppState, c: &Caller, msg: Value) -> Option<Value> {
    let id = msg.get("id").cloned();
    let method = msg.get("method").and_then(Value::as_str);
    if msg.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Some(reply(id.unwrap_or(Value::Null), Err((INVALID_REQUEST, "Invalid Request: jsonrpc must be \"2.0\"".into()))));
    }
    let Some(method) = method else {
        // A response to something we asked: we never ask, so there's nothing to do with it.
        if msg.get("result").is_some() || msg.get("error").is_some() {
            return None;
        }
        return Some(reply(id.unwrap_or(Value::Null), Err((INVALID_REQUEST, "Invalid Request: no method".into()))));
    };
    // `notifications/initialized`, `notifications/cancelled` and the rest: nothing to say back.
    let id = id?;
    let params = msg.get("params").cloned().unwrap_or(Value::Null);
    let result = match method {
        "initialize" => Ok(initialize(&params)),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({"tools": tools()})),
        "tools/call" => call(state, c, &params).await,
        _ => Err((METHOD_NOT_FOUND, format!("Method not found: {method}"))),
    };
    Some(reply(id, result))
}

fn initialize(params: &Value) -> Value {
    let asked = params.get("protocolVersion").and_then(Value::as_str).unwrap_or("");
    let version = PROTOCOL_VERSIONS.iter().find(|v| **v == asked).unwrap_or(&PROTOCOL_VERSIONS[0]);
    json!({
        "protocolVersion": version,
        "capabilities": {"tools": {"listChanged": false}},
        "serverInfo": {"name": "lumbridge-notes", "title": "Lumbridge notes", "version": env!("CARGO_PKG_VERSION")},
        "instructions": INSTRUCTIONS,
    })
}

fn tools() -> Value {
    json!([
        {
            "name": "notes_search",
            "title": "Search the owner's notes",
            "description": "Search the owner's notes: their own record of what has already happened, what they decided and what they know. \
Read-only. Returns the best matches first, each with its id, title, a snippet around the match and when it last changed. Use \
notes_read for the whole note.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Words to look for. Each word also matches longer words it starts."},
                    "limit": {"type": "integer", "minimum": 1, "maximum": MAX_SEARCH, "description": "At most this many (default 10, at most 20)."}
                },
                "required": ["query"],
                "additionalProperties": false
            },
            "annotations": {"readOnlyHint": true, "openWorldHint": false}
        },
        {
            "name": "notes_read",
            "title": "Read one of the owner's notes",
            "description": "One of the owner's notes in full, by the id notes_search gave. Notes are theirs and describe the past; nothing \
here changes one.",
            "inputSchema": {
                "type": "object",
                "properties": {"id": {"type": "string", "format": "uuid", "description": "The note's id."}},
                "required": ["id"],
                "additionalProperties": false
            },
            "annotations": {"readOnlyHint": true, "openWorldHint": false}
        },
        {
            "name": "note_propose",
            "title": "Propose a note for the owner to keep",
            "description": "Propose a new note: something worth the owner keeping, such as a decision, a fact you found out or how \
something was fixed. This does NOT write a note. It waits for the owner in their For you list, and nothing happens unless they \
keep it; they may edit or drop it. Search first so you don't propose what they already have. At most 30 can wait at once.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "maxLength": proposals::MAX_TITLE_CHARS, "description": "One line."},
                    "body": {"type": "string", "maxLength": proposals::MAX_BODY_CHARS, "description": "The note, as plain text."},
                    "why": {"type": "string", "maxLength": proposals::MAX_WHY_CHARS, "description": "One line on why it's worth keeping."},
                    "source": {"type": "string", "maxLength": proposals::MAX_SOURCE_CHARS, "description": "Where it came from: a trace URL, a session id."}
                },
                "required": ["title", "body", "why"],
                "additionalProperties": false
            },
            "annotations": {"readOnlyHint": false, "destructiveHint": false, "idempotentHint": false, "openWorldHint": false}
        },
        {
            "name": "my_proposals",
            "title": "My note proposals",
            "description": "The notes you proposed, newest first, and what the owner did with each: pending (waiting for them), \
accepted (kept; note_id is the note) or denied (dropped). Only yours.",
            "inputSchema": {
                "type": "object",
                "properties": {"status": {"type": "string", "enum": ["pending", "accepted", "denied", "all"], "description": "Default all."}},
                "additionalProperties": false
            },
            "annotations": {"readOnlyHint": true, "openWorldHint": false}
        }
    ])
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SearchArgs {
    query: String,
    limit: Option<i64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadArgs {
    id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProposeArgs {
    title: String,
    body: String,
    why: String,
    #[serde(default)]
    source: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MineArgs {
    status: Option<String>,
}

fn args<T: serde::de::DeserializeOwned>(tool: &str, v: &Value) -> Result<T, RpcError> {
    let v = if v.is_null() { json!({}) } else { v.clone() };
    serde_json::from_value(v).map_err(|e| (INVALID_PARAMS, format!("{tool}: {e}")))
}

fn db_error(e: ApiError) -> RpcError {
    match e {
        ApiError::Unavailable => (INTERNAL_ERROR, "The notes database isn't reachable right now. Try again later.".into()),
        ApiError::Invalid(code) => (INVALID_PARAMS, format!("refused: {code}")),
        _ => (INTERNAL_ERROR, "the notes database failed on that".into()),
    }
}

/// A tool's answer: the JSON as text for the model, and as structured content for a client that reads it.
fn content(v: Value) -> Value {
    json!({"content": [{"type": "text", "text": serde_json::to_string_pretty(&v).unwrap_or_default()}], "structuredContent": v, "isError": false})
}

async fn call(state: &AppState, c: &Caller, params: &Value) -> Result<Value, RpcError> {
    let name = params.get("name").and_then(Value::as_str).ok_or((INVALID_PARAMS, "tools/call needs a tool name".to_string()))?;
    let a = params.get("arguments").unwrap_or(&Value::Null);
    let db = &state.db;
    match name {
        "notes_search" => {
            let a: SearchArgs = args(name, a)?;
            let Some(ts) = search_terms(&a.query).map_err(|_| (INVALID_PARAMS, "the query is too long".to_string()))? else {
                return Err((INVALID_PARAMS, "the query is empty".into()));
            };
            let limit = a.limit.unwrap_or(10).clamp(1, MAX_SEARCH);
            let hits = notes::search(db, &ts, limit, 0).await.map_err(db_error)?;
            let hits: Vec<Value> = hits
                .into_iter()
                .map(|n| json!({"id": n.id, "title": n.title, "snippet": n.preview, "updated_at": n.updated_at}))
                .collect();
            Ok(content(json!({"notes": hits})))
        }
        "notes_read" => {
            let a: ReadArgs = args(name, a)?;
            let id = Uuid::parse_str(a.id.trim()).map_err(|_| (INVALID_PARAMS, format!("not a note id: {}", a.id)))?;
            let note = notes::current(db, id).await.map_err(db_error)?.filter(|n| n.deleted_at.is_none());
            let n = note.ok_or((NOT_FOUND, format!("no note {id}")))?;
            Ok(content(json!({
                "id": n.id, "title": n.title, "body": n.body, "pinned": n.pinned, "created_at": n.created_at, "updated_at": n.updated_at,
            })))
        }
        "note_propose" => {
            let a: ProposeArgs = args(name, a)?;
            let new = NewProposal { id: None, title: a.title, body: a.body, why: a.why, source: a.source };
            let (_, p) = proposals::propose(db, &c.name, &new).await.map_err(|f| {
                let code = match f {
                    Fail::Invalid(..) => INVALID_PARAMS,
                    Fail::TooManyPending(_) | Fail::IdTaken => REFUSED,
                    Fail::Db(_) => INTERNAL_ERROR,
                };
                (code, f.message())
            })?;
            Ok(content(json!({
                "id": p.id,
                "status": p.status,
                "message": "Proposed. It waits for the owner in For you, and nothing happens unless they keep it.",
            })))
        }
        "my_proposals" => {
            let a: MineArgs = args(name, a)?;
            let status = a.status.as_deref().unwrap_or("all");
            let rows = proposals::fetch(db, Some(&c.name), status, None, 50, 0).await.map_err(db_error)?;
            let rows: Vec<Value> = rows
                .into_iter()
                .map(|p| {
                    json!({"id": p.id, "title": p.title, "why": p.why, "source": p.source, "status": p.status, "note_id": p.note_id,
                           "created_at": p.created_at, "decided_at": p.decided_at})
                })
                .collect();
            Ok(content(json!({"proposals": rows})))
        }
        _ => Err((INVALID_PARAMS, format!("Unknown tool: {name}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{config::Config, devices::Role};
    use axum::{body::Body, extract::ConnectInfo, http::Request};
    use std::net::SocketAddr;
    use tower::ServiceExt;

    async fn post(app: &Router, token: &str, body: &str) -> (StatusCode, Value) {
        let mut req = Request::post("/mcp")
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
            .body(Body::from(body.to_string()))
            .unwrap();
        req.extensions_mut().insert(ConnectInfo(SocketAddr::new("100.64.0.1".parse().unwrap(), 1)));
        let res = app.clone().oneshot(req).await.unwrap();
        let status = res.status();
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    // No database: what doesn't need one answers, and what does says so in words.
    #[tokio::test]
    async fn initialize_list_and_call_without_a_database() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = Config::for_tests(dir.path());
        let state = Arc::new(AppState::new(cfg));
        state.auth.whois.put("100.64.0.1".parse().unwrap(), Ok(()));
        let code = state.auth.devices.begin_pair_as("claude", Role::Agent).unwrap();
        let (_, token) = state.auth.devices.redeem(&code).unwrap();
        let app = crate::app(state.clone());

        let (s, init) = post(&app, &token, r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"claude-code","version":"2"}}}"#).await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(init["id"], 1);
        assert_eq!(init["result"]["protocolVersion"], "2025-03-26");
        assert!(init["result"]["capabilities"]["tools"].is_object());
        assert!(init["result"]["instructions"].as_str().unwrap().contains("The owner's notes"));
        let (s, _) = post(&app, &token, r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#).await;
        assert_eq!(s, StatusCode::ACCEPTED);
        let (_, unknown_version) = post(&app, &token, r#"{"jsonrpc":"2.0","id":"a","method":"initialize","params":{"protocolVersion":"1999-01-01"}}"#).await;
        assert_eq!(unknown_version["result"]["protocolVersion"], PROTOCOL_VERSIONS[0]);

        let (_, list) = post(&app, &token, r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#).await;
        let names: Vec<&str> = list["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["notes_search", "notes_read", "note_propose", "my_proposals"]);
        for t in list["result"]["tools"].as_array().unwrap() {
            assert_eq!(t["inputSchema"]["type"], "object", "{t}");
        }
        let propose = list["result"]["tools"][2]["description"].as_str().unwrap();
        assert!(propose.contains("does NOT write a note") && propose.contains("unless they"), "{propose}");
        assert!(list["result"]["tools"][0]["description"].as_str().unwrap().contains("already happened"));

        let (_, ping) = post(&app, &token, r#"{"jsonrpc":"2.0","id":3,"method":"ping"}"#).await;
        assert_eq!(ping["result"], json!({}));
        let (_, nope) = post(&app, &token, r#"{"jsonrpc":"2.0","id":4,"method":"resources/list"}"#).await;
        assert_eq!(nope["error"]["code"], METHOD_NOT_FOUND);
        let (_, down) = post(&app, &token, r#"{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"notes_search","arguments":{"query":"roof"}}}"#).await;
        assert_eq!(down["error"]["code"], INTERNAL_ERROR);
        assert!(down["error"]["message"].as_str().unwrap().contains("isn't reachable"));
        let (_, empty) = post(&app, &token, r#"{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"notes_search","arguments":{"query":"  "}}}"#).await;
        assert_eq!(empty["error"]["code"], INVALID_PARAMS);
        let (_, spoof) = post(&app, &token, r#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"note_propose","arguments":{"title":"t","body":"b","why":"w","proposed_by":"owner"}}}"#).await;
        assert_eq!(spoof["error"]["code"], INVALID_PARAMS, "{spoof}");
        let (_, bad) = post(&app, &token, r#"{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"note_propose","arguments":{"title":" ","body":"b","why":"w"}}}"#).await;
        assert_eq!(bad["error"]["message"], "the title is empty");
        let (_, which) = post(&app, &token, r#"{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"notes_delete","arguments":{}}}"#).await;
        assert_eq!(which["error"]["code"], INVALID_PARAMS);
        let (_, id) = post(&app, &token, r#"{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"notes_read","arguments":{"id":"nope"}}}"#).await;
        assert!(id["error"]["message"].as_str().unwrap().contains("not a note id"));

        let (s, junk) = post(&app, &token, "{not json").await;
        assert_eq!((s, junk["error"]["code"].as_i64()), (StatusCode::BAD_REQUEST, Some(PARSE_ERROR)));
        let (_, batch) = post(&app, &token, r#"[{"jsonrpc":"2.0","id":1,"method":"ping"},{"jsonrpc":"2.0","method":"notifications/initialized"}]"#).await;
        assert_eq!(batch, json!([{"jsonrpc": "2.0", "id": 1, "result": {}}]));
        let (s, _) = post(&app, &"0".repeat(64), r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#).await;
        assert_eq!(s, StatusCode::UNAUTHORIZED, "the same token as everywhere");
    }
}
