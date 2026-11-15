//! The outermost layer, on everything including static files: nobody outside the admitted set gets so much as the
//! page. It also answers CORS (the Tauri page calls the gateway's address cross-origin) and sets the security headers.

use crate::{auth, AppState};
use axum::{
    body::Body,
    extract::{ConnectInfo, Request, State},
    http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use std::{net::SocketAddr, sync::Arc};
use tower::util::MapResponse;
use tower_http::services::{fs::ServeFileSystemResponseBody, ServeDir};

const STATIC_HEADERS: &[(&str, &str)] = &[
    ("x-content-type-options", "nosniff"),
    ("referrer-policy", "no-referrer"),
    ("x-frame-options", "DENY"),
    ("permissions-policy", "microphone=(self), camera=(), geolocation=()"),
];
const HSTS: &str = "max-age=31536000";

/// `Content-Security-Policy`. The page's own fetches and socket are same-origin; xterm.js needs inline styles. Video thumbnails
/// come from `i.ytimg.com`: images only, nothing that runs or is called. Over TLS the socket is `wss://` to each `https://` origin in
/// LUMBRIDGE_ORIGINS. LUMBRIDGE_CSP_CONNECT adds origins the page may call itself (space-separated), for an instance's own screens.
fn csp(tls: bool, origins: &[String]) -> String {
    let sockets = if tls {
        origins.iter().filter_map(|o| o.strip_prefix("https://")).map(|h| format!("wss://{h}")).collect::<Vec<_>>().join(" ")
    } else {
        "ws://127.0.0.1:* ws://localhost:*".to_string()
    };
    let extra = extra_connect();
    let connect = [sockets.as_str(), extra.as_str()].iter().filter(|s| !s.is_empty()).copied().collect::<Vec<_>>().join(" ");
    format!(
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://i.ytimg.com; \
         media-src 'self' blob:; connect-src 'self' {connect}; worker-src 'self'; manifest-src 'self'; \
         object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
    )
}

/// LUMBRIDGE_CSP_CONNECT, read once: only `https://` origins, anything else is left out.
fn extra_connect() -> String {
    static EXTRA: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    EXTRA
        .get_or_init(|| {
            std::env::var("LUMBRIDGE_CSP_CONNECT")
                .unwrap_or_default()
                .split_whitespace()
                .filter(|o| o.starts_with("https://") && !o.contains(';') && !o.contains('\''))
                .collect::<Vec<_>>()
                .join(" ")
        })
        .clone()
}

fn is_api(path: &str) -> bool {
    path == "/api" || path.starts_with("/api/")
}

fn is_file_content(path: &str) -> bool {
    (path.starts_with("/api/files/") && path.ends_with("/content")) || path.starts_with("/api/social/media/")
}

fn allowed_origin(state: &AppState, headers: &HeaderMap) -> Option<HeaderValue> {
    let origin = headers.get(header::ORIGIN)?;
    state.cfg.origins.iter().any(|o| o.as_bytes() == origin.as_bytes()).then(|| origin.clone())
}

fn preflight(state: &AppState, headers: &HeaderMap) -> Response {
    let Some(origin) = allowed_origin(state, headers) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    let mut res = StatusCode::NO_CONTENT.into_response();
    let h = res.headers_mut();
    h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
    h.insert(header::ACCESS_CONTROL_ALLOW_METHODS, HeaderValue::from_static("GET, POST, PUT, PATCH, DELETE"));
    h.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, HeaderValue::from_static("authorization, content-type"));
    h.insert(header::ACCESS_CONTROL_MAX_AGE, HeaderValue::from_static("600"));
    // Chrome's Private Network Access asks before a page reaches a private address.
    if headers.contains_key("access-control-request-private-network") {
        h.insert("access-control-allow-private-network", HeaderValue::from_static("true"));
    }
    res
}

/// Vite names everything under /assets by its content, so those last forever. Everything else, index.html and sw.js above
/// all, comes fresh each time, or a browser could guess it's still good and run the old build after a deploy, asking for
/// chunks that are gone. `no-store`, not `no-cache`: a rollback serves an older file, which a date check would call
/// unchanged. The worker's own cache (for when there's no network) doesn't go by this header.
fn cache_control(path: &str, ok: bool) -> &'static str {
    if path.starts_with("/assets/") && ok {
        "public, max-age=31536000, immutable"
    } else {
        "no-store"
    }
}

type FileResponse = http::Response<ServeFileSystemResponseBody>;

/// The built app. `npm run build` leaves a `.br` and a `.gz` beside each text file (web/scripts/compress.mjs); a browser
/// that takes one gets it, else the plain file. ServeDir doesn't say the answer depends on `Accept-Encoding`, so this does,
/// or a cache in between could hand brotli to a client that can't read it.
pub fn web_files(dir: &str) -> MapResponse<ServeDir, fn(FileResponse) -> FileResponse> {
    fn vary(mut res: FileResponse) -> FileResponse {
        res.headers_mut().append(header::VARY, HeaderValue::from_static("Accept-Encoding"));
        res
    }
    MapResponse::new(ServeDir::new(dir).precompressed_br().precompressed_gzip(), vary)
}

fn finish(state: &AppState, path: &str, origin: Option<HeaderValue>, res: &mut Response) {
    let tls = state.cfg.tls.is_some();
    let ok = res.status().is_success();
    let h = res.headers_mut();
    for (name, value) in STATIC_HEADERS {
        h.insert(HeaderName::from_static(name), HeaderValue::from_static(value));
    }
    if let Ok(value) = HeaderValue::from_str(&csp(tls, &state.cfg.origins)) {
        h.insert(header::CONTENT_SECURITY_POLICY, value);
    }
    // A file's bytes, opened on their own, still can't run anything: no script, no plugins, a unique origin.
    if is_file_content(path) {
        h.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("sandbox; default-src 'none'; img-src 'self'"));
    }
    if tls {
        h.insert(header::STRICT_TRANSPORT_SECURITY, HeaderValue::from_static(HSTS));
    }
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache_control(path, ok)));
    if is_api(path) {
        h.append(header::VARY, HeaderValue::from_static("Origin"));
        if let Some(origin) = origin {
            h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
        }
    }
}

/// False only for an agent device's token on a request outside `auth::agent_may`. This is where agents are held to that list,
/// for every route there is and every one added later. A request with no token, or a bad one, goes on and is refused by its
/// handler as before. `/ws` carries its token in its first message, not here: ws.rs asks `agent_may` itself.
fn agent_allowed(state: &AppState, req: &Request<Body>) -> bool {
    let Some(token) = auth::bearer(req.headers()) else { return true };
    match state.auth.devices.check_device(token) {
        Some((_, crate::devices::Role::Agent)) => auth::agent_may(req.method(), req.uri().path(), req.uri().query()),
        _ => true,
    }
}

pub async fn gate(State(state): State<Arc<AppState>>, req: Request<Body>, next: Next) -> Response {
    let path = req.uri().path().to_string();
    let Some(ConnectInfo(peer)) = req.extensions().get::<ConnectInfo<SocketAddr>>().copied() else {
        return StatusCode::FORBIDDEN.into_response();
    };
    let origin = allowed_origin(&state, req.headers());
    // A local liveness probe needs no identity and learns nothing. Anyone else's /healthz goes through admission.
    let local_probe = path == "/healthz" && peer.ip().is_loopback();
    let mut res = if local_probe {
        next.run(req).await
    } else {
        match auth::admit(&state, req.headers(), peer).await {
            Err(why) => {
                eprintln!("refused {}: {why}", peer.ip());
                StatusCode::FORBIDDEN.into_response()
            }
            Ok(()) if is_api(&path) && req.method() == Method::OPTIONS => preflight(&state, req.headers()),
            Ok(()) if !agent_allowed(&state, &req) => auth::agent_refused(),
            Ok(()) => next.run(req).await,
        }
    };
    finish(&state, &path, origin, &mut res);
    res
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use tower::ServiceExt;

    fn state(tls: bool) -> AppState {
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
            origins: vec!["https://mobile.example.com".into(), "https://tauri.localhost".into(), "tauri://localhost".into()],
            hc: "hc".into(),
            bind: String::new(),
            tls_bind: String::new(),
            tls: tls.then(|| crate::config::TlsFiles { cert: String::new(), key: String::new() }),
            web: String::new(),
            state_dir: std::env::temp_dir().to_string_lossy().into_owned(),
        };
        AppState::new(cfg)
    }

    fn with_origin(origin: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(header::ORIGIN, HeaderValue::from_str(origin).unwrap());
        h
    }

    #[test]
    fn only_listed_origins_are_allowed() {
        let s = state(false);
        for good in ["https://mobile.example.com", "https://tauri.localhost", "tauri://localhost"] {
            assert_eq!(allowed_origin(&s, &with_origin(good)).unwrap(), good);
        }
        for bad in ["https://evil.example", "https://mobile.example.com.evil.example", "http://mobile.example.com", "null", ""] {
            assert!(allowed_origin(&s, &with_origin(bad)).is_none(), "{bad}");
        }
        assert!(allowed_origin(&s, &HeaderMap::new()).is_none());
    }

    #[test]
    fn preflight_answers_a_listed_origin_and_refuses_the_rest() {
        let s = state(false);
        let ok = preflight(&s, &with_origin("https://tauri.localhost"));
        assert_eq!(ok.status(), StatusCode::NO_CONTENT);
        assert_eq!(ok.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "https://tauri.localhost");
        assert!(ok.headers()[header::ACCESS_CONTROL_ALLOW_HEADERS].to_str().unwrap().contains("authorization"));
        let no = preflight(&s, &with_origin("https://evil.example"));
        assert_eq!(no.status(), StatusCode::FORBIDDEN);
        assert!(!no.headers().contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN));
    }

    #[test]
    fn headers_on_api_and_static() {
        let s = state(true);
        let mut api = StatusCode::OK.into_response();
        finish(&s, "/api/notes", allowed_origin(&s, &with_origin("https://mobile.example.com")), &mut api);
        assert_eq!(api.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(api.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "https://mobile.example.com");
        assert_eq!(api.headers()["x-content-type-options"], "nosniff");
        assert_eq!(api.headers()[header::STRICT_TRANSPORT_SECURITY], HSTS);

        let mut page = StatusCode::OK.into_response();
        finish(&s, "/index.html", None, &mut page);
        assert_eq!(page.headers()[header::CACHE_CONTROL], "no-store", "a deploy must reach an installed client");
        assert!(!page.headers().contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN));
        assert!(page.headers()[header::CONTENT_SECURITY_POLICY].to_str().unwrap().contains("frame-ancestors 'none'"));
        let csp = page.headers()[header::CONTENT_SECURITY_POLICY].to_str().unwrap().to_string();
        assert!(csp.contains("img-src 'self' data: blob: https://i.ytimg.com") && !csp.contains("connect-src 'self' https://i.ytimg.com"), "{csp}");
        assert!(csp.contains("connect-src 'self' wss://mobile.example.com wss://tauri.localhost; worker-src"), "{csp}");

        let mut asset = StatusCode::OK.into_response();
        finish(&s, "/assets/index-abc123.js", None, &mut asset);
        assert!(asset.headers()[header::CACHE_CONTROL].to_str().unwrap().contains("immutable"));
        let mut gone = StatusCode::NOT_FOUND.into_response();
        finish(&s, "/assets/index-old.js", None, &mut gone);
        assert_eq!(gone.headers()[header::CACHE_CONTROL], "no-store", "a missing chunk isn't missing forever");

        let mut ws = StatusCode::OK.into_response();
        finish(&s, "/ws", None, &mut ws);
        assert_eq!(ws.headers()[header::CACHE_CONTROL], "no-store");

        let mut plain = StatusCode::OK.into_response();
        finish(&state(false), "/", None, &mut plain);
        assert!(!plain.headers().contains_key(header::STRICT_TRANSPORT_SECURITY));
    }

    async fn fetch(dir: &str, path: &str, accept: Option<&str>) -> Response {
        let mut req = Request::get(path);
        if let Some(a) = accept {
            req = req.header(header::ACCEPT_ENCODING, a);
        }
        let res = web_files(dir).oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
        let mut res = res.map(Body::new);
        finish(&state(true), path, None, &mut res);
        res
    }

    async fn bytes(res: Response) -> Vec<u8> {
        axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap().to_vec()
    }

    #[tokio::test]
    async fn precompressed_files_go_to_who_accepts_them() {
        let dir = tempfile::tempdir().unwrap();
        let assets = dir.path().join("assets");
        std::fs::create_dir(&assets).unwrap();
        std::fs::write(assets.join("a.js"), b"plain").unwrap();
        std::fs::write(assets.join("a.js.br"), b"brotli").unwrap();
        std::fs::write(assets.join("a.js.gz"), b"gzip").unwrap();
        std::fs::write(dir.path().join("index.html"), b"<html>").unwrap();
        let web = dir.path().to_str().unwrap();

        for (accept, encoding, body) in [
            (Some("br"), Some("br"), &b"brotli"[..]),
            (Some("gzip, deflate, br"), Some("br"), b"brotli"),
            (Some("gzip"), Some("gzip"), b"gzip"),
            (Some("identity"), None, b"plain"),
            (None, None, b"plain"),
        ] {
            let res = fetch(web, "/assets/a.js", accept).await;
            assert_eq!(res.status(), StatusCode::OK, "{accept:?}");
            assert_eq!(res.headers().get(header::CONTENT_ENCODING).map(|v| v.to_str().unwrap()), encoding, "{accept:?}");
            assert_eq!(res.headers()[header::CACHE_CONTROL], "public, max-age=31536000, immutable", "{accept:?}");
            assert_eq!(res.headers()[header::CONTENT_TYPE], "text/javascript", "{accept:?}");
            assert!(res.headers().get_all(header::VARY).iter().any(|v| v == "Accept-Encoding"), "{accept:?}");
            assert_eq!(res.headers()["x-content-type-options"], "nosniff");
            assert_eq!(bytes(res).await, body, "{accept:?}");
        }

        // No .br beside it: the plain file, whatever the browser takes.
        let page = fetch(web, "/index.html", Some("br, gzip")).await;
        assert_eq!(page.headers()[header::CACHE_CONTROL], "no-store");
        assert!(!page.headers().contains_key(header::CONTENT_ENCODING));
        assert_eq!(bytes(page).await, b"<html>");
        let root = fetch(web, "/", Some("br")).await;
        assert_eq!(root.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(bytes(root).await, b"<html>");
    }
}
