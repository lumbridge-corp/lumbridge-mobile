//! Don't buzz when the owner is already looking at that agent. The rule is happy's (focusTracker.ts, MIT): suppress only on
//! positive, recent proof of an active client, and when uncertain, send. A client that never said anything, or whose
//! word has run out, counts for nothing. This is in the gateway because on iOS a service worker must show every push.
//!
//! The expiry is ours, not the client's to choose, and the map is bounded and in memory: a restart forgets it, which
//! only means a buzz.

use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

/// A client repeats itself every 12 s (web/src/notify.ts), so two reports can be lost before this runs out.
pub const FOCUS_TTL: Duration = Duration::from_secs(30);
const MAX_DEVICES: usize = 16;
const MAX_ADDRESS: usize = 128;

/// `machine/t7`. Only ever compared with what core calls a terminal, but it's a client's text in our memory.
pub fn valid_address(address: &str) -> bool {
    !address.is_empty() && address.len() <= MAX_ADDRESS && !address.chars().any(|c| c.is_control() || c.is_whitespace())
}

#[derive(Default)]
pub struct Focus(Mutex<HashMap<String, (String, Instant)>>);

impl Focus {
    pub fn set(&self, device: &str, address: String, now: Instant) {
        let mut map = self.0.lock().unwrap();
        map.retain(|_, (_, until)| *until > now);
        if map.len() >= MAX_DEVICES && !map.contains_key(device) {
            let soonest = map.iter().min_by_key(|(_, (_, until))| *until).map(|(k, _)| k.clone());
            if let Some(soonest) = soonest {
                map.remove(&soonest);
            }
        }
        map.insert(device.to_string(), (address, now + FOCUS_TTL));
    }

    pub fn clear(&self, device: &str) {
        self.0.lock().unwrap().remove(device);
    }

    pub fn watching(&self, address: &str, now: Instant) -> bool {
        self.0.lock().unwrap().values().any(|(a, until)| a == address && *until > now)
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.0.lock().unwrap().len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nobody_said_anything_so_it_sends() {
        assert!(!Focus::default().watching("t1", Instant::now()));
    }

    #[test]
    fn recent_proof_suppresses_only_that_terminal() {
        let f = Focus::default();
        let now = Instant::now();
        f.set("phone", "gpu/t1".into(), now);
        assert!(f.watching("gpu/t1", now));
        assert!(f.watching("gpu/t1", now + FOCUS_TTL - Duration::from_secs(1)));
        assert!(!f.watching("gpu/t2", now));
        assert!(!f.watching("t1", now), "same number, another machine");
    }

    #[test]
    fn it_runs_out_by_itself() {
        let f = Focus::default();
        let now = Instant::now();
        f.set("phone", "t1".into(), now);
        assert!(!f.watching("t1", now + FOCUS_TTL));
        assert!(!f.watching("t1", now + FOCUS_TTL * 10));
    }

    #[test]
    fn a_new_report_replaces_and_renews_and_a_clear_ends_it() {
        let f = Focus::default();
        let now = Instant::now();
        f.set("phone", "t1".into(), now);
        f.set("phone", "t2".into(), now + Duration::from_secs(20));
        assert!(!f.watching("t1", now + Duration::from_secs(21)));
        assert!(f.watching("t2", now + FOCUS_TTL + Duration::from_secs(10)));
        f.clear("phone");
        assert!(!f.watching("t2", now + Duration::from_secs(21)));
    }

    #[test]
    fn any_device_looking_counts() {
        let f = Focus::default();
        let now = Instant::now();
        f.set("phone", "t1".into(), now);
        f.set("desk", "t2".into(), now);
        assert!(f.watching("t1", now) && f.watching("t2", now));
        f.clear("phone");
        assert!(!f.watching("t1", now) && f.watching("t2", now));
    }

    #[test]
    fn it_stays_small() {
        let f = Focus::default();
        let now = Instant::now();
        for i in 0..200 {
            f.set(&format!("device-{i}"), "t1".into(), now + Duration::from_millis(i));
        }
        assert_eq!(f.len(), MAX_DEVICES);
        // The newest word survives.
        assert!(f.0.lock().unwrap().contains_key("device-199"));
        // Expired ones go as soon as anything is written.
        f.set("late", "t2".into(), now + FOCUS_TTL * 3);
        assert_eq!(f.len(), 1);
    }

    #[test]
    fn addresses_are_checked() {
        assert!(valid_address("gpu/t7") && valid_address("t7"));
        assert!(!valid_address("") && !valid_address("a b") && !valid_address("a\nb") && !valid_address(&"x".repeat(129)));
    }
}
