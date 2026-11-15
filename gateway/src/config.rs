//! Everything comes from the environment; the README's Configuration section and its example unit are the reference.

use std::time::Duration;

fn required(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| {
        eprintln!("{name} is required");
        std::process::exit(2)
    })
}

fn optional(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.into())
}

fn seconds(name: &str, default: u64) -> Duration {
    Duration::from_secs(std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default))
}

fn list(value: &str) -> Vec<String> {
    value.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()
}

/// What the owner is called where the assistant hears it (an answered ask, the speech prompt): LUMBRIDGE_OWNER_NAME, or none.
pub fn owner_name() -> Option<&'static str> {
    static NAME: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    NAME.get_or_init(|| {
        std::env::var("LUMBRIDGE_OWNER_NAME").ok().map(|n| n.trim().chars().take(40).collect::<String>()).filter(|n| !n.is_empty())
    })
    .as_deref()
}

#[derive(Clone)]
pub struct TlsFiles {
    pub cert: String,
    pub key: String,
}

pub struct Config {
    /// The tailnet login whose user-owned nodes (the owner's phones) are admitted.
    pub login: String,
    /// The only nodes ever admitted, by exact tailnet name (`laptop`, not its hostname). Default deny.
    pub allowed_nodes: Vec<String>,
    /// MagicDNS suffix of our tailnet, so a node shared in from elsewhere can't borrow an allowed name.
    pub tailnet: String,
    /// The `tailscale` binary used for whois.
    pub tailscale: String,
    pub origins: Vec<String>,
    pub hc: String,
    /// Plain HTTP, for scripts/dev.sh. Not started when `tls` is set.
    pub bind: String,
    /// TLS + PROXY protocol, behind `tailscale serve --tcp`.
    pub tls_bind: String,
    pub tls: Option<TlsFiles>,
    pub web: String,
    /// Directory for gateway-owned state (devices, push subscriptions, VAPID keys).
    pub state_dir: String,
    /// What notifications call this machine; core's own name when unset.
    pub machine: Option<String>,
    /// A connection that moves nothing for this long is closed.
    pub conn_idle: Duration,
    /// A WebSocket that hears nothing from its client for this long is closed, which also stops its `hc connect`.
    pub ws_dead_after: Duration,
    /// Nodes the assistant can operate itself: nothing that approves or mints access is accepted from them (reach.rs).
    pub assistant_nodes: Vec<String>,
    /// Of those, the ones that may still be paired (reach.rs).
    pub pairs_anyway: Vec<String>,
}

impl Config {
    pub fn from_env() -> Self {
        let tls = match (std::env::var("LUMBRIDGE_TLS_CERT"), std::env::var("LUMBRIDGE_TLS_KEY")) {
            (Ok(cert), Ok(key)) => Some(TlsFiles { cert, key }),
            (Err(_), Err(_)) => None,
            _ => {
                eprintln!("LUMBRIDGE_TLS_CERT and LUMBRIDGE_TLS_KEY go together");
                std::process::exit(2)
            }
        };
        let allowed_nodes = list(&optional("LUMBRIDGE_ALLOWED_NODES", ""));
        let tailnet = optional("LUMBRIDGE_TAILNET", "");
        if !allowed_nodes.is_empty() && tailnet.is_empty() {
            eprintln!("LUMBRIDGE_TAILNET is required with LUMBRIDGE_ALLOWED_NODES");
            std::process::exit(2)
        }
        if allowed_nodes.is_empty() && !cfg!(feature = "dev-identity") {
            eprintln!("LUMBRIDGE_ALLOWED_NODES is empty: nobody will be admitted");
        }
        Self {
            login: required("LUMBRIDGE_LOGIN"),
            allowed_nodes,
            tailnet,
            tailscale: optional("LUMBRIDGE_TAILSCALE", "tailscale"),
            origins: list(&required("LUMBRIDGE_ORIGINS")),
            hc: optional("LUMBRIDGE_HC", "lbc"),
            bind: optional("LUMBRIDGE_BIND", "127.0.0.1:8450"),
            tls_bind: optional("LUMBRIDGE_TLS_BIND", "127.0.0.1:8451"),
            tls,
            web: optional("LUMBRIDGE_WEB", "web"),
            state_dir: required("LUMBRIDGE_STATE_DIR"),
            machine: std::env::var("LUMBRIDGE_MACHINE").ok().filter(|s| !s.is_empty()),
            conn_idle: seconds("LUMBRIDGE_CONN_IDLE_SECS", 180),
            ws_dead_after: seconds("LUMBRIDGE_WS_DEAD_SECS", 90),
            assistant_nodes: list(&optional("LUMBRIDGE_ASSISTANT_NODES", "")),
            pairs_anyway: list(&optional("LUMBRIDGE_PAIRS_ANYWAY", "")),
        }
    }
}

#[cfg(test)]
impl Config {
    /// What the tests use: state in `dir`, no TLS, no origins, whois from the cache only.
    pub fn for_tests(dir: &std::path::Path) -> Self {
        Self {
            login: "k@example.com".into(),
            allowed_nodes: vec![],
            tailnet: String::new(),
            tailscale: "/nonexistent".into(),
            origins: vec![],
            hc: "hc".into(),
            bind: String::new(),
            tls_bind: String::new(),
            tls: None,
            web: dir.join("web").to_string_lossy().into_owned(),
            state_dir: dir.to_string_lossy().into_owned(),
            machine: None,
            conn_idle: Duration::from_secs(180),
            ws_dead_after: Duration::from_secs(90),
            assistant_nodes: vec!["assistant-phone".into(), "desk".into(), "build-box".into()],
            pairs_anyway: vec!["assistant-phone".into()],
        }
    }
}
