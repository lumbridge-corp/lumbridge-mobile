//! Who may connect. `Device` is the extractor every /api handler takes.
//!
//! Two independent checks: the tailnet says which node this is (`whois`), and the device proves itself with its own
//! token (`devices`). The source IP comes from a PROXY header any local process could forge, so the token is
//! mandatory everywhere and is the only thing that opens /ws or /api.

use crate::{
    devices::{Role, Store},
    whois, AppState,
};
use axum::{
    async_trait,
    extract::{ConnectInfo, FromRef, FromRequestParts, State},
    http::{request::Parts, HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

const MAX_FAILURES: u32 = 10;
const FAILURE_WINDOW: Duration = Duration::from_secs(5 * 60);
const LIMITER_MAX: usize = 1024;

/// Bad tokens and pairing codes per source. Both are 256 bits so guessing is hopeless anyway; this keeps a broken or
/// hostile client from hammering, and a tripped source is refused even with a good token until the window ends.
#[derive(Default)]
pub struct Limiter(Mutex<HashMap<IpAddr, (u32, Instant)>>);

impl Limiter {
    fn blocked_at(&self, ip: IpAddr, now: Instant) -> bool {
        // Every dev client is 127.0.0.1, and test suites try bad tokens on purpose.
        if cfg!(feature = "dev-identity") {
            return false;
        }
        let map = self.0.lock().unwrap();
        map.get(&ip).is_some_and(|(n, since)| *n >= MAX_FAILURES && now.duration_since(*since) < FAILURE_WINDOW)
    }

    fn failed_at(&self, ip: IpAddr, now: Instant) {
        let mut map = self.0.lock().unwrap();
        if map.len() >= LIMITER_MAX {
            map.retain(|_, (_, since)| now.duration_since(*since) < FAILURE_WINDOW);
        }
        let entry = map.entry(ip).or_insert((0, now));
        if now.duration_since(entry.1) >= FAILURE_WINDOW {
            *entry = (0, now);
        }
        entry.0 += 1;
        if entry.0 == MAX_FAILURES {
            eprintln!("too many failed attempts from {ip}");
        }
    }

    fn succeeded(&self, ip: IpAddr) {
        self.0.lock().unwrap().remove(&ip);
    }
}

pub struct Auth {
    pub devices: Store,
    pub whois: whois::Cache,
    pub limiter: Limiter,
}

impl Auth {
    pub fn new(state_dir: &str) -> Self {
        Self { devices: Store::new(state_dir), whois: whois::Cache::default(), limiter: Limiter::default() }
    }
}

/// A request that passed every check, and the paired device it came from.
pub struct Device(pub String);

/// `Device`, with the device's role, for the handlers that answer agents and the owner differently.
pub struct Caller {
    pub name: String,
    pub role: Role,
}

/// Everything an agent device may call, and nothing else: read the owner's notes, propose new ones and see its own proposals, and
/// MCP, which does those same things as tools. Anything not named here is refused to an agent (`gate::gate`, and the token
/// that opens `/ws`), so a route added tomorrow is closed to agents until it's added here on purpose.
pub fn agent_may(method: &Method, path: &str, query: Option<&str>) -> bool {
    // Decoded as the handler's `Query` will decode it, so `delet%65d=true` is `deleted=true` here too.
    let param = |name: &str| {
        query
            .unwrap_or("")
            .split('&')
            .filter(|kv| !kv.is_empty())
            .map(|kv| kv.split_once('=').unwrap_or((kv, "")))
            .map(|(k, v)| (form_decode(k), form_decode(v)))
            .find(|(k, _)| k == name)
            .map(|(_, v)| v)
    };
    let one_segment = |rest: &str| !rest.is_empty() && !rest.contains('/');
    match (method.as_str(), path) {
        // The list and search. Not the deleted ones: what the owner threw away isn't theirs to read.
        ("GET", "/api/notes") => param("deleted").is_none_or(|v| v == "false"),
        ("GET", p) if p.strip_prefix("/api/notes/").is_some_and(one_segment) => true,
        ("POST", "/api/note-proposals") => true,
        // Only its own: `mine=true`, which the handler holds it to as well.
        ("GET", "/api/note-proposals") => param("mine").as_deref() == Some("true"),
        // POST is the transport. Any other method there is answered 405 by the router, which an MCP client expects of a
        // server with no event stream.
        (_, "/mcp") => true,
        _ => false,
    }
}

/// `application/x-www-form-urlencoded` decoding: `+` is a space and `%XX` a byte. A bad escape stays as it is.
fn form_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = |c: u8| (c as char).to_digit(16);
        match b[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < b.len() => {
                match (hex(b[i + 1]), hex(b[i + 2])) {
                    (Some(h), Some(l)) => {
                        out.push((h * 16 + l) as u8);
                        i += 2;
                    }
                    _ => out.push(b'%'),
                }
            }
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// What an agent device hears from anything outside `agent_may`.
pub fn agent_refused() -> Response {
    (StatusCode::FORBIDDEN, Json(json!({"error": "agent_not_allowed"}))).into_response()
}

/// Tailnet identity and Origin; runs before any WebSocket upgrade or API handler.
pub async fn admit(state: &AppState, headers: &HeaderMap, peer: SocketAddr) -> Result<(), &'static str> {
    // Dev builds only (scripts/dev.sh). This feature must never be enabled in a deployed binary.
    #[cfg(feature = "dev-identity")]
    {
        let _ = (state, headers, peer);
        return Ok(());
    }
    #[allow(unreachable_code)]
    {
        whois::check(&state.cfg, &state.auth.whois, peer.ip()).await?;
        if let Some(origin) = headers.get("origin") {
            if !state.cfg.origins.iter().any(|o| o.as_bytes() == origin.as_bytes()) {
                return Err("origin");
            }
        }
        Ok(())
    }
}

#[derive(PartialEq, Debug)]
pub enum TokenCheck {
    Good,
    Bad,
    TooManyFailures,
}

/// The token check with its source, so one misbehaving client doesn't lock out the others.
pub fn check_token(state: &AppState, ip: IpAddr, presented: &str) -> TokenCheck {
    let limiter = &state.auth.limiter;
    let now = Instant::now();
    if limiter.blocked_at(ip, now) {
        return TokenCheck::TooManyFailures;
    }
    if state.auth.devices.check(presented).is_some() {
        limiter.succeeded(ip);
        TokenCheck::Good
    } else {
        limiter.failed_at(ip, now);
        TokenCheck::Bad
    }
}

#[allow(dead_code)] // Prefer `check_token` where the source is known.
pub fn token_ok(state: &AppState, presented: &str) -> bool {
    check_token(state, IpAddr::V4(Ipv4Addr::UNSPECIFIED), presented) == TokenCheck::Good
}

/// The token an /api request carries.
pub fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers.get("authorization")?.to_str().ok()?.strip_prefix("Bearer ")
}

/// Resolves when this token stops being valid, so revoking a device also ends its open sessions.
pub async fn until_revoked(state: &AppState, token: &str) {
    loop {
        tokio::time::sleep(Duration::from_secs(5)).await;
        if state.auth.devices.check(token).is_none() {
            return;
        }
    }
}

async fn authenticate(parts: &Parts, state: &AppState) -> Result<(String, Role), StatusCode> {
    let ConnectInfo(peer) = parts
        .extensions
        .get::<ConnectInfo<SocketAddr>>()
        .copied()
        .ok_or(StatusCode::FORBIDDEN)?;
    admit(state, &parts.headers, peer).await.map_err(|_| StatusCode::FORBIDDEN)?;
    let bearer = bearer(&parts.headers).ok_or(StatusCode::UNAUTHORIZED)?;
    match check_token(state, peer.ip(), bearer) {
        // A revoke landing between the two checks reads as a bad token, which is what it now is.
        TokenCheck::Good => state.auth.devices.check_device(bearer).ok_or(StatusCode::UNAUTHORIZED),
        TokenCheck::Bad => Err(StatusCode::UNAUTHORIZED),
        TokenCheck::TooManyFailures => Err(StatusCode::TOO_MANY_REQUESTS),
    }
}

#[async_trait]
impl<S> FromRequestParts<S> for Device
where
    Arc<AppState>: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = StatusCode;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, StatusCode> {
        let state = Arc::<AppState>::from_ref(state);
        authenticate(parts, &state).await.map(|(name, _)| Device(name))
    }
}

#[async_trait]
impl<S> FromRequestParts<S> for Caller
where
    Arc<AppState>: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = StatusCode;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, StatusCode> {
        let state = Arc::<AppState>::from_ref(state);
        authenticate(parts, &state).await.map(|(name, role)| Caller { name, role })
    }
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new().route("/api/pair", post(pair))
}

/// Trades a one-time code for this device's long-lived token. Runs behind admission, so a pairing link is useless off
/// the tailnet or from another person's node, and useless to anyone after its first use.
async fn pair(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if admit(&state, &headers, peer).await.is_err() {
        return StatusCode::FORBIDDEN.into_response();
    }
    let now = Instant::now();
    if state.auth.limiter.blocked_at(peer.ip(), now) {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }
    // A token on a machine where the assistant has a shell would be its to make and use: those aren't paired from here, and
    // the code isn't spent. A phone listed in LUMBRIDGE_PAIRS_ANYWAY is; what it may not do is refused where it's asked.
    if !crate::reach::may_pair_from(&state, Some(peer)).await {
        return (StatusCode::FORBIDDEN, Json(json!({"error": "not_from_here"}))).into_response();
    }
    let code = body["code"].as_str().unwrap_or("");
    match state.auth.devices.redeem(code) {
        Ok((device, token)) => {
            eprintln!("paired {device} from {}", peer.ip());
            Json(json!({"device": device, "token": token})).into_response()
        }
        Err(_) => {
            state.auth.limiter.failed_at(peer.ip(), now);
            (StatusCode::UNAUTHORIZED, Json(json!({"error": "bad_code"}))).into_response()
        }
    }
}

// Not under dev-identity, which turns both the limiter and admission off.
#[cfg(all(test, not(feature = "dev-identity")))]
mod tests {
    use super::*;
    use crate::config::Config;
    use axum::{body::Body, http::Request, routing::get};
    use tower::ServiceExt;

    #[test]
    fn a_source_is_blocked_after_too_many_failures_and_only_that_source() {
        let l = Limiter::default();
        let a: IpAddr = "100.64.0.1".parse().unwrap();
        let b: IpAddr = "100.64.0.2".parse().unwrap();
        let t0 = Instant::now();
        for _ in 0..MAX_FAILURES - 1 {
            l.failed_at(a, t0);
        }
        assert!(!l.blocked_at(a, t0));
        l.failed_at(a, t0);
        assert!(l.blocked_at(a, t0));
        assert!(!l.blocked_at(b, t0));
    }

    #[test]
    fn the_block_ends_with_the_window() {
        let l = Limiter::default();
        let a: IpAddr = "100.64.0.1".parse().unwrap();
        let t0 = Instant::now();
        for _ in 0..MAX_FAILURES {
            l.failed_at(a, t0);
        }
        let later = t0 + FAILURE_WINDOW + Duration::from_secs(1);
        assert!(!l.blocked_at(a, later));
        l.failed_at(a, later);
        assert!(!l.blocked_at(a, later), "a new window starts counting from one");
    }

    #[test]
    fn what_an_agent_may_call() {
        let may = |m: &str, p: &str, q: Option<&str>| agent_may(&Method::from_bytes(m.as_bytes()).unwrap(), p, q);
        assert!(may("GET", "/api/notes", None));
        assert!(may("GET", "/api/notes", Some("q=roof&limit=5")));
        assert!(may("GET", "/api/notes", Some("deleted=false")));
        assert!(!may("GET", "/api/notes", Some("deleted=true")));
        assert!(!may("GET", "/api/notes", Some("q=x&deleted")));
        assert!(!may("GET", "/api/notes", Some("delet%65d=true")), "decoded as the handler decodes it");
        assert!(!may("GET", "/api/notes", Some("deleted=fals%65x")));
        assert!(may("GET", "/api/notes", Some("deleted=fals%65")));
        assert!(may("GET", "/api/notes", Some("q=a+b%2")));
        assert!(may("GET", "/api/notes/0b7c6a43-8a0e-4d58-9a3c-6f0a8e1f2b3c", None));
        assert!(!may("GET", "/api/notes/", None));
        assert!(!may("POST", "/api/notes/x/restore", None));
        assert!(!may("GET", "/api/notes/x/restore", None));
        for m in ["POST", "PATCH", "DELETE", "PUT"] {
            assert!(!may(m, "/api/notes", None), "{m}");
            assert!(!may(m, "/api/notes/x", None), "{m}");
        }
        assert!(may("POST", "/api/note-proposals", None));
        assert!(may("GET", "/api/note-proposals", Some("mine=true&status=all")));
        assert!(!may("GET", "/api/note-proposals", None));
        assert!(!may("GET", "/api/note-proposals", Some("mine=false")));
        assert!(may("GET", "/api/note-proposals", Some("m%69ne=tru%65")));
        assert!(!may("POST", "/api/note-proposals/x/decide", None));
        assert!(may("POST", "/mcp", None));
        for (m, p) in [("GET", "/ws"), ("GET", "/api/tasks"), ("GET", "/api/asks"), ("GET", "/api/assistant/needs"), ("POST", "/api/pair"), ("GET", "/"), ("GET", "/healthz"), ("GET", "/api/notesx")] {
            assert!(!may(m, p, None), "{m} {p}");
        }
    }

    #[test]
    fn success_clears_the_count() {
        let l = Limiter::default();
        let a: IpAddr = "100.64.0.1".parse().unwrap();
        let t0 = Instant::now();
        for _ in 0..MAX_FAILURES - 1 {
            l.failed_at(a, t0);
        }
        l.succeeded(a);
        l.failed_at(a, t0);
        assert!(!l.blocked_at(a, t0));
    }

    #[tokio::test]
    async fn no_device_the_assistant_operates_can_spend_a_pairing_code() {
        let dir = tempfile::tempdir().unwrap();
        let tailscale = dir.path().join("tailscale");
        crate::test_exe::write_exe(&tailscale, "#!/bin/sh\nexec cat \"$(dirname \"$0\")/whois-$3\"\n");
        let cfg = Config {
            login: "k@example.com".into(),
            allowed_nodes: vec![],
            tailnet: String::new(),
            tailscale: tailscale.to_string_lossy().into_owned(),
            machine: None,
            conn_idle: std::time::Duration::from_secs(180),
            ws_dead_after: std::time::Duration::from_secs(90),
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
        let state = Arc::new(AppState::new(cfg));
        let code = state.auth.devices.begin_pair("phone").unwrap();
        let ip: IpAddr = "100.64.0.1".parse().unwrap();
        state.auth.whois.put(ip, Ok(()));
        let app: Router = router().with_state(state.clone());
        let pair_as = |node: &str| {
            let who = json!({"Node": {"Name": format!("{node}.example-tailnet.ts.net.")}, "UserProfile": {"LoginName": "k@example.com"}});
            std::fs::write(dir.path().join(format!("whois-{ip}")), who.to_string()).unwrap();
            let mut req = Request::post("/api/pair").header("content-type", "application/json").body(Body::from(json!({"code": code}).to_string())).unwrap();
            req.extensions_mut().insert(ConnectInfo(SocketAddr::new(ip, 1)));
            let app = app.clone();
            async move {
                let res = app.oneshot(req).await.unwrap();
                let status = res.status();
                let body: Value = serde_json::from_slice(&axum::body::to_bytes(res.into_body(), 1 << 16).await.unwrap()).unwrap_or(Value::Null);
                (status, body)
            }
        };
        for node in ["desk", "build-box"] {
            assert!(state.cfg.assistant_nodes.iter().any(|n| n == node));
            let (status, body) = pair_as(node).await;
            assert_eq!((status, body["error"].as_str()), (StatusCode::FORBIDDEN, Some("not_from_here")), "{node}");
        }
        // Not spent by those. The phone the assistant taps but has no shell on may pair: the code is good there, once.
        let (status, body) = pair_as("assistant-phone").await;
        assert_eq!((status, body["device"].as_str()), (StatusCode::OK, Some("phone")));
        let (status, body) = pair_as("sam-phone").await;
        assert_eq!((status, body["error"].as_str()), (StatusCode::UNAUTHORIZED, Some("bad_code")), "spent");
    }

    // The extractor as a handler sees it, with whois answered from the cache.
    #[tokio::test]
    async fn the_device_extractor_needs_admission_and_a_live_token() {
        let dir = std::env::temp_dir().join(format!("lumbridge-auth-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let cfg = Config {
            login: "k@example.com".into(),
            allowed_nodes: vec![],
            tailnet: String::new(),
            tailscale: "/nonexistent".into(),
            machine: None,
            conn_idle: std::time::Duration::from_secs(180),
            ws_dead_after: std::time::Duration::from_secs(90),
            assistant_nodes: vec!["assistant-phone".into(), "desk".into(), "build-box".into()],
            pairs_anyway: vec!["assistant-phone".into()],
            origins: vec!["https://mobile.example.com".into()],
            hc: "hc".into(),
            bind: String::new(),
            tls_bind: String::new(),
            tls: None,
            web: String::new(),
            state_dir: dir.to_string_lossy().into_owned(),
        };
        let state = Arc::new(AppState::new(cfg));
        let code = state.auth.devices.begin_pair("phone").unwrap();
        let (_, token) = state.auth.devices.redeem(&code).unwrap();
        let good: IpAddr = "100.64.0.1".parse().unwrap();
        state.auth.whois.put(good, Ok(()));

        let app: Router = Router::new()
            .route("/api/x", get(|_: Device| async { "in" }))
            .with_state(state.clone());
        let call = |ip: IpAddr, bearer: Option<String>, origin: Option<&'static str>| {
            let app = app.clone();
            async move {
                let mut req = Request::builder().uri("/api/x");
                if let Some(b) = bearer {
                    req = req.header("authorization", format!("Bearer {b}"));
                }
                if let Some(o) = origin {
                    req = req.header("origin", o);
                }
                let mut req = req.body(Body::empty()).unwrap();
                req.extensions_mut().insert(ConnectInfo(SocketAddr::new(ip, 1)));
                app.oneshot(req).await.unwrap().status()
            }
        };
        assert_eq!(call(good, Some(token.clone()), None).await, StatusCode::OK);
        assert_eq!(call(good, Some(token.clone()), Some("https://mobile.example.com")).await, StatusCode::OK);
        assert_eq!(call(good, Some(token.clone()), Some("https://evil.example")).await, StatusCode::FORBIDDEN);
        assert_eq!(call(good, None, None).await, StatusCode::UNAUTHORIZED);
        assert_eq!(call("127.0.0.1".parse().unwrap(), Some(token.clone()), None).await, StatusCode::FORBIDDEN);
        assert_eq!(call("100.64.0.2".parse().unwrap(), Some(token.clone()), None).await, StatusCode::FORBIDDEN, "whois failed");
        for _ in 0..MAX_FAILURES {
            assert_eq!(call(good, Some("x".repeat(64)), None).await, StatusCode::UNAUTHORIZED);
        }
        assert_eq!(call(good, Some(token.clone()), None).await, StatusCode::TOO_MANY_REQUESTS);
        state.auth.limiter.succeeded(good);
        state.auth.devices.revoke("phone").unwrap();
        assert_eq!(call(good, Some(token), None).await, StatusCode::UNAUTHORIZED);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
