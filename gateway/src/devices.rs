//! One token per device, in `$LUMBRIDGE_STATE_DIR/devices.json` (0600). Only hashes are stored: both tokens and pairing
//! codes are 256 random bits, so plain sha256 is enough. The CLI and the server share the file: writes take a lock and
//! replace it atomically, and the server notices a new file on its next check, so no restart.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use subtle::ConstantTimeEq;

const PAIR_TTL_SECS: u64 = 10 * 60;
/// How stale `last_seen` may get, so a busy device doesn't rewrite the file on every request.
const SEEN_EVERY_SECS: u64 = 60;

/// Whose device this is. `Owner` is one of the owner's: a phone, a computer. `Agent` is a program working for them (a coding
/// agent, the assistant) that may only read the notes and propose new ones: `auth::agent_may` is the whole list of what it can call.
/// Records from before roles existed have none, and are the owner's.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Role {
    #[default]
    Owner,
    Agent,
}

/// How `Owner` is written in devices.json and the API. An install whose files use another word builds with
/// `LUMBRIDGE_OWNER_ROLE=<word>`, so its devices file reads the same before and after (and a rollback can still read it).
const OWNER: &str = match option_env!("LUMBRIDGE_OWNER_ROLE") {
    Some(word) => word,
    None => "owner",
};

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Owner => OWNER,
            Role::Agent => "agent",
        }
    }
}

impl Serialize for Role {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for Role {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let word = String::deserialize(d)?;
        match word.as_str() {
            "agent" => Ok(Role::Agent),
            w if w == OWNER || w == "owner" => Ok(Role::Owner),
            _ => Err(serde::de::Error::unknown_variant(&word, &["owner", "agent"])),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct DeviceRecord {
    pub name: String,
    pub token_sha256: String,
    pub created: u64,
    pub last_seen: Option<u64>,
    pub revoked: bool,
    #[serde(default)]
    pub role: Role,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
struct Pairing {
    device: String,
    code_sha256: String,
    expires: u64,
    /// What the device becomes when the code is spent.
    #[serde(default)]
    role: Role,
}

#[derive(Serialize, Deserialize, Default, Clone, PartialEq, Debug)]
struct Contents {
    devices: Vec<DeviceRecord>,
    pairings: Vec<Pairing>,
}

#[derive(PartialEq, Clone, Copy)]
struct Stamp(u64, u64, i64, i64, u64);

fn stamp_of(path: &Path) -> Option<Stamp> {
    fs::metadata(path).ok().map(|m| Stamp(m.dev(), m.ino(), m.mtime(), m.mtime_nsec(), m.size()))
}

pub fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn sha256_hex(secret: &str) -> String {
    hex(&Sha256::digest(secret.as_bytes()))
}

fn random_secret() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| format!("random: {e}"))?;
    Ok(hex(&bytes))
}

fn same(a: &str, b: &str) -> bool {
    bool::from(a.as_bytes().ct_eq(b.as_bytes()))
}

pub fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 64 && name.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
}

pub struct Store {
    path: PathBuf,
    lock_path: PathBuf,
    cache: Mutex<Option<(Option<Stamp>, Arc<Contents>)>>,
}

impl Store {
    pub fn new(state_dir: &str) -> Self {
        let dir = Path::new(state_dir);
        Self { path: dir.join("devices.json"), lock_path: dir.join("devices.lock"), cache: Mutex::new(None) }
    }

    fn read(&self) -> Result<Contents, String> {
        match fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("devices.json: {e}")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Contents::default()),
            Err(e) => Err(format!("devices.json: {e}")),
        }
    }

    /// The current contents, reloaded when the file changed. An unreadable file means no devices: fail closed.
    fn snapshot(&self) -> Arc<Contents> {
        let stamp = stamp_of(&self.path);
        let mut cache = self.cache.lock().unwrap();
        if let Some((seen, contents)) = cache.as_ref() {
            if *seen == stamp {
                return contents.clone();
            }
        }
        let contents = Arc::new(self.read().unwrap_or_else(|e| {
            eprintln!("refusing all devices: {e}");
            Contents::default()
        }));
        *cache = Some((stamp, contents.clone()));
        contents
    }

    /// Read-modify-write under the lock. The closure's `Err` leaves the file alone, and so does a corrupt file.
    fn update<R>(&self, change: impl FnOnce(&mut Contents) -> Result<R, String>) -> Result<R, String> {
        let dir = self.path.parent().ok_or("no state dir")?;
        fs::create_dir_all(dir).map_err(|e| format!("state dir: {e}"))?;
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .mode(0o600)
            .open(&self.lock_path)
            .map_err(|e| format!("lock: {e}"))?;
        lock.lock().map_err(|e| format!("lock: {e}"))?;
        let mut contents = self.read()?;
        let result = change(&mut contents)?;
        self.write(&contents)?;
        Ok(result)
    }

    fn write(&self, contents: &Contents) -> Result<(), String> {
        let tmp = self.path.with_extension("json.tmp");
        let _ = fs::remove_file(&tmp);
        let mut file: File = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&tmp)
            .map_err(|e| format!("write: {e}"))?;
        let bytes = serde_json::to_vec_pretty(contents).map_err(|e| e.to_string())?;
        file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(|e| format!("write: {e}"))?;
        // create_new with a mode is subject to umask only in the safe direction, but be exact.
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600)).map_err(|e| format!("chmod: {e}"))?;
        fs::rename(&tmp, &self.path).map_err(|e| format!("rename: {e}"))
    }

    /// The device this token belongs to, if it's live. Looks at every device so timing says nothing about which.
    pub fn check(&self, token: &str) -> Option<String> {
        self.check_at(token, now()).map(|(name, _)| name)
    }

    /// `check`, with the device's role.
    pub fn check_device(&self, token: &str) -> Option<(String, Role)> {
        self.check_at(token, now())
    }

    fn check_at(&self, token: &str, at: u64) -> Option<(String, Role)> {
        let hash = sha256_hex(token);
        let contents = self.snapshot();
        let mut found: Option<&DeviceRecord> = None;
        for device in &contents.devices {
            if same(&device.token_sha256, &hash) && !device.revoked {
                found = Some(device);
            }
        }
        let device = found?;
        if device.last_seen.is_none_or(|t| at.saturating_sub(t) >= SEEN_EVERY_SECS) {
            let name = device.name.clone();
            let touched = self.update(|c| {
                if let Some(d) = c.devices.iter_mut().find(|d| d.name == name) {
                    d.last_seen = Some(at);
                }
                Ok(())
            });
            if let Err(e) = touched {
                eprintln!("last_seen: {e}");
            }
        }
        Some((device.name.clone(), device.role))
    }

    /// A one-time code for this device name. It replaces any earlier code for the same name.
    pub fn begin_pair(&self, name: &str) -> Result<String, String> {
        self.begin_pair_as(name, Role::Owner)
    }

    /// `begin_pair` for a device that gets this role: `lumbridge-mobile-server pair <name> --agent`.
    pub fn begin_pair_as(&self, name: &str, role: Role) -> Result<String, String> {
        self.begin_pair_at(name, role, now())
    }

    fn begin_pair_at(&self, name: &str, role: Role, at: u64) -> Result<String, String> {
        if !valid_name(name) {
            return Err("device names are letters, digits, . _ - (64 at most)".into());
        }
        let code = random_secret()?;
        let hash = sha256_hex(&code);
        self.update(|c| {
            c.pairings.retain(|p| p.expires > at && p.device != name);
            c.pairings.push(Pairing { device: name.into(), code_sha256: hash, expires: at + PAIR_TTL_SECS, role });
            Ok(())
        })?;
        Ok(code)
    }

    /// Spends a code, whatever happens next, and returns the device's name and long-lived token. Pairing a name that
    /// already exists replaces its token, so the old one stops working.
    pub fn redeem(&self, code: &str) -> Result<(String, String), String> {
        self.redeem_at(code, now())
    }

    fn redeem_at(&self, code: &str, at: u64) -> Result<(String, String), String> {
        let hash = sha256_hex(code);
        let token = random_secret()?;
        let token_hash = sha256_hex(&token);
        self.update(|c| {
            let mut found = None;
            for (i, p) in c.pairings.iter().enumerate() {
                if same(&p.code_sha256, &hash) {
                    found = Some(i);
                }
            }
            let spent = found.map(|i| c.pairings.remove(i));
            let spent = spent.filter(|p| p.expires > at);
            c.pairings.retain(|p| p.expires > at);
            let Some(pairing) = spent else {
                return Ok(None);
            };
            let record = DeviceRecord {
                name: pairing.device.clone(),
                token_sha256: token_hash,
                created: at,
                last_seen: None,
                revoked: false,
                role: pairing.role,
            };
            match c.devices.iter_mut().find(|d| d.name == pairing.device) {
                Some(existing) => *existing = record,
                None => c.devices.push(record),
            }
            Ok(Some(pairing.device))
        })?
        .map(|name| (name, token))
        .ok_or_else(|| "bad code".to_string())
    }

    /// Revokes a device and any code still waiting for it. False if no such device or code exists.
    pub fn revoke(&self, name: &str) -> Result<bool, String> {
        self.update(|c| {
            let before = c.pairings.len();
            c.pairings.retain(|p| p.device != name);
            let mut hit = c.pairings.len() != before;
            if let Some(d) = c.devices.iter_mut().find(|d| d.name == name) {
                d.revoked = true;
                hit = true;
            }
            Ok(hit)
        })
    }

    pub fn list(&self) -> Result<Vec<DeviceRecord>, String> {
        Ok(self.read()?.devices)
    }

    /// scripts/dev.sh only: a known token, so a scratch gateway stays scriptable.
    #[cfg(any(test, feature = "dev-identity"))]
    pub fn add_token(&self, name: &str, token: &str, role: Role) -> Result<(), String> {
        let record = DeviceRecord {
            name: name.into(),
            token_sha256: sha256_hex(token),
            created: now(),
            last_seen: None,
            revoked: false,
            role,
        };
        self.update(|c| {
            c.devices.retain(|d| d.name != name);
            c.devices.push(record);
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static N: AtomicU32 = AtomicU32::new(0);

    struct Scratch(PathBuf);
    impl Scratch {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!("lumbridge-devices-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
            fs::create_dir_all(&p).unwrap();
            Scratch(p)
        }
        fn store(&self) -> Store {
            Store::new(self.0.to_str().unwrap())
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn paired(store: &Store, name: &str) -> String {
        let code = store.begin_pair(name).unwrap();
        store.redeem(&code).unwrap().1
    }

    #[test]
    fn nothing_secret_is_stored_and_the_file_is_private() {
        let s = Scratch::new();
        let store = s.store();
        let code = store.begin_pair("pixel").unwrap();
        let raw = fs::read_to_string(s.0.join("devices.json")).unwrap();
        assert!(!raw.contains(&code));
        assert!(raw.contains(&sha256_hex(&code)));
        let (name, token) = store.redeem(&code).unwrap();
        assert_eq!(name, "pixel");
        let raw = fs::read_to_string(s.0.join("devices.json")).unwrap();
        assert!(!raw.contains(&token));
        assert!(raw.contains(&sha256_hex(&token)));
        assert_eq!(fs::metadata(s.0.join("devices.json")).unwrap().mode() & 0o777, 0o600);
        assert_eq!(token.len(), 64);
    }

    #[test]
    fn a_token_checks_out_and_nothing_else_does() {
        let s = Scratch::new();
        let store = s.store();
        let a = paired(&store, "a");
        let b = paired(&store, "b");
        assert_eq!(store.check(&a).as_deref(), Some("a"));
        assert_eq!(store.check(&b).as_deref(), Some("b"));
        assert!(store.check("").is_none());
        assert!(store.check(&"0".repeat(64)).is_none());
        assert!(store.check(&sha256_hex(&a)).is_none(), "the stored hash isn't a credential");
    }

    #[test]
    fn a_code_works_once() {
        let s = Scratch::new();
        let store = s.store();
        let code = store.begin_pair("a").unwrap();
        assert!(store.redeem(&code).is_ok());
        assert!(store.redeem(&code).is_err());
        assert!(store.redeem("nope").is_err());
    }

    #[test]
    fn a_code_expires_after_ten_minutes_and_is_spent_by_trying() {
        let s = Scratch::new();
        let store = s.store();
        let code = store.begin_pair_at("a", Role::Owner, 1000).unwrap();
        assert!(store.redeem_at(&code, 1000 + PAIR_TTL_SECS).is_err());
        assert!(store.redeem_at(&code, 1000).is_err(), "gone even if the clock goes back");
        let code = store.begin_pair_at("a", Role::Owner, 1000).unwrap();
        assert!(store.redeem_at(&code, 1000 + PAIR_TTL_SECS - 1).is_ok());
    }

    #[test]
    fn a_new_code_replaces_the_old_one() {
        let s = Scratch::new();
        let store = s.store();
        let old = store.begin_pair("a").unwrap();
        let new = store.begin_pair("a").unwrap();
        assert!(store.redeem(&old).is_err());
        assert!(store.redeem(&new).is_ok());
    }

    #[test]
    fn revoke_takes_effect_on_a_server_with_a_cached_copy() {
        let s = Scratch::new();
        let server = s.store();
        let cli = s.store();
        let token = paired(&cli, "a");
        assert!(server.check(&token).is_some());
        assert!(cli.revoke("a").unwrap());
        assert!(server.check(&token).is_none());
        assert!(cli.list().unwrap()[0].revoked);
        assert!(!cli.revoke("never-existed").unwrap());
    }

    #[test]
    fn revoke_cancels_a_waiting_code() {
        let s = Scratch::new();
        let store = s.store();
        let code = store.begin_pair("a").unwrap();
        assert!(store.revoke("a").unwrap());
        assert!(store.redeem(&code).is_err());
    }

    #[test]
    fn repairing_replaces_the_token_and_unrevokes() {
        let s = Scratch::new();
        let store = s.store();
        let old = paired(&store, "a");
        store.revoke("a").unwrap();
        let new = paired(&store, "a");
        assert!(store.check(&old).is_none());
        assert!(store.check(&new).is_some());
        assert_eq!(store.list().unwrap().len(), 1);
    }

    #[test]
    fn last_seen_is_recorded_but_not_on_every_request() {
        let s = Scratch::new();
        let store = s.store();
        let token = paired(&store, "a");
        store.check_at(&token, 5000).unwrap();
        assert_eq!(store.list().unwrap()[0].last_seen, Some(5000));
        store.check_at(&token, 5000 + SEEN_EVERY_SECS - 1).unwrap();
        assert_eq!(store.list().unwrap()[0].last_seen, Some(5000));
        store.check_at(&token, 5000 + SEEN_EVERY_SECS).unwrap();
        assert_eq!(store.list().unwrap()[0].last_seen, Some(5000 + SEEN_EVERY_SECS));
    }

    #[test]
    fn a_corrupt_file_admits_nobody_and_isnt_overwritten() {
        let s = Scratch::new();
        let store = s.store();
        let token = paired(&store, "a");
        fs::write(s.0.join("devices.json"), "{broken").unwrap();
        assert!(store.check(&token).is_none());
        assert!(store.begin_pair("b").is_err());
        assert_eq!(fs::read_to_string(s.0.join("devices.json")).unwrap(), "{broken");
    }

    #[test]
    fn a_file_from_before_roles_loads_and_its_devices_are_his() {
        let s = Scratch::new();
        let token = "0".repeat(63) + "1";
        let old = format!(
            r#"{{"devices": [{{"name": "iphone", "token_sha256": "{}", "created": 1, "last_seen": null, "revoked": false}}],
                "pairings": [{{"device": "air", "code_sha256": "{}", "expires": {}}}]}}"#,
            sha256_hex(&token),
            sha256_hex("code"),
            now() + 60
        );
        fs::write(s.0.join("devices.json"), old).unwrap();
        let store = s.store();
        assert_eq!(store.check_device(&token), Some(("iphone".into(), Role::Owner)));
        assert_eq!(store.list().unwrap()[0].role, Role::Owner);
        let (name, air) = store.redeem("code").unwrap();
        assert_eq!(name, "air");
        assert_eq!(store.check_device(&air), Some(("air".into(), Role::Owner)), "a code from before roles makes one of the owner's");
        // Written back with the role spelled out.
        assert!(fs::read_to_string(s.0.join("devices.json")).unwrap().contains(r#""role": "owner""#));
    }

    #[test]
    fn an_agent_code_makes_an_agent_and_repairing_without_it_makes_his() {
        let s = Scratch::new();
        let store = s.store();
        let code = store.begin_pair_as("claude-build", Role::Agent).unwrap();
        let (_, token) = store.redeem(&code).unwrap();
        assert_eq!(store.check_device(&token), Some(("claude-build".into(), Role::Agent)));
        assert_eq!(store.list().unwrap()[0].role, Role::Agent);
        assert!(fs::read_to_string(s.0.join("devices.json")).unwrap().contains(r#""role": "agent""#));
        let again = paired(&store, "claude-build");
        assert_eq!(store.check_device(&again).unwrap().1, Role::Owner);
    }

    #[test]
    fn bad_names_are_refused() {
        let s = Scratch::new();
        for bad in ["", "a b", "../x", "a/b", &"x".repeat(65)] {
            assert!(s.store().begin_pair(bad).is_err(), "{bad}");
        }
        assert!(s.store().begin_pair("pixel-6.home_1").is_ok());
    }

    #[test]
    fn concurrent_writers_lose_nothing() {
        let s = Scratch::new();
        let dir = s.0.to_str().unwrap().to_string();
        let handles: Vec<_> = (0..8)
            .map(|i| {
                let dir = dir.clone();
                std::thread::spawn(move || {
                    let store = Store::new(&dir);
                    let code = store.begin_pair(&format!("d{i}")).unwrap();
                    store.redeem(&code).unwrap();
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        assert_eq!(s.store().list().unwrap().len(), 8);
    }
}
