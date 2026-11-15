//! The owner's speech-recognition vocabulary, from files in LUMBRIDGE_VOICE_VOCAB_DIR (kept up to date by whatever the owner uses
//! to edit them): `vocab.json` (the owner's `terms`, `fixes` [[heard, right]], `never`), `learned.json` (`terms`, `fixes`) and `fleet-vocab.json`
//! (`phrases`, `replacements` [[python regex, replacement]], `replacements_enabled`). A missing or unreadable file is an empty
//! one. The files are re-read when one's mtime changes. Nothing here logs a term or a transcript.

use crate::pyre::Regex;
use serde_json::Value;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::SystemTime,
};

/// The most terms the prompt carries.
pub const MAX_TERMS: usize = 250;
const FILES: [&str; 3] = ["vocab.json", "learned.json", "fleet-vocab.json"];

#[derive(Default)]
pub struct Loaded {
    /// For the prompt: the owner's, learned, fleet phrases, then replacement targets; deduped case-insensitively.
    pub terms: Vec<String>,
    /// The owner's and learned `fixes`, as whole-word case-insensitive replacements.
    fixes: Vec<(Regex, String)>,
    /// The fleet's regex replacements, when enabled; a rule this matcher can't compile is left out.
    replacements: Vec<(Regex, String)>,
}

impl Loaded {
    /// The transcript with the owner's fixes, then the fleet's replacements, applied.
    pub fn apply(&self, text: &str) -> String {
        let fixed = self.fixes.iter().fold(text.to_string(), |t, (re, right)| re.replace_all(&t, right, true));
        self.replacements.iter().fold(fixed, |t, (re, to)| re.replace_all(&t, to, false))
    }
}

type Stamp = [Option<SystemTime>; 3];

pub struct Vocab {
    dir: PathBuf,
    cache: Mutex<Option<(Stamp, Arc<Loaded>)>>,
}

fn strings(v: &Value) -> impl Iterator<Item = &str> {
    v.as_array().into_iter().flatten().filter_map(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
}

fn pairs(v: &Value) -> impl Iterator<Item = (&str, &str)> {
    v.as_array().into_iter().flatten().filter_map(|p| Some((p.get(0)?.as_str()?, p.get(1)?.as_str()?)))
}

/// The terms in order, without case-insensitive repeats or anything in `never`, at most `MAX_TERMS`.
fn merge<'a>(lists: impl IntoIterator<Item = &'a str>, never: &[String]) -> Vec<String> {
    let mut seen: Vec<String> = never.to_vec();
    let mut out = Vec::new();
    for t in lists {
        let key = t.to_lowercase();
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        out.push(t.to_string());
        if out.len() == MAX_TERMS {
            break;
        }
    }
    out
}

/// The vocabulary from the three files' contents (None: missing or not JSON).
pub fn build(his: Option<&Value>, learned: Option<&Value>, fleet: Option<&Value>) -> Loaded {
    let null = Value::Null;
    let (his, learned, fleet) = (his.unwrap_or(&null), learned.unwrap_or(&null), fleet.unwrap_or(&null));
    let never: Vec<String> = strings(&his["never"]).map(str::to_lowercase).collect();
    let targets = pairs(&fleet["replacements"]).map(|(_, to)| to.trim()).filter(|to| !to.is_empty() && !to.contains('\\'));
    let terms = merge(
        strings(&his["terms"]).chain(strings(&learned["terms"])).chain(strings(&fleet["phrases"])).chain(targets),
        &never,
    );
    let fixes = pairs(&his["fixes"])
        .chain(pairs(&learned["fixes"]))
        .filter(|(heard, _)| !heard.trim().is_empty())
        .map(|(heard, right)| (Regex::whole_word(heard.trim()), right.to_string()))
        .collect();
    let mut replacements = Vec::new();
    if fleet["replacements_enabled"] != Value::Bool(false) {
        let mut skipped = 0;
        for (pattern, to) in pairs(&fleet["replacements"]) {
            match Regex::new(pattern) {
                Ok(re) => replacements.push((re, to.to_string())),
                Err(_) => skipped += 1,
            }
        }
        if skipped > 0 {
            eprintln!("asr vocab: {skipped} fleet replacement(s) use regex this gateway doesn't support; left out");
        }
    }
    Loaded { terms, fixes, replacements }
}

impl Vocab {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir, cache: Mutex::new(None) }
    }

    fn stamp(&self) -> Stamp {
        FILES.map(|f| std::fs::metadata(self.dir.join(f)).and_then(|m| m.modified()).ok())
    }

    /// The vocabulary as the files are now; read again only when one of them changed.
    pub fn current(&self) -> Arc<Loaded> {
        let stamp = self.stamp();
        let mut cache = self.cache.lock().unwrap();
        if let Some((s, loaded)) = cache.as_ref() {
            if *s == stamp {
                return loaded.clone();
            }
        }
        let read = |f: &str| -> Option<Value> { serde_json::from_slice(&std::fs::read(self.dir.join(f)).ok()?).ok() };
        let [his, learned, fleet] = FILES.map(read);
        let loaded = Arc::new(build(his.as_ref(), learned.as_ref(), fleet.as_ref()));
        *cache = Some((stamp, loaded.clone()));
        loaded
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn terms_merge_in_order_without_repeats_and_skip_never() {
        let his = json!({ "terms": ["gpu-box", "Deskflow", " ", 7, "postgres"], "never": ["POSTGRES"] });
        let learned = json!({ "terms": ["deskflow", "build-box"] });
        let fleet = json!({
            "phrases": ["Gpu-box", "Acme"],
            "replacements": [["gpu ?box", "gpu-box"], ["(\\d+) gigs", "\\1 GB"], ["lumbrige", "Lumbridge"], ["x", ""]],
        });
        let v = build(Some(&his), Some(&learned), Some(&fleet));
        assert_eq!(v.terms, ["gpu-box", "Deskflow", "build-box", "Acme", "Lumbridge"]);
    }

    #[test]
    fn terms_stop_at_the_cap() {
        let his = json!({ "terms": (0..300).map(|i| format!("t{i}")).collect::<Vec<_>>() });
        let fleet = json!({ "phrases": ["late"] });
        let v = build(Some(&his), None, Some(&fleet));
        assert_eq!(v.terms.len(), MAX_TERMS);
        assert_eq!(v.terms[MAX_TERMS - 1], "t249");
    }

    #[test]
    fn missing_or_broken_files_are_an_empty_vocabulary() {
        let dir = tempfile::tempdir().unwrap();
        let v = Vocab::new(dir.path().join("nothing-here"));
        let loaded = v.current();
        assert!(loaded.terms.is_empty());
        assert_eq!(loaded.apply("Gpu box"), "Gpu box");
        std::fs::write(dir.path().join("vocab.json"), "{not json").unwrap();
        assert!(Vocab::new(dir.path().into()).current().terms.is_empty());
    }

    #[test]
    fn fixes_then_fleet_replacements() {
        let his = json!({ "fixes": [["desk flow", "Deskflow"], ["build box", "build-box"]] });
        let learned = json!({ "fixes": [["postgress", "postgres"]] });
        let fleet = json!({ "replacements": [["\\bgpu[ -]?(box|1)\\b", "gpu-box"], ["(\\d+) ?gigs?\\b", "\\1 GB"], ["build-box", "BUILD-BOX-WRONG"]] });
        let v = build(Some(&his), Some(&learned), Some(&fleet));
        assert_eq!(
            v.apply("Open Desk Flow on the build box, Postgress on Gpu box, 32 gigs. Postgressable desk flows."),
            "Open Deskflow on the BUILD-BOX-WRONG, postgres on gpu-box, 32 GB. Postgressable desk flows."
        );
        let off = json!({ "replacements": [["gpu box", "gpu-box"]], "replacements_enabled": false });
        let v = build(Some(&his), None, Some(&off));
        assert_eq!(v.apply("gpu box, desk flow"), "gpu box, Deskflow");
    }

    #[test]
    fn a_rule_the_matcher_cant_read_is_left_out() {
        let fleet = json!({ "replacements": [["(?<=a)b", "c"], ["gpu box", "gpu-box"]] });
        assert_eq!(build(None, None, Some(&fleet)).apply("ab gpu box"), "ab gpu-box");
    }

    #[test]
    fn a_changed_file_is_read_again() {
        let dir = tempfile::tempdir().unwrap();
        let v = Vocab::new(dir.path().into());
        let file = dir.path().join("vocab.json");
        std::fs::write(&file, r#"{"terms":["one"]}"#).unwrap();
        assert_eq!(v.current().terms, ["one"]);
        std::fs::write(&file, r#"{"terms":["two"]}"#).unwrap();
        let later = SystemTime::now() + std::time::Duration::from_secs(5);
        std::fs::File::options().write(true).open(&file).unwrap().set_modified(later).unwrap();
        assert_eq!(v.current().terms, ["two"]);
    }
}
