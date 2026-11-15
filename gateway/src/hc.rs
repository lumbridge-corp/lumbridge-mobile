//! Finding core, and starting `lbc connect`.
//!
//! **The gateway never starts a core.** `lbc connect` starts one when nobody is listening (`connect_or_start` in
//! lumbridge-core), and lbc has no read-only command that doesn't. A core started from here at boot would have no DISPLAY
//! or SSH_AUTH_SOCK, and every later desktop terminal would inherit that. So before each `lbc connect` we try core's
//! socket ourselves and, if nothing answers, don't run it. Core belongs to the desktop session.
//!
//! The gap between that check and lbc's own connect is milliseconds, and only matters if core stops inside it. So `command`
//! also gives each child a minimal environment: if that race is ever lost, the core it starts still has no secrets.

use serde::Deserialize;
use std::{
    ffi::{OsStr, OsString},
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::{net::UnixStream, process::Command};

const CHECK_TIMEOUT: Duration = Duration::from_secs(2);

/// What lbc needs to find its core and nothing more. LUMBRIDGE_* (the database URL) never gets past this.
const KEEP_ENV: &[&str] = &[
    "HOME",
    "PATH",
    "USER",
    "LOGNAME",
    "LANG",
    "LBC_SESSION",
    "LBC_SOCKET",
    "XDG_RUNTIME_DIR",
    "XDG_STATE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
];

#[derive(Deserialize)]
struct HcConfig {
    socket: Option<String>,
}

fn present(var: &impl Fn(&str) -> Option<OsString>, name: &str) -> Option<PathBuf> {
    var(name).filter(|v| !v.is_empty()).map(PathBuf::from)
}

fn configured_socket(config: &Path) -> Option<PathBuf> {
    let text = std::fs::read_to_string(config).ok()?;
    toml::from_str::<HcConfig>(&text).ok()?.socket.map(PathBuf::from)
}

/// Where lbc would connect, worked out the way `Paths::from_env` does in lumbridge-core: `LBC_SOCKET`, else `socket` in
/// config.toml, else `lumbridge-core/<session>.sock` under the runtime dir, else beside the state. None for a session name
/// lbc itself would refuse.
fn socket_path(var: impl Fn(&str) -> Option<OsString>, uid_run: Option<PathBuf>) -> Option<PathBuf> {
    let session = var("LBC_SESSION").map(|s| s.to_string_lossy().trim().to_string()).filter(|s| !s.is_empty());
    let session = session.unwrap_or_else(|| "default".into());
    if session == "." || session == ".." || session.chars().any(|c| c.is_control() || r#"/\:*?"<>|"#.contains(c)) {
        return None;
    }
    if let Some(socket) = present(&var, "LBC_SOCKET") {
        return Some(socket);
    }
    let home = PathBuf::from(var("HOME").unwrap_or_else(|| "/".into()));
    let config = present(&var, "XDG_CONFIG_HOME").unwrap_or_else(|| home.join(".config")).join("lumbridge-core/config.toml");
    if let Some(socket) = configured_socket(&config) {
        return Some(socket);
    }
    let state = present(&var, "XDG_STATE_HOME").unwrap_or_else(|| home.join(".local/state")).join("lumbridge-core").join(&session);
    let dir = present(&var, "XDG_RUNTIME_DIR").or(uid_run).map_or(state, |run| run.join("lumbridge-core"));
    Some(dir.join(format!("{session}.sock")))
}

/// `/run/user/<uid>`, when it exists: where hc looks for logins without XDG_RUNTIME_DIR.
fn uid_run_dir() -> Option<PathBuf> {
    let uid = std::fs::metadata("/proc/self").ok()?.uid();
    Some(PathBuf::from(format!("/run/user/{uid}"))).filter(|p| p.is_dir())
}

/// Does a core answer right now? Connecting and hanging up is all this does; core doesn't mind.
pub async fn running() -> bool {
    let Some(socket) = socket_path(|name| std::env::var_os(name), uid_run_dir()) else { return false };
    matches!(tokio::time::timeout(CHECK_TIMEOUT, UnixStream::connect(socket)).await, Ok(Ok(_)))
}

pub fn kept_env() -> Vec<(OsString, OsString)> {
    std::env::vars_os().filter(|(k, _)| KEEP_ENV.iter().any(|keep| OsStr::new(keep) == k)).collect()
}

/// `lbc connect`, for a caller that has just checked `running`. Dies with its handle.
pub fn connect(hc: &str) -> Command {
    let mut command = Command::new(hc);
    command.arg("connect").env_clear().envs(kept_env()).kill_on_drop(true);
    command
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn resolve(vars: &[(&str, &str)], uid_run: Option<&str>) -> Option<PathBuf> {
        let vars: HashMap<String, OsString> = vars.iter().map(|(k, v)| (k.to_string(), OsString::from(v))).collect();
        socket_path(|name| vars.get(name).cloned(), uid_run.map(PathBuf::from))
    }
    fn at(p: &str) -> Option<PathBuf> {
        Some(PathBuf::from(p))
    }

    #[test]
    fn paths_match_hc() {
        let home = ("HOME", "/nonexistent-home");
        assert_eq!(resolve(&[home, ("XDG_RUNTIME_DIR", "/run/user/1002")], None), at("/run/user/1002/lumbridge-core/default.sock"));
        assert_eq!(resolve(&[home, ("XDG_RUNTIME_DIR", "/r"), ("LBC_SESSION", " k ")], None), at("/r/lumbridge-core/k.sock"), "trimmed, as hc does");
        assert_eq!(resolve(&[home, ("XDG_RUNTIME_DIR", "/r"), ("LBC_SESSION", "")], None), at("/r/lumbridge-core/default.sock"));
        assert_eq!(resolve(&[home], Some("/run/user/7")), at("/run/user/7/lumbridge-core/default.sock"), "no XDG_RUNTIME_DIR");
        assert_eq!(resolve(&[home], None), at("/nonexistent-home/.local/state/lumbridge-core/default/default.sock"), "no runtime dir at all");
        assert_eq!(resolve(&[home, ("XDG_STATE_HOME", "/s"), ("LBC_SESSION", "k")], None), at("/s/lumbridge-core/k/k.sock"));
        assert_eq!(resolve(&[home, ("LBC_SOCKET", "/x/y.sock"), ("XDG_RUNTIME_DIR", "/r")], None), at("/x/y.sock"), "LBC_SOCKET wins");
    }

    #[test]
    fn config_socket_comes_before_the_runtime_dir_but_after_hc_socket() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("lumbridge-core")).unwrap();
        std::fs::write(dir.path().join("lumbridge-core/config.toml"), "notes = false\nsocket = \"/cfg/core.sock\"\n").unwrap();
        let cfg = dir.path().to_str().unwrap();
        assert_eq!(resolve(&[("XDG_CONFIG_HOME", cfg), ("XDG_RUNTIME_DIR", "/r")], None), at("/cfg/core.sock"));
        assert_eq!(resolve(&[("XDG_CONFIG_HOME", cfg), ("LBC_SOCKET", "/x.sock")], None), at("/x.sock"));
        // hc ignores a config it can't read here, so we do too.
        std::fs::write(dir.path().join("lumbridge-core/config.toml"), "not toml [").unwrap();
        assert_eq!(resolve(&[("XDG_CONFIG_HOME", cfg), ("XDG_RUNTIME_DIR", "/r")], None), at("/r/lumbridge-core/default.sock"));
    }

    #[test]
    fn a_session_hc_would_refuse_finds_nothing() {
        for bad in ["a/b", "..", "a:b"] {
            assert_eq!(resolve(&[("LBC_SESSION", bad), ("XDG_RUNTIME_DIR", "/r")], None), None, "{bad}");
        }
    }

    #[test]
    fn no_gateway_variable_is_ever_kept() {
        assert!(KEEP_ENV.iter().all(|k| !k.starts_with("LUMBRIDGE_") && !k.contains("DATABASE")));
    }
}
