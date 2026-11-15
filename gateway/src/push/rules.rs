//! When the phone buzzes. Pure: no clock, no I/O, so every rule is table-tested below.
//!
//! The rules, from lumbridge-core's label conventions and its schema:
//! - `status` becoming blocked or error: "needs you".
//! - A `turn` event ending in done or idle: "finished", unless someone already looked (`lumbridge.seen >= turn`).
//!   A missing `lumbridge.seen` means nobody has said they looked, so it fires.
//! - Only news fires. Snapshots, `missed` and `created` replace what we know and never fire, so restarting the
//!   gateway or a machine's line coming back can't flood the phone.
//! - Everything waits `HOLD_MS`, then is checked again, so a blocked-working flap doesn't buzz.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};

/// Long enough to swallow a flap of a couple of seconds, short enough to still feel right away.
pub const HOLD_MS: u64 = 3000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    NeedsYou,
    Finished,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Notice {
    pub kind: Kind,
    pub address: String,
    pub label: String,
    pub machine: String,
    /// blocked, error, or the word the turn ended on.
    pub state: String,
    pub turn: u64,
}

#[derive(Default)]
struct Tracked {
    reported: bool,
    state: Option<String>,
    turn: u64,
    seen: Option<u64>,
    name: String,
    title: String,
    foreground: String,
    needs_at: Option<u64>,
    finish_at: Option<(u64, u64)>,
    fired: HashSet<(u64, String)>,
}

impl Tracked {
    fn replace(&mut self, r: &Value) {
        self.reported = r["reported"].as_bool().unwrap_or(false) || !r["status"].is_null();
        self.state = state_of(&r["status"]);
        self.turn = r["turn"].as_u64().unwrap_or(0);
        self.seen = seen_of(&r["labels"]);
        self.name = text(&r["name"]);
        self.title = text(&r["title"]);
        self.foreground = text(&r["foreground"]["name"]);
    }

    fn stuck(&self) -> bool {
        matches!(self.state.as_deref(), Some("blocked" | "error"))
    }

    /// Fire at most once per terminal, turn and state.
    fn first_time(&mut self, state: &str) -> bool {
        let turn = self.turn;
        self.fired.retain(|(t, _)| *t >= turn);
        self.fired.insert((turn, state.to_string()))
    }
}

fn text(v: &Value) -> String {
    v.as_str().unwrap_or("").to_string()
}

fn state_of(status: &Value) -> Option<String> {
    status["state"].as_str().map(String::from)
}

fn seen_of(labels: &Value) -> Option<u64> {
    labels["lumbridge.seen"].as_str().and_then(|s| s.parse().ok())
}

#[derive(Default)]
pub struct Engine {
    terms: BTreeMap<String, Tracked>,
    seq: u64,
    local: String,
}

impl Engine {
    /// What to call terminals with no machine in their address.
    pub fn set_local(&mut self, name: &str) {
        self.local = name.to_string();
    }

    /// A snapshot: the truth now, not news. What's pending and what already fired survive, so a
    /// reconnect neither repeats a notification nor loses one that was about to go.
    pub fn resync(&mut self, seq: u64, terminals: &[Value]) {
        self.seq = seq;
        let keep: HashSet<&str> = terminals.iter().filter_map(|t| t["address"].as_str()).collect();
        self.terms.retain(|a, _| keep.contains(a.as_str()));
        for r in terminals {
            if let Some(a) = r["address"].as_str() {
                self.terms.entry(a.to_string()).or_default().replace(r);
            }
        }
    }

    /// One line from the event channel.
    pub fn line(&mut self, now: u64, msg: &Value) {
        let p = &msg["params"];
        match msg["method"].as_str() {
            Some("missed") => {
                let none = Vec::new();
                self.resync(p["seq"].as_u64().unwrap_or(self.seq), p["terminals"].as_array().unwrap_or(&none));
            }
            Some("event") => {
                let seq = p["seq"].as_u64().unwrap_or(0);
                if seq <= self.seq {
                    return;
                }
                self.seq = seq;
                if let (Some(kind), Some(address)) = (p["type"].as_str(), p["terminal"].as_str()) {
                    self.event(now, kind, address, &p["data"]);
                }
            }
            _ => {}
        }
    }

    fn event(&mut self, now: u64, kind: &str, address: &str, data: &Value) {
        match kind {
            // Also what a machine's line re-delivers on reconnect, so it's a fact, never news.
            "created" => self.terms.entry(address.to_string()).or_default().replace(data),
            "removed" => {
                self.terms.remove(address);
            }
            _ => {
                let Some(t) = self.terms.get_mut(address) else { return };
                match kind {
                    "restarted" => {
                        t.replace(data);
                        t.needs_at = None;
                        t.finish_at = None;
                    }
                    "status" => {
                        let was = t.state.take();
                        t.state = state_of(&data["status"]);
                        t.reported = t.reported || data["reported"].as_bool().unwrap_or(false);
                        if !t.reported {
                            return;
                        }
                        if t.stuck() {
                            t.finish_at = None;
                            if t.state != was {
                                t.needs_at.get_or_insert(now + HOLD_MS);
                            }
                        } else {
                            t.needs_at = None;
                            if t.state.as_deref() == Some("working") {
                                t.finish_at = None;
                            }
                        }
                    }
                    "turn" => {
                        let Some(turn) = data["turn"].as_u64() else { return };
                        if turn <= t.turn {
                            return;
                        }
                        t.turn = turn;
                        if t.reported && matches!(data["state"].as_str(), Some("done" | "idle")) {
                            t.finish_at = Some((now + HOLD_MS, turn));
                        }
                    }
                    "finished" => t.state = None,
                    "labels" => t.seen = seen_of(&data["labels"]),
                    "title" => t.title = text(&data["title"]),
                    "foreground" => t.foreground = text(&data["name"]),
                    _ => {}
                }
            }
        }
    }

    /// How many are waiting on the owner right now, for the number on the app icon. `needsCount` in web/src/app.ts.
    pub fn stuck(&self) -> usize {
        self.terms.values().filter(|t| t.stuck()).count()
    }

    /// When the next held notification comes due.
    pub fn next_due(&self) -> Option<u64> {
        self.terms.values().flat_map(|t| t.needs_at.into_iter().chain(t.finish_at.map(|f| f.0))).min()
    }

    /// Everything whose hold is over and which is still true.
    pub fn due(&mut self, now: u64) -> Vec<Notice> {
        let mut out = Vec::new();
        for (address, t) in &mut self.terms {
            if t.needs_at.is_some_and(|at| at <= now) {
                t.needs_at = None;
                if t.stuck() {
                    let state = t.state.clone().unwrap_or_default();
                    if t.first_time(&state) {
                        out.push(notice(Kind::NeedsYou, address, t, state, t.turn, &self.local));
                    }
                }
            }
            if let Some((_, turn)) = t.finish_at.filter(|(at, _)| *at <= now) {
                t.finish_at = None;
                let looked = t.seen.is_some_and(|seen| seen >= turn);
                let moved_on = t.stuck() || t.state.as_deref() == Some("working");
                if !looked && !moved_on && t.first_time("finished") {
                    out.push(notice(Kind::Finished, address, t, "finished".into(), turn, &self.local));
                }
            }
        }
        out
    }
}

fn notice(kind: Kind, address: &str, t: &Tracked, state: String, turn: u64, local: &str) -> Notice {
    Notice {
        kind,
        address: address.to_string(),
        label: label_of(address, t),
        machine: address.split_once('/').map_or(local, |(m, _)| m).to_string(),
        state,
        turn,
    }
}

/// `labelOf` in web/src/app.ts, made fit for a lock screen.
fn label_of(address: &str, t: &Tracked) -> String {
    let slug = |s: &str| {
        let s = s.replace(['-', '_'], " ");
        let mut c = s.chars();
        c.next().map_or(String::new(), |f| f.to_uppercase().chain(c).collect())
    };
    let cleaned = clean(&t.name);
    if !cleaned.is_empty() {
        return slug(&cleaned);
    }
    let cleaned = clean(&t.title);
    if !cleaned.is_empty() {
        return cleaned;
    }
    let cleaned = clean(&t.foreground);
    if !cleaned.is_empty() {
        return slug(&cleaned);
    }
    format!("Agent {}", address.rsplit('/').next().unwrap_or(address))
}

/// Titles come from programs: no control characters, no spinner glyphs in front, and short.
fn clean(s: &str) -> String {
    let s: String = s.chars().filter(|c| !c.is_control()).collect();
    let s = s.trim_start_matches(|c: char| !c.is_alphanumeric()).trim();
    let mut out: String = s.chars().take(60).collect();
    if s.chars().count() > 60 {
        out = format!("{}…", out.trim_end());
    }
    out
}

/// Shown on a lock screen: name, machine, state. Never anything from the terminal's contents.
pub fn words(n: &Notice) -> (String, String) {
    match n.kind {
        Kind::NeedsYou => {
            let why = if n.state == "error" { "hit an error" } else { "waiting for you" };
            (format!("{} needs you", n.label), format!("{} · {why}", n.machine))
        }
        Kind::Finished => (format!("{} finished", n.label), n.machine.clone()),
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Prefs {
    pub needs_you: bool,
    pub finished: bool,
    pub quiet: Quiet,
}

/// Times are HH:MM on the gateway's clock.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Quiet {
    pub enabled: bool,
    pub start: String,
    pub end: String,
}

impl Default for Prefs {
    fn default() -> Self {
        Self { needs_you: true, finished: true, quiet: Quiet::default() }
    }
}

impl Default for Quiet {
    fn default() -> Self {
        Self { enabled: false, start: "22:00".into(), end: "07:00".into() }
    }
}

fn minutes(s: &str) -> Option<u32> {
    let (h, m) = s.split_once(':')?;
    if h.len() != 2 || m.len() != 2 {
        return None;
    }
    let (h, m): (u32, u32) = (h.parse().ok()?, m.parse().ok()?);
    (h < 24 && m < 60).then_some(h * 60 + m)
}

impl Prefs {
    pub fn valid(&self) -> bool {
        minutes(&self.quiet.start).is_some() && minutes(&self.quiet.end).is_some()
    }

    /// `minute` is minutes since midnight, now.
    pub fn allows(&self, kind: Kind, minute: u32) -> bool {
        let wanted = match kind {
            Kind::NeedsYou => self.needs_you,
            Kind::Finished => self.finished,
        };
        wanted && !self.is_quiet(minute)
    }

    fn is_quiet(&self, minute: u32) -> bool {
        if !self.quiet.enabled {
            return false;
        }
        let (Some(start), Some(end)) = (minutes(&self.quiet.start), minutes(&self.quiet.end)) else {
            return false;
        };
        if start <= end {
            (start..end).contains(&minute)
        } else {
            minute >= start || minute < end
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn agent(address: &str, state: Option<&str>, turn: u64) -> Value {
        json!({"address": address, "name": "acme-deploy", "reported": state.is_some(), "turn": turn, "labels": {},
               "status": state.map(|s| json!({"state": s}))})
    }
    fn shell(address: &str) -> Value {
        json!({"address": address, "name": "bash", "reported": false, "turn": 0, "labels": {}, "status": null})
    }

    /// A little script: what happens at which millisecond.
    enum S {
        Status(u64, &'static str, Option<&'static str>),
        Turn(u64, &'static str, u64, Option<&'static str>),
        Seen(u64, &'static str, u64),
        Created(u64, Value),
        Removed(u64, &'static str),
        Missed(u64, Vec<Value>),
        Raw(u64, Value),
    }
    use S::*;

    /// Plays a script after `snapshot`, returning every notice as (ms, kind, address, turn).
    fn play(snapshot: Vec<Value>, script: Vec<S>) -> Vec<(u64, Kind, String, u64)> {
        let mut e = Engine::default();
        e.set_local("desk");
        e.resync(10, &snapshot);
        let mut seq = 10;
        let mut out = Vec::new();
        let mut clock = 0;
        let mut advance = |e: &mut Engine, to: u64| {
            while clock <= to {
                for n in e.due(clock) {
                    out.push((clock, n.kind, n.address, n.turn));
                }
                clock += 100;
            }
        };
        let mut last = 0;
        for s in script {
            seq += 1;
            let ev = |at: u64, kind: &str, terminal: &str, data: Value| {
                (at, json!({"method": "event", "params": {"seq": seq, "type": kind, "terminal": terminal, "data": data}}))
            };
            let (at, msg) = match s {
                Status(at, t, state) => {
                    ev(at, "status", t, json!({"status": state.map(|s| json!({"state": s})), "records": {}, "reported": true}))
                }
                Turn(at, t, turn, state) => ev(at, "turn", t, json!({"turn": turn, "state": state})),
                Seen(at, t, seen) => ev(at, "labels", t, json!({"labels": {"lumbridge.seen": seen.to_string()}})),
                Created(at, r) => {
                    let a = r["address"].as_str().unwrap().to_string();
                    ev(at, "created", &a, r)
                }
                Removed(at, t) => ev(at, "removed", t, json!({})),
                Missed(at, terminals) => (at, json!({"method": "missed", "params": {"seq": seq, "terminals": terminals}})),
                Raw(at, msg) => (at, msg),
            };
            advance(&mut e, at);
            e.line(at, &msg);
            last = at;
        }
        advance(&mut e, last + 10_000);
        out
    }

    fn kinds(n: &[(u64, Kind, String, u64)]) -> Vec<(Kind, &str, u64)> {
        n.iter().map(|(_, k, a, t)| (*k, a.as_str(), *t)).collect()
    }

    #[test]
    fn rules_table() {
        use Kind::*;
        let idle = || vec![agent("t1", Some("idle"), 0)];
        type Case = (&'static str, Vec<Value>, Vec<S>, Vec<(Kind, &'static str, u64)>);
        let cases: Vec<Case> = vec![
            ("a snapshot alone never fires, even blocked", vec![agent("t1", Some("blocked"), 3), agent("t2", Some("done"), 9)], vec![], vec![]),
            ("becoming blocked fires", idle(), vec![Status(0, "t1", Some("blocked"))], vec![(NeedsYou, "t1", 0)]),
            ("becoming error fires", idle(), vec![Status(0, "t1", Some("error"))], vec![(NeedsYou, "t1", 0)]),
            ("blocked out of working fires with the new turn", vec![agent("t1", Some("working"), 4)],
             vec![Status(0, "t1", Some("blocked")), Turn(0, "t1", 5, Some("blocked"))], vec![(NeedsYou, "t1", 5)]),
            ("a blocked to working flap doesn't buzz", idle(),
             vec![Status(0, "t1", Some("blocked")), Status(2000, "t1", Some("working"))], vec![]),
            ("still blocked after a flap fires once", vec![agent("t1", Some("working"), 1)],
             vec![Status(0, "t1", Some("blocked")), Turn(0, "t1", 2, Some("blocked")), Status(1000, "t1", Some("working")),
                  Status(1500, "t1", Some("blocked")), Turn(1500, "t1", 3, Some("blocked"))], vec![(NeedsYou, "t1", 3)]),
            ("a repeated blocked report isn't news", vec![agent("t1", Some("blocked"), 1)],
             vec![Status(0, "t1", Some("blocked")), Status(5000, "t1", Some("blocked"))], vec![]),
            ("blocked again in a new turn fires again", vec![agent("t1", Some("working"), 1)],
             vec![Status(0, "t1", Some("blocked")), Turn(0, "t1", 2, Some("blocked")), Status(5000, "t1", Some("working")),
                  Status(9000, "t1", Some("blocked")), Turn(9000, "t1", 3, Some("blocked"))],
             vec![(NeedsYou, "t1", 2), (NeedsYou, "t1", 3)]),
            ("blocked, idle, blocked in one turn fires once", idle(),
             vec![Status(0, "t1", Some("blocked")), Status(5000, "t1", Some("idle")), Status(9000, "t1", Some("blocked"))],
             vec![(NeedsYou, "t1", 0)]),
            ("turn ending done fires finished", vec![agent("t1", Some("working"), 1)],
             vec![Status(0, "t1", Some("done")), Turn(0, "t1", 2, Some("done"))], vec![(Finished, "t1", 2)]),
            ("turn ending idle fires finished", vec![agent("t1", Some("working"), 1)],
             vec![Status(0, "t1", Some("idle")), Turn(0, "t1", 2, Some("idle"))], vec![(Finished, "t1", 2)]),
            ("status done without a turn event doesn't fire", idle(), vec![Status(0, "t1", Some("done"))], vec![]),
            ("a duplicate turn fires once", vec![agent("t1", Some("working"), 1)],
             vec![Status(0, "t1", Some("done")), Turn(0, "t1", 2, Some("done")), Turn(100, "t1", 2, Some("done")),
                  Turn(5000, "t1", 2, Some("done"))], vec![(Finished, "t1", 2)]),
            ("a turn ending blocked isn't finished", vec![agent("t1", Some("working"), 1)],
             vec![Turn(0, "t1", 2, Some("blocked"))], vec![]),
            ("a turn ended by exit isn't finished", vec![agent("t1", Some("working"), 1)],
             vec![Status(0, "t1", None), Turn(0, "t1", 2, None)], vec![]),
            ("seen at this turn stops finished", vec![agent("t1", Some("working"), 1)],
             vec![Status(0, "t1", Some("done")), Turn(0, "t1", 2, Some("done")), Seen(500, "t1", 2)], vec![]),
            ("seen behind this turn doesn't", vec![agent("t1", Some("working"), 1)],
             vec![Seen(0, "t1", 1), Status(100, "t1", Some("done")), Turn(100, "t1", 2, Some("done"))], vec![(Finished, "t1", 2)]),
            ("seen doesn't stop needs you", vec![agent("t1", Some("working"), 1)],
             vec![Status(0, "t1", Some("blocked")), Turn(0, "t1", 2, Some("blocked")), Seen(500, "t1", 2)], vec![(NeedsYou, "t1", 2)]),
            ("done then working again in the hold doesn't buzz", vec![agent("t1", Some("working"), 1)],
             vec![Status(0, "t1", Some("done")), Turn(0, "t1", 2, Some("done")), Status(1000, "t1", Some("working"))], vec![]),
            ("done then blocked in the hold is only needs you", vec![agent("t1", Some("working"), 1)],
             vec![Status(0, "t1", Some("done")), Turn(0, "t1", 2, Some("done")), Status(1000, "t1", Some("blocked"))],
             vec![(NeedsYou, "t1", 2)]),
            ("plain shells never fire", vec![shell("t2")],
             vec![Raw(0, json!({"method": "event", "params": {"seq": 11, "type": "status", "terminal": "t2",
                                 "data": {"status": null, "records": {}, "reported": false}}})),
                  Turn(100, "t2", 1, Some("done"))], vec![]),
            ("a shell that starts reporting is an agent", vec![shell("t2")], vec![Status(0, "t2", Some("blocked"))], vec![(NeedsYou, "t2", 0)]),
            ("a machine's reconnect doesn't flood", vec![agent("gpu/t1", Some("working"), 1), agent("gpu/t2", Some("working"), 1)],
             vec![Removed(0, "gpu/t2"),
                  Created(100, agent("gpu/t1", Some("blocked"), 2)),
                  Created(100, agent("gpu/t2", Some("done"), 7)),
                  Created(100, agent("gpu/t3", Some("error"), 1))], vec![]),
            ("news after a reconnect still fires", vec![agent("gpu/t1", Some("working"), 1)],
             vec![Created(0, agent("gpu/t1", Some("working"), 5)),
                  Status(100, "gpu/t1", Some("done")), Turn(100, "gpu/t1", 6, Some("done"))], vec![(Finished, "gpu/t1", 6)]),
            ("a missed resync doesn't fire", vec![agent("t1", Some("working"), 1)],
             vec![Missed(0, vec![agent("t1", Some("blocked"), 2), agent("t9", Some("error"), 1)])], vec![]),
            ("old events after a missed resync are dropped", vec![agent("t1", Some("working"), 1)],
             vec![Missed(0, vec![agent("t1", Some("working"), 1)]),
                  Raw(100, json!({"method": "event", "params": {"seq": 1, "type": "status", "terminal": "t1",
                                  "data": {"status": {"state": "blocked"}, "reported": true}}}))], vec![]),
            ("a held notification survives a resync if still true", idle(),
             vec![Status(0, "t1", Some("blocked")), Missed(500, vec![agent("t1", Some("blocked"), 0)])], vec![(NeedsYou, "t1", 0)]),
            ("a removed terminal drops what's held", idle(), vec![Status(0, "t1", Some("blocked")), Removed(500, "t1")], vec![]),
            ("an unknown terminal is ignored", idle(), vec![Status(0, "t9", Some("blocked"))], vec![]),
        ];
        for (name, snapshot, script, want) in cases {
            let got = play(snapshot, script);
            assert_eq!(kinds(&got), want, "{name}");
        }
    }

    #[test]
    fn it_holds_before_firing_and_reports_when() {
        let mut e = Engine::default();
        e.resync(1, &[agent("t1", Some("idle"), 0)]);
        let msg = json!({"method": "event", "params": {"seq": 2, "type": "status", "terminal": "t1",
                         "data": {"status": {"state": "blocked"}, "reported": true}}});
        e.line(1000, &msg);
        assert_eq!(e.next_due(), Some(1000 + HOLD_MS));
        assert!(e.due(1000 + HOLD_MS - 1).is_empty());
        assert_eq!(e.due(1000 + HOLD_MS).len(), 1);
        assert_eq!(e.next_due(), None);
    }

    #[test]
    fn a_new_connection_with_a_lower_seq_works_and_doesnt_refire() {
        let mut e = Engine::default();
        e.resync(100, &[agent("t1", Some("idle"), 0)]);
        e.line(0, &json!({"method": "event", "params": {"seq": 101, "type": "status", "terminal": "t1",
                          "data": {"status": {"state": "blocked"}, "reported": true}}}));
        assert_eq!(e.due(HOLD_MS).len(), 1);
        // The core restarted: seq starts over, the same blocked agent is in the snapshot.
        e.resync(2, &[agent("t1", Some("blocked"), 0)]);
        assert!(e.due(HOLD_MS * 2).is_empty());
        e.line(HOLD_MS * 2, &json!({"method": "event", "params": {"seq": 3, "type": "status", "terminal": "t1",
                                    "data": {"status": {"state": "working"}, "reported": true}}}));
        e.line(HOLD_MS * 2, &json!({"method": "event", "params": {"seq": 4, "type": "status", "terminal": "t1",
                                    "data": {"status": {"state": "done"}, "reported": true}}}));
        e.line(HOLD_MS * 2, &json!({"method": "event", "params": {"seq": 5, "type": "turn", "terminal": "t1",
                                    "data": {"turn": 1, "state": "done"}}}));
        assert_eq!(e.due(HOLD_MS * 3).len(), 1);
    }

    #[test]
    fn heartbeats_and_doc_events_are_nothing() {
        let mut e = Engine::default();
        e.resync(1, &[agent("t1", Some("idle"), 0)]);
        e.line(0, &json!({"method": "heartbeat", "params": {"seq": 1}}));
        e.line(0, &json!({"method": "event", "params": {"seq": 2, "type": "doc", "data": {"name": "x", "version": 2}}}));
        assert!(e.due(HOLD_MS).is_empty());
    }

    #[test]
    fn lock_screen_words() {
        let n = |kind, label: &str, machine: &str, state: &str| Notice {
            kind, label: label.into(), machine: machine.into(), state: state.into(), address: "t1".into(), turn: 1,
        };
        assert_eq!(words(&n(Kind::NeedsYou, "Acme deploy", "runner", "blocked")),
                   ("Acme deploy needs you".into(), "runner · waiting for you".into()));
        assert_eq!(words(&n(Kind::NeedsYou, "X", "desk", "error")).1, "desk · hit an error");
        assert_eq!(words(&n(Kind::Finished, "Gpu-box lineup", "gpu-box", "finished")),
                   ("Gpu-box lineup finished".into(), "gpu-box".into()));
    }

    #[test]
    fn labels_never_carry_status_messages_and_are_cleaned() {
        let mut e = Engine::default();
        e.set_local("desk");
        e.resync(1, &[
            json!({"address": "t1", "name": null, "title": "\u{2733} Fix \u{1b}[31mauth", "reported": true, "turn": 0,
                   "labels": {}, "status": {"state": "idle", "msg": "SECRET", "title": "SECRET"}}),
            json!({"address": "gpu/t2", "name": "nightly-lineup", "reported": true, "turn": 0, "labels": {}, "status": {"state": "idle"}}),
            json!({"address": "t3", "reported": true, "turn": 0, "labels": {}, "status": {"state": "idle"}, "foreground": {"name": "claude"}}),
            json!({"address": "t4", "reported": true, "turn": 0, "labels": {}, "status": {"state": "idle"}}),
        ]);
        for (i, a) in ["t1", "gpu/t2", "t3", "t4"].iter().enumerate() {
            e.line(0, &json!({"method": "event", "params": {"seq": 2 + i, "type": "status", "terminal": a,
                              "data": {"status": {"state": "blocked", "msg": "SECRET"}, "reported": true}}}));
        }
        let got: Vec<(String, String)> = e.due(HOLD_MS).into_iter().map(|n| (n.label, n.machine)).collect();
        let pair = |l: &str, m: &str| (l.to_string(), m.to_string());
        // In address order.
        assert_eq!(got, vec![pair("Nightly lineup", "gpu"), pair("Fix [31mauth", "desk"), pair("Claude", "desk"), pair("Agent t4", "desk")]);
    }

    #[test]
    fn prefs_table() {
        let p = |needs_you, finished, enabled, start: &str, end: &str| Prefs {
            needs_you, finished, quiet: Quiet { enabled, start: start.into(), end: end.into() },
        };
        let at = |h: u32, m: u32| h * 60 + m;
        let cases = [
            ("defaults allow all", Prefs::default(), Kind::NeedsYou, at(3, 0), true),
            ("defaults allow finished", Prefs::default(), Kind::Finished, at(3, 0), true),
            ("needs you off", p(false, true, false, "22:00", "07:00"), Kind::NeedsYou, at(12, 0), false),
            ("needs you off leaves finished", p(false, true, false, "22:00", "07:00"), Kind::Finished, at(12, 0), true),
            ("finished off", p(true, false, false, "22:00", "07:00"), Kind::Finished, at(12, 0), false),
            ("finished off leaves needs you", p(true, false, false, "22:00", "07:00"), Kind::NeedsYou, at(12, 0), true),
            ("overnight, late", p(true, true, true, "22:00", "07:00"), Kind::NeedsYou, at(23, 30), false),
            ("overnight, early", p(true, true, true, "22:00", "07:00"), Kind::Finished, at(6, 59), false),
            ("overnight, end is out", p(true, true, true, "22:00", "07:00"), Kind::Finished, at(7, 0), true),
            ("overnight, day", p(true, true, true, "22:00", "07:00"), Kind::NeedsYou, at(12, 0), true),
            ("same day window", p(true, true, true, "13:00", "14:00"), Kind::NeedsYou, at(13, 30), false),
            ("same day window, out", p(true, true, true, "13:00", "14:00"), Kind::NeedsYou, at(14, 0), true),
            ("equal times mean no window", p(true, true, true, "13:00", "13:00"), Kind::NeedsYou, at(13, 0), true),
        ];
        for (name, prefs, kind, minute, want) in cases {
            assert_eq!(prefs.allows(kind, minute), want, "{name}");
        }
        assert!(Prefs::default().valid());
        assert!(!p(true, true, true, "25:00", "07:00").valid());
        assert!(!p(true, true, true, "7:00", "07:00").valid());
        assert!(!p(true, true, true, "22:00", "nope").valid());
    }
}
