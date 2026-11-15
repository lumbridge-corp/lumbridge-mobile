//! Gateway-owned push state on disk: the VAPID key and push.json, both 0600, written atomically.

use super::rules::Prefs;
use base64ct::{Base64UrlUnpadded, Encoding};
use serde::{Deserialize, Serialize};
use std::{
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::Mutex,
};
use web_push_native::jwt_simple::algorithms::{ECDSAP256PublicKeyLike, ES256KeyPair};

const MAX_DEVICES: usize = 10;
/// A subscription that keeps failing without saying it's gone is dropped after this many failures in a row.
const MAX_FAILURES: u32 = 20;
/// Endpoints remembered as dead. A browser can't tell its subscription died, so it keeps reporting it.
const MAX_DEAD: usize = 50;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sub {
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
    /// "iPhone · Safari": which device, for a person.
    pub label: String,
    /// The paired device it belongs to, when `auth::Device` can name one.
    #[serde(default)]
    pub device: Option<String>,
    pub created_ms: u64,
    #[serde(default)]
    pub failures: u32,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
struct Data {
    subscriptions: Vec<Sub>,
    prefs: Prefs,
    dead: Vec<String>,
}

pub struct Store {
    path: PathBuf,
    data: Mutex<Data>,
}

fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp)?;
    f.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    f.write_all(bytes)?;
    f.sync_all()?;
    std::fs::rename(&tmp, path)
}

impl Store {
    /// A broken file is set aside rather than taking the gateway down: subscriptions come back
    /// the next time each device opens the app.
    pub fn open(dir: &Path) -> Self {
        let path = dir.join("push.json");
        let data = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|e| {
                eprintln!("push: push.json is broken ({e}); moved to push.json.bad");
                let _ = std::fs::rename(&path, path.with_extension("json.bad"));
                Data::default()
            }),
            Err(_) => Data::default(),
        };
        if path.exists() {
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
        Self { path, data: Mutex::new(data) }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Data> {
        self.data.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn save(&self, d: &Data) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(d).map_err(|e| e.to_string())?;
        write_private(&self.path, &bytes).map_err(|e| {
            eprintln!("push: can't write push.json: {e}");
            e.to_string()
        })
    }

    /// The same browser subscribing again replaces its record. Keeps the newest few.
    pub fn add(&self, sub: Sub) -> Result<(), String> {
        let mut d = self.lock();
        d.subscriptions.retain(|s| s.endpoint != sub.endpoint);
        d.subscriptions.push(sub);
        let extra = d.subscriptions.len().saturating_sub(MAX_DEVICES);
        d.subscriptions.drain(..extra);
        self.save(&d)
    }

    pub fn remove(&self, endpoint: &str) -> Result<bool, String> {
        let mut d = self.lock();
        let before = d.subscriptions.len();
        d.subscriptions.retain(|s| s.endpoint != endpoint);
        let changed = d.subscriptions.len() != before;
        if changed {
            self.save(&d)?;
        }
        Ok(changed)
    }

    /// The push service says this endpoint is over: forget it, and refuse it if a browser reports it again.
    pub fn bury(&self, endpoint: &str) {
        let mut d = self.lock();
        d.subscriptions.retain(|s| s.endpoint != endpoint);
        if !d.dead.iter().any(|e| e == endpoint) {
            d.dead.push(endpoint.to_string());
            let extra = d.dead.len().saturating_sub(MAX_DEAD);
            d.dead.drain(..extra);
        }
        let _ = self.save(&d);
    }

    pub fn is_dead(&self, endpoint: &str) -> bool {
        self.lock().dead.iter().any(|e| e == endpoint)
    }

    pub fn list(&self) -> Vec<Sub> {
        self.lock().subscriptions.clone()
    }

    pub fn delivered(&self, endpoint: &str) {
        let mut d = self.lock();
        if let Some(s) = d.subscriptions.iter_mut().find(|s| s.endpoint == endpoint && s.failures > 0) {
            s.failures = 0;
            let _ = self.save(&d);
        }
    }

    /// Returns whether the subscription was dropped.
    pub fn failed(&self, endpoint: &str) -> bool {
        let mut d = self.lock();
        let Some(s) = d.subscriptions.iter_mut().find(|s| s.endpoint == endpoint) else { return false };
        s.failures += 1;
        let drop = s.failures >= MAX_FAILURES;
        if drop {
            d.subscriptions.retain(|s| s.endpoint != endpoint);
        }
        let _ = self.save(&d);
        drop
    }

    pub fn prefs(&self) -> Prefs {
        self.lock().prefs.clone()
    }

    pub fn set_prefs(&self, prefs: Prefs) -> Result<(), String> {
        let mut d = self.lock();
        d.prefs = prefs;
        self.save(&d)
    }
}

/// The VAPID key, created once. Subscriptions are bound to it for life, so a key we can't read is an
/// error that turns push off; replacing it would silently orphan every device.
pub fn load_or_create_vapid(dir: &Path) -> Result<ES256KeyPair, String> {
    let path = dir.join("vapid.key");
    match std::fs::read_to_string(&path) {
        Ok(text) => {
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
            let bytes = Base64UrlUnpadded::decode_vec(text.trim()).map_err(|_| "vapid.key isn't base64url")?;
            ES256KeyPair::from_bytes(&bytes).map_err(|_| "vapid.key isn't a P-256 key".to_string())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let key = ES256KeyPair::generate();
            write_private(&path, Base64UrlUnpadded::encode_string(&key.to_bytes()).as_bytes()).map_err(|e| e.to_string())?;
            Ok(key)
        }
        Err(e) => Err(format!("can't read vapid.key: {e}")),
    }
}

/// The base64url key the browser subscribes with (uncompressed point).
pub fn public_key(key: &ES256KeyPair) -> String {
    let point = key.public_key().public_key().to_bytes_uncompressed();
    Base64UrlUnpadded::encode_string(&point)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sub(n: usize) -> Sub {
        Sub {
            endpoint: format!("https://web.push.apple.com/{n}"),
            p256dh: "p".into(),
            auth: "a".into(),
            label: "iPhone · Safari".into(),
            device: None,
            created_ms: n as u64,
            failures: 0,
        }
    }
    fn mode(p: &Path) -> u32 {
        std::fs::metadata(p).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn survives_a_restart_private_and_replaces_by_endpoint() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open(dir.path());
        s.add(sub(1)).unwrap();
        s.add(Sub { label: "newer".into(), ..sub(1) }).unwrap();
        s.add(sub(2)).unwrap();
        let p = Prefs { finished: false, ..Prefs::default() };
        s.set_prefs(p.clone()).unwrap();
        assert_eq!(mode(&dir.path().join("push.json")), 0o600);
        let again = Store::open(dir.path());
        assert_eq!(again.list().len(), 2);
        assert_eq!(again.list()[0].endpoint, sub(1).endpoint);
        assert!(again.list().iter().any(|s| s.label == "newer"));
        assert_eq!(again.prefs(), p);
    }

    #[test]
    fn removes_and_keeps_only_the_newest() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open(dir.path());
        for n in 0..(MAX_DEVICES + 3) {
            s.add(sub(n)).unwrap();
        }
        assert_eq!(s.list().len(), MAX_DEVICES);
        assert_eq!(s.list()[0].endpoint, sub(3).endpoint);
        assert!(s.remove(&sub(3).endpoint).unwrap());
        assert!(!s.remove(&sub(3).endpoint).unwrap());
        assert_eq!(s.list().len(), MAX_DEVICES - 1);
    }

    #[test]
    fn repeated_failures_prune_and_success_resets() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open(dir.path());
        s.add(sub(1)).unwrap();
        for _ in 0..(MAX_FAILURES - 1) {
            assert!(!s.failed(&sub(1).endpoint));
        }
        s.delivered(&sub(1).endpoint);
        assert_eq!(s.list()[0].failures, 0);
        for _ in 0..(MAX_FAILURES - 1) {
            s.failed(&sub(1).endpoint);
        }
        assert!(s.failed(&sub(1).endpoint));
        assert!(s.list().is_empty());
    }

    #[test]
    fn a_buried_endpoint_stays_dead_across_restarts() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open(dir.path());
        s.add(sub(1)).unwrap();
        s.bury(&sub(1).endpoint);
        assert!(s.list().is_empty());
        assert!(Store::open(dir.path()).is_dead(&sub(1).endpoint));
        assert!(!s.is_dead(&sub(2).endpoint));
        for n in 10..(10 + MAX_DEAD) {
            s.bury(&sub(n).endpoint);
        }
        assert!(!s.is_dead(&sub(1).endpoint), "the list stays bounded");
    }

    #[test]
    fn a_broken_file_is_set_aside() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("push.json"), "{not json").unwrap();
        let s = Store::open(dir.path());
        assert!(s.list().is_empty());
        assert!(dir.path().join("push.json.bad").exists());
    }

    #[test]
    fn the_vapid_key_is_made_once_and_private() {
        let dir = tempfile::tempdir().unwrap();
        let a = load_or_create_vapid(dir.path()).unwrap();
        let b = load_or_create_vapid(dir.path()).unwrap();
        assert_eq!(public_key(&a), public_key(&b));
        assert_eq!(public_key(&a).len(), 87); // 65 bytes, base64url, no padding
        assert_eq!(mode(&dir.path().join("vapid.key")), 0o600);
    }

    #[test]
    fn a_broken_vapid_key_is_an_error_not_a_new_key() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("vapid.key"), "garbage!").unwrap();
        assert!(load_or_create_vapid(dir.path()).is_err());
        assert_eq!(std::fs::read_to_string(dir.path().join("vapid.key")).unwrap(), "garbage!");
    }
}
