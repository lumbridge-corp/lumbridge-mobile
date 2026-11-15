//! lumbridge-mobile-server: Lumbridge Mobile's only server. It lets a browser or Tauri webview speak
//! lumbridge-core's framed protocol and reach the assistant, its voice and the owner's data.
//!
//! Core has no login and its API is a shell, so this process is the trust boundary.
//! See docs/ARCHITECTURE.md before changing `auth` or the allowlist in `ws`.

#[cfg(all(feature = "dev-identity", not(debug_assertions)))]
compile_error!("dev-identity skips the tailnet check and must never be in a release build");

mod auth;
mod cli;
mod config;
mod data;
mod devices;
#[cfg(ext)]
mod ext;
mod gate;
mod hc;
mod listen;
mod mail;
mod mcp;
mod needs;
mod push;
mod pyre;
mod reach;
mod vocab;
mod voice;
mod whois;
mod ws;

use axum::{middleware, routing::get, Router};
use std::sync::Arc;

pub struct AppState {
    pub cfg: config::Config,
    pub auth: auth::Auth,
    pub voice: voice::Voice,
    pub push: push::Push,
    pub needs: needs::Needs,
    pub mail: mail::Mail,
    pub db: data::db::Db,
    pub asks: data::asks::Relay,
    /// This instance's own screens (src/ext/, when it is there).
    #[cfg(ext)]
    pub ext: ext::Ext,
}

impl AppState {
    pub fn new(cfg: config::Config) -> Self {
        let auth = auth::Auth::new(&cfg.state_dir);
        let voice = voice::Voice::from_env(&cfg.state_dir);
        let push = push::Push::open(&cfg.state_dir);
        Self {
            cfg,
            auth,
            voice,
            push,
            needs: needs::Needs::from_env(),
            mail: mail::Mail::from_env(),
            db: data::db::Db::from_env(),
            asks: data::asks::Relay::default(),
            #[cfg(ext)]
            ext: ext::Ext::from_env(),
        }
    }
}

/// Every route the gateway serves, behind the gate. A function so tests can try each of them (`agent_tests`).
pub fn app(state: Arc<AppState>) -> Router {
    let web = state.cfg.web.clone();
    let router = Router::new()
        .route("/ws", get(ws::ws))
        .route("/healthz", get(|| async { "ok" }))
        .merge(auth::router())
        .merge(voice::router())
        .merge(push::router())
        .merge(data::router(state.db.clone()))
        .merge(mcp::router())
        .merge(needs::router())
        .merge(mail::router());
    #[cfg(ext)]
    let router = router.merge(ext::router());
    router
        .fallback_service(gate::web_files(&web))
        .layer(middleware::from_fn_with_state(state.clone(), gate::gate))
        .with_state(state)
}

fn die(why: impl std::fmt::Display) -> ! {
    eprintln!("lumbridge-mobile-server: {why}");
    std::process::exit(2)
}

/// An install that used other names for its settings builds with `LUMBRIDGE_ENV_ALIAS=<prefix>`: then `LUMBRIDGE_<X>`, when it is
/// unset, takes the value of `<prefix><X>`. Runs before any thread starts, so nothing reads the environment while it changes.
fn alias_env() {
    let Some(prefix) = option_env!("LUMBRIDGE_ENV_ALIAS").filter(|p| !p.is_empty() && *p != "LUMBRIDGE_") else { return };
    let found: Vec<(String, std::ffi::OsString)> = std::env::vars_os()
        .filter_map(|(k, v)| Some((k.to_str()?.strip_prefix(prefix)?.to_string(), v)))
        .collect();
    for (rest, value) in found {
        let name = format!("LUMBRIDGE_{rest}");
        if std::env::var_os(&name).is_none() {
            std::env::set_var(name, value);
        }
    }
}

fn main() {
    alias_env();
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap_or_else(|e| die(e));
    runtime.block_on(run());
}

async fn run() {
    // `lumbridge-mobile-server migrate [--status]` needs only LUMBRIDGE_DATABASE_URL, not a full gateway config.
    if std::env::args().nth(1).as_deref() == Some("migrate") {
        let status_only = std::env::args().nth(2).as_deref() == Some("--status");
        if let Err(e) = data::migrate::cli(status_only).await {
            eprintln!("migrate: {e}");
            std::process::exit(1);
        }
        return;
    }
    // `lumbridge-mobile-server thoughts ...`, for the assistant: read-only, and it too needs only LUMBRIDGE_DATABASE_URL.
    if std::env::args().nth(1).as_deref() == Some("thoughts") {
        let args: Vec<String> = std::env::args().skip(2).collect();
        std::process::exit(cli::thoughts(&args).await);
    }
    // `lumbridge-mobile-server asks create|recent`, for the assistant: the same, and `create` is the only write.
    if std::env::args().nth(1).as_deref() == Some("asks") {
        let args: Vec<String> = std::env::args().skip(2).collect();
        std::process::exit(cli::asks(&args).await);
    }
    // `lumbridge-mobile-server notes search|read|recent`, for the assistant: read-only like `thoughts`.
    if std::env::args().nth(1).as_deref() == Some("notes") {
        let args: Vec<String> = std::env::args().skip(2).collect();
        std::process::exit(cli::notes(&args).await);
    }
    // `lumbridge-mobile-server proposals create`, for the assistant: a note idea for the owner to keep or drop.
    if std::env::args().nth(1).as_deref() == Some("proposals") {
        let args: Vec<String> = std::env::args().skip(2).collect();
        std::process::exit(cli::proposals(&args).await);
    }
    // `lumbridge-mobile-server files ...`, for the filer (pending, update) and the assistant (recent, search, read). Only the database.
    if std::env::args().nth(1).as_deref() == Some("files") {
        let args: Vec<String> = std::env::args().skip(2).collect();
        std::process::exit(cli::files(&args).await);
    }
    let args: Vec<String> = std::env::args().skip(1).collect();
    if !args.is_empty() {
        std::process::exit(cli::run(&args));
    }
    let cfg = config::Config::from_env();
    // The dev build admits anyone who reaches it, so nothing but this machine may. No TLS either: that listener
    // exists to sit behind `tailscale serve`, which would put the whole tailnet in front of it.
    if cfg!(feature = "dev-identity") && cfg.tls.is_some() {
        die("a dev-identity build refuses TLS: it would be reachable through tailscale serve");
    }
    let bind = listen::require_loopback(if cfg.tls.is_some() { &cfg.tls_bind } else { &cfg.bind }).unwrap_or_else(|e| die(e));
    let certs = cfg.tls.clone().map(|files| listen::Certs::load(files).unwrap_or_else(|e| die(e)));
    let state = Arc::new(AppState::new(cfg));
    tokio::spawn(push::watcher(state.clone()));
    tokio::spawn(needs::watcher(state.clone()));
    tokio::spawn(mail::watcher(state.clone()));
    tokio::spawn(data::asks::watcher(state.clone()));
    tokio::spawn(data::proposals::watcher(state.clone()));

    let app = app(state.clone());
    #[cfg(ext)]
    let app = Router::new().fallback_service(tower::ServiceBuilder::new().map_request(ext::legacy_path).service(app));
    let served = match certs {
        Some(certs) => listen::serve_tls(bind, certs, app, state).await,
        None => listen::serve_plain(bind, app).await,
    };
    die(format!("listener on {bind}: {}", served.err().map(|e| e.to_string()).unwrap_or_default()));
}

/// An agent device against every route the gateway has: only what `auth::agent_may` names gets past the gate. The routes are read
/// out of the source, every `.route("…", …)` with its methods, so a route added later is tried here without anyone listing it.
#[cfg(test)]
mod agent_tests {
    use super::*;
    use crate::devices::Role;
    use axum::{
        body::Body,
        extract::ConnectInfo,
        http::{Method, Request, StatusCode},
    };
    use std::{collections::BTreeSet, net::SocketAddr};
    use tower::ServiceExt;

    /// `(method, path)` for every route in src/, test modules left out.
    fn routes() -> BTreeSet<(String, String)> {
        fn files(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            for e in std::fs::read_dir(dir).unwrap() {
                let p = e.unwrap().path();
                if p.is_dir() {
                    files(&p, out);
                } else if p.extension().is_some_and(|x| x == "rs") {
                    out.push(p);
                }
            }
        }
        let mut paths = Vec::new();
        files(std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/src")), &mut paths);
        let mut found = BTreeSet::new();
        for p in paths {
            let text = std::fs::read_to_string(&p).unwrap();
            let code = text.split("#[cfg(test)]").next().unwrap().split("#[cfg(all(test").next().unwrap();
            let mut rest = code;
            while let Some(at) = rest.find(".route(\"") {
                rest = &rest[at + 8..];
                let end = rest.find('"').unwrap();
                let path = rest[..end].to_string();
                if !path.starts_with('/') {
                    continue; // this comment's own example, say
                }
                // The method router: up to the parenthesis that closes `.route(`.
                let (mut depth, mut close) = (1, 0);
                for (i, ch) in rest[end..].char_indices() {
                    match ch {
                        '(' => depth += 1,
                        ')' => depth -= 1,
                        _ => {}
                    }
                    if depth == 0 {
                        close = end + i;
                        break;
                    }
                }
                let methods = &rest[end..close];
                let mut any = false;
                for m in ["get", "post", "put", "patch", "delete"] {
                    let hit = methods.match_indices(&format!("{m}(")).any(|(i, _)| {
                        i == 0 || !methods.as_bytes()[i - 1].is_ascii_alphanumeric() && methods.as_bytes()[i - 1] != b'_'
                    });
                    if hit {
                        found.insert((m.to_uppercase(), path.clone()));
                        any = true;
                    }
                }
                assert!(any, "no method found for {path} in {}", p.display());
            }
        }
        found
    }

    fn concrete(path: &str) -> String {
        path.split('/')
            .map(|seg| match seg.chars().next() {
                Some(':') => "0b7c6a43-8a0e-4d58-9a3c-6f0a8e1f2b3c",
                Some('*') => "x",
                _ => seg,
            })
            .collect::<Vec<_>>()
            .join("/")
    }

    async fn call(app: &Router, method: &str, uri: &str, token: &str) -> (StatusCode, String) {
        let mut req = Request::builder()
            .method(Method::from_bytes(method.as_bytes()).unwrap())
            .uri(uri)
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", "application/json")
            .body(Body::from("{}"))
            .unwrap();
        req.extensions_mut().insert(ConnectInfo(SocketAddr::new("100.64.0.1".parse().unwrap(), 1)));
        let res = app.clone().oneshot(req).await.unwrap();
        let status = res.status();
        let body = axum::body::to_bytes(res.into_body(), 1 << 20).await.unwrap();
        (status, String::from_utf8_lossy(&body).into_owned())
    }

    const REFUSED: &str = r#"{"error":"agent_not_allowed"}"#;

    #[tokio::test]
    async fn an_agent_gets_only_what_it_is_allowed() {
        let dir = tempfile::tempdir().unwrap();
        let state = Arc::new(AppState::new(config::Config::for_tests(dir.path())));
        state.auth.whois.put("100.64.0.1".parse().unwrap(), Ok(()));
        let code = state.auth.devices.begin_pair_as("claude", Role::Agent).unwrap();
        let (_, agent) = state.auth.devices.redeem(&code).unwrap();
        let code = state.auth.devices.begin_pair("iphone").unwrap();
        let (_, owner) = state.auth.devices.redeem(&code).unwrap();
        let app = app(state.clone());

        let all = routes();
        // The reader works: these are there, and so are plenty of others.
        for want in [("GET", "/ws"), ("GET", "/api/notes"), ("GET", "/api/notes/:id"), ("PATCH", "/api/notes/:id"), ("POST", "/api/note-proposals"),
                     ("GET", "/api/note-proposals"), ("POST", "/api/note-proposals/:id/decide"), ("POST", "/mcp"), ("POST", "/api/pair"), ("POST", "/api/asks/:id/answer")] {
            assert!(all.contains(&(want.0.to_string(), want.1.to_string())), "{want:?} not found: {all:?}");
        }
        assert!(all.len() > if cfg!(ext) { 60 } else { 25 }, "{}", all.len());

        let mut allowed = Vec::new();
        for (method, path) in &all {
            let uri = concrete(path);
            let (status, body) = call(&app, method, &uri, &agent).await;
            if auth::agent_may(&Method::from_bytes(method.as_bytes()).unwrap(), &uri, None) {
                assert_ne!(body, REFUSED, "{method} {path}");
                allowed.push(format!("{method} {path}"));
            } else {
                assert_eq!((status, body.as_str()), (StatusCode::FORBIDDEN, REFUSED), "{method} {path}");
            }
        }
        assert_eq!(allowed, ["GET /api/notes", "GET /api/notes/:id", "POST /api/note-proposals", "POST /mcp"]);

        // What isn't a route at all, and what a query changes.
        for (method, uri) in [("GET", "/"), ("GET", "/index.html"), ("GET", "/healthz"), ("GET", "/api/notes?deleted=true"), ("GET", "/api/notes?delet%65d=true"),
                              ("GET", "/api/note-proposals"), ("GET", "/api/note-proposals?status=all"), ("GET", "/api/nothing-here")] {
            assert_eq!(call(&app, method, uri, &agent).await, (StatusCode::FORBIDDEN, REFUSED.to_string()), "{method} {uri}");
        }
        // No database here: what it may call gets as far as asking for one.
        for (method, uri) in [("GET", "/api/notes"), ("GET", "/api/notes?q=roof&deleted=false"), ("GET", "/api/notes/0b7c6a43-8a0e-4d58-9a3c-6f0a8e1f2b3c"),
                              ("GET", "/api/note-proposals?mine=true&status=all")] {
            assert_eq!(call(&app, method, uri, &agent).await.0, StatusCode::SERVICE_UNAVAILABLE, "{method} {uri}");
        }
        assert_eq!(call(&app, "GET", "/mcp", &agent).await.0, StatusCode::METHOD_NOT_ALLOWED, "no event stream");

        // The owner's devices are held to nothing of the kind.
        for (method, uri) in [("GET", "/api/tasks"), ("GET", "/api/note-proposals"), ("GET", "/api/notes?deleted=true")] {
            assert_eq!(call(&app, method, uri, &owner).await.0, StatusCode::SERVICE_UNAVAILABLE, "{method} {uri}");
        }
        let (status, body) = call(&app, "POST", "/api/note-proposals/0b7c6a43-8a0e-4d58-9a3c-6f0a8e1f2b3c/decide", &owner).await;
        assert_ne!(body, REFUSED, "{status}");
    }
}

/// Fake tools for the tests. Declared down here, as `agent_tests` reads main.rs's routes up to its first `#[cfg(test)]`.
#[cfg(test)]
mod test_exe;
