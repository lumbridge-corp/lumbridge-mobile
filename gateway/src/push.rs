//! Web Push: tells the owner's phone when an agent needs them or finishes. Nothing here can affect anything
//! else: sends run on their own tasks, and the watcher only reads events.
//!
//! `rules` decides (pure), `watch` reads core (read-only by construction), `send` delivers, `store` remembers.

mod focus;
mod rules;
mod send;
mod store;
mod watch;

use crate::{auth::Device, AppState};
use axum::{
    extract::State,
    http::{header::USER_AGENT, HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use chrono::Timelike;
use rules::{Engine, Kind, Notice, Prefs};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use store::{Store, Sub};
use tokio::sync::Semaphore;
use web_push_native::jwt_simple::algorithms::ES256KeyPair;

/// No sign of life from core for this long means the pipe is stuck: core sends a heartbeat every 15 s.
const SILENCE: Duration = Duration::from_secs(45);
const MAX_BACKOFF: u64 = 30;
/// Sends at once; a burst waits its turn rather than opening a socket per notification.
const MAX_SENDING: usize = 8;

pub struct Push {
    store: Store,
    vapid: Option<ES256KeyPair>,
    http: reqwest::Client,
    sending: Semaphore,
    /// Who is looking at which terminal right now, on the clients' word.
    focus: focus::Focus,
    /// Terminals waiting on the owner, as the watcher last knew.
    stuck: AtomicUsize,
}

impl Push {
    pub fn open(state_dir: &str) -> Self {
        let dir = Path::new(state_dir);
        if let Err(e) = std::fs::create_dir_all(dir) {
            eprintln!("push: can't create the state directory: {e}");
        }
        let vapid = store::load_or_create_vapid(dir).map_err(|e| eprintln!("push: off: {e}")).ok();
        Self { store: Store::open(dir), vapid, http: send::client(), sending: Semaphore::new(MAX_SENDING), focus: focus::Focus::default(), stuck: AtomicUsize::new(0) }
    }
}

/// The web's `encodeURIComponent`, for `#/t/<address>`.
fn encode_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn payload(n: &Notice, badge: usize) -> String {
    let (title, body) = rules::words(n);
    let address = encode_component(&n.address);
    json!({
        "title": title,
        "body": body,
        "url": format!("/#/t/{address}"),
        // One agent shows one notification: "finished" replaces its "needs you".
        "tag": format!("t-{address}"),
        // The page closes a "needs" one when the agent stops waiting, and leaves "finished" for the owner to see.
        "kind": if n.kind == Kind::NeedsYou { "needs" } else { "finished" },
        // For the app icon, while the app is closed.
        "badge": badge,
    })
    .to_string()
}

/// What notifications call the assistant: LUMBRIDGE_ASSISTANT_NAME, else "Your assistant".
fn assistant_name() -> &'static str {
    static NAME: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    NAME.get_or_init(|| {
        std::env::var("LUMBRIDGE_ASSISTANT_NAME").ok().map(|n| n.trim().chars().take(40).collect::<String>()).filter(|n| !n.is_empty())
            .unwrap_or_else(|| "Your assistant".into())
    })
}

fn draft_payload(id: &str, badge: usize) -> String {
    json!({
        "title": format!("{} has a draft for you", assistant_name()),
        "body": "Read it, then approve it or don't.",
        "url": "/#/assistant",
        "tag": format!("draft-{id}"),
        "kind": "draft",
        "badge": badge,
    })
    .to_string()
}

/// As with drafts, none of the ask's words: its title is the assistant's, and could be a stranger's text it passed on.
fn ask_payload(id: &str, badge: usize) -> String {
    json!({
        "title": format!("{} has a question for you", assistant_name()),
        "body": "It's in Tasks, under For you.",
        "url": "/#/tasks",
        "tag": format!("ask-{id}"),
        "kind": "ask",
        "badge": badge,
    })
    .to_string()
}

/// Agents proposed notes (data/proposals.rs). How many are waiting, and not a word of any: an agent wrote them, and could be
/// passing on a stranger's text. One notification for all of them, replaced as the number changes.
fn note_ideas_payload(waiting: usize, badge: usize) -> String {
    json!({
        "title": if waiting == 1 { "1 note idea".to_string() } else { format!("{waiting} note ideas") },
        "body": "",
        "url": "/#/tasks",
        "tag": "note-ideas",
        "kind": "note-ideas",
        "badge": badge,
    })
    .to_string()
}

/// Mail waiting on the owner went up (mail.rs). Not a word of it: no sender, no subject, not even how many.
fn mail_payload(badge: usize) -> String {
    json!({
        "title": "Mail needs you",
        "body": "It's in Tasks, under For you.",
        "url": "/#/tasks",
        "tag": "mail",
        "kind": "mail",
        "badge": badge,
    })
    .to_string()
}

/// What the number on the app icon should say: agents waiting plus drafts waiting.
fn waiting(state: &AppState) -> usize {
    state.push.stuck.load(Ordering::Relaxed) + state.needs.count()
}

#[derive(Default, Debug, PartialEq)]
struct Tally {
    sent: u32,
    removed: u32,
    failed: u32,
    reason: Option<String>,
}

/// Subscriptions whose device is still paired, so revoking a phone also stops its notifications.
/// `revoke` runs in another process, so this reads the device list each time. If it can't, nothing is sent.
fn live_subs(state: &AppState) -> Vec<Sub> {
    let Ok(devices) = state.auth.devices.list() else { return vec![] };
    keep_paired(state.push.store.list(), &devices)
}

fn keep_paired(subs: Vec<Sub>, devices: &[crate::devices::DeviceRecord]) -> Vec<Sub> {
    subs.into_iter()
        // An agent device never gets one, even through a subscription left from when that name was one of the owner's.
        .filter(|s| devices.iter().any(|d| !d.revoked && d.role == crate::devices::Role::Owner && s.device.as_deref() == Some(d.name.as_str())))
        .collect()
}

async fn deliver(push: &Push, subs: Vec<Sub>, body: &str, high: bool) -> Tally {
    let mut tally = Tally::default();
    let Some(vapid) = &push.vapid else { return tally };
    let sends = subs.into_iter().map(|sub| async move {
        let Ok(_permit) = push.sending.acquire().await else { return (sub, send::Outcome::Failed("closed".into())) };
        let outcome = send::send(&push.http, &sub, vapid, body, high).await;
        (sub, outcome)
    });
    for (sub, outcome) in futures_util::future::join_all(sends).await {
        let service = send::service(&sub.endpoint);
        match outcome {
            send::Outcome::Sent => {
                push.store.delivered(&sub.endpoint);
                tally.sent += 1;
            }
            send::Outcome::Gone => {
                eprintln!("push: {service} says a subscription is gone; dropped it");
                push.store.bury(&sub.endpoint);
                tally.removed += 1;
            }
            send::Outcome::Failed(why) => {
                eprintln!("push: {service}: {why}");
                if push.store.failed(&sub.endpoint) {
                    tally.removed += 1;
                }
                tally.failed += 1;
                tally.reason = Some(why);
            }
        }
    }
    tally
}

fn minute_now() -> u32 {
    let now = chrono::Local::now();
    now.hour() * 60 + now.minute()
}

/// Hands a due notification off to its own task, if the prefs want it.
fn dispatch(state: &Arc<AppState>, n: Notice) {
    if !state.push.store.prefs().allows(n.kind, minute_now()) {
        return;
    }
    // The owner is looking at it, on some device, and said so in the last few seconds. Anything less sure than that buzzes.
    if state.push.focus.watching(&n.address, Instant::now()) {
        return;
    }
    let subs = live_subs(state);
    if subs.is_empty() {
        return;
    }
    let body = payload(&n, waiting(state));
    let state = state.clone();
    tokio::spawn(async move {
        deliver(&state.push, subs, &body, n.kind == Kind::NeedsYou).await;
    });
}

/// The assistant wrote a draft. It counts as "needs you", so the same switch and quiet hours apply.
pub fn draft_arrived(state: &Arc<AppState>, id: &str) {
    assistant_needs_you(state, draft_payload(id, waiting(state)));
}

/// The assistant asked the owner something (data/asks.rs), under the same rules as a draft.
pub fn ask_arrived(state: &Arc<AppState>, id: &str) {
    assistant_needs_you(state, ask_payload(id, waiting(state)));
}

/// New note proposals, under the same rules as a draft.
pub fn note_ideas(state: &Arc<AppState>, waiting: usize) {
    assistant_needs_you(state, note_ideas_payload(waiting, self::waiting(state)));
}

/// More of the owner's mail needs them than a minute ago (mail.rs rate-limits it), under the same rules as a draft.
pub fn mail_needs_you(state: &Arc<AppState>) {
    assistant_needs_you(state, mail_payload(waiting(state)));
}

fn assistant_needs_you(state: &Arc<AppState>, body: String) {
    if !state.push.store.prefs().allows(Kind::NeedsYou, minute_now()) {
        return;
    }
    let subs = live_subs(state);
    if subs.is_empty() {
        return;
    }
    let state = state.clone();
    tokio::spawn(async move {
        deliver(&state.push, subs, &body, true).await;
    });
}

/// The background watcher: one read-only `hc connect`, for as long as the gateway runs.
pub async fn watcher(state: Arc<AppState>) {
    let started = Instant::now();
    let now = || started.elapsed().as_millis() as u64;
    let mut engine = Engine::default();
    let mut backoff = 1;
    let mut core_down = false;
    loop {
        let began = Instant::now();
        match watch::Events::open(&state.cfg.hc).await {
            // Once, not every retry: core being down for hours isn't news each time.
            Err(e) if e == watch::CORE_DOWN => {
                if !core_down {
                    eprintln!("push: waiting for core to start");
                }
                core_down = true;
            }
            Err(e) => eprintln!("push: watcher can't connect: {e}"),
            Ok(mut events) => {
                core_down = false;
                let local = state.cfg.machine.clone().unwrap_or_else(|| events.core_name.clone());
                engine.set_local(&local);
                engine.resync(events.seq, &events.terminals);
                state.push.stuck.store(engine.stuck(), Ordering::Relaxed);
                let why = loop {
                    let wait = engine.next_due().map(|at| Duration::from_millis(at.saturating_sub(now())));
                    tokio::select! {
                        line = tokio::time::timeout(SILENCE, events.next()) => match line {
                            Ok(Ok(line)) => engine.line(now(), &line),
                            Ok(Err(e)) => break e,
                            Err(_) => break "core went silent".to_string(),
                        },
                        _ = tokio::time::sleep(wait.unwrap_or(SILENCE)), if wait.is_some() => {}
                    }
                    state.push.stuck.store(engine.stuck(), Ordering::Relaxed);
                    for n in engine.due(now()) {
                        dispatch(&state, n);
                    }
                };
                eprintln!("push: watcher reconnecting: {why}");
            }
        }
        if began.elapsed() > Duration::from_secs(60) {
            backoff = 1;
        }
        tokio::time::sleep(Duration::from_secs(backoff)).await;
        backoff = (backoff * 2).min(MAX_BACKOFF);
    }
}

/// "iPhone · Safari": which device, for a person. Nothing identifying beyond that.
fn device_label(headers: &HeaderMap) -> String {
    let ua = headers.get(USER_AGENT).and_then(|v| v.to_str().ok()).unwrap_or("");
    let os = [("iPhone", "iPhone"), ("iPad", "iPad"), ("Android", "Android"), ("Mac OS X", "Mac"), ("Windows", "Windows"), ("Linux", "Linux")]
        .iter()
        .find(|(needle, _)| ua.contains(needle))
        .map_or("Device", |(_, name)| name);
    let browser = [("Edg/", "Edge"), ("Firefox/", "Firefox"), ("Chrome/", "Chrome"), ("CriOS/", "Chrome"), ("Safari/", "Safari")]
        .iter()
        .find(|(needle, _)| ua.contains(needle))
        .map_or("Browser", |(_, name)| name);
    format!("{os} · {browser}")
}

async fn config(_: Device, State(state): State<Arc<AppState>>) -> Json<Value> {
    let key = state.push.vapid.as_ref().map(store::public_key);
    let clock = chrono::Local::now().format("%H:%M").to_string();
    Json(json!({"publicKey": key, "version": env!("CARGO_PKG_VERSION"), "clock": clock}))
}

#[derive(Deserialize)]
struct Keys {
    p256dh: String,
    auth: String,
}

#[derive(Deserialize)]
struct Subscribe {
    endpoint: String,
    keys: Keys,
}

async fn subscribe(
    Device(device): Device,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(b): Json<Subscribe>,
) -> Result<Json<Value>, StatusCode> {
    if !send::valid_endpoint(&b.endpoint) || !send::valid_keys(&b.keys.p256dh, &b.keys.auth) {
        return Err(StatusCode::BAD_REQUEST);
    }
    // 410 tells the browser to drop this subscription and make a new one.
    if state.push.store.is_dead(&b.endpoint) {
        return Err(StatusCode::GONE);
    }
    let created_ms = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
    let sub = Sub {
        endpoint: b.endpoint,
        p256dh: b.keys.p256dh,
        auth: b.keys.auth,
        label: device_label(&headers),
        device: Some(device),
        created_ms,
        failures: 0,
    };
    state.push.store.add(sub).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(json!({"ok": true})))
}

#[derive(Deserialize)]
struct Endpoint {
    endpoint: String,
}

async fn unsubscribe(_: Device, State(state): State<Arc<AppState>>, Json(b): Json<Endpoint>) -> Result<Json<Value>, StatusCode> {
    state.push.store.remove(&b.endpoint).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(json!({"ok": true})))
}

/// Sends to the asking device when it says which, otherwise to all of them. Ignores prefs: it's a test.
#[derive(Deserialize, Default)]
struct TestFor {
    endpoint: Option<String>,
}

async fn test(_: Device, State(state): State<Arc<AppState>>, Json(b): Json<TestFor>) -> Json<Value> {
    let subs: Vec<Sub> =
        live_subs(&state).into_iter().filter(|s| b.endpoint.as_ref().is_none_or(|e| *e == s.endpoint)).collect();
    let body = json!({
        "title": "Lumbridge notifications work",
        "body": "This is how an agent will reach you.",
        "url": "/#/settings",
        "tag": "test",
    })
    .to_string();
    let t = deliver(&state.push, subs, &body, true).await;
    Json(json!({"sent": t.sent, "removed": t.removed, "failed": t.failed, "reason": t.reason}))
}

async fn get_prefs(_: Device, State(state): State<Arc<AppState>>) -> Json<Prefs> {
    Json(state.push.store.prefs())
}

async fn put_prefs(_: Device, State(state): State<Arc<AppState>>, Json(prefs): Json<Prefs>) -> Result<Json<Prefs>, StatusCode> {
    if !prefs.valid() {
        return Err(StatusCode::BAD_REQUEST);
    }
    state.push.store.set_prefs(prefs.clone()).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(prefs))
}

#[derive(Deserialize)]
struct FocusReport {
    /// The terminal this device is showing to the owner right now, or null for none.
    terminal: Option<String>,
}

/// A client saying what's in front of the owner. It expires by itself: silence means nobody is looking.
async fn report_focus(Device(device): Device, State(state): State<Arc<AppState>>, Json(b): Json<FocusReport>) -> StatusCode {
    match b.terminal {
        Some(address) if !focus::valid_address(&address) => return StatusCode::BAD_REQUEST,
        Some(address) => state.push.focus.set(&device, address, Instant::now()),
        None => state.push.focus.clear(&device),
    }
    StatusCode::NO_CONTENT
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/push/config", get(config))
        .route("/api/push/focus", post(report_focus))
        .route("/api/push/subscribe", post(subscribe))
        .route("/api/push/unsubscribe", post(unsubscribe))
        .route("/api/push/test", post(test))
        .route("/api/push/prefs", get(get_prefs).put(put_prefs))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_encode_like_the_web() {
        assert_eq!(encode_component("gpu/t7"), "gpu%2Ft7");
        assert_eq!(encode_component("t7"), "t7");
    }

    #[test]
    fn the_payload_goes_to_the_agent_and_carries_no_contents() {
        let n = Notice {
            kind: Kind::NeedsYou,
            address: "runner/t7".into(),
            label: "Acme deploy".into(),
            machine: "runner".into(),
            state: "blocked".into(),
            turn: 3,
        };
        let p: Value = serde_json::from_str(&payload(&n, 3)).unwrap();
        assert_eq!(p, json!({"title": "Acme deploy needs you", "body": "runner · waiting for you",
                             "url": "/#/t/runner%2Ft7", "tag": "t-runner%2Ft7", "kind": "needs", "badge": 3}));
    }

    #[test]
    fn a_drafts_notification_carries_none_of_the_draft() {
        let p: Value = serde_json::from_str(&draft_payload("1793758374-ec32", 2)).unwrap();
        assert_eq!(p, json!({"title": "Your assistant has a draft for you", "body": "Read it, then approve it or don't.",
                             "url": "/#/assistant", "tag": "draft-1793758374-ec32", "kind": "draft", "badge": 2}));
    }

    #[test]
    fn a_note_ideas_notification_says_only_how_many() {
        let p: Value = serde_json::from_str(&note_ideas_payload(3, 1)).unwrap();
        assert_eq!(p, json!({"title": "3 note ideas", "body": "", "url": "/#/tasks", "tag": "note-ideas", "kind": "note-ideas", "badge": 1}));
        let one: Value = serde_json::from_str(&note_ideas_payload(1, 0)).unwrap();
        assert_eq!(one["title"], "1 note idea");
    }

    #[test]
    fn an_asks_notification_carries_none_of_the_ask() {
        let id = "3f1c1a2e-0000-4000-8000-000000000001";
        let p: Value = serde_json::from_str(&ask_payload(id, 1)).unwrap();
        assert_eq!(p, json!({"title": "Your assistant has a question for you", "body": "It's in Tasks, under For you.",
                             "url": "/#/tasks", "tag": format!("ask-{id}"), "kind": "ask", "badge": 1}));
    }

    #[test]
    fn a_mail_notification_carries_none_of_the_mail() {
        let p: Value = serde_json::from_str(&mail_payload(1)).unwrap();
        assert_eq!(p, json!({"title": "Mail needs you", "body": "It's in Tasks, under For you.",
                             "url": "/#/tasks", "tag": "mail", "kind": "mail", "badge": 1}));
    }

    #[test]
    fn a_revoked_devices_subscription_stops() {
        let sub = |device: Option<&str>| Sub {
            endpoint: "https://push.example/1".into(),
            p256dh: String::new(),
            auth: String::new(),
            label: String::new(),
            device: device.map(Into::into),
            created_ms: 0,
            failures: 0,
        };
        let record = |name: &str, revoked| crate::devices::DeviceRecord {
            name: name.into(),
            token_sha256: String::new(),
            created: 0,
            last_seen: None,
            revoked,
            role: crate::devices::Role::Owner,
        };
        let agent = crate::devices::DeviceRecord { role: crate::devices::Role::Agent, ..record("claude", false) };
        let devices = [record("phone", false), record("old", true), agent];
        let kept = keep_paired(vec![sub(Some("phone")), sub(Some("old")), sub(Some("gone")), sub(None), sub(Some("claude"))], &devices);
        assert_eq!(kept.iter().map(|s| s.device.as_deref()).collect::<Vec<_>>(), [Some("phone")]);
    }

    #[test]
    fn device_labels() {
        let label = |ua: &str| {
            let mut h = HeaderMap::new();
            h.insert(USER_AGENT, ua.parse().unwrap());
            device_label(&h)
        };
        assert_eq!(label("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605 Version/18.0 Mobile/15E148 Safari/604.1"), "iPhone · Safari");
        assert_eq!(label("Mozilla/5.0 (Linux; Android 15; Pixel 6) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36"), "Android · Chrome");
    }
}
