//! The real gateway binary against a real Postgres (scripts/dev-db.sh): each test gets its own database, shaped like
//! production's (db/bootstrap.sql, then `lumbridge-mobile-server migrate` as lumbridge_app). If lumbridge-dev-db is down the tests
//! say so and skip, so other lanes' `cargo test` still works; LUMBRIDGE_TEST_REQUIRE_DB=1 makes that a failure.
//!
//! The gateway's front door isn't what's under test here, and tailnet admission can't pass on a test machine. Where it
//! refuses (403), the tests that need to get past it say so and skip: run `cargo test --features dev-identity` for all of
//! them. With LUMBRIDGE_TEST_REQUIRE_DB=1 a skip is a failure.

use reqwest::{Client, Method, StatusCode};
use serde_json::{json, Value};
use std::{
    net::SocketAddr,
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    sync::Arc,
    time::Duration,
};
use tokio::net::{TcpListener, TcpStream};
use uuid::Uuid;

/// The throwaway Postgres (scripts/dev-db.sh, scripts/ci-db.sh): 127.0.0.1, port LUMBRIDGE_PG_PORT or 5498.
fn pg(login: &str, db: &str) -> String {
    format!("postgres://{login}@{}/{db}", pg_addr())
}
fn pg_addr() -> String {
    format!("127.0.0.1:{}", std::env::var("LUMBRIDGE_PG_PORT").unwrap_or_else(|_| "5498".into()))
}
const ADMIN_LOGIN: &str = "postgres:lumbridge-throwaway";
const LOGIN: &str = "sam@test";
const TOKEN: &str = "a-test-device-token-of-at-least-32-characters";

async fn admin() -> Option<tokio_postgres::Client> {
    let url = pg(ADMIN_LOGIN, "postgres");
    let connecting = tokio_postgres::connect(&url, tokio_postgres::NoTls);
    match tokio::time::timeout(Duration::from_secs(3), connecting).await {
        Ok(Ok((client, connection))) => {
            tokio::spawn(connection);
            Some(client)
        }
        _ => {
            eprintln!("SKIPPED: lumbridge-dev-db is down (scripts/dev-db.sh)");
            assert!(std::env::var_os("LUMBRIDGE_TEST_REQUIRE_DB").is_none(), "lumbridge-dev-db is required");
            None
        }
    }
}

/// A new database and its lumbridge_app URL, after real migrations through the real binary.
async fn database() -> Option<(String, String)> {
    let a = admin().await?;
    let name = format!("lumbridge_it_{}", Uuid::new_v4().simple());
    a.batch_execute(&format!("create database {name}")).await.unwrap();
    let (on_it, connection) =
        tokio_postgres::connect(&pg(ADMIN_LOGIN, &name), tokio_postgres::NoTls).await.unwrap();
    tokio::spawn(connection);
    let _ = on_it.batch_execute("create role lumbridge_app login noinherit password 'dev'; alter role lumbridge_app set search_path = lumbridge").await;
    on_it.batch_execute("create schema lumbridge authorization lumbridge_app; revoke all on schema lumbridge from public").await.unwrap();
    let url = pg("lumbridge_app:dev", &name);
    let out = Command::new(env!("CARGO_BIN_EXE_lumbridge-mobile-server")).arg("migrate").env("LUMBRIDGE_DATABASE_URL", &url).output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    Some((name, url))
}

async fn drop_database(name: &str) {
    let a = admin().await.unwrap();
    a.batch_execute(&format!("drop database {name} with (force)")).await.unwrap();
}

struct Gateway {
    child: Child,
    base: String,
    http: Client,
    dir: std::path::PathBuf,
}

impl Drop for Gateway {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Where devices are per-device records (dev builds only), TOKEN becomes one. Where the token file is the only
/// credential this does nothing: without a full config the binary exits straight away.
fn register_device(state_dir: &std::path::Path) {
    let child = Command::new(env!("CARGO_BIN_EXE_lumbridge-mobile-server"))
        .args(["dev-add", "tests"])
        .env_clear()
        .env("LUMBRIDGE_STATE_DIR", state_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    if let Ok(mut child) = child {
        if let Some(mut stdin) = child.stdin.take() {
            let _ = std::io::Write::write_all(&mut stdin, TOKEN.as_bytes());
        }
        let _ = child.wait();
    }
}

async fn gateway(database_url: Option<&str>) -> Gateway {
    gateway_with(database_url, &[]).await
}

async fn gateway_with(database_url: Option<&str>, extra: &[(&str, String)]) -> Gateway {
    let dir = std::env::temp_dir().join(format!("lumbridge-it-{}", Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir).unwrap();
    let token_file = dir.join("token");
    std::fs::write(&token_file, TOKEN).unwrap();
    let port = TcpListener::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap().port();
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_lumbridge-mobile-server"));
    cmd.env_clear()
        .env("LUMBRIDGE_TOKEN_FILE", &token_file)
        .env("LUMBRIDGE_LOGIN", LOGIN)
        .env("LUMBRIDGE_ORIGINS", "http://127.0.0.1")
        .env("LUMBRIDGE_BIND", format!("127.0.0.1:{port}"))
        .env("LUMBRIDGE_WEB", &dir)
        .env("LUMBRIDGE_STATE_DIR", &dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(url) = database_url {
        cmd.env("LUMBRIDGE_DATABASE_URL", url);
    }
    for (k, v) in extra {
        cmd.env(k, v);
    }
    register_device(&dir);
    let gw = Gateway { child: cmd.spawn().unwrap(), base: format!("http://127.0.0.1:{port}"), http: Client::new(), dir };
    for _ in 0..100 {
        if gw.http.get(format!("{}/healthz", gw.base)).send().await.is_ok() {
            return gw;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("gateway did not start");
}

impl Gateway {
    /// False, and says so, if this build's admission won't let a test machine in at all.
    async fn admitted(&self) -> bool {
        let status = self.get("/api/notes").await.0;
        if status != StatusCode::FORBIDDEN {
            return true;
        }
        // Only a dev-identity build has no admission to get past, so a real build can never run these. It says so and
        // goes on: LUMBRIDGE_TEST_REQUIRE_DB still holds its migration tests to the database.
        eprintln!("SKIPPED: admission refuses this machine; run with --features dev-identity");
        if cfg!(feature = "dev-identity") {
            panic!("a dev-identity build was refused");
        }
        false
    }
    async fn call(&self, method: Method, path: &str, body: Option<Value>) -> (StatusCode, Value) {
        let mut req = self
            .http
            .request(method, format!("{}{path}", self.base))
            .header("Tailscale-User-Login", LOGIN)
            .bearer_auth(TOKEN);
        if let Some(b) = body {
            req = req.json(&b);
        }
        let res = req.send().await.unwrap();
        let status = res.status();
        let text = res.text().await.unwrap();
        (status, serde_json::from_str(&text).unwrap_or(Value::String(text)))
    }
    async fn get(&self, path: &str) -> (StatusCode, Value) {
        self.call(Method::GET, path, None).await
    }
    async fn post(&self, path: &str, body: Value) -> (StatusCode, Value) {
        self.call(Method::POST, path, Some(body)).await
    }
    async fn patch(&self, path: &str, body: Value) -> (StatusCode, Value) {
        self.call(Method::PATCH, path, Some(body)).await
    }
    async fn delete(&self, path: &str) -> (StatusCode, Value) {
        self.call(Method::DELETE, path, None).await
    }
}

macro_rules! setup {
    () => {{
        let Some((name, url)) = database().await else { return };
        let gw = gateway(Some(&url)).await;
        if !gw.admitted().await {
            drop_database(&name).await;
            return;
        }
        (name, gw)
    }};
}

fn titles(list: &Value) -> Vec<&str> {
    list.as_array().unwrap().iter().map(|n| n["title"].as_str().unwrap()).collect()
}

#[tokio::test]
async fn notes_crud() {
    let (db, gw) = setup!();
    let (s, created) = gw.post("/api/notes", json!({"title": "First", "body": "hello **world**"})).await;
    assert_eq!(s, StatusCode::CREATED);
    assert_eq!(created["version"], 1);
    assert_eq!(created["pinned"], false);
    assert!(created["deleted_at"].is_null());
    let path = format!("/api/notes/{}", created["id"].as_str().unwrap());

    let (s, read) = gw.get(&path).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(read, created);

    let (s, patched) = gw.patch(&path, json!({"version": 1, "body": "changed"})).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(patched["version"], 2);
    assert_eq!(patched["body"], "changed");
    assert_eq!(patched["title"], "First", "fields left out are untouched");
    assert!(patched["updated_at"].as_str() > created["updated_at"].as_str());

    let (s, list) = gw.get("/api/notes").await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(list[0]["preview"], "changed");
    assert!(list[0].get("body").is_none(), "the list carries a preview, not whole bodies");

    let (s, _) = gw.get(&format!("/api/notes/{}", Uuid::new_v4())).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    let (s, _) = gw.get("/api/notes/not-a-uuid").await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    drop(gw);
    drop_database(&db).await;
}

#[tokio::test]
async fn notes_order_pinned_then_last_edited_and_a_pin_is_not_an_edit() {
    let (db, gw) = setup!();
    let (_, a) = gw.post("/api/notes", json!({"title": "a"})).await;
    let (_, _b) = gw.post("/api/notes", json!({"title": "b"})).await;
    let (_, c) = gw.post("/api/notes", json!({"title": "c"})).await;
    let (_, list) = gw.get("/api/notes").await;
    assert_eq!(titles(&list), ["c", "b", "a"]);

    let a_path = format!("/api/notes/{}", a["id"].as_str().unwrap());
    let (_, pinned) = gw.patch(&a_path, json!({"version": 1, "pinned": true})).await;
    assert_eq!(pinned["updated_at"], a["updated_at"], "pinning doesn't count as an edit");
    assert_eq!(pinned["version"], 2, "but it does bump the version");
    let (_, list) = gw.get("/api/notes").await;
    assert_eq!(titles(&list), ["a", "c", "b"]);

    gw.patch(&format!("/api/notes/{}", _b["id"].as_str().unwrap()), json!({"version": 1, "body": "edit"})).await;
    let (_, list) = gw.get("/api/notes").await;
    assert_eq!(titles(&list), ["a", "b", "c"]);
    let _ = c;

    let (_, page) = gw.get("/api/notes?limit=1&offset=1").await;
    assert_eq!(titles(&page), ["b"]);
    drop(gw);
    drop_database(&db).await;
}

#[tokio::test]
async fn patch_on_an_old_version_conflicts_with_the_current_row() {
    let (db, gw) = setup!();
    let (_, n) = gw.post("/api/notes", json!({"title": "t", "body": "base"})).await;
    let path = format!("/api/notes/{}", n["id"].as_str().unwrap());
    let (s, _) = gw.patch(&path, json!({"version": 1, "body": "from the phone"})).await;
    assert_eq!(s, StatusCode::OK);

    let (s, current) = gw.patch(&path, json!({"version": 1, "body": "from the computer"})).await;
    assert_eq!(s, StatusCode::CONFLICT);
    assert_eq!(current["body"], "from the phone");
    assert_eq!(current["version"], 2);
    let (_, unchanged) = gw.get(&path).await;
    assert_eq!(unchanged["body"], "from the phone", "the losing write changed nothing");

    let (s, _) = gw.patch(&format!("/api/notes/{}", Uuid::new_v4()), json!({"version": 1, "body": "x"})).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    let (s, _) = gw.patch(&path, json!({"version": 2})).await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY, "an empty patch is refused");
    let (s, _) = gw.patch(&path, json!({"version": 2, "bogus": 1})).await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY, "unknown fields are refused");
    let (s, _) = gw.patch(&path, json!({"body": "no version"})).await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY, "the version is required");
    drop(gw);
    drop_database(&db).await;
}

#[tokio::test]
async fn soft_delete_and_undo() {
    let (db, gw) = setup!();
    let (_, n) = gw.post("/api/notes", json!({"title": "keep me", "body": "text"})).await;
    let id = n["id"].as_str().unwrap();
    let path = format!("/api/notes/{id}");

    let (s, deleted) = gw.delete(&path).await;
    assert_eq!(s, StatusCode::OK);
    assert!(deleted["deleted_at"].is_string());
    assert_eq!(deleted["version"], 2);
    assert_eq!(gw.get(&path).await.0, StatusCode::NOT_FOUND);
    assert_eq!(titles(&gw.get("/api/notes").await.1).len(), 0);
    assert_eq!(titles(&gw.get("/api/notes?deleted=true").await.1), ["keep me"]);
    let (_, hits) = gw.get("/api/notes?q=keep").await;
    assert_eq!(titles(&hits).len(), 0, "deleted notes aren't searchable");

    let (s, again) = gw.delete(&path).await;
    assert_eq!(s, StatusCode::OK, "deleting twice is not an error");
    assert_eq!(again["version"], 2);

    // An edit from a device that hasn't heard about the delete must get the row back, not silently vanish.
    let (s, current) = gw.patch(&path, json!({"version": 2, "body": "still typing"})).await;
    assert_eq!(s, StatusCode::CONFLICT);
    assert!(current["deleted_at"].is_string());

    let (s, restored) = gw.post(&format!("{path}/restore"), json!({})).await;
    assert_eq!(s, StatusCode::OK);
    assert!(restored["deleted_at"].is_null());
    assert_eq!(restored["body"], "text");
    assert_eq!(gw.get(&path).await.0, StatusCode::OK);
    assert_eq!(gw.post(&format!("/api/notes/{}/restore", Uuid::new_v4()), json!({})).await.0, StatusCode::NOT_FOUND);
    drop(gw);
    drop_database(&db).await;
}

#[tokio::test]
async fn a_retried_create_with_the_same_id_makes_one_note() {
    let (db, gw) = setup!();
    let id = Uuid::new_v4().to_string();
    let (s, first) = gw.post("/api/notes", json!({"id": id, "title": "once"})).await;
    assert_eq!(s, StatusCode::CREATED);
    let (s, retry) = gw.post("/api/notes", json!({"id": id, "title": "once"})).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(retry, first);
    assert_eq!(titles(&gw.get("/api/notes").await.1).len(), 1);

    let (s, _) = gw.post("/api/tasks", json!({"id": id, "title": "same id, other table"})).await;
    assert_eq!(s, StatusCode::CREATED);
    let (s, _) = gw.post("/api/tasks", json!({"id": id, "title": "same id, other table"})).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(titles(&gw.get("/api/tasks").await.1).len(), 1);
    drop(gw);
    drop_database(&db).await;
}

#[tokio::test]
async fn search_notes_and_tasks() {
    let (db, gw) = setup!();
    gw.post("/api/notes", json!({"title": "Roof quote", "body": "Call the contractor about flashing"})).await;
    gw.post("/api/notes", json!({"title": "Groceries", "body": "running shoes and the contractor's invoice"})).await;
    gw.post("/api/notes", json!({"title": "Other", "body": "nothing related"})).await;

    let (s, hits) = gw.get("/api/notes?q=roof").await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(titles(&hits), ["Roof quote"]);
    assert_eq!(titles(&gw.get("/api/notes?q=runs").await.1), ["Groceries"], "stemmed");
    assert_eq!(titles(&gw.get("/api/notes?q=runni").await.1), ["Groceries"], "a word still being typed");
    assert_eq!(titles(&gw.get("/api/notes?q=flash%20contract").await.1), ["Roof quote"], "every word must match");
    assert_eq!(titles(&gw.get("/api/notes?q=contractor").await.1).len(), 2);
    assert_eq!(titles(&gw.get("/api/notes?q=zzzz").await.1).len(), 0);
    assert_eq!(titles(&gw.get("/api/notes?q=%20%20").await.1).len(), 3, "a blank search is no search");

    // Search syntax in the box is just text, never an error.
    for q in ["a%26b", "%27", "!%20(", "%3A*", "foo%20%7C%20bar", "%5C"] {
        let (s, _) = gw.get(&format!("/api/notes?q={q}")).await;
        assert_eq!(s, StatusCode::OK, "{q}");
    }
    let (_, hit) = gw.get("/api/notes?q=flashing").await;
    assert!(hit[0]["preview"].as_str().unwrap().contains("flashing"));
    assert_eq!(gw.get(&format!("/api/notes?q={}", "x".repeat(501))).await.0, StatusCode::UNPROCESSABLE_ENTITY);

    gw.post("/api/tasks", json!({"title": "Pay the roofer", "notes": "invoice 42"})).await;
    gw.post("/api/tasks", json!({"title": "Walk the dog"})).await;
    assert_eq!(titles(&gw.get("/api/tasks?q=invoice").await.1), ["Pay the roofer"]);
    assert_eq!(titles(&gw.get("/api/tasks?q=dog").await.1), ["Walk the dog"]);
    drop(gw);
    drop_database(&db).await;
}

#[tokio::test]
async fn tasks_crud_order_complete_and_conflict() {
    let (db, gw) = setup!();
    let (s, no_due) = gw.post("/api/tasks", json!({"title": "no due"})).await;
    assert_eq!(s, StatusCode::CREATED);
    assert!(no_due["due_on"].is_null());
    assert!(no_due["done_at"].is_null());
    let (_, later) = gw.post("/api/tasks", json!({"title": "later", "due_on": "2030-01-02"})).await;
    let (_, soon) = gw.post("/api/tasks", json!({"title": "soon", "due_on": "2030-01-01"})).await;
    let (_, newer) = gw.post("/api/tasks", json!({"title": "newest no due"})).await;
    assert_eq!(later["due_on"], "2030-01-02");
    assert_eq!(titles(&gw.get("/api/tasks").await.1), ["soon", "later", "newest no due", "no due"]);

    let path = |t: &Value| format!("/api/tasks/{}", t["id"].as_str().unwrap());
    let (_, pinned) = gw.patch(&path(&no_due), json!({"version": 1, "pinned": true})).await;
    assert_eq!(pinned["pinned"], true);
    assert_eq!(titles(&gw.get("/api/tasks").await.1)[0], "no due", "a pin goes above any due date");

    // Complete, keep the first completion time, reopen.
    let (s, done) = gw.patch(&path(&soon), json!({"version": 1, "done": true})).await;
    assert_eq!(s, StatusCode::OK);
    let done_at = done["done_at"].as_str().unwrap().to_string();
    let (_, again) = gw.patch(&path(&soon), json!({"version": 2, "done": true})).await;
    assert_eq!(again["done_at"], done_at.as_str());
    assert_eq!(titles(&gw.get("/api/tasks").await.1).last().unwrap(), &"soon", "completed sinks to the end");
    let (_, reopened) = gw.patch(&path(&soon), json!({"version": 3, "done": false})).await;
    assert!(reopened["done_at"].is_null());

    // due_on: absent leaves it, null clears it.
    let (_, kept) = gw.patch(&path(&later), json!({"version": 1, "title": "later!"})).await;
    assert_eq!(kept["due_on"], "2030-01-02");
    let (_, cleared) = gw.patch(&path(&later), json!({"version": 2, "due_on": null})).await;
    assert!(cleared["due_on"].is_null());

    // Conflict and validation.
    let (s, current) = gw.patch(&path(&later), json!({"version": 1, "title": "stale"})).await;
    assert_eq!(s, StatusCode::CONFLICT);
    assert_eq!(current["title"], "later!");
    assert_eq!(gw.post("/api/tasks", json!({"title": "   "})).await.0, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(gw.post("/api/tasks", json!({"title": "x", "due_on": "soon"})).await.0, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(gw.patch(&path(&later), json!({"version": 3, "title": ""})).await.0, StatusCode::UNPROCESSABLE_ENTITY);

    // Soft delete and undo.
    assert_eq!(gw.delete(&path(&newer)).await.0, StatusCode::OK);
    assert_eq!(gw.get(&path(&newer)).await.0, StatusCode::NOT_FOUND);
    assert_eq!(titles(&gw.get("/api/tasks?deleted=true").await.1), ["newest no due"]);
    let (s, back) = gw.post(&format!("{}/restore", path(&newer)), json!({})).await;
    assert_eq!(s, StatusCode::OK);
    assert!(back["deleted_at"].is_null());
    drop(gw);
    drop_database(&db).await;
}

#[tokio::test]
async fn sizes_and_awkward_text() {
    let (db, gw) = setup!();
    assert_eq!(gw.post("/api/notes", json!({"title": "x".repeat(4001)})).await.0, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(gw.post("/api/notes", json!({"body": "x".repeat(1024 * 1024 + 1)})).await.0, StatusCode::UNPROCESSABLE_ENTITY);
    // Past the request limit the gateway answers 413 and stops reading, so a client may see a broken pipe instead.
    let huge = Client::new().post(format!("{}/api/notes", gw.base)).header("Tailscale-User-Login", LOGIN).bearer_auth(TOKEN)
        .json(&json!({"body": "x".repeat(2 * 1024 * 1024)})).send().await;
    if let Ok(res) = huge {
        assert_eq!(res.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }
    assert_eq!(titles(&gw.get("/api/notes").await.1).len(), 0, "nothing oversized was stored");
    assert_eq!(gw.post("/api/notes", json!({"body": "nul\u{0}byte"})).await.0, StatusCode::UNPROCESSABLE_ENTITY);

    // The search column has a 1 MB limit and must never stop a big note from saving: every word here is different.
    let mut big = String::with_capacity(1024 * 1024);
    let mut i = 0u64;
    while big.len() < 1024 * 1024 - 32 {
        big.push_str(&format!("w{i:x} "));
        i += 1;
    }
    let (s, n) = gw.post("/api/notes", json!({"title": "big", "body": big})).await;
    assert_eq!(s, StatusCode::CREATED, "{n}");
    assert_eq!(n["body"].as_str().unwrap().len(), big.len());
    assert_eq!(titles(&gw.get("/api/notes?q=w1f").await.1), ["big"]);

    // Text comes back exactly as it went in.
    let awkward = "emoji 🐶, 日本語, 'quotes' \"double\" \\ back\nnewline\ttab <b>html</b> %s $1";
    let (_, n) = gw.post("/api/notes", json!({"title": awkward, "body": awkward})).await;
    assert_eq!(n["title"], awkward);
    assert_eq!(n["body"], awkward);
    assert_eq!(titles(&gw.get("/api/notes?q=日本語").await.1).len(), 1);
    drop(gw);
    drop_database(&db).await;
}

#[tokio::test]
async fn every_route_needs_the_device_token_even_with_no_database() {
    let gw = gateway(None).await;
    let id = Uuid::new_v4();
    let routes = [
        (Method::GET, "/api/notes".to_string()),
        (Method::POST, "/api/notes".to_string()),
        (Method::GET, format!("/api/notes/{id}")),
        (Method::PATCH, format!("/api/notes/{id}")),
        (Method::DELETE, format!("/api/notes/{id}")),
        (Method::POST, format!("/api/notes/{id}/restore")),
        (Method::GET, "/api/tasks".to_string()),
        (Method::POST, "/api/tasks".to_string()),
        (Method::GET, format!("/api/tasks/{id}")),
        (Method::PATCH, format!("/api/tasks/{id}")),
        (Method::DELETE, format!("/api/tasks/{id}")),
        (Method::POST, format!("/api/tasks/{id}/restore")),
        (Method::GET, "/api/thoughts".to_string()),
        (Method::POST, "/api/thoughts".to_string()),
        (Method::GET, format!("/api/thoughts/{id}")),
        (Method::PATCH, format!("/api/thoughts/{id}")),
        (Method::DELETE, format!("/api/thoughts/{id}")),
        (Method::POST, format!("/api/thoughts/{id}/restore")),
        (Method::POST, format!("/api/thoughts/{id}/note")),
        (Method::GET, "/api/asks".to_string()),
        (Method::POST, format!("/api/asks/{id}/answer")),
        (Method::GET, "/api/note-proposals".to_string()),
        (Method::POST, "/api/note-proposals".to_string()),
        (Method::POST, format!("/api/note-proposals/{id}/decide")),
        (Method::POST, "/mcp".to_string()),
    ];
    let refused = |s: StatusCode| s == StatusCode::UNAUTHORIZED || s == StatusCode::FORBIDDEN;
    for (method, path) in routes {
        let url = format!("{}{path}", gw.base);
        let no_token = gw.http.request(method.clone(), &url).header("Tailscale-User-Login", LOGIN).send().await.unwrap();
        assert!(refused(no_token.status()), "{method} {path}: {}", no_token.status());
        let bad_token =
            gw.http.request(method.clone(), &url).header("Tailscale-User-Login", LOGIN).bearer_auth("wrong").send().await.unwrap();
        assert!(refused(bad_token.status()), "{method} {path}: {}", bad_token.status());
    }
}

async fn assert_gateway_alive_but_data_503(gw: &Gateway) {
    let started = std::time::Instant::now();
    let (s, body) = gw.get("/api/notes").await;
    assert_eq!(s, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert_eq!(body["error"], "database_unavailable");
    assert_eq!(gw.post("/api/tasks", json!({"title": "x"})).await.0, StatusCode::SERVICE_UNAVAILABLE);
    assert!(started.elapsed() < Duration::from_secs(12), "fails fast, took {:?}", started.elapsed());
    assert_eq!(gw.http.get(format!("{}/healthz", gw.base)).send().await.unwrap().status(), StatusCode::OK);
}

#[tokio::test]
async fn unset_url_answers_503_and_the_gateway_works() {
    let gw = gateway(None).await;
    if gw.admitted().await {
        assert_gateway_alive_but_data_503(&gw).await;
    }
}

#[tokio::test]
async fn unparseable_url_answers_503_and_the_gateway_works() {
    let gw = gateway(Some("postgres://%%%not a url")).await;
    if gw.admitted().await {
        assert_gateway_alive_but_data_503(&gw).await;
    }
}

#[tokio::test]
async fn refused_connection_answers_503() {
    let free = TcpListener::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap();
    let gw = gateway(Some(&format!("postgres://lumbridge_app:dev@{free}/postgres"))).await;
    if gw.admitted().await {
        assert_gateway_alive_but_data_503(&gw).await;
    }
}

#[tokio::test]
async fn a_database_that_never_answers_gets_503_not_a_hang() {
    let silent = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = silent.local_addr().unwrap();
    tokio::spawn(async move {
        let mut held = Vec::new();
        while let Ok((sock, _)) = silent.accept().await {
            held.push(sock);
        }
    });
    let gw = gateway(Some(&format!("postgres://lumbridge_app:dev@{addr}/postgres"))).await;
    if gw.admitted().await {
        assert_gateway_alive_but_data_503(&gw).await;
    }
}

#[tokio::test]
async fn unmigrated_schema_answers_503() {
    let Some(a) = admin().await else { return };
    let name = format!("lumbridge_it_{}", Uuid::new_v4().simple());
    a.batch_execute(&format!("create database {name}")).await.unwrap();
    let gw = gateway(Some(&pg(ADMIN_LOGIN, &name))).await;
    if gw.admitted().await {
        assert_eq!(gw.get("/api/notes").await.0, StatusCode::SERVICE_UNAVAILABLE);
    }
    drop(gw);
    drop_database(&name).await;
}

/// A forwarder we can cut, standing in for the tailnet link.
async fn proxy(to: String) -> (SocketAddr, Arc<AtomicBool>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let up = Arc::new(AtomicBool::new(true));
    let flag = up.clone();
    tokio::spawn(async move {
        while let Ok((mut client, _)) = listener.accept().await {
            if !flag.load(Ordering::SeqCst) {
                continue; // Dropped: refused, as far as the client can tell.
            }
            let (flag, to) = (flag.clone(), to.clone());
            tokio::spawn(async move {
                let Ok(mut server) = TcpStream::connect(&to).await else { return };
                let copy = tokio::io::copy_bidirectional(&mut client, &mut server);
                tokio::pin!(copy);
                loop {
                    tokio::select! {
                        _ = &mut copy => return,
                        _ = tokio::time::sleep(Duration::from_millis(50)) => {
                            if !flag.load(Ordering::SeqCst) { return; }
                        }
                    }
                }
            });
        }
    });
    (addr, up)
}

#[tokio::test]
async fn losing_and_regaining_the_database_at_runtime() {
    let Some((name, _)) = database().await else { return };
    let (addr, up) = proxy(pg_addr()).await;
    let gw = gateway(Some(&format!("postgres://lumbridge_app:dev@{addr}/{name}"))).await;
    if !gw.admitted().await {
        drop(gw);
        drop_database(&name).await;
        return;
    }
    let (s, _) = gw.post("/api/notes", json!({"title": "before the outage"})).await;
    assert_eq!(s, StatusCode::CREATED);

    up.store(false, Ordering::SeqCst);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_gateway_alive_but_data_503(&gw).await;

    up.store(true, Ordering::SeqCst);
    let (s, list) = gw.get("/api/notes").await;
    assert_eq!(s, StatusCode::OK, "recovers by itself: {list}");
    assert_eq!(titles(&list), ["before the outage"]);
    drop(gw);
    drop_database(&name).await;
}

// ---- Thoughts ---------------------------------------------------------------------------------------------------------

fn previews(list: &Value) -> Vec<&str> {
    list.as_array().unwrap().iter().map(|t| t["preview"].as_str().unwrap()).collect()
}

#[tokio::test]
async fn thoughts_crud_and_conflict() {
    let (name, gw) = setup!();
    let (s, t) = gw.post("/api/thoughts", json!({"body": "the roof leaks over the stairs", "source": "voice", "duration_ms": 4200})).await;
    assert_eq!(s, StatusCode::CREATED);
    assert_eq!((t["source"].as_str(), t["duration_ms"].as_i64(), t["version"].as_i64()), (Some("voice"), Some(4200), Some(1)));
    assert!(t["note_id"].is_null());
    let id = t["id"].as_str().unwrap();

    let (s, typed) = gw.post("/api/thoughts", json!({"body": "typed one"})).await;
    assert_eq!((s, typed["source"].as_str(), typed["duration_ms"].is_null()), (StatusCode::CREATED, Some("typed"), true));

    let (s, got) = gw.get(&format!("/api/thoughts/{id}")).await;
    assert_eq!((s, got["body"].as_str()), (StatusCode::OK, Some("the roof leaks over the stairs")));

    let (s, edited) = gw.patch(&format!("/api/thoughts/{id}"), json!({"version": 1, "body": "the roof leaks"})).await;
    assert_eq!((s, edited["version"].as_i64()), (StatusCode::OK, Some(2)));

    // On an old version: 409 with the current row, and nothing changes.
    let (s, current) = gw.patch(&format!("/api/thoughts/{id}"), json!({"version": 1, "body": "stale"})).await;
    assert_eq!((s, current["body"].as_str()), (StatusCode::CONFLICT, Some("the roof leaks")));

    for (body, why) in [
        (json!({"body": "   "}), "empty_body"),
        (json!({"body": "x", "source": "dream"}), "invalid_source"),
        (json!({"body": "x", "duration_ms": -1}), "invalid_duration"),
        (json!({"body": "nul \u{0} here"}), "invalid_text"),
    ] {
        let (s, e) = gw.post("/api/thoughts", body).await;
        assert_eq!((s, e["error"].as_str()), (StatusCode::UNPROCESSABLE_ENTITY, Some(why)));
    }
    let (s, e) = gw.patch(&format!("/api/thoughts/{id}"), json!({"version": 2, "body": ""})).await;
    assert_eq!((s, e["error"].as_str()), (StatusCode::UNPROCESSABLE_ENTITY, Some("empty_body")));
    drop(gw);
    drop_database(&name).await;
}

#[tokio::test]
async fn a_retried_thought_with_the_same_id_makes_one() {
    let (name, gw) = setup!();
    let id = Uuid::new_v4();
    let thought = json!({"id": id, "body": "said once", "source": "voice", "duration_ms": 1000});
    let (s, first) = gw.post("/api/thoughts", thought.clone()).await;
    assert_eq!(s, StatusCode::CREATED);
    let (s, again) = gw.post("/api/thoughts", thought.clone()).await;
    assert_eq!((s, &again), (StatusCode::OK, &first), "a retry answers 200 with the same row");
    let (_, list) = gw.get("/api/thoughts").await;
    assert_eq!(previews(&list), ["said once"]);

    // A retry arriving after the owner deleted it answers with the row and doesn't bring it back.
    gw.delete(&format!("/api/thoughts/{id}")).await;
    let (s, late) = gw.post("/api/thoughts", thought).await;
    assert_eq!(s, StatusCode::OK);
    assert!(!late["deleted_at"].is_null());
    let (_, list) = gw.get("/api/thoughts").await;
    assert!(list.as_array().unwrap().is_empty());
    drop(gw);
    drop_database(&name).await;
}

#[tokio::test]
async fn thoughts_keep_when_they_were_said_newest_first_with_paging() {
    let (name, gw) = setup!();
    gw.post("/api/thoughts", json!({"body": "monday", "created_at": "2026-11-02T09:00:00Z"})).await;
    gw.post("/api/thoughts", json!({"body": "wednesday", "created_at": "2026-11-04T09:00:00Z"})).await;
    gw.post("/api/thoughts", json!({"body": "tuesday", "created_at": "2026-11-03T09:00:00Z"})).await;
    let (_, list) = gw.get("/api/thoughts").await;
    assert_eq!(previews(&list), ["wednesday", "tuesday", "monday"]);
    assert_eq!(list[2]["created_at"].as_str().map(|s| &s[..10]), Some("2026-11-02"));
    let (_, page) = gw.get("/api/thoughts?limit=1&offset=1").await;
    assert_eq!(previews(&page), ["tuesday"]);

    // A clock that's ahead doesn't get to sit on top of the list.
    let (_, ahead) = gw.post("/api/thoughts", json!({"body": "from the future", "created_at": "2999-01-01T00:00:00Z"})).await;
    assert!(ahead["created_at"].as_str().unwrap() < "2999", "{ahead}");
    drop(gw);
    drop_database(&name).await;
}

#[tokio::test]
async fn thoughts_delete_restore_and_search() {
    let (name, gw) = setup!();
    let (_, t) = gw.post("/api/thoughts", json!({"body": "running a marathon in spring"})).await;
    gw.post("/api/thoughts", json!({"body": "buy a kettle"})).await;
    let id = t["id"].as_str().unwrap();

    for (q, want) in [("runs", 1), ("marath", 1), ("kettle", 1), ("spring%20marathon", 1), ("nothing", 0), ("%21%21%21", 0)] {
        let (s, hits) = gw.get(&format!("/api/thoughts?q={q}")).await;
        assert_eq!((s, hits.as_array().unwrap().len()), (StatusCode::OK, want), "{q}");
    }

    let (s, gone) = gw.delete(&format!("/api/thoughts/{id}")).await;
    assert_eq!(s, StatusCode::OK);
    assert!(!gone["deleted_at"].is_null());
    let (s, twice) = gw.delete(&format!("/api/thoughts/{id}")).await;
    assert_eq!((s, twice["version"].as_i64()), (StatusCode::OK, gone["version"].as_i64()), "deleting twice changes nothing");
    assert_eq!(gw.get(&format!("/api/thoughts/{id}")).await.0, StatusCode::NOT_FOUND);
    let (_, hits) = gw.get("/api/thoughts?q=marathon").await;
    assert!(hits.as_array().unwrap().is_empty(), "a deleted thought isn't found");
    let (_, trash) = gw.get("/api/thoughts?deleted=true").await;
    assert_eq!(previews(&trash), ["running a marathon in spring"]);
    let (s, stale) = gw.patch(&format!("/api/thoughts/{id}"), json!({"version": gone["version"], "body": "edit"})).await;
    assert_eq!(s, StatusCode::CONFLICT, "{stale}");

    let (s, back) = gw.post(&format!("/api/thoughts/{id}/restore"), json!({})).await;
    assert_eq!(s, StatusCode::OK);
    assert!(back["deleted_at"].is_null());
    assert_eq!(back["version"].as_i64(), gone["version"].as_i64().map(|v| v + 1));
    let (s, again) = gw.post(&format!("/api/thoughts/{id}/restore"), json!({})).await;
    assert_eq!((s, again["version"].as_i64()), (StatusCode::OK, back["version"].as_i64()), "restoring twice changes nothing");
    let (_, hits) = gw.get("/api/thoughts?q=marathon").await;
    assert_eq!(hits.as_array().unwrap().len(), 1);
    drop(gw);
    drop_database(&name).await;
}

#[tokio::test]
async fn a_thought_becomes_one_note_however_often_it_is_asked() {
    let (name, gw) = setup!();
    let (_, t) = gw.post("/api/thoughts", json!({"body": "turn me into a note"})).await;
    let id = t["id"].as_str().unwrap();
    let path = format!("/api/thoughts/{id}/note");

    // Two devices at once, then a retry: still one note.
    let ((a, ra), (b, rb)) = tokio::join!(gw.post(&path, json!({})), gw.post(&path, json!({})));
    let mut statuses = [a.as_u16(), b.as_u16()];
    statuses.sort_unstable();
    assert_eq!(statuses, [200, 201]);
    assert_eq!(ra["note_id"], rb["note_id"]);
    let (s, retry) = gw.post(&path, json!({})).await;
    assert_eq!((s, &retry["note_id"]), (StatusCode::OK, &ra["note_id"]));
    assert_eq!(retry["version"].as_i64(), Some(2), "the version moved once");

    let (_, notes) = gw.get("/api/notes").await;
    assert_eq!(notes.as_array().unwrap().len(), 1);
    let (s, note) = gw.get(&format!("/api/notes/{}", ra["note_id"].as_str().unwrap())).await;
    assert_eq!((s, note["body"].as_str(), note["title"].as_str()), (StatusCode::OK, Some("turn me into a note"), Some("")));
    let (_, kept) = gw.get(&format!("/api/thoughts/{id}")).await;
    assert_eq!(kept["body"].as_str(), Some("turn me into a note"), "the thought stays");

    assert_eq!(gw.post(&format!("/api/thoughts/{}/note", Uuid::new_v4()), json!({})).await.0, StatusCode::NOT_FOUND);
    let (_, other) = gw.post("/api/thoughts", json!({"body": "deleted first"})).await;
    let other = other["id"].as_str().unwrap();
    gw.delete(&format!("/api/thoughts/{other}")).await;
    assert_eq!(gw.post(&format!("/api/thoughts/{other}/note"), json!({})).await.0, StatusCode::NOT_FOUND);
    let (_, notes) = gw.get("/api/notes").await;
    assert_eq!(notes.as_array().unwrap().len(), 1, "no note from a deleted thought");
    drop(gw);
    drop_database(&name).await;
}

fn thoughts_cli(url: Option<&str>, args: &[&str]) -> (bool, Value, String) {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_lumbridge-mobile-server"));
    cmd.env_clear().arg("thoughts").args(args);
    if let Some(url) = url {
        cmd.env("LUMBRIDGE_DATABASE_URL", url);
    }
    let out = cmd.output().unwrap();
    let stdout = String::from_utf8_lossy(&out.stdout);
    (out.status.success(), serde_json::from_str(&stdout).unwrap_or(Value::Null), String::from_utf8_lossy(&out.stderr).into_owned())
}

/// Needs no gateway, so no admission: this runs in every build.
#[tokio::test]
async fn the_cli_reads_thoughts_as_json_and_changes_nothing() {
    let Some((name, url)) = database().await else { return };
    let (c, connection) = tokio_postgres::connect(&url, tokio_postgres::NoTls).await.unwrap();
    tokio::spawn(connection);
    c.batch_execute(
        "insert into thoughts (body, source, duration_ms, created_at) values
           ('the old roof idea', 'voice', 5000, '2026-11-01T10:00:00Z'),
           ('call the plumber', 'typed', null, '2026-11-03T10:00:00Z'),
           ('a newer roof idea', 'voice', 9000, '2026-11-04T10:00:00Z');
         insert into thoughts (body, deleted_at) values ('deleted roof', now());",
    )
    .await
    .unwrap();
    let state = || async {
        let row = c.query_one("select md5(string_agg(t::text, ',' order by id)), count(*) from thoughts t", &[]).await.unwrap();
        (row.get::<_, String>(0), row.get::<_, i64>(1))
    };
    let before = state().await;

    let bodies = |v: &Value| v.as_array().unwrap().iter().map(|t| t["body"].as_str().unwrap().to_string()).collect::<Vec<_>>();
    let (ok, all, err) = thoughts_cli(Some(&url), &["recent"]);
    assert!(ok, "{err}");
    assert_eq!(bodies(&all), ["a newer roof idea", "call the plumber", "the old roof idea"], "newest first, no deleted ones");
    assert_eq!(all[0]["source"].as_str(), Some("voice"));
    assert_eq!(all[0]["duration_ms"].as_i64(), Some(9000));

    let (_, one, _) = thoughts_cli(Some(&url), &["recent", "--limit", "1"]);
    assert_eq!(bodies(&one), ["a newer roof idea"]);
    let (_, since, _) = thoughts_cli(Some(&url), &["recent", "--since", "2026-11-03T00:00:00Z"]);
    assert_eq!(bodies(&since), ["a newer roof idea", "call the plumber"]);

    let (ok, hits, err) = thoughts_cli(Some(&url), &["search", "roofs"]);
    assert!(ok, "{err}");
    assert_eq!(bodies(&hits), ["a newer roof idea", "the old roof idea"]);
    let (_, limited, _) = thoughts_cli(Some(&url), &["search", "roof", "--limit", "1"]);
    assert_eq!(bodies(&limited), ["a newer roof idea"]);
    // tsquery syntax in the search is only words, and punctuation alone finds nothing.
    let (ok, odd, err) = thoughts_cli(Some(&url), &["search", "roof'); drop table thoughts; --"]);
    assert!(ok, "{err}");
    assert!(odd.as_array().unwrap().is_empty());
    let (ok, none, err) = thoughts_cli(Some(&url), &["search", "!!!"]);
    assert!(ok, "{err}");
    assert!(none.as_array().unwrap().is_empty());

    assert_eq!(state().await, before, "the CLI changed nothing");

    // Failing says why on stderr, nothing on stdout and no URL anywhere.
    let (ok, _, err) = thoughts_cli(None, &["recent"]);
    assert!(!ok);
    assert!(err.contains("LUMBRIDGE_DATABASE_URL is required"), "{err}");
    let (ok, _, err) = thoughts_cli(Some("postgres://lumbridge_app:sekrit@127.0.0.1:1/x"), &["recent"]);
    assert!(!ok);
    assert!(!err.contains("sekrit"), "{err}");
    let (ok, _, err) = thoughts_cli(Some(&url), &["add", "something"]);
    assert!(!ok);
    assert!(err.contains("usage"), "{err}");
    drop(c);
    drop_database(&name).await;
}

// ---- Asks -------------------------------------------------------------------------------------------------------------

fn asks_cli(url: &str, args: &[&str], stdin: &str) -> (bool, Value, String) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_lumbridge-mobile-server"))
        .env_clear()
        .env("LUMBRIDGE_DATABASE_URL", url)
        .arg("asks")
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    std::io::Write::write_all(&mut child.stdin.take().unwrap(), stdin.as_bytes()).unwrap();
    let out = child.wait_with_output().unwrap();
    let stdout = String::from_utf8_lossy(&out.stdout);
    (out.status.success(), serde_json::from_str(&stdout).unwrap_or(Value::Null), String::from_utf8_lossy(&out.stderr).into_owned())
}

fn ask(url: &str, title: &str, body: &str) -> String {
    let (ok, row, err) = asks_cli(url, &["create"], &json!({"title": title, "body": body}).to_string());
    assert!(ok, "{err}");
    row["id"].as_str().unwrap().to_string()
}

/// Needs no gateway, so no admission: this runs in every build.
#[tokio::test]
async fn the_assistant_asks_from_the_cli_within_limits() {
    let Some((name, url)) = database().await else { return };
    let (ok, row, err) = asks_cli(&url, &["create"], r#"{"title": "  Book the dentist for Thursday?  ", "body": "They have 9:30 or 15:00."}"#);
    assert!(ok, "{err}");
    assert_eq!((row["title"].as_str(), row["status"].as_str(), row["version"].as_i64()), (Some("Book the dentist for Thursday?"), Some("pending"), Some(1)));
    assert!(row["reply"].is_null() && row["answered_at"].is_null() && row["delivered_at"].is_null());

    for (input, why) in [
        (json!({"title": "   ", "body": "x"}).to_string(), "empty"),
        (json!({"title": "x".repeat(121)}).to_string(), "120"),
        (json!({"title": "two\nlines"}).to_string(), "one line"),
        ("not json".to_string(), "JSON"),
        (json!({"title": "ok", "urgent": true}).to_string(), "JSON"),
    ] {
        let (ok, out, err) = asks_cli(&url, &["create"], &input);
        assert!(!ok && out.is_null(), "{input}");
        assert!(err.contains(why), "{input}: {err}");
    }
    assert!(asks_cli(&url, &["create"], &json!({"title": "é".repeat(120)}).to_string()).0, "120 characters, not bytes");

    // 20 waiting at most, even when they come at once.
    let (c, connection) = tokio_postgres::connect(&url, tokio_postgres::NoTls).await.unwrap();
    tokio::spawn(connection);
    let pending = || async { c.query_one("select count(*) from asks where status = 'pending'", &[]).await.unwrap().get::<_, i64>(0) };
    let burst: Vec<_> = (0..22)
        .map(|i| {
            let url = url.clone();
            std::thread::spawn(move || asks_cli(&url, &["create"], &json!({"title": format!("question {i}")}).to_string()))
        })
        .collect();
    let results: Vec<_> = burst.into_iter().map(|t| t.join().unwrap()).collect();
    assert_eq!(pending().await, 20);
    assert_eq!(results.iter().filter(|r| r.0).count(), 18, "two were already waiting");
    assert!(results.iter().filter(|r| !r.0).all(|r| r.2.contains("at most 20")), "{:?}", results.iter().map(|r| &r.2).collect::<Vec<_>>());
    // Any one that got in: which two of the burst were refused is a race, so "question 0" may not be there to answer.
    let answered = c
        .execute(
            "update asks set status = 'denied', answered_at = now() where id = (select id from asks where status = 'pending' order by created_at limit 1)",
            &[],
        )
        .await
        .unwrap();
    assert_eq!(answered, 1);
    assert!(asks_cli(&url, &["create"], r#"{"title": "one more"}"#).0, "answering one makes room");

    let (ok, recent, err) = asks_cli(&url, &["recent", "--limit", "3"], "");
    assert!(ok, "{err}");
    let recent = recent.as_array().unwrap();
    assert_eq!(recent.len(), 3);
    assert_eq!(recent[0]["title"], "one more", "newest first");
    let before: i64 = c.query_one("select count(*) from asks", &[]).await.unwrap().get(0);
    let (ok, all, _) = asks_cli(&url, &["recent", "--limit", "200"], "");
    assert!(ok);
    assert_eq!(all.as_array().unwrap().len() as i64, before);
    assert!(all.as_array().unwrap().iter().any(|a| a["status"] == "denied"), "with their answers");
    let (ok, _, err) = asks_cli(&url, &["answer"], "");
    assert!(!ok && err.contains("usage"), "{err}");
    drop(c);
    drop_database(&name).await;
}

/// Hermes, as far as the gateway can tell: each turn's session and words, and a switch to make it refuse.
#[derive(Clone, Default)]
struct FakeHermes {
    turns: Arc<std::sync::Mutex<Vec<(String, String)>>>,
    down: Arc<AtomicBool>,
}

async fn fake_hermes() -> (FakeHermes, String) {
    use axum::{extract::State, http::HeaderMap, routing::post, Json, Router};
    async fn chat(State(f): State<FakeHermes>, headers: HeaderMap, Json(body): Json<Value>) -> axum::response::Response {
        use axum::response::IntoResponse;
        if f.down.load(Ordering::SeqCst) {
            return axum::http::StatusCode::SERVICE_UNAVAILABLE.into_response();
        }
        let session = headers.get("x-hermes-session-id").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
        let words = body["messages"].as_array().and_then(|m| m.last()).and_then(|m| m["content"].as_str()).unwrap_or("").to_string();
        f.turns.lock().unwrap().push((session, words));
        ([("content-type", "text/event-stream")], "data: {\"choices\":[{\"delta\":{\"content\":\"Noted.\"}}]}\n\ndata: [DONE]\n\n").into_response()
    }
    let fake = FakeHermes::default();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let app = Router::new().route("/v1/chat/completions", post(chat)).with_state(fake.clone());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (fake, url)
}

fn hermes_env(url: &str, dir: &std::path::Path) -> Vec<(&'static str, String)> {
    let key = dir.join("hermes-key");
    std::fs::write(&key, "hermes-test-key").unwrap();
    vec![
        ("LUMBRIDGE_HERMES_URL", url.to_string()),
        ("LUMBRIDGE_HERMES_KEY_FILE", key.to_string_lossy().into_owned()),
        ("LUMBRIDGE_ASKS_TICK_MS", "100".into()),
        ("LUMBRIDGE_ASKS_RETRY_MS", "300".into()),
    ]
}

/// Up to 20 s: on a loaded CI runner a gateway's first database connection and first retry round can take seconds. It returns as
/// soon as `ok` holds, so a fast run stays fast.
async fn eventually(mut ok: impl FnMut() -> bool) -> bool {
    for _ in 0..400 {
        if ok() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    false
}

#[tokio::test]
async fn answering_each_way_tells_the_assistant_once() {
    let Some((name, url)) = database().await else { return };
    let (hermes, hermes_url) = fake_hermes().await;
    let keys = tempfile::tempdir().unwrap();
    let gw = gateway_with(Some(&url), &hermes_env(&hermes_url, keys.path())).await;
    if !gw.admitted().await {
        drop(gw);
        drop_database(&name).await;
        return;
    }
    let first = ask(&url, "Book the dentist for Thursday?", "");
    let second = ask(&url, "Cancel the gym?", "It renews on the 10th.");
    let third = ask(&url, "Which day for the plumber?", "");

    let (s, list) = gw.get("/api/asks").await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(titles(&list), ["Which day for the plumber?", "Cancel the gym?", "Book the dentist for Thursday?"], "newest first");
    assert_eq!(list[1]["body"], "It renews on the 10th.");

    let gw = &gw;
    let answer = |id: &str, body: Value| {
        let path = format!("/api/asks/{id}/answer");
        async move { gw.post(&path, body).await }
    };
    let (s, a) = answer(&first, json!({"verdict": "accept"})).await;
    assert_eq!((s, a["status"].as_str(), a["version"].as_i64()), (StatusCode::OK, Some("accepted"), Some(2)));
    assert!(a["answered_at"].is_string());
    let (s, d) = answer(&second, json!({"verdict": "deny"})).await;
    assert_eq!((s, d["status"].as_str()), (StatusCode::OK, Some("denied")));
    for (body, code) in [
        (json!({"verdict": "reply"}), "empty_reply"),
        (json!({"verdict": "reply", "text": "   "}), "empty_reply"),
        (json!({"verdict": "maybe"}), "invalid_verdict"),
        (json!({"verdict": "accept", "text": "but only mornings"}), "text_needs_reply"),
    ] {
        let (s, e) = answer(&third, body.clone()).await;
        assert_eq!((s, e["error"].as_str()), (StatusCode::UNPROCESSABLE_ENTITY, Some(code)), "{body}");
    }
    let (s, r) = answer(&third, json!({"verdict": "reply", "text": " Friday, after 3. "})).await;
    assert_eq!((s, r["status"].as_str(), r["reply"].as_str()), (StatusCode::OK, Some("replied"), Some("Friday, after 3.")));

    // A second answer changes nothing, and says what stands.
    let (s, again) = answer(&first, json!({"verdict": "deny"})).await;
    assert_eq!((s, again["error"].as_str(), again["ask"]["status"].as_str()), (StatusCode::CONFLICT, Some("already_answered"), Some("accepted")));
    let (s, again) = answer(&third, json!({"verdict": "reply", "text": "Saturday"})).await;
    assert_eq!((s, again["ask"]["reply"].as_str()), (StatusCode::CONFLICT, Some("Friday, after 3.")));
    assert_eq!(answer(&Uuid::new_v4().to_string(), json!({"verdict": "accept"})).await.0, StatusCode::NOT_FOUND);

    let (_, pending) = gw.get("/api/asks").await;
    assert!(pending.as_array().unwrap().is_empty(), "answered ones leave the list");
    let (_, answered) = gw.get("/api/asks?answered=1").await;
    assert_eq!(titles(&answered), ["Which day for the plumber?", "Cancel the gym?", "Book the dentist for Thursday?"]);

    assert!(eventually(|| hermes.turns.lock().unwrap().len() == 3).await, "{:?}", hermes.turns.lock().unwrap());
    let mut words: Vec<String> = hermes.turns.lock().unwrap().iter().map(|t| t.1.clone()).collect();
    words.sort();
    assert_eq!(
        words,
        [
            "The owner answered your question \"Book the dentist for Thursday?\": accepted.",
            "The owner answered your question \"Cancel the gym?\": denied.",
            "The owner answered your question \"Which day for the plumber?\": replied: Friday, after 3.",
        ]
    );
    assert!(hermes.turns.lock().unwrap().iter().all(|t| t.0.starts_with("lumbridge_")), "in the pinned assistant session");
    let (c, connection) = tokio_postgres::connect(&url, tokio_postgres::NoTls).await.unwrap();
    tokio::spawn(connection);
    let undelivered = || async { c.query_one("select count(*) from asks where delivered_at is null", &[]).await.unwrap().get::<_, i64>(0) };
    for _ in 0..400 {
        if undelivered().await == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(undelivered().await, 0);
    tokio::time::sleep(Duration::from_millis(1000)).await; // a few retry rounds
    assert_eq!(hermes.turns.lock().unwrap().len(), 3, "each went once");
    drop(c);
    drop_database(&name).await;
}

#[tokio::test]
async fn an_answer_the_assistant_missed_reaches_it_later_once() {
    let Some((name, url)) = database().await else { return };
    let (hermes, hermes_url) = fake_hermes().await;
    let keys = tempfile::tempdir().unwrap();
    let env = hermes_env(&hermes_url, keys.path());
    hermes.down.store(true, Ordering::SeqCst);
    let gw = gateway_with(Some(&url), &env).await;
    if !gw.admitted().await {
        drop(gw);
        drop_database(&name).await;
        return;
    }
    let (c, connection) = tokio_postgres::connect(&url, tokio_postgres::NoTls).await.unwrap();
    tokio::spawn(connection);
    let delivered = |id: String| {
        let c = &c;
        async move {
            let id: Uuid = id.parse().unwrap();
            c.query_one("select delivered_at is not null from asks where id = $1", &[&id]).await.unwrap().get::<_, bool>(0)
        }
    };

    // Hermes is down: the answer is saved, and the owner isn't kept waiting.
    let id = ask(&url, "Renew the domain?", "");
    let started = std::time::Instant::now();
    let (s, _) = gw.post(&format!("/api/asks/{id}/answer"), json!({"verdict": "accept"})).await;
    assert_eq!(s, StatusCode::OK);
    assert!(started.elapsed() < Duration::from_secs(2));
    tokio::time::sleep(Duration::from_millis(800)).await;
    assert!(!delivered(id.clone()).await);
    assert!(hermes.turns.lock().unwrap().is_empty());

    // It comes back: the retry sends it, once.
    hermes.down.store(false, Ordering::SeqCst);
    assert!(eventually(|| hermes.turns.lock().unwrap().len() == 1).await);
    let mut marked = false;
    for _ in 0..400 {
        if delivered(id.clone()).await {
            marked = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(marked);
    tokio::time::sleep(Duration::from_millis(1000)).await;
    assert_eq!(hermes.turns.lock().unwrap().len(), 1, "not sent twice");

    // Across a gateway restart: nothing is held in memory that matters.
    hermes.down.store(true, Ordering::SeqCst);
    let id = ask(&url, "Move the call to 4?", "");
    let (s, _) = gw.post(&format!("/api/asks/{id}/answer"), json!({"verdict": "reply", "text": "Make it 5"})).await;
    assert_eq!(s, StatusCode::OK);
    drop(gw);
    hermes.down.store(false, Ordering::SeqCst);
    let gw = gateway_with(Some(&url), &env).await;
    assert!(eventually(|| hermes.turns.lock().unwrap().len() == 2).await);
    assert_eq!(hermes.turns.lock().unwrap()[1].1, "The owner answered your question \"Move the call to 4?\": replied: Make it 5");
    tokio::time::sleep(Duration::from_millis(1000)).await;
    assert!(delivered(id).await);
    assert_eq!(hermes.turns.lock().unwrap().len(), 2);
    drop(c);
    drop(gw);
    drop_database(&name).await;
}

fn roles() -> Value {
    json!([
        {"key": "459", "label": "Platform engineer, Acme", "detail": "Remote. Rust and Postgres.", "link": "https://jobs.example.com/459"},
        {"key": "436", "label": "SRE, Initech", "detail": "Hybrid, two days in."},
        {"key": "12", "label": "Backend, Globex", "detail": ""},
    ])
}

fn ask_with_options(url: &str, title: &str, options: Value) -> String {
    let (ok, row, err) = asks_cli(url, &["create"], &json!({"title": title, "body": "1. Acme\n2. Initech\n3. Globex", "options": options}).to_string());
    assert!(ok, "{err}");
    row["id"].as_str().unwrap().to_string()
}

/// Needs no gateway, so no admission: this runs in every build.
#[tokio::test]
async fn an_ask_with_options_from_the_cli_and_what_the_database_holds_it_to() {
    let Some((name, url)) = database().await else { return };
    let (ok, row, err) = asks_cli(&url, &["create"], &json!({"title": "Pick roles for your first applications", "options": roles()}).to_string());
    assert!(ok, "{err}");
    assert_eq!(row["options"], roles());
    assert!(row["picked"].is_null());
    let plain = ask(&url, "Call the bank?", "");

    let three = |o: Value| json!({"title": "Pick", "options": o}).to_string();
    for (input, why) in [
        (three(json!([])), "1 to 20"),
        (three(json!((0..21).map(|i| json!({"key": i.to_string(), "label": "x"})).collect::<Vec<_>>())), "1 to 20"),
        (three(json!([{"key": "a", "label": "x"}, {"key": "a", "label": "y"}])), "two options"),
        (three(json!([{"key": "k".repeat(41), "label": "x"}])), "40"),
        (three(json!([{"key": "a", "label": "x".repeat(121)}])), "120"),
        (three(json!([{"key": "a", "label": "x", "detail": "d".repeat(401)}])), "400"),
        (three(json!([{"key": "a", "label": "x", "link": "http://jobs.example.com/1"}])), "https://"),
        (three(json!([{"key": "a", "label": "x", "link": "javascript:alert(1)"}])), "https://"),
        (three(json!([{"key": "a", "label": "x", "salary": "lots"}])), "JSON"),
        (three(json!([{"label": "x"}])), "JSON"),
        (three(json!({"key": "a"})), "JSON"),
    ] {
        let (ok, out, err) = asks_cli(&url, &["create"], &input);
        assert!(!ok && out.is_null(), "{input}");
        assert!(err.contains(why), "{input}: {err}");
    }

    // The same rules in the database, for anything that gets past the gateway.
    let (c, connection) = tokio_postgres::connect(&url, tokio_postgres::NoTls).await.unwrap();
    tokio::spawn(connection);
    let insert = |options: Value| {
        let c = &c;
        async move { c.execute("insert into asks (title, options) values ('x', $1::text::jsonb)", &[&options.to_string()]).await }
    };
    for bad in [
        json!([]),
        json!({"key": "a", "label": "x"}),
        json!([{"key": "a", "label": "x", "detail": ""}, {"key": "a", "label": "y", "detail": ""}]),
        json!([{"key": "", "label": "x", "detail": ""}]),
        json!([{"key": "a", "label": "x", "detail": "", "link": "http://x.com"}]),
        json!([{"key": "a", "label": "x", "detail": "", "extra": 1}]),
        json!([{"key": "a", "label": "x"}]),
        json!([{"key": "a", "label": "x\ny", "detail": ""}]),
    ] {
        assert!(insert(bad.clone()).await.is_err(), "{bad}");
    }
    assert!(insert(json!([{"key": "a", "label": "x", "detail": "", "link": "https://x.com/a?b=c"}])).await.is_ok());
    let id: Uuid = row["id"].as_str().unwrap().parse().unwrap();
    let plain: Uuid = plain.parse().unwrap();
    let set = |sql: &'static str, id: Uuid, picked: Vec<&'static str>| {
        let c = &c;
        let picked: Vec<String> = picked.into_iter().map(String::from).collect();
        async move { c.execute(sql, &[&id, &picked]).await }
    };
    let accept = "update asks set status = 'accepted', answered_at = now(), picked = $2 where id = $1";
    let deny = "update asks set status = 'denied', answered_at = now(), picked = $2 where id = $1";
    assert!(set(accept, id, vec!["999"]).await.is_err(), "only its own keys");
    assert!(set(accept, id, vec!["459", "459"]).await.is_err(), "no repeats");
    assert!(set(accept, id, vec![]).await.is_err(), "at least one");
    assert!(set(deny, id, vec!["459"]).await.is_err(), "only with accepted");
    assert!(set(accept, plain, vec!["459"]).await.is_err(), "only with options");
    assert!(c.execute("update asks set status = 'accepted', answered_at = now() where id = $1", &[&id]).await.is_err(), "accepted means which");
    assert_eq!(set(accept, id, vec!["459", "12"]).await.unwrap(), 1);

    let (ok, recent, err) = asks_cli(&url, &["recent"], "");
    assert!(ok, "{err}");
    let listed = recent.as_array().unwrap().iter().find(|a| a["id"] == row["id"]).unwrap();
    assert_eq!((&listed["options"], &listed["picked"]), (&roles(), &json!(["459", "12"])), "asks recent prints them");
    drop(c);
    drop_database(&name).await;
}

#[tokio::test]
async fn picking_from_an_ask_with_options() {
    let Some((name, url)) = database().await else { return };
    let (hermes, hermes_url) = fake_hermes().await;
    let keys = tempfile::tempdir().unwrap();
    let gw = gateway_with(Some(&url), &hermes_env(&hermes_url, keys.path())).await;
    if !gw.admitted().await {
        drop(gw);
        drop_database(&name).await;
        return;
    }
    let plain = ask(&url, "Call the bank?", "");
    let picked = ask_with_options(&url, "Pick roles for your first applications", roles());
    let none = ask_with_options(&url, "Pick roles for round two", roles());
    let replied = ask_with_options(&url, "Pick roles for round three", roles());

    let (s, list) = gw.get("/api/asks").await;
    assert_eq!(s, StatusCode::OK);
    let row = |id: &str| list.as_array().unwrap().iter().find(|a| a["id"] == id).unwrap().clone();
    assert_eq!(row(&picked)["options"], roles());
    assert!(row(&picked)["picked"].is_null());
    assert!(row(&plain)["options"].is_null(), "a plain ask has none");

    let gw = &gw;
    let answer = |id: &str, body: Value| {
        let path = format!("/api/asks/{id}/answer");
        async move { gw.post(&path, body).await }
    };
    for (id, body, code) in [
        (&picked, json!({"verdict": "accept"}), "pick_which"),
        (&picked, json!({"verdict": "pick"}), "bad_keys"),
        (&picked, json!({"verdict": "pick", "keys": []}), "bad_keys"),
        (&picked, json!({"verdict": "pick", "keys": ["459", "459"]}), "bad_keys"),
        (&picked, json!({"verdict": "pick", "keys": ["459", "999"]}), "bad_keys"),
        (&picked, json!({"verdict": "deny", "keys": ["459"]}), "bad_keys"),
        (&plain, json!({"verdict": "pick", "keys": ["459"]}), "bad_keys"),
    ] {
        let (s, e) = answer(id, body.clone()).await;
        assert_eq!((s, e["error"].as_str()), (StatusCode::BAD_REQUEST, Some(code)), "{body}");
    }
    let (s, e) = answer(&picked, json!({"verdict": "pick", "keys": ["459"], "text": "fast"})).await;
    assert_eq!((s, e["error"].as_str()), (StatusCode::UNPROCESSABLE_ENTITY, Some("text_needs_reply")));
    let (_, still) = gw.get("/api/asks").await;
    assert_eq!(still.as_array().unwrap().len(), 4, "a refused answer changes nothing");

    let (s, a) = answer(&picked, json!({"verdict": "pick", "keys": ["459", "436"]})).await;
    assert_eq!((s, a["status"].as_str(), &a["picked"]), (StatusCode::OK, Some("accepted"), &json!(["459", "436"])));
    assert!(a["answered_at"].is_string());
    let (s, d) = answer(&none, json!({"verdict": "deny"})).await;
    assert_eq!((s, d["status"].as_str(), d["picked"].is_null()), (StatusCode::OK, Some("denied"), true), "None of these");
    let (s, r) = answer(&replied, json!({"verdict": "reply", "text": "1 and 5, if 5 is remote"})).await;
    assert_eq!((s, r["status"].as_str(), r["picked"].is_null()), (StatusCode::OK, Some("replied"), true));
    let (s, a) = answer(&plain, json!({"verdict": "accept"})).await;
    assert_eq!((s, a["status"].as_str()), (StatusCode::OK, Some("accepted")), "a plain ask still takes accept");

    // Once only, whichever way.
    for (id, body) in [
        (&picked, json!({"verdict": "pick", "keys": ["12"]})),
        (&picked, json!({"verdict": "deny"})),
        (&none, json!({"verdict": "pick", "keys": ["459"]})),
        (&replied, json!({"verdict": "pick", "keys": ["459"]})),
    ] {
        let (s, again) = answer(id, body.clone()).await;
        assert_eq!((s, again["error"].as_str()), (StatusCode::CONFLICT, Some("already_answered")), "{body}");
    }
    let (_, again) = answer(&picked, json!({"verdict": "pick", "keys": ["12"]})).await;
    assert_eq!(again["ask"]["picked"], json!(["459", "436"]), "the first pick stands");
    assert_eq!(answer(&Uuid::new_v4().to_string(), json!({"verdict": "pick", "keys": ["459"]})).await.0, StatusCode::NOT_FOUND);

    let (_, answered) = gw.get("/api/asks?answered=1").await;
    let row = answered.as_array().unwrap().iter().find(|a| a["id"] == picked.as_str()).unwrap();
    assert_eq!((&row["options"], &row["picked"]), (&roles(), &json!(["459", "436"])));

    assert!(eventually(|| hermes.turns.lock().unwrap().len() == 4).await, "{:?}", hermes.turns.lock().unwrap());
    let words: Vec<String> = hermes.turns.lock().unwrap().iter().map(|t| t.1.clone()).collect();
    for said in [
        "The owner answered your question \"Pick roles for your first applications\": picked 459, 436.",
        "The owner answered your question \"Pick roles for round two\": none of these.",
        "The owner answered your question \"Pick roles for round three\": replied: 1 and 5, if 5 is remote",
    ] {
        assert!(words.iter().any(|w| w == said), "{said}: {words:?}");
    }
    drop_database(&name).await;
}

// ---- Note proposals, agent devices and MCP ------------------------------------------------------------------------------

const AGENT_TOKEN: &str = "an-agent-device-token-of-at-least-32-characters";
const OTHER_AGENT_TOKEN: &str = "another-agent-device-token-of-at-least-32-chars";

impl Gateway {
    /// An agent device by this name, as `lumbridge-mobile-server pair <name> --agent` would make one (dev builds only).
    fn add_agent(&self, name: &str, token: &str) {
        let mut child = Command::new(env!("CARGO_BIN_EXE_lumbridge-mobile-server"))
            .args(["dev-add", name, "--agent"])
            .env_clear()
            .env("LUMBRIDGE_STATE_DIR", &self.dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        std::io::Write::write_all(&mut child.stdin.take().unwrap(), token.as_bytes()).unwrap();
        assert!(child.wait().unwrap().success());
    }
    async fn call_as(&self, token: &str, method: Method, path: &str, body: Option<Value>) -> (StatusCode, Value) {
        let mut req = self.http.request(method, format!("{}{path}", self.base)).header("Tailscale-User-Login", LOGIN).bearer_auth(token);
        if let Some(b) = body {
            req = req.json(&b);
        }
        let res = req.send().await.unwrap();
        let status = res.status();
        let text = res.text().await.unwrap();
        (status, serde_json::from_str(&text).unwrap_or(Value::String(text)))
    }
}

async fn on_db(url: &str) -> tokio_postgres::Client {
    let (client, connection) = tokio_postgres::connect(url, tokio_postgres::NoTls).await.unwrap();
    tokio::spawn(connection);
    client
}

async fn count(db: &tokio_postgres::Client, sql: &str) -> i64 {
    db.query_one(sql, &[]).await.unwrap().get(0)
}

macro_rules! setup_with_agent {
    () => {{
        let Some((name, url)) = database().await else { return };
        let gw = gateway(Some(&url)).await;
        if !gw.admitted().await {
            drop_database(&name).await;
            return;
        }
        gw.add_agent("claude-build", AGENT_TOKEN);
        (name, url, gw)
    }};
}

#[tokio::test]
async fn an_agent_reads_notes_and_proposes_and_nothing_else() {
    let (name, url, gw) = setup_with_agent!();
    let db = on_db(&url).await;
    let (_, note) = gw.post("/api/notes", json!({"title": "Roof", "body": "The north corner leaks when it rains from the east."})).await;
    let note_id = note["id"].as_str().unwrap();
    let (_, gone) = gw.post("/api/notes", json!({"title": "Thrown away", "body": "x"})).await;
    gw.delete(&format!("/api/notes/{}", gone["id"].as_str().unwrap())).await;
    let gw = &gw;
    let agent = |m: Method, p: &str, b: Option<Value>| {
        let p = p.to_string();
        async move { gw.call_as(AGENT_TOKEN, m, &p, b).await }
    };

    // Reading is allowed, and only reading.
    let (s, list) = agent(Method::GET, "/api/notes?q=leaks", None).await;
    assert_eq!((s, titles(&list)), (StatusCode::OK, vec!["Roof"]));
    assert_eq!(agent(Method::GET, &format!("/api/notes/{note_id}"), None).await.1["body"], note["body"]);
    let refused = (StatusCode::FORBIDDEN, json!({"error": "agent_not_allowed"}));
    assert_eq!(agent(Method::GET, "/api/notes?deleted=true", None).await, refused);
    assert_eq!(agent(Method::POST, "/api/notes", Some(json!({"title": "mine now"}))).await, refused);
    assert_eq!(agent(Method::PATCH, &format!("/api/notes/{note_id}"), Some(json!({"version": 1, "body": "x"}))).await, refused);
    assert_eq!(agent(Method::DELETE, &format!("/api/notes/{note_id}"), None).await, refused);
    assert_eq!(agent(Method::GET, "/api/tasks", None).await, refused);
    assert_eq!(agent(Method::GET, "/api/asks", None).await, refused);
    assert_eq!(agent(Method::GET, "/api/assistant/needs", None).await, refused);
    assert_eq!(agent(Method::GET, "/api/note-proposals", None).await, refused, "only its own, and only by asking for them");
    assert_eq!(count(&db, "select count(*) from notes where deleted_at is null").await, 1, "nothing written");

    // Proposing: from the device, whatever the body says.
    let (s, spoof) = agent(Method::POST, "/api/note-proposals", Some(json!({"title": "t", "body": "b", "proposed_by": "sam-phone"}))).await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY, "{spoof}");
    assert_eq!(count(&db, "select count(*) from note_proposals").await, 0);
    let (s, p) = agent(Method::POST, "/api/note-proposals", Some(json!({"title": " Gutter ", "body": "Clear the north gutter in October.", "why": "It caused the leak.", "source": "https://langfuse.example/trace/1"}))).await;
    assert_eq!(s, StatusCode::CREATED, "{p}");
    assert_eq!((p["title"].as_str(), p["proposed_by"].as_str(), p["status"].as_str()), (Some("Gutter"), Some("claude-build"), Some("pending")));
    assert_eq!(count(&db, "select count(*) from note_proposals where proposed_by = 'claude-build'").await, 1);

    // Its own, and not anyone else's.
    gw.add_agent("assistant-hermes", OTHER_AGENT_TOKEN);
    let (s, _) = gw.call_as(OTHER_AGENT_TOKEN, Method::POST, "/api/note-proposals", Some(json!({"title": "Other", "body": "From another agent."}))).await;
    assert_eq!(s, StatusCode::CREATED);
    let (s, mine) = agent(Method::GET, "/api/note-proposals?mine=true&status=all", None).await;
    assert_eq!((s, titles(&mine)), (StatusCode::OK, vec!["Gutter"]));
    let (_, all) = gw.get("/api/note-proposals").await;
    assert_eq!(titles(&all), vec!["Other", "Gutter"], "the owner's devices see them all, newest first");
    let (_, found) = gw.get("/api/note-proposals?q=gutter").await;
    assert_eq!(titles(&found), vec!["Gutter"]);

    // Only the owner decides.
    let decide = format!("/api/note-proposals/{}/decide", p["id"].as_str().unwrap());
    assert_eq!(agent(Method::POST, &decide, Some(json!({"decision": "accept", "version": 1}))).await, refused);
    assert_eq!(count(&db, "select count(*) from note_proposals where status = 'pending'").await, 2);
    drop_database(&name).await;
}

#[tokio::test]
async fn a_proposal_is_kept_once_as_one_note_or_dropped() {
    let (name, url, gw) = setup_with_agent!();
    let db = on_db(&url).await;
    let propose = |title: &str| {
        let body = json!({"title": title, "body": format!("{title}, as proposed."), "why": "worth it", "source": "session 42"});
        gw.call_as(AGENT_TOKEN, Method::POST, "/api/note-proposals", Some(body))
    };
    let (_, keep) = propose("Keep me").await;
    let (_, drop_me) = propose("Drop me").await;
    let (_, plain) = propose("Keep me as I am").await;
    let path = |p: &Value| format!("/api/note-proposals/{}/decide", p["id"].as_str().unwrap());

    assert_eq!(gw.post(&path(&keep), json!({"decision": "maybe", "version": 1})).await.0, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(gw.post(&path(&drop_me), json!({"decision": "deny", "version": 1, "body": "x"})).await.0, StatusCode::UNPROCESSABLE_ENTITY);
    let (s, stale) = gw.post(&path(&keep), json!({"decision": "accept", "version": 7})).await;
    assert_eq!((s, stale["error"].as_str(), stale["proposal"]["status"].as_str()), (StatusCode::CONFLICT, Some("version_conflict"), Some("pending")));
    assert_eq!(gw.post(&format!("/api/note-proposals/{}/decide", Uuid::new_v4()), json!({"decision": "deny", "version": 1})).await.0, StatusCode::NOT_FOUND);

    // Edit and keep: the owner's words, and the footer.
    let (s, kept) = gw.post(&path(&keep), json!({"decision": "accept", "version": 1, "title": "Kept, edited", "body": "His own words.\n"})).await;
    assert_eq!(s, StatusCode::OK, "{kept}");
    let note = &kept["note"];
    let day = chrono_day(&keep["created_at"]);
    assert_eq!(note["title"], "Kept, edited");
    assert_eq!(note["body"], format!("His own words.\n\n— proposed by claude-build, {day}; source: session 42"));
    assert_eq!(kept["proposal"]["status"], "accepted");
    assert_eq!(kept["proposal"]["note_id"], note["id"]);
    assert!(kept["proposal"]["decided_at"].is_string());
    assert_eq!(gw.get(&format!("/api/notes/{}", note["id"].as_str().unwrap())).await.1["title"], "Kept, edited");

    // Twice: the decision stands, and the client sees it.
    for again in [json!({"decision": "accept", "version": 2}), json!({"decision": "deny", "version": 1}), json!({"decision": "accept", "version": 1})] {
        let (s, body) = gw.post(&path(&keep), again.clone()).await;
        assert_eq!((s, body["error"].as_str(), body["proposal"]["status"].as_str()), (StatusCode::CONFLICT, Some("already_decided"), Some("accepted")), "{again}");
    }
    assert_eq!(count(&db, "select count(*) from notes").await, 1, "kept once, one note");

    let (_, as_is) = gw.post(&path(&plain), json!({"decision": "accept", "version": 1})).await;
    assert_eq!(as_is["note"]["title"], "Keep me as I am");
    assert!(as_is["note"]["body"].as_str().unwrap().starts_with("Keep me as I am, as proposed.\n\n— proposed by claude-build, "));

    let (s, dropped) = gw.post(&path(&drop_me), json!({"decision": "deny", "version": 1})).await;
    assert_eq!((s, dropped["proposal"]["status"].as_str(), &dropped["note"]), (StatusCode::OK, Some("denied"), &Value::Null));
    assert_eq!(count(&db, "select count(*) from notes").await, 2);
    assert_eq!(gw.get("/api/note-proposals").await.1, json!([]), "nothing pending");
    let (_, all) = gw.get("/api/note-proposals?status=all").await;
    assert_eq!(all.as_array().unwrap().len(), 3);
    assert_eq!(gw.get("/api/note-proposals?status=nope").await.0, StatusCode::UNPROCESSABLE_ENTITY);
    drop_database(&name).await;
}

fn chrono_day(at: &Value) -> String {
    at.as_str().unwrap()[..10].to_string()
}

#[tokio::test]
async fn keeping_is_one_transaction() {
    let (name, url, gw) = setup_with_agent!();
    let (_, p) = gw.call_as(AGENT_TOKEN, Method::POST, "/api/note-proposals", Some(json!({"title": "t", "body": "b"}))).await;
    // Making the note fails: the proposal must be left as it was, not marked kept with no note.
    let admin_db = on_db(&pg(ADMIN_LOGIN, &name)).await;
    admin_db
        .batch_execute(
            "create function lumbridge.no_notes() returns trigger language plpgsql as $$ begin raise exception 'no notes today'; end $$;
             create trigger no_notes before insert on lumbridge.notes for each row execute function lumbridge.no_notes();",
        )
        .await
        .unwrap();
    let path = format!("/api/note-proposals/{}/decide", p["id"].as_str().unwrap());
    assert_eq!(gw.post(&path, json!({"decision": "accept", "version": 1})).await.0, StatusCode::INTERNAL_SERVER_ERROR);
    let db = on_db(&url).await;
    let row = db.query_one("select status, note_id, decided_at, version from note_proposals", &[]).await.unwrap();
    assert_eq!(row.get::<_, String>(0), "pending");
    assert!(row.get::<_, Option<Uuid>>(1).is_none());
    assert_eq!(row.get::<_, i32>(3), 1);
    admin_db.batch_execute("drop trigger no_notes on lumbridge.notes").await.unwrap();
    let (s, kept) = gw.post(&path, json!({"decision": "accept", "version": 1})).await;
    assert_eq!((s, kept["proposal"]["status"].as_str()), (StatusCode::OK, Some("accepted")));
    assert_eq!(count(&db, "select count(*) from notes").await, 1);
    drop(gw);
    drop(admin_db);
    drop_database(&name).await;
}

#[tokio::test]
async fn proposals_are_capped_and_a_retry_makes_one() {
    let (name, url, gw) = setup_with_agent!();
    let db = on_db(&url).await;
    let agent = |b: Value| gw.call_as(AGENT_TOKEN, Method::POST, "/api/note-proposals", Some(b));
    let id = Uuid::new_v4();
    let (s, first) = agent(json!({"id": id, "title": "Once", "body": "Only once."})).await;
    assert_eq!(s, StatusCode::CREATED);
    let (s, again) = agent(json!({"id": id, "title": "Once", "body": "Only once."})).await;
    assert_eq!((s, &again), (StatusCode::OK, &first), "a retry answers with the same row");
    assert_eq!(count(&db, "select count(*) from note_proposals").await, 1);
    // Another device's id isn't this one's to see.
    let (s, taken) = gw.post("/api/note-proposals", json!({"id": id, "title": "x", "body": "y"})).await;
    assert_eq!((s, taken["error"].as_str()), (StatusCode::CONFLICT, Some("id_taken")));

    for i in 1..30 {
        assert_eq!(agent(json!({"title": format!("Idea {i}"), "body": "x"})).await.0, StatusCode::CREATED, "{i}");
    }
    let (s, full) = agent(json!({"title": "One too many", "body": "x"})).await;
    assert_eq!((s, full["error"].as_str()), (StatusCode::TOO_MANY_REQUESTS, Some("too_many_pending")));
    assert_eq!(gw.post("/api/note-proposals", json!({"title": "Nor from his", "body": "x"})).await.0, StatusCode::TOO_MANY_REQUESTS, "the cap is for everyone together");
    // A retry of one that's in still answers, cap or not.
    assert_eq!(agent(json!({"id": id, "title": "Once", "body": "Only once."})).await.0, StatusCode::OK);
    // Deciding one makes room for one.
    gw.post(&format!("/api/note-proposals/{id}/decide"), json!({"decision": "deny", "version": 1})).await;
    assert_eq!(agent(json!({"title": "Room now", "body": "x"})).await.0, StatusCode::CREATED);
    assert_eq!(agent(json!({"title": "And not again", "body": "x"})).await.0, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(count(&db, "select count(*) from note_proposals where status = 'pending'").await, 30);
    // The checks.
    for (bad, code) in [(json!({"title": " ", "body": "x"}), "empty_title"), (json!({"title": "x", "body": "x".repeat(20_001)}), "body_too_long"), (json!({"title": "x".repeat(201), "body": "x"}), "title_too_long")] {
        let (s, body) = agent(bad).await;
        assert_eq!((s, body["error"].as_str()), (StatusCode::UNPROCESSABLE_ENTITY, Some(code)));
    }
    drop_database(&name).await;
}

async fn mcp(gw: &Gateway, token: &str, id: i64, method: &str, params: Value) -> Value {
    let res = gw
        .http
        .post(format!("{}/mcp", gw.base))
        .header("Tailscale-User-Login", LOGIN)
        .header("accept", "application/json, text/event-stream")
        .bearer_auth(token)
        .json(&json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert!(res.headers()["content-type"].to_str().unwrap().starts_with("application/json"));
    res.json().await.unwrap()
}

#[tokio::test]
async fn mcp_round_trip() {
    let (name, url, gw) = setup_with_agent!();
    let (_, note) = gw.post("/api/notes", json!({"title": "Boiler", "body": "The boiler was serviced in March by Heatwise. Next due in March."})).await;
    let init = mcp(&gw, AGENT_TOKEN, 1, "initialize", json!({"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "claude-code", "version": "2"}})).await;
    assert_eq!(init["result"]["protocolVersion"], "2025-06-18");
    let res = gw.http.post(format!("{}/mcp", gw.base)).bearer_auth(AGENT_TOKEN).json(&json!({"jsonrpc": "2.0", "method": "notifications/initialized"})).send().await.unwrap();
    assert_eq!(res.status(), StatusCode::ACCEPTED);
    let tools = mcp(&gw, AGENT_TOKEN, 2, "tools/list", json!({})).await;
    assert_eq!(tools["result"]["tools"].as_array().unwrap().len(), 4);

    let found = mcp(&gw, AGENT_TOKEN, 3, "tools/call", json!({"name": "notes_search", "arguments": {"query": "boiler service", "limit": 50}})).await;
    let hits = &found["result"]["structuredContent"]["notes"];
    assert_eq!(hits.as_array().unwrap().len(), 1, "{found}");
    assert_eq!(hits[0]["id"], note["id"]);
    assert!(hits[0]["snippet"].as_str().unwrap().contains("serviced"));
    assert!(found["result"]["content"][0]["text"].as_str().unwrap().contains("Boiler"));
    let read = mcp(&gw, AGENT_TOKEN, 4, "tools/call", json!({"name": "notes_read", "arguments": {"id": note["id"]}})).await;
    assert_eq!(read["result"]["structuredContent"]["body"], note["body"]);
    let missing = mcp(&gw, AGENT_TOKEN, 5, "tools/call", json!({"name": "notes_read", "arguments": {"id": Uuid::new_v4()}})).await;
    assert!(missing["error"]["message"].as_str().unwrap().starts_with("no note"));

    let proposed = mcp(&gw, AGENT_TOKEN, 6, "tools/call", json!({"name": "note_propose", "arguments": {"title": "Boiler pressure", "body": "Keep it at 1.5 bar.", "why": "Sam asked twice."}})).await;
    let pid = proposed["result"]["structuredContent"]["id"].as_str().unwrap().to_string();
    assert!(proposed["result"]["structuredContent"]["message"].as_str().unwrap().contains("For you"));
    let (_, pending) = gw.get("/api/note-proposals").await;
    assert_eq!((pending[0]["id"].as_str(), pending[0]["proposed_by"].as_str()), (Some(pid.as_str()), Some("claude-build")));
    let mine = mcp(&gw, AGENT_TOKEN, 7, "tools/call", json!({"name": "my_proposals", "arguments": {}})).await;
    assert_eq!(mine["result"]["structuredContent"]["proposals"][0]["status"], "pending");
    gw.post(&format!("/api/note-proposals/{pid}/decide"), json!({"decision": "accept", "version": 1})).await;
    let mine = mcp(&gw, AGENT_TOKEN, 8, "tools/call", json!({"name": "my_proposals", "arguments": {"status": "accepted"}})).await;
    assert!(mine["result"]["structuredContent"]["proposals"][0]["note_id"].is_string(), "{mine}");
    // The owner's devices may use it too, and their proposals are theirs.
    let his = mcp(&gw, TOKEN, 9, "tools/call", json!({"name": "my_proposals", "arguments": {}})).await;
    assert_eq!(his["result"]["structuredContent"]["proposals"], json!([]));
    let unknown = mcp(&gw, AGENT_TOKEN, 10, "prompts/list", json!({})).await;
    assert_eq!(unknown["error"]["code"], -32601);
    let _ = url;
    drop_database(&name).await;
}

#[tokio::test]
async fn without_migration_006_proposals_are_503_and_the_rest_works() {
    let (name, url, gw) = setup_with_agent!();
    let admin_db = on_db(&pg(ADMIN_LOGIN, &name)).await;
    admin_db.batch_execute("drop table lumbridge.note_proposals").await.unwrap();
    assert_eq!(gw.get("/api/note-proposals").await.0, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(gw.post("/api/note-proposals", json!({"title": "t", "body": "b"})).await.0, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(gw.post(&format!("/api/note-proposals/{}/decide", Uuid::new_v4()), json!({"decision": "deny", "version": 1})).await.0, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(gw.post("/api/notes", json!({"title": "still"})).await.0, StatusCode::CREATED);
    let _ = url;
    drop(admin_db);
    drop(gw);
    drop_database(&name).await;
}

fn cli(url: &str, args: &[&str], stdin: &str) -> (bool, Value, String) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_lumbridge-mobile-server"))
        .env_clear()
        .env("LUMBRIDGE_DATABASE_URL", url)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    std::io::Write::write_all(&mut child.stdin.take().unwrap(), stdin.as_bytes()).unwrap();
    let out = child.wait_with_output().unwrap();
    let stdout = String::from_utf8_lossy(&out.stdout);
    (out.status.success(), serde_json::from_str(&stdout).unwrap_or(Value::Null), String::from_utf8_lossy(&out.stderr).into_owned())
}

/// Needs no gateway, so no admission: this runs in every build.
#[tokio::test]
async fn the_assistant_reads_notes_and_proposes_from_the_cli() {
    let Some((name, url)) = database().await else { return };
    let db = on_db(&url).await;
    db.batch_execute(
        "insert into notes (title, body, updated_at) values ('Boiler', 'Serviced in March by Heatwise.', '2026-03-02');
         insert into notes (title, body, updated_at) values ('Car', 'Tyres changed.', '2026-11-01');
         insert into notes (title, body, updated_at, deleted_at) values ('Gone boiler', 'boiler', '2026-11-01', now());",
    )
    .await
    .unwrap();
    let (ok, found, err) = cli(&url, &["notes", "search", "boiler"], "");
    assert!(ok, "{err}");
    assert_eq!(titles(&found), vec!["Boiler"], "never a deleted one");
    let id = found[0]["id"].as_str().unwrap();
    let (ok, one, _) = cli(&url, &["notes", "read", id], "");
    assert!(ok);
    assert_eq!(one["body"], "Serviced in March by Heatwise.");
    let (ok, recent, _) = cli(&url, &["notes", "recent", "--since", "2026-10-01"], "");
    assert!(ok);
    assert_eq!(titles(&recent), vec!["Car"]);
    let (ok, _, err) = cli(&url, &["notes", "read", &Uuid::new_v4().to_string()], "");
    assert!(!ok && err.contains("no note"), "{err}");

    let (ok, p, err) = cli(&url, &["proposals", "create"], &json!({"title": "Heatwise", "body": "Their number is in the boiler note.", "why": "He asked."}).to_string());
    assert!(ok, "{err}");
    assert_eq!((p["proposed_by"].as_str(), p["status"].as_str()), (Some("assistant"), Some("pending")));
    let (ok, _, err) = cli(&url, &["proposals", "create"], &json!({"title": "x", "body": "y", "proposed_by": "owner"}).to_string());
    assert!(!ok && err.contains("proposed_by"), "{err}");
    let (ok, _, err) = cli(&url, &["proposals", "create"], &json!({"title": " ", "body": "y"}).to_string());
    assert!(!ok && err.contains("title is empty"), "{err}");
    assert_eq!(count(&db, "select count(*) from note_proposals").await, 1);
    assert_eq!(count(&db, "select count(*) from notes").await, 3, "the CLI wrote no note");
    drop(db);
    drop_database(&name).await;
}
