//! The owner's inbox, as the assistant's triage sorted it: the few messages and invites that need the owner, for For you.
//! Read-only rows, and two corrections the owner can make, which only teach the triage command (LUMBRIDGE_TRIAGE_CMD). Nothing
//! here touches mail or calendar services: a reply goes as a `mail_reply` draft, through the approve command (needs.rs), like
//! any other.
//!
//! The assistant's watcher puts a `mail` key in the needs file (LUMBRIDGE_NEEDS_FILE). Every word in it is a stranger's: who
//! wrote, the subject, and the assistant's one line on why. So it's re-serialized through the types below, each string capped and anything unknown dropped, and none of it
//! reaches a log or a push.

use crate::{auth::Device, hc, needs, reach, AppState};
use axum::{
    extract::{rejection::JsonRejection, ConnectInfo, Path as UrlPath, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Extension, Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    net::SocketAddr,
    path::PathBuf,
    process::Stdio,
    sync::{Arc, Mutex as StdMutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{process::Command, sync::Semaphore};

/// Under $HOME, when LUMBRIDGE_NEEDS_FILE is unset (the same default as needs.rs).
const DEFAULT_FILE: &str = ".local/state/lumbridge/needs.json";
const TOOL_TIMEOUT: Duration = Duration::from_secs(10);
/// The triage sorts every few minutes. Three quarters of an hour without a word means it has stalled.
const STALE_MS: u64 = 45 * 60_000;
/// The same bound as needs.rs: anything bigger isn't the file we think it is.
const MAX_FILE: u64 = 8 << 20;
const MAX_ROWS: usize = 200;
const MAX_FROM: usize = 60;
const MAX_SUBJECT: usize = 120;
const MAX_WHY: usize = 160;
const MAX_ACCOUNT: usize = 120;
const MAX_SENSITIVE: usize = 40;
/// How long Done or a sort hides a row the file still lists. The watcher rewrites it every minute, unless it has stopped.
const REMEMBER: Duration = Duration::from_secs(600);
const MAX_REMEMBERED: usize = 256;
/// Corrections at once. A hung tool can't pile up processes.
const MAX_RUNNING: usize = 4;
const WATCH_EVERY: Duration = Duration::from_secs(60);
/// At most one "Mail needs you" in this long.
const PUSH_EVERY: Duration = Duration::from_secs(30 * 60);

/// The three piles the triage sorts into, as it spells them.
const CATEGORIES: [&str; 3] = ["needs_you", "fyi", "noise"];

/// `<account>:<message id>` or `<account>:event:<calendar id>`, the account being one of LUMBRIDGE_MAIL_ACCOUNTS. Checked
/// before anything runs. No accounts: no key is valid, and the inbox is empty.
pub fn valid_key(accounts: &[String], key: &str) -> bool {
    let Some((account, rest)) = key.split_once(':') else { return false };
    let id = rest.strip_prefix("event:").unwrap_or(rest);
    accounts.iter().any(|a| a == account)
        && (5..=200).contains(&id.len())
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// At most `max` characters, cut on a character boundary.
fn cap(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// A row as the file has it. Every field is checked, because the file is another program's and the words are strangers'.
#[derive(Deserialize, Default)]
#[serde(default)]
struct RawRow {
    key: String,
    account: String,
    kind: String,
    from: String,
    subject: Option<String>,
    sensitive: Option<Value>,
    suspicious: Option<Value>,
    why: String,
    draft: Option<String>,
    since_ms: Option<u64>,
}

/// One row, as the page gets it.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Row {
    pub key: String,
    pub account: String,
    /// `mail` or `invite`.
    pub kind: &'static str,
    pub from: String,
    /// Never set on a sensitive row.
    pub subject: Option<String>,
    /// What kind of sensitive (`government`, ...), or none.
    pub sensitive: Option<String>,
    pub suspicious: bool,
    pub why: String,
    /// A `mail_reply` draft's id, shown under the row and not again among the drafts.
    pub draft: Option<String>,
    pub since_ms: u64,
}

impl RawRow {
    fn shown(self, accounts: &[String]) -> Option<Row> {
        let kind = match self.kind.as_str() {
            "mail" => "mail",
            "invite" => "invite",
            _ => return None,
        };
        if !valid_key(accounts, &self.key) || self.why.trim().is_empty() {
            return None;
        }
        // `"sensitive": "government"` or `true`; anything but absent, null or false counts. When in doubt, it's sensitive.
        let sensitive = match self.sensitive {
            None | Some(Value::Null) | Some(Value::Bool(false)) => None,
            Some(Value::String(s)) if !s.trim().is_empty() => Some(cap(&s, MAX_SENSITIVE)),
            Some(_) => Some("sensitive".to_string()),
        };
        let suspicious = !matches!(self.suspicious, None | Some(Value::Null) | Some(Value::Bool(false)));
        Some(Row {
            key: self.key,
            account: cap(&self.account, MAX_ACCOUNT),
            kind,
            from: cap(&self.from, MAX_FROM),
            subject: if sensitive.is_some() { None } else { self.subject.filter(|s| !s.is_empty()).map(|s| cap(&s, MAX_SUBJECT)) },
            sensitive,
            suspicious,
            why: cap(&self.why, MAX_WHY),
            draft: self.draft.filter(|d| needs::valid_id(d)),
            since_ms: self.since_ms.unwrap_or(0),
        })
    }
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct RawMail {
    updated_ms: u64,
    spark: Option<String>,
    unsorted: u64,
    fyi_count: u64,
    noise_count: u64,
    needs_you: Vec<Value>,
}

/// `GET /api/mail`. With no `mail` in the file, only `rows` and `stale`.
#[derive(Serialize, Default, Debug)]
pub struct Listing {
    pub rows: Vec<Row>,
    /// The triage hasn't sorted in 45 minutes, or the file is unreadable: the rows may be behind.
    pub stale: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_ms: Option<u64>,
    /// `ok` when the model host that does the sorting is up.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spark: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unsorted: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fyi_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub noise_count: Option<u64>,
}

pub struct Mail {
    file: PathBuf,
    bin: PathBuf,
    accounts: Vec<String>,
    timeout: Duration,
    /// Rows the owner has dealt with, by key, until the file catches up.
    handled: StdMutex<HashMap<String, Instant>>,
    running: Semaphore,
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Refusal {
    NotFromHere,
    BadKey,
    BadRequest,
    Busy,
    Failed,
}

impl IntoResponse for Refusal {
    fn into_response(self) -> Response {
        let (status, code) = match self {
            Refusal::NotFromHere => (StatusCode::FORBIDDEN, "not_from_here"),
            Refusal::BadKey => (StatusCode::BAD_REQUEST, "bad_key"),
            Refusal::BadRequest => (StatusCode::BAD_REQUEST, "bad_request"),
            Refusal::Busy => (StatusCode::SERVICE_UNAVAILABLE, "busy"),
            Refusal::Failed => (StatusCode::BAD_GATEWAY, "failed"),
        };
        (status, Json(json!({ "error": code }))).into_response()
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

impl Mail {
    pub fn from_env() -> Self {
        let home = PathBuf::from(std::env::var_os("HOME").unwrap_or_default());
        let file = std::env::var_os("LUMBRIDGE_NEEDS_FILE").map_or_else(|| home.join(DEFAULT_FILE), PathBuf::from);
        let bin = std::env::var_os("LUMBRIDGE_TRIAGE_CMD").map(PathBuf::from).unwrap_or_default();
        let accounts = std::env::var("LUMBRIDGE_MAIL_ACCOUNTS")
            .unwrap_or_default()
            .split(',')
            .map(|a| a.trim().to_string())
            .filter(|a| !a.is_empty() && a.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b)))
            .collect();
        Self::new(file, bin, accounts, TOOL_TIMEOUT)
    }

    fn new(file: PathBuf, bin: PathBuf, accounts: Vec<String>, timeout: Duration) -> Self {
        Self { file, bin, accounts, timeout, handled: StdMutex::new(HashMap::new()), running: Semaphore::new(MAX_RUNNING) }
    }

    /// The file's `mail`, typed. A missing file or key is an empty inbox; a broken file is stale.
    fn read(&self, now: u64) -> Listing {
        let Ok(meta) = std::fs::metadata(&self.file) else { return Listing::default() };
        let parsed = (meta.len() <= MAX_FILE)
            .then(|| std::fs::read(&self.file).ok())
            .flatten()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
        let Some(mut doc) = parsed else { return Listing { stale: true, ..Default::default() } };
        let raw = match doc.get_mut("mail").map(Value::take) {
            None | Some(Value::Null) => return Listing::default(),
            Some(m) => serde_json::from_value::<RawMail>(m).unwrap_or_default(),
        };
        let mut rows: Vec<Row> = raw
            .needs_you
            .into_iter()
            .take(MAX_ROWS)
            .filter_map(|r| serde_json::from_value::<RawRow>(r).ok()?.shown(&self.accounts))
            .collect();
        rows.sort_by(|a, b| b.since_ms.cmp(&a.since_ms).then_with(|| a.key.cmp(&b.key)));
        let mut seen = std::collections::HashSet::new();
        rows.retain(|r| seen.insert(r.key.clone()));
        Listing {
            rows,
            stale: now.saturating_sub(raw.updated_ms) > STALE_MS,
            updated_ms: Some(raw.updated_ms),
            spark: Some(cap(raw.spark.as_deref().unwrap_or("unknown"), 20)),
            unsorted: Some(raw.unsorted),
            fyi_count: Some(raw.fyi_count),
            noise_count: Some(raw.noise_count),
        }
    }

    /// The rows, without those the owner has just dealt with here.
    pub fn listing(&self) -> Listing {
        let mut listing = self.read(now_ms());
        let handled = self.handled.lock().unwrap();
        listing.rows.retain(|r| !handled.get(&r.key).is_some_and(|at| at.elapsed() < REMEMBER));
        listing
    }

    fn remember(&self, key: &str) {
        let mut handled = self.handled.lock().unwrap();
        handled.retain(|_, at| at.elapsed() < REMEMBER);
        if handled.len() >= MAX_REMEMBERED {
            if let Some(oldest) = handled.iter().min_by_key(|(_, at)| **at).map(|(k, _)| k.clone()) {
                handled.remove(&oldest);
            }
        }
        handled.insert(key.to_string(), Instant::now());
    }

    /// Runs the fixed binary, argv only, no shell, every argument already checked. Its output is never read.
    async fn run(&self, args: &[&str]) -> Result<(), Refusal> {
        let Ok(_permit) = self.running.try_acquire() else { return Err(Refusal::Busy) };
        let mut command = Command::new(&self.bin);
        command
            .args(args)
            .env_clear()
            .envs(hc::kept_env())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        match tokio::time::timeout(self.timeout, command.status()).await {
            Ok(Ok(status)) if status.success() => Ok(()),
            _ => Err(Refusal::Failed),
        }
    }
}

fn peer_of(peer: Option<Extension<ConnectInfo<SocketAddr>>>) -> Option<SocketAddr> {
    peer.map(|Extension(ConnectInfo(addr))| addr)
}

async fn list(_: Device, State(state): State<Arc<AppState>>) -> Json<Listing> {
    Json(state.mail.listing())
}

/// Done: the owner has seen it, and it needn't be shown again.
async fn dismiss(
    _: Device,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    State(state): State<Arc<AppState>>,
    UrlPath(key): UrlPath<String>,
) -> Result<Json<Value>, Refusal> {
    if !valid_key(&state.mail.accounts, &key) {
        return Err(Refusal::BadKey);
    }
    // The assistant could tap it on a device it operates, and teaching its own triage is not its to do.
    if !reach::from_owners_hands(&state, peer_of(peer)).await {
        return Err(Refusal::NotFromHere);
    }
    state.mail.run(&["dismiss", &key]).await?;
    state.mail.remember(&key);
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct Sort {
    category: String,
}

/// Wrong sort: where it should have gone.
async fn sort(
    _: Device,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    State(state): State<Arc<AppState>>,
    UrlPath(key): UrlPath<String>,
    body: Result<Json<Sort>, JsonRejection>,
) -> Result<Json<Value>, Refusal> {
    let Json(body) = body.map_err(|_| Refusal::BadRequest)?;
    if !valid_key(&state.mail.accounts, &key) {
        return Err(Refusal::BadKey);
    }
    let Some(category) = CATEGORIES.iter().find(|c| **c == body.category) else { return Err(Refusal::BadRequest) };
    if !reach::from_owners_hands(&state, peer_of(peer)).await {
        return Err(Refusal::NotFromHere);
    }
    state.mail.run(&["correct", &key, category]).await?;
    if *category != "needs_you" {
        state.mail.remember(&key);
    }
    Ok(Json(json!({ "ok": true })))
}

/// How many rows wait on the owner with no draft to answer them.
fn undrafted(listing: &Listing) -> usize {
    listing.rows.iter().filter(|r| r.draft.is_none()).count()
}

/// One "Mail needs you" when more mail waits on the owner than before, and at most one in half an hour. No names, no words: the
/// count going up is all it knows. What's there when the gateway starts isn't news.
pub async fn watcher(state: Arc<AppState>) {
    let mut last: Option<usize> = None;
    let mut buzzed: Option<Instant> = None;
    loop {
        let now = undrafted(&state.mail.listing());
        if worth_a_buzz(last, now, buzzed, Instant::now()) {
            buzzed = Some(Instant::now());
            crate::push::mail_needs_you(&state);
        }
        last = Some(now);
        tokio::time::sleep(WATCH_EVERY).await;
    }
}

fn worth_a_buzz(last: Option<usize>, now: usize, buzzed: Option<Instant>, at: Instant) -> bool {
    last.is_some_and(|last| now > last) && buzzed.is_none_or(|b| at.duration_since(b) >= PUSH_EVERY)
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/mail", get(list))
        .route("/api/mail/:key/dismiss", post(dismiss))
        .route("/api/mail/:key/sort", post(sort))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use axum::{body::Body, http::Request};
    use std::net::IpAddr;
    use tower::ServiceExt;

    /// A stand-in for the triage command that writes down each call, and fails when told to.
    const FAKE: &str = r#"#!/bin/sh
d="$(dirname "$0")"
echo "$*" >> "$d/calls"
printf '%s\n' "SECRET=${LUMBRIDGE_DATABASE_URL:-unset}" > "$d/env"
[ -e "$d/hang" ] && exec sleep 30
[ -e "$d/refuse" ] && { echo "SECRET TOOL OUTPUT" >&2; exit 1; }
echo ok
"#;
    const FAKE_TAILSCALE: &str = r#"#!/bin/sh
[ "$1 $2" = "whois --json" ] && exec cat "$(dirname "$0")/whois-$3"
exit 9
"#;

    const LUNCH: &str = "sam:18f2c0a1b2c3d4e5";
    const IRS: &str = "sam:18f2c0a1b2c3ffff";
    const INVITE: &str = "samwork:event:abc123";
    const FAVOR: &str = "sam:18f2c0a1b2c30000";

    fn accounts() -> Vec<String> {
        vec!["sam".into(), "samwork".into()]
    }

    fn mail_doc(updated_ms: u64) -> Value {
        json!({
            "updated_ms": now_ms(),
            "drafts": [],
            "mail": {
                "updated_ms": updated_ms, "spark": "ok", "unsorted": 0, "fyi_count": 23, "noise_count": 34, "extra": "dropped",
                "needs_you": [
                    {"key": LUNCH, "account": "sam@example.com", "kind": "mail", "from": "Dana Lee", "subject": "Lunch Thursday?",
                     "why": "Dana asks about lunch Thursday at noon.", "draft": "1793800000-ab12", "since_ms": 4, "body": "SECRET BODY"},
                    {"key": IRS, "kind": "mail", "from": "IRS", "subject": "Your notice", "sensitive": "government", "why": "Government mail from IRS.", "draft": null, "since_ms": 3},
                    {"key": INVITE, "kind": "invite", "from": "vendor@example.test", "subject": "Vendor pitch", "why": "Invite, not answered yet.", "draft": null, "since_ms": 2},
                    {"key": FAVOR, "kind": "mail", "from": "Helpful", "subject": "Quick favor", "suspicious": true, "why": "Looks like it's trying to instruct an assistant. Nothing was done.", "draft": null, "since_ms": 1},
                    {"key": "other:abcdef", "kind": "mail", "from": "x", "why": "bad key"},
                    {"key": "sam:abcdef1", "kind": "chat", "from": "x", "why": "unknown kind"},
                    {"key": "sam:abcdef2", "kind": "mail", "from": "x", "why": ""},
                    "not a row",
                ],
            },
        })
    }

    struct Rig {
        dir: tempfile::TempDir,
        app: Router,
        token: String,
        ip: IpAddr,
    }

    fn rig(timeout: Duration) -> Rig {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("triage");
        crate::test_exe::write_exe(&bin, FAKE);
        let file = dir.path().join("needs-you.json");
        std::fs::write(&file, mail_doc(now_ms()).to_string()).unwrap();
        let tailscale = dir.path().join("tailscale");
        crate::test_exe::write_exe(&tailscale, FAKE_TAILSCALE);
        let cfg = Config {
            login: "k@example.com".into(),
            allowed_nodes: vec![],
            tailnet: String::new(),
            tailscale: tailscale.to_string_lossy().into_owned(),
            machine: None,
            conn_idle: Duration::from_secs(180),
            ws_dead_after: Duration::from_secs(90),
            assistant_nodes: vec!["assistant-phone".into(), "desk".into(), "build-box".into()],
            pairs_anyway: vec!["assistant-phone".into()],
            origins: vec![],
            hc: "hc".into(),
            bind: String::new(),
            tls_bind: String::new(),
            tls: None,
            web: String::new(),
            state_dir: dir.path().to_string_lossy().into_owned(),
        };
        let mut state = AppState::new(cfg);
        state.mail = Mail::new(file, bin, accounts(), timeout);
        let code = state.auth.devices.begin_pair("phone").unwrap();
        let (_, token) = state.auth.devices.redeem(&code).unwrap();
        let ip: IpAddr = "100.64.0.1".parse().unwrap();
        state.auth.whois.put(ip, Ok(()));
        let r = Rig { dir, app: router().with_state(Arc::new(state)), token, ip };
        r.be("laptop");
        r
    }

    fn rig10() -> Rig {
        rig(Duration::from_secs(10))
    }

    impl Rig {
        fn be(&self, node: &str) {
            let who = json!({"Node": {"Name": format!("{node}.example-tailnet.ts.net.")}, "UserProfile": {"LoginName": "k@example.com"}});
            std::fs::write(self.dir.path().join(format!("whois-{}", self.ip)), who.to_string()).unwrap();
        }
        async fn call(&self, method: &str, path: &str, body: Option<Value>, auth: bool) -> (StatusCode, Value) {
            let mut req = Request::builder().method(method).uri(path).header("content-type", "application/json");
            if auth {
                req = req.header("authorization", format!("Bearer {}", self.token));
            }
            let mut req = req.body(body.map_or_else(Body::empty, |b| Body::from(b.to_string()))).unwrap();
            req.extensions_mut().insert(ConnectInfo(SocketAddr::new(self.ip, 1)));
            let res = self.app.clone().oneshot(req).await.unwrap();
            let status = res.status();
            let bytes = axum::body::to_bytes(res.into_body(), 1 << 22).await.unwrap();
            (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
        }
        async fn list(&self) -> Value {
            self.call("GET", "/api/mail", None, true).await.1
        }
        async fn dismiss(&self, key: &str) -> (StatusCode, Value) {
            self.call("POST", &format!("/api/mail/{}/dismiss", enc(key)), None, true).await
        }
        async fn sort(&self, key: &str, category: &str) -> (StatusCode, Value) {
            self.call("POST", &format!("/api/mail/{}/sort", enc(key)), Some(json!({"category": category})), true).await
        }
        fn calls(&self) -> Vec<String> {
            std::fs::read_to_string(self.dir.path().join("calls")).unwrap_or_default().lines().map(String::from).collect()
        }
        fn write(&self, doc: Value) {
            std::fs::write(self.dir.path().join("needs-you.json"), doc.to_string()).unwrap();
        }
    }

    /// As the page's encodeURIComponent would.
    fn enc(s: &str) -> String {
        s.bytes()
            .map(|b| if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
            .collect()
    }

    fn keys(list: &Value) -> Vec<String> {
        list["rows"].as_array().unwrap().iter().map(|r| r["key"].as_str().unwrap().to_string()).collect()
    }

    #[tokio::test]
    async fn every_route_wants_a_token_and_runs_nothing_without_one() {
        let r = rig10();
        for (method, path, body) in [
            ("GET", "/api/mail".to_string(), None),
            ("POST", format!("/api/mail/{}/dismiss", enc(LUNCH)), None),
            ("POST", format!("/api/mail/{}/sort", enc(LUNCH)), Some(json!({"category": "fyi"}))),
        ] {
            assert_eq!(r.call(method, &path, body, false).await.0, StatusCode::UNAUTHORIZED, "{method} {path}");
        }
        assert!(r.calls().is_empty());
    }

    #[tokio::test]
    async fn the_rows_are_typed_newest_first_and_only_what_can_be_shown() {
        let r = rig10();
        let list = r.list().await;
        assert_eq!(keys(&list), [LUNCH, IRS, INVITE, FAVOR]);
        assert_eq!(list["stale"], false);
        assert_eq!((list["spark"].as_str(), list["unsorted"].as_u64()), (Some("ok"), Some(0)));
        assert_eq!((list["fyi_count"].as_u64(), list["noise_count"].as_u64()), (Some(23), Some(34)));
        let rows = list["rows"].as_array().unwrap();
        assert_eq!(
            rows[0],
            json!({"key": LUNCH, "account": "sam@example.com", "kind": "mail", "from": "Dana Lee", "subject": "Lunch Thursday?",
                   "sensitive": null, "suspicious": false, "why": "Dana asks about lunch Thursday at noon.", "draft": "1793800000-ab12", "since_ms": 4})
        );
        assert_eq!((rows[1]["sensitive"].as_str(), &rows[1]["subject"]), (Some("government"), &Value::Null), "a sensitive row never has a subject");
        assert_eq!(rows[2]["kind"], "invite");
        assert_eq!(rows[3]["suspicious"], true);
        let text = list.to_string();
        for gone in ["extra", "SECRET BODY", "Your notice", "body"] {
            assert!(!text.contains(gone), "{gone}");
        }
        assert!(r.calls().is_empty(), "listing runs nothing");
    }

    #[test]
    fn strings_are_capped_and_a_bad_draft_id_is_dropped() {
        let long = "é".repeat(500);
        let row = RawRow {
            key: LUNCH.into(),
            kind: "mail".into(),
            from: long.clone(),
            subject: Some(long.clone()),
            why: long.clone(),
            account: long.clone(),
            draft: Some("../../etc".into()),
            ..Default::default()
        }
        .shown(&accounts())
        .unwrap();
        assert_eq!(
            (row.from.chars().count(), row.subject.unwrap().chars().count(), row.why.chars().count(), row.account.chars().count()),
            (MAX_FROM, MAX_SUBJECT, MAX_WHY, MAX_ACCOUNT)
        );
        assert_eq!(row.draft, None);
        let sensitive = |v: Value| RawRow { key: LUNCH.into(), kind: "mail".into(), why: "w".into(), subject: Some("s".into()), sensitive: Some(v), ..Default::default() }.shown(&accounts()).unwrap();
        assert_eq!(sensitive(json!(true)).sensitive.as_deref(), Some("sensitive"));
        assert_eq!(sensitive(json!(1)).subject, None, "anything that isn't plainly no is sensitive");
        assert_eq!(sensitive(json!(false)).subject.as_deref(), Some("s"));
    }

    #[tokio::test]
    async fn stale_after_45_minutes_and_a_missing_mail_is_empty() {
        let r = rig10();
        r.write(mail_doc(now_ms() - STALE_MS + 60_000));
        assert_eq!(r.list().await["stale"], false);
        r.write(mail_doc(now_ms() - STALE_MS - 1000));
        let list = r.list().await;
        assert_eq!(list["stale"], true);
        assert_eq!(keys(&list).len(), 4, "still shown");
        r.write(json!({"updated_ms": now_ms(), "drafts": []}));
        assert_eq!(r.list().await, json!({"rows": [], "stale": false}));
        std::fs::remove_file(r.dir.path().join("needs-you.json")).unwrap();
        assert_eq!(r.list().await, json!({"rows": [], "stale": false}));
        std::fs::write(r.dir.path().join("needs-you.json"), "{ not json").unwrap();
        assert_eq!(r.list().await, json!({"rows": [], "stale": true}));
    }

    #[test]
    fn keys_are_a_listed_account_and_a_plain_id() {
        for good in [LUNCH, INVITE, "samwork:abc_-9", &format!("sam:{}", "a".repeat(200))] {
            assert!(valid_key(&accounts(), good), "{good}");
        }
        for bad in [
            "sam:../x", "other:abc", "noise; rm", "other:abcdef", "sam:abcd", "sam:event:",
            "sam:abc def", "sam:abcdef;rm", "sam:event:event:abcdef", "sam:abcdef\n",
            "Sam:abcdef", "sam", "", &format!("sam:{}", "a".repeat(201)),
        ] {
            assert!(!valid_key(&accounts(), bad), "{bad:?}");
        }
        assert!(!valid_key(&[], LUNCH), "no accounts, no keys");
    }

    #[tokio::test]
    async fn bad_keys_and_categories_are_refused_without_running_anything() {
        let r = rig10();
        for bad in ["sam:../x", "other:abc", "noise; rm", "sam:abc def"] {
            let (status, body) = r.dismiss(bad).await;
            assert_eq!((status, body["error"].as_str()), (StatusCode::BAD_REQUEST, Some("bad_key")), "{bad}");
            let (status, body) = r.sort(bad, "fyi").await;
            assert_eq!((status, body["error"].as_str()), (StatusCode::BAD_REQUEST, Some("bad_key")), "{bad}");
        }
        for bad in ["noise; rm", "FYI", "spam", "", "fyi "] {
            let (status, body) = r.sort(LUNCH, bad).await;
            assert_eq!((status, body["error"].as_str()), (StatusCode::BAD_REQUEST, Some("bad_request")), "{bad:?}");
        }
        let (status, _) = r.call("POST", &format!("/api/mail/{}/sort", enc(LUNCH)), Some(json!({})), true).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(r.calls().is_empty());
    }

    #[cfg(not(feature = "dev-identity"))]
    #[tokio::test]
    async fn done_and_wrong_sort_are_refused_from_a_device_the_assistant_operates() {
        for node in ["assistant-phone", "desk", "build-box"] {
            let r = rig10();
            r.be(node);
            let (status, body) = r.dismiss(LUNCH).await;
            assert_eq!((status, body["error"].as_str()), (StatusCode::FORBIDDEN, Some("not_from_here")), "{node}");
            let (status, body) = r.sort(LUNCH, "fyi").await;
            assert_eq!((status, body["error"].as_str()), (StatusCode::FORBIDDEN, Some("not_from_here")), "{node}");
            assert_eq!(keys(&r.list().await).len(), 4, "{node}: still listed");
            assert!(r.calls().is_empty(), "{node}: the tool never ran");
        }
    }

    #[tokio::test]
    async fn done_runs_dismiss_and_hides_the_row() {
        let r = rig10();
        let (status, body) = r.dismiss(INVITE).await;
        assert_eq!((status, body), (StatusCode::OK, json!({"ok": true})));
        assert_eq!(r.calls(), [format!("dismiss {INVITE}")]);
        assert_eq!(keys(&r.list().await), [LUNCH, IRS, FAVOR], "gone before the file catches up");
    }

    #[tokio::test]
    async fn wrong_sort_runs_correct_with_the_category() {
        let r = rig10();
        assert_eq!(r.sort(LUNCH, "fyi").await.0, StatusCode::OK);
        assert_eq!(r.sort(IRS, "noise").await.0, StatusCode::OK);
        assert_eq!(r.sort(FAVOR, "needs_you").await.0, StatusCode::OK);
        assert_eq!(r.calls(), [format!("correct {LUNCH} fyi"), format!("correct {IRS} noise"), format!("correct {FAVOR} needs_you")]);
        assert_eq!(keys(&r.list().await), [INVITE, FAVOR], "needs you stays where it is");
    }

    #[tokio::test]
    async fn a_failing_or_hung_tool_is_failed_and_its_words_stay_here() {
        let r = rig(Duration::from_millis(800));
        std::fs::write(r.dir.path().join("refuse"), "").unwrap();
        let (status, body) = r.dismiss(LUNCH).await;
        assert_eq!((status, body), (StatusCode::BAD_GATEWAY, json!({"error": "failed"})));
        assert_eq!(keys(&r.list().await).len(), 4, "a failure hides nothing");
        std::fs::remove_file(r.dir.path().join("refuse")).unwrap();
        std::fs::write(r.dir.path().join("hang"), "").unwrap();
        let started = Instant::now();
        let (status, body) = r.sort(LUNCH, "noise").await;
        assert_eq!((status, body), (StatusCode::BAD_GATEWAY, json!({"error": "failed"})));
        assert!(started.elapsed() < Duration::from_secs(5), "the timeout holds");
        std::fs::remove_file(r.dir.path().join("hang")).unwrap();
        std::fs::remove_file(r.dir.path().join("triage")).unwrap();
        assert_eq!(r.dismiss(LUNCH).await.0, StatusCode::BAD_GATEWAY, "no tool: failed");
    }

    #[tokio::test]
    async fn the_tool_gets_a_minimal_environment() {
        std::env::set_var("LUMBRIDGE_DATABASE_URL", "postgres://secret");
        let r = rig10();
        r.dismiss(LUNCH).await;
        let seen = std::fs::read_to_string(r.dir.path().join("env")).unwrap();
        std::env::remove_var("LUMBRIDGE_DATABASE_URL");
        assert!(seen.contains("SECRET=unset"), "{seen}");
    }

    #[test]
    fn a_buzz_only_when_more_waits_and_not_twice_in_half_an_hour() {
        let t = Instant::now();
        assert!(!worth_a_buzz(None, 3, None, t), "what's there at start isn't news");
        assert!(!worth_a_buzz(Some(3), 3, None, t));
        assert!(!worth_a_buzz(Some(3), 2, None, t));
        assert!(worth_a_buzz(Some(2), 3, None, t));
        assert!(!worth_a_buzz(Some(2), 3, Some(t), t + Duration::from_secs(29 * 60)));
        assert!(worth_a_buzz(Some(2), 3, Some(t), t + PUSH_EVERY));
    }

    #[test]
    fn a_row_with_a_draft_isnt_counted_for_the_buzz() {
        let doc = mail_doc(now_ms());
        let raw: RawMail = serde_json::from_value(doc["mail"].clone()).unwrap();
        let rows: Vec<Row> = raw.needs_you.into_iter().filter_map(|r| serde_json::from_value::<RawRow>(r).ok()?.shown(&accounts())).collect();
        assert_eq!(undrafted(&Listing { rows, ..Default::default() }), 3);
    }
}
