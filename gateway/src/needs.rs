//! The assistant's drafts, from the phone. The assistant can only draft; a draft is carried out when the owner presses Approve,
//! which runs the approve command (LUMBRIDGE_APPROVE_CMD, a program of the assistant's install). The assistant has no way to run
//! that itself, and this module is the only thing in the gateway that does.
//!
//! The assistant's watcher keeps the list in the needs file (LUMBRIDGE_NEEDS_FILE). We read the drafts out of it and nothing
//! else: its `needs` rows hold the tail of agents' screens, and those stay out of this API.
//!
//! **Nothing goes twice, and nothing goes that the owner didn't read.** The approve command moves a draft from pending to
//! running, but takes no lock, and the list lags its files by a few seconds. So a decision here is one at a time, and each one
//! asks `<approve command> show` first: the state there is the truth (not pending: refuse), and the words there must hash to
//! the digest the page was shown (different: refuse). That also holds across a gateway restart or a timed-out request,
//! so a client may retry anything. Another client of the same command pressing Approve in the same instant is the one race
//! left, and only the approve command can close it.
//!
//! Tool output and draft text never reach a log, and a client only ever gets a stable code.

use axum::extract::ConnectInfo;
use axum::Extension;
use std::net::SocketAddr;
use crate::{auth::Device, hc, reach, AppState};
use axum::{
    extract::{rejection::JsonRejection, Path as UrlPath, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex as StdMutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{
    process::Command,
    sync::{Mutex, Semaphore},
};

/// Under $HOME, when LUMBRIDGE_NEEDS_FILE is unset.
const DEFAULT_FILE: &str = ".local/state/lumbridge/needs.json";
const TOOL_TIMEOUT: Duration = Duration::from_secs(10);
/// The watcher rewrites the file at least once a minute.
const STALE_MS: u64 = 180_000;
/// A draft is at most 20 000 characters. Anything this big isn't the file we think it is.
const MAX_FILE: u64 = 8 << 20;
const MAX_ID: usize = 40;
const MAX_REMEMBERED: usize = 256;
/// How long a decision hides a draft that the list hasn't dropped yet. The watcher takes seconds, unless it has stopped.
const REMEMBER: Duration = Duration::from_secs(600);
/// Status reads at once. One tab can't pile up processes behind a hung tool.
const MAX_RUNNING: usize = 4;
const WATCH_EVERY: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, PartialEq, Debug)]
enum Verdict {
    Yes,
    No,
}

pub struct Needs {
    file: PathBuf,
    bin: PathBuf,
    timeout: Duration,
    /// Approving makes the approve command run `hc`, which starts a core when none is running. A core started from here has no
    /// desktop session behind it (hc.rs), so a production gateway checks first.
    check_core: bool,
    /// What some kinds may name, from the environment.
    allow: Allow,
    /// One decision at a time, for the length of the tool's run.
    turn: Mutex<()>,
    /// What was decided lately. Locked only for a moment, so a hung tool can't hold up the list.
    decided: StdMutex<HashMap<String, (Verdict, Instant)>>,
    running: Semaphore,
}

/// What can go wrong, as the client hears it.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Refusal {
    NotFromHere,
    BadId,
    BadRequest,
    NotPending,
    Changed,
    AlreadyHandled,
    CoreDown,
    TimedOut,
    Failed,
    Busy,
}

impl Refusal {
    fn parts(self) -> (StatusCode, &'static str) {
        match self {
            Refusal::NotFromHere => (StatusCode::FORBIDDEN, "not_from_here"),
            Refusal::BadId => (StatusCode::BAD_REQUEST, "bad_id"),
            Refusal::BadRequest => (StatusCode::BAD_REQUEST, "bad_request"),
            Refusal::NotPending => (StatusCode::NOT_FOUND, "not_pending"),
            Refusal::Changed => (StatusCode::CONFLICT, "changed"),
            Refusal::AlreadyHandled => (StatusCode::CONFLICT, "already_handled"),
            Refusal::CoreDown => (StatusCode::SERVICE_UNAVAILABLE, "core_down"),
            Refusal::TimedOut => (StatusCode::GATEWAY_TIMEOUT, "timed_out"),
            Refusal::Failed => (StatusCode::BAD_GATEWAY, "failed"),
            Refusal::Busy => (StatusCode::SERVICE_UNAVAILABLE, "busy"),
        }
    }
}

impl IntoResponse for Refusal {
    fn into_response(self) -> Response {
        let (status, code) = self.parts();
        (status, Json(json!({ "error": code }))).into_response()
    }
}

/// A draft as the tools write it. Every field is checked, because the file is another program's.
#[derive(Deserialize, Default)]
#[serde(default)]
struct RawDraft {
    id: String,
    kind: String,
    state: String,
    why: String,
    created_ms: u64,
    #[serde(rename = "where")]
    place: Option<String>,
    address: String,
    text: String,
    machine: String,
    folder: String,
    name: String,
    task: String,
    /// An `ig_post`'s card, as the approve command will find it on disk or refuse.
    sha256: String,
    /// The card's size. The approve command checks it along with the hash, which already pins it.
    #[allow(dead_code)]
    bytes: u64,
}

/// What a `resume` draft does in Reactive Resume, by its `address`. No other action is shown.
fn resume_action(action: &str) -> Option<&'static str> {
    Some(match action {
        "tailor" => "Tailor a copy",
        "patch" => "Change a resume",
        "letter-create" => "Write a cover letter",
        "letter-edit" => "Edit a cover letter",
        "app-create" => "Add a job application",
        "app-update" => "Update a job application",
        "app-note" => "Add a note to an application",
        _ => return None,
    })
}

/// `@account`: lowercase letters, digits, dots and underscores.
fn ig_account(s: &str) -> bool {
    s.strip_prefix('@').is_some_and(|a| !a.is_empty() && a.bytes().all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'.' | b'_')))
}

/// `out/<file>` or `specials/<file>`, the file starting with a letter or digit: nothing that climbs out of the folder.
fn ig_card(s: &str) -> bool {
    let Some(file) = s.strip_prefix("out/").or_else(|| s.strip_prefix("specials/")) else { return false };
    file.bytes().next().is_some_and(|b| b.is_ascii_alphanumeric())
        && file.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// What a `deploy` or `service_record` draft may name, and the branch prefix a `worker` gets. Exact strings only: a draft
/// naming anything else isn't shown, so it can't be approved.
#[derive(Clone, Debug, Default)]
pub struct Allow {
    /// LUMBRIDGE_DEPLOY_SITES: the sites the approve command can deploy (it re-checks the site and action itself).
    pub deploy_sites: Vec<String>,
    /// LUMBRIDGE_SERVICE_LOGS: `<repo>:<path>` of each service log a `service_record` may add to.
    pub service_logs: Vec<String>,
    /// LUMBRIDGE_WORKER_BRANCH_PREFIX: what the approve command names a worker's branch, `<prefix>/<name>`. Shown only.
    pub branch_prefix: String,
}

impl Allow {
    pub fn from_env() -> Self {
        let list = |name| std::env::var(name).unwrap_or_default().split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
        Self {
            deploy_sites: list("LUMBRIDGE_DEPLOY_SITES"),
            service_logs: list("LUMBRIDGE_SERVICE_LOGS"),
            branch_prefix: std::env::var("LUMBRIDGE_WORKER_BRANCH_PREFIX").ok().filter(|p| !p.trim().is_empty()).unwrap_or_else(|| "assistant".into()),
        }
    }

    fn deploy_site(&self, s: &str) -> bool {
        self.deploy_sites.iter().any(|d| d == s)
    }

    fn service_log(&self, s: &str) -> bool {
        s.split_once(':').is_some_and(|(repo, path)| !repo.is_empty() && !path.is_empty()) && self.service_logs.iter().any(|l| l == s)
    }
}

fn sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

impl RawDraft {
    /// The words that get carried out, and where. The approve command acts on exactly these fields. A resume's or an inbox
    /// draft's `fields` aren't here: the approve command rebuilds `text` from them and refuses any difference, so `text` binds them.
    fn digest(&self) -> String {
        let acted_on = [&self.kind, &self.address, &self.text, &self.machine, &self.folder, &self.name, &self.task, &self.sha256];
        let canonical = serde_json::to_string(&acted_on).unwrap_or_default();
        Sha256::digest(canonical.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
    }

    /// Only what can be read in full and acted on. The approve command would treat any other kind as a worker.
    fn shown_with(&self, allow: &Allow) -> Option<Draft> {
        if !valid_id(&self.id) || self.state != "pending" {
            return None;
        }
        let (to, detail, text) = match self.kind.as_str() {
            "send" if !self.address.is_empty() && !self.text.is_empty() => {
                let to = self.place.as_deref().filter(|p| !p.is_empty()).unwrap_or(&self.address);
                (to.to_string(), self.address.clone(), self.text.clone())
            }
            "worker" if ![&self.machine, &self.folder, &self.name, &self.task].iter().any(|f| f.is_empty()) => (
                format!("{} on {}", self.name, self.machine),
                format!("{}, new worktree, branch {}/{}", self.folder, allow.branch_prefix, self.name),
                self.task.clone(),
            ),
            // Time-limited use of something on a phone or a browser the assistant operates: `address` is what, `name` how many minutes.
            "access" if !self.address.is_empty() && !self.text.is_empty() && self.name.bytes().all(|b| b.is_ascii_digit()) && !self.name.is_empty() => {
                (self.address.clone(), format!("for {} minutes", self.name), self.text.clone())
            }
            // A factory issue, filed on the owner's login: `address` is the repo, `name` the title, `text` the body.
            "issue" if ![&self.address, &self.name, &self.text].iter().any(|f| f.is_empty()) => {
                (self.address.clone(), self.name.clone(), self.text.clone())
            }
            // A change in Reactive Resume: `address` the action, `name` a one-line summary, `text` every change in full.
            "resume" if !self.name.is_empty() && !self.text.is_empty() => {
                (self.name.clone(), resume_action(&self.address)?.to_string(), self.text.clone())
            }
            // An Instagram Story: `address` the account, `name` the card, which must still have this hash when it goes.
            "ig_post" if ig_account(&self.address) && ig_card(&self.name) && sha256_hex(&self.sha256) && !self.text.is_empty() => {
                (self.address.clone(), format!("{} · sha256 {}…", self.name, &self.sha256[..16]), self.text.clone())
            }
            // A service-log entry: `address` the log as `<repo>:<path>`, `name` "<what>: <date> <title>", `text` the whole entry.
            // The approve command rebuilds `text` from the draft's fields on Approve and refuses any difference; it never commits.
            "service_record" if allow.service_log(&self.address) && !self.name.is_empty() && !self.text.is_empty() => {
                let (repo, file) = self.address.split_once(':')?;
                (self.name.clone(), format!("adds this entry to {file} in {repo}, not committed"), self.text.clone())
            }
            // A deploy or rollback of one of the owner's sites: `address` the site, `name` deploy or rollback, `text` exactly what
            // runs. The approve command runs that site's own deploy script from a clean clone of main, never a checkout.
            "deploy" if allow.deploy_site(&self.address) && matches!(self.name.as_str(), "deploy" | "rollback") && !self.text.is_empty() => {
                (self.address.clone(), self.name.clone(), self.text.clone())
            }
            // From the owner's inbox: `address` the mail account, `name` the thread or event, `text` everything that will happen.
            "mail_reply" | "cal_create" | "cal_change" | "cal_decline" if ![&self.address, &self.name, &self.text].iter().any(|f| f.is_empty()) => {
                let (to, detail) = match self.kind.as_str() {
                    "mail_reply" => ("Email reply", "reply in thread, recipients from its headers"),
                    "cal_create" => ("Calendar", "new event, no guests"),
                    "cal_change" => ("Calendar", "change an event"),
                    _ => ("Calendar", "decline an invite"),
                };
                (format!("{to} · {}", self.address), detail.to_string(), self.text.clone())
            }
            _ => return None,
        };
        Some(Draft {
            id: self.id.clone(),
            kind: self.kind.clone(),
            to,
            detail,
            why: self.why.clone(),
            text,
            digest: self.digest(),
            created_ms: self.created_ms,
        })
    }
}

/// A draft as the page gets it.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    pub id: String,
    pub kind: String,
    pub to: String,
    pub detail: String,
    pub why: String,
    pub text: String,
    pub digest: String,
    pub created_ms: u64,
}

#[derive(Serialize, Default, Debug)]
pub struct Listing {
    pub drafts: Vec<Draft>,
    /// The watcher is quiet or its file is unreadable, so the list may be behind. Never true for a missing file.
    pub stale: bool,
    /// Approve would be taken from the device asking: false on one the assistant can operate (`reach`).
    #[serde(rename = "approveHere")]
    pub approve_here: bool,
}

/// `<seconds>-<4 hex>`, as the approve command insists.
pub fn valid_id(id: &str) -> bool {
    let Some((secs, tail)) = id.split_once('-') else { return false };
    id.len() <= MAX_ID
        && !secs.is_empty()
        && secs.bytes().all(|b| b.is_ascii_digit())
        && tail.len() == 4
        && tail.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

fn executable(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

impl Needs {
    pub fn from_env() -> Self {
        let home = PathBuf::from(std::env::var_os("HOME").unwrap_or_default());
        let file = std::env::var_os("LUMBRIDGE_NEEDS_FILE").map_or_else(|| home.join(DEFAULT_FILE), PathBuf::from);
        let bin = std::env::var_os("LUMBRIDGE_APPROVE_CMD").map(PathBuf::from).unwrap_or_default();
        let mut needs = Self::new(file, bin, TOOL_TIMEOUT, true);
        needs.allow = Allow::from_env();
        needs
    }

    fn new(file: PathBuf, bin: PathBuf, timeout: Duration, check_core: bool) -> Self {
        Self { file, bin, timeout, check_core, allow: Allow::default(), turn: Mutex::new(()), decided: StdMutex::new(HashMap::new()), running: Semaphore::new(MAX_RUNNING) }
    }

    /// Reads the file. A missing file or tool is "nothing pending": this box may simply not run the assistant.
    fn read(&self, now: u64) -> Listing {
        if !executable(&self.bin) {
            return Listing::default();
        }
        let Ok(meta) = std::fs::metadata(&self.file) else { return Listing::default() };
        let parsed = (meta.len() <= MAX_FILE)
            .then(|| std::fs::read(&self.file).ok())
            .flatten()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
        let Some(doc) = parsed else { return Listing { drafts: vec![], stale: true, ..Default::default() } };
        let updated = doc["updated_ms"].as_u64().unwrap_or(0);
        let stale = doc["error"].is_string() || now.saturating_sub(updated) > STALE_MS;
        let none = Vec::new();
        let raw = doc["drafts"].as_array().unwrap_or(&none);
        let mut drafts: Vec<Draft> =
            raw.iter().filter_map(|d| serde_json::from_value::<RawDraft>(d.clone()).ok()?.shown_with(&self.allow)).collect();
        drafts.sort_by(|a, b| (a.created_ms, &a.id).cmp(&(b.created_ms, &b.id)));
        Listing { drafts, stale, ..Default::default() }
    }

    /// The list, without what's just been decided here and is still working its way out of the file.
    pub fn listing(&self) -> Listing {
        let mut listing = self.read(now_ms());
        let decided = self.decided.lock().unwrap();
        listing.drafts.retain(|d| !decided.get(&d.id).is_some_and(|(_, at)| at.elapsed() < REMEMBER));
        listing
    }

    /// How many wait for the owner, for the number on the app icon.
    pub fn count(&self) -> usize {
        self.listing().drafts.len()
    }

    fn remember(&self, id: &str, verdict: Verdict) {
        let mut decided = self.decided.lock().unwrap();
        decided.retain(|_, (_, at)| at.elapsed() < REMEMBER);
        if decided.len() >= MAX_REMEMBERED {
            if let Some(oldest) = decided.iter().min_by_key(|(_, (_, at))| *at).map(|(k, _)| k.clone()) {
                decided.remove(&oldest);
            }
        }
        decided.insert(id.to_string(), (verdict, Instant::now()));
    }

    fn already(&self, id: &str) -> Option<Verdict> {
        self.decided.lock().unwrap().get(id).filter(|(_, at)| at.elapsed() < REMEMBER).map(|(v, _)| *v)
    }

    /// Runs the fixed binary. Only ever `Command::new`, no shell, the id already validated. Its output isn't kept unless
    /// `want_output`, and stderr never is.
    async fn run(&self, args: &[&str], want_output: bool) -> Result<(bool, Vec<u8>), Refusal> {
        let mut command = Command::new(&self.bin);
        command
            .args(args)
            .env_clear()
            .envs(hc::kept_env())
            .stdin(Stdio::null())
            .stdout(if want_output { Stdio::piped() } else { Stdio::null() })
            .stderr(Stdio::null())
            .kill_on_drop(true);
        match tokio::time::timeout(self.timeout, command.output()).await {
            Err(_) => Err(Refusal::TimedOut),
            Ok(Err(_)) => Err(Refusal::NotPending), // no binary: nothing to decide
            Ok(Ok(out)) => Ok((out.status.success(), out.stdout)),
        }
    }

    /// The draft in the approve command's own files: the truth, where the list is only a copy.
    async fn show(&self, id: &str) -> Result<RawDraft, Refusal> {
        let (ok, stdout) = self.run(&["show", id], true).await?;
        if !ok {
            return Err(Refusal::NotPending);
        }
        serde_json::from_slice(&stdout).map_err(|_| Refusal::Failed)
    }

    async fn decide(&self, id: &str, verdict: Verdict, digest: Option<&str>) -> Result<bool, Refusal> {
        if !valid_id(id) {
            return Err(Refusal::BadId);
        }
        let _turn = self.turn.lock().await;
        match self.already(id) {
            // The same answer again is the same press: say so, run nothing.
            Some(before) if before == verdict => return Ok(true),
            Some(_) => return Err(Refusal::AlreadyHandled),
            None => {}
        }
        if !self.read(now_ms()).drafts.iter().any(|d| d.id == id) {
            return Err(Refusal::NotPending);
        }
        if verdict == Verdict::Yes && self.check_core && !hc::running().await {
            return Err(Refusal::CoreDown);
        }
        // The list says it's waiting and the tool won't say so: that's the tool in trouble, or the list a moment behind.
        let draft = self.show(id).await.map_err(|e| if e == Refusal::NotPending { Refusal::Failed } else { e })?;
        if draft.state != "pending" {
            return Err(Refusal::AlreadyHandled);
        }
        if verdict == Verdict::Yes && digest != Some(draft.digest().as_str()) {
            return Err(Refusal::Changed);
        }
        let (ok, _) = match verdict {
            // --bg: it marks the draft running and returns. A send can wait minutes for a pause in the terminal.
            Verdict::Yes => self.run(&["yes", id, "--bg"], false).await?,
            Verdict::No => self.run(&["no", id], false).await?,
        };
        if !ok {
            return Err(Refusal::Failed);
        }
        self.remember(id, verdict);
        Ok(false)
    }

    /// How a draft stands now, as a word. Output beyond the state stays here: `result` can hold a tool's stderr.
    async fn status(&self, id: &str) -> Result<&'static str, Refusal> {
        if !valid_id(id) {
            return Err(Refusal::BadId);
        }
        let Ok(_permit) = self.running.try_acquire() else { return Err(Refusal::Busy) };
        Ok(match self.show(id).await?.state.as_str() {
            "pending" => "pending",
            "running" => "running",
            "done" => "done",
            "rejected" => "rejected",
            _ => "failed",
        })
    }
}

/// The list, and whether Approve can work from the device asking, so the page needn't offer a button that would be refused.
async fn needs(_: Device, peer: Option<Extension<ConnectInfo<SocketAddr>>>, State(state): State<Arc<AppState>>) -> Json<Listing> {
    let approve_here = reach::from_owners_hands(&state, peer.map(|Extension(ConnectInfo(addr))| addr)).await;
    Json(Listing { approve_here, ..state.needs.listing() })
}

#[derive(Deserialize)]
struct Approve {
    /// The `digest` of the draft the owner read.
    digest: String,
}

async fn approve(
    _: Device,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    State(state): State<Arc<AppState>>,
    UrlPath(id): UrlPath<String>,
    body: Result<Json<Approve>, JsonRejection>,
) -> Result<Json<Value>, Refusal> {
    let Json(body) = body.map_err(|_| Refusal::BadRequest)?;
    // Any doubt about who's asking means no. Every kind goes through here, `access` included.
    if !reach::from_owners_hands(&state, peer.map(|Extension(ConnectInfo(addr))| addr)).await {
        return Err(Refusal::NotFromHere);
    }
    let repeat = state.needs.decide(&id, Verdict::Yes, Some(&body.digest)).await?;
    Ok(Json(json!({ "state": "running", "repeat": repeat })))
}

async fn reject(_: Device, State(state): State<Arc<AppState>>, UrlPath(id): UrlPath<String>) -> Result<Json<Value>, Refusal> {
    let repeat = state.needs.decide(&id, Verdict::No, None).await?;
    Ok(Json(json!({ "state": "rejected", "repeat": repeat })))
}

async fn status(_: Device, State(state): State<Arc<AppState>>, UrlPath(id): UrlPath<String>) -> Result<Json<Value>, Refusal> {
    Ok(Json(json!({ "state": state.needs.status(&id).await? })))
}

/// Buzzes once for each new draft: a draft nobody knows about would wait for ever. What's already there when the gateway
/// starts isn't news, and the word on the lock screen never comes from the draft.
pub async fn watcher(state: Arc<AppState>) {
    let mut known: Option<HashSet<String>> = None;
    loop {
        let ids: Vec<String> = state.needs.listing().drafts.into_iter().map(|d| d.id).collect();
        match &mut known {
            None => known = Some(ids.into_iter().collect()),
            Some(known) => {
                for id in fresh(known, ids) {
                    crate::push::draft_arrived(&state, &id);
                }
            }
        }
        tokio::time::sleep(WATCH_EVERY).await;
    }
}

/// Which of these haven't been seen. Ids are never reused, so what's known stays known; only the bound forgets.
fn fresh(known: &mut HashSet<String>, ids: Vec<String>) -> Vec<String> {
    if known.len() > MAX_REMEMBERED {
        known.clear();
        known.extend(ids.iter().cloned());
        return vec![];
    }
    ids.into_iter().filter(|id| known.insert(id.clone())).collect()
}

pub fn router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/assistant/needs", get(needs))
        .route("/api/assistant/drafts/:id", get(status))
        .route("/api/assistant/drafts/:id/approve", post(approve))
        .route("/api/assistant/drafts/:id/reject", post(reject))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_allow() -> Allow {
        Allow {
            deploy_sites: vec!["example.com".into(), "app.example.com".into(), "mobile.example.com".into()],
            service_logs: ["car-a", "car-b", "car-c"].iter().map(|c| format!("garage:logs/{c}-service-log.md")).collect(),
            branch_prefix: "assistant".into(),
        }
    }

    impl RawDraft {
        fn shown(&self) -> Option<Draft> {
            self.shown_with(&test_allow())
        }
    }

    #[test]
    fn an_access_draft_shows_what_and_how_long_and_covers_both_in_the_digest() {
        let d = |name: &str| RawDraft {
            id: "1793758374-ec32".into(),
            kind: "access".into(),
            state: "pending".into(),
            address: "desk:b1".into(),
            name: name.into(),
            text: "Fill the Acme application; stop before Submit".into(),
            ..Default::default()
        };
        let shown = d("30").shown().expect("shown");
        assert_eq!(shown.to, "desk:b1");
        assert_eq!(shown.detail, "for 30 minutes");
        assert_ne!(shown.digest, d("60").shown().unwrap().digest);
        assert!(d("").shown().is_none());
        assert!(d("soon").shown().is_none());
    }

    #[test]
    fn an_issue_draft_shows_repo_title_and_body_and_covers_all_three_in_the_digest() {
        let d = |address: &str, name: &str, text: &str| RawDraft {
            id: "1793758374-ec33".into(),
            kind: "issue".into(),
            state: "pending".into(),
            address: address.into(),
            name: name.into(),
            text: text.into(),
            ..Default::default()
        };
        let base = d("acme/app", "Thoughts lose a word", "Steps to reproduce");
        let shown = base.shown().expect("shown");
        assert_eq!((shown.kind.as_str(), shown.to.as_str()), ("issue", "acme/app"));
        assert_eq!(shown.detail, "Thoughts lose a word");
        assert_eq!(shown.text, "Steps to reproduce");
        for other in [
            d("acme/home", "Thoughts lose a word", "Steps to reproduce"),
            d("acme/app", "Thoughts lose two words", "Steps to reproduce"),
            d("acme/app", "Thoughts lose a word", "Other steps"),
        ] {
            assert_ne!(shown.digest, other.shown().unwrap().digest);
        }
        assert!(d("", "t", "b").shown().is_none());
        assert!(d("r", "", "b").shown().is_none());
        assert!(d("r", "t", "").shown().is_none());
    }

    const CARD_HASH: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const RESUME_TEXT: &str = "Tailored copy \"Acme FDE\" from Sam Example (v10)\nCHANGE summary\n  was: Engineer\n  now: Forward-deployed engineer\nADD skill: Rust";
    const MAIL_TEXT: &str = "From: k@example.com\nTo: a@example.com\nCc: b@example.com\nSubject: Re: Lunch\n\nThursday works.\n";

    /// One well-formed draft of each new kind, as the approve command writes them.
    fn raw_new(kind: &str) -> RawDraft {
        let mut d = RawDraft { id: "1793758374-ec34".into(), kind: kind.into(), state: "pending".into(), why: "He asked".into(), ..Default::default() };
        match kind {
            "resume" => {
                d.address = "tailor".into();
                d.name = "Tailored copy \"Sam Example — Acme FDE\" from Sam Example (v10), 3 change(s)".into();
                d.text = RESUME_TEXT.into();
            }
            "ig_post" => {
                d.address = "@sam.runs".into();
                d.name = "out/2026-11-05_story.png".into();
                d.sha256 = CARD_HASH.into();
                d.bytes = 123_456;
                d.text = "Morning run, 10k".into();
            }
            "deploy" => {
                d.address = "example.com".into();
                d.name = "rollback".into();
                d.text = DEPLOY_TEXT.into();
            }
            "service_record" => {
                d.address = "garage:logs/car-a-service-log.md".into();
                d.name = "Car A: 2026-11-05 Four-wheel alignment".into();
                d.text = SERVICE_TEXT.into();
            }
            _ => {
                d.address = "k@example.com".into();
                d.name = if kind == "cal_create" { "new".into() } else { "18c2f0a9b7d3e1aa".into() };
                d.text = MAIL_TEXT.into();
            }
        }
        d
    }

    const NEW_KINDS: [&str; 8] = ["resume", "ig_post", "mail_reply", "cal_create", "cal_change", "cal_decline", "service_record", "deploy"];
    const DEPLOY_TEXT: &str = "Rollback example.com to 81cf537.\nWhat runs: tags the commit you name and runs the same deploy workflow on it.";

    #[test]
    fn a_deploy_draft_shows_the_site_the_action_and_what_runs() {
        let shown = raw_new("deploy").shown().expect("shown");
        assert_eq!((shown.to.as_str(), shown.detail.as_str(), shown.text.as_str()), ("example.com", "rollback", DEPLOY_TEXT));
        for site in ["app.example.com", "mobile.example.com"] {
            assert!(RawDraft { address: site.into(), ..raw_new("deploy") }.shown().is_some(), "{site}");
        }
        for (address, name) in [("evil.example", "deploy"), ("example.com.evil", "deploy"), ("example.com", "push"), ("example.com", ""), ("", "deploy")] {
            assert!(RawDraft { address: address.into(), name: name.into(), ..raw_new("deploy") }.shown().is_none(), "{address} {name}");
        }
        assert!(RawDraft { text: String::new(), ..raw_new("deploy") }.shown().is_none());
    }
    const SERVICE_TEXT: &str = "## 2026-11-05 · Corner Garage · Four-wheel alignment\n\n- Car: Car A (2023 sedan)\n- Category: tires\n\nReadings:\n- Right front toe 0.24° before, 0.08° after (spec -0.15° to 0.15°)\n";

    #[test]
    fn a_service_record_draft_shows_the_log_and_the_whole_entry() {
        let shown = raw_new("service_record").shown().expect("shown");
        assert_eq!(shown.to, "Car A: 2026-11-05 Four-wheel alignment");
        assert_eq!(shown.detail, "adds this entry to logs/car-a-service-log.md in garage, not committed");
        assert_eq!(shown.text, SERVICE_TEXT);
        for car in ["car-b", "car-c"] {
            let address = format!("garage:logs/{car}-service-log.md");
            assert!(RawDraft { address, ..raw_new("service_record") }.shown().is_some(), "{car}");
        }
        for bad in [
            "",
            "garage:README.md",
            "garage:logs/../../README.md",
            "garage:logs/car-d-service-log.md",
            "garage:logs/car-a-service-log.md ",
            "logs/car-a-service-log.md",
            "garage:/home/sam/repos/garage/logs/car-a-service-log.md",
        ] {
            assert!(RawDraft { address: bad.into(), ..raw_new("service_record") }.shown().is_none(), "{bad:?}");
        }
        assert!(RawDraft { name: String::new(), ..raw_new("service_record") }.shown().is_none());
        assert!(RawDraft { text: String::new(), ..raw_new("service_record") }.shown().is_none());
        assert!(RawDraft { kind: "service-record".into(), ..raw_new("service_record") }.shown().is_none());
    }

    #[test]
    fn a_resume_draft_shows_the_action_the_summary_and_every_change() {
        let shown = raw_new("resume").shown().expect("shown");
        assert_eq!(shown.to, raw_new("resume").name);
        assert_eq!(shown.detail, "Tailor a copy");
        assert_eq!(shown.text, RESUME_TEXT);
        for (action, words) in [
            ("tailor", "Tailor a copy"),
            ("patch", "Change a resume"),
            ("letter-create", "Write a cover letter"),
            ("letter-edit", "Edit a cover letter"),
            ("app-create", "Add a job application"),
            ("app-update", "Update a job application"),
            ("app-note", "Add a note to an application"),
        ] {
            let d = RawDraft { address: action.into(), ..raw_new("resume") };
            assert_eq!(d.shown().expect(action).detail, words);
        }
        for bad in ["", "delete", "Tailor", "tailor ", "letter_edit"] {
            assert!(RawDraft { address: bad.into(), ..raw_new("resume") }.shown().is_none(), "{bad:?}");
        }
        assert!(RawDraft { name: String::new(), ..raw_new("resume") }.shown().is_none());
        assert!(RawDraft { text: String::new(), ..raw_new("resume") }.shown().is_none());
    }

    #[test]
    fn an_ig_post_draft_shows_account_card_and_hash() {
        let shown = raw_new("ig_post").shown().expect("shown");
        assert_eq!(shown.to, "@sam.runs");
        assert_eq!(shown.detail, "out/2026-11-05_story.png · sha256 0123456789abcdef…");
        assert_eq!(shown.text, "Morning run, 10k");
        assert!(RawDraft { name: "specials/x.png".into(), ..raw_new("ig_post") }.shown().is_some());
        assert!(RawDraft { address: "@a.b_c9".into(), ..raw_new("ig_post") }.shown().is_some());
        for bad in ["", "sam.runs", "@", "@Sam.runs", "@sam-runs", "@sam.runs ", "@ sam.runs"] {
            assert!(RawDraft { address: bad.into(), ..raw_new("ig_post") }.shown().is_none(), "account {bad:?}");
        }
        for bad in ["", "out/", "x.png", "/out/x.png", "out/../x.png", "out/.x.png", "out/a/b.png", "out/x y.png", "Out/x.png", "specials/-x.png", "out/x.png\n"] {
            assert!(RawDraft { name: bad.into(), ..raw_new("ig_post") }.shown().is_none(), "card {bad:?}");
        }
        for bad in ["", &CARD_HASH[..63], &CARD_HASH.to_uppercase(), &format!("{}0", CARD_HASH), &CARD_HASH.replace('0', "g")] {
            assert!(RawDraft { sha256: bad.into(), ..raw_new("ig_post") }.shown().is_none(), "hash {bad:?}");
        }
        assert!(RawDraft { text: String::new(), ..raw_new("ig_post") }.shown().is_none());
    }

    #[test]
    fn an_inbox_draft_shows_the_account_and_everything_that_will_happen() {
        for (kind, to, detail) in [
            ("mail_reply", "Email reply · k@example.com", "reply in thread, recipients from its headers"),
            ("cal_create", "Calendar · k@example.com", "new event, no guests"),
            ("cal_change", "Calendar · k@example.com", "change an event"),
            ("cal_decline", "Calendar · k@example.com", "decline an invite"),
        ] {
            let shown = raw_new(kind).shown().expect(kind);
            assert_eq!((shown.kind.as_str(), shown.to.as_str(), shown.detail.as_str(), shown.text.as_str()), (kind, to, detail, MAIL_TEXT));
            assert!(RawDraft { address: String::new(), ..raw_new(kind) }.shown().is_none(), "{kind}");
            assert!(RawDraft { name: String::new(), ..raw_new(kind) }.shown().is_none(), "{kind}");
            assert!(RawDraft { text: String::new(), ..raw_new(kind) }.shown().is_none(), "{kind}");
        }
    }

    #[test]
    fn every_new_kind_digests_what_is_shown_and_acted_on_and_an_unknown_kind_stays_hidden() {
        for kind in NEW_KINDS {
            let digest = raw_new(kind).shown().expect(kind).digest;
            let mut same = raw_new(kind);
            same.why = "another reason".into();
            same.bytes = 1;
            assert_eq!(digest, same.digest(), "{kind}: why and bytes aren't acted on");
            let changes: [fn(&mut RawDraft); 5] = [
                |d| d.text.push('!'),
                |d| d.address.push('x'),
                |d| d.name.push('x'),
                |d| d.sha256.push('x'),
                |d| d.kind = "send".into(),
            ];
            for (i, change) in changes.iter().enumerate() {
                let mut d = raw_new(kind);
                change(&mut d);
                assert_ne!(digest, d.digest(), "{kind}: change {i}");
            }
        }
        for kind in ["mystery", "Resume", "ig-post", "mail", "cal_delete", ""] {
            assert!(RawDraft { kind: kind.into(), ..raw_new("mail_reply") }.shown().is_none(), "{kind:?}");
            assert!(RawDraft { kind: kind.into(), ..raw_new("ig_post") }.shown().is_none(), "{kind:?}");
        }
    }
    use crate::config::Config;
    use axum::{body::Body, extract::ConnectInfo, http::Request};
    use std::net::{IpAddr, SocketAddr};
    use tower::ServiceExt;

    /// A stand-in for the approve command that keeps its state in a file, the way the real one does, and writes down each call.
    /// `SHOW_SAYS` overrides what `show` reads back, for the copy and the truth disagreeing.
    const FAKE: &str = r#"#!/bin/sh
d="$(dirname "$0")"
echo "$*" >> "$d/calls"
printf '%s\n' "HOME=${HOME:-unset} SECRET=${LUMBRIDGE_DATABASE_URL:-unset}" > "$d/env"
[ -e "$d/hang" ] && exec sleep 30
case "$1" in
  show)
    [ -e "$d/show-fails" ] && exit 1
    [ -e "$d/show-says" ] && exec cat "$d/show-says"
    state=pending; [ -e "$d/state-$2" ] && state="$(cat "$d/state-$2")"
    [ "$2" = 1793758500-acce ] && exec printf '{"id":"%s","kind":"access","state":"%s","address":"desk:b1","text":"Fill the form","name":"30"}\n' "$2" "$state"
    printf '{"id":"%s","kind":"send","state":"%s","address":"t7","text":"Run the tests","result":"SECRET TOOL OUTPUT"}\n' "$2" "$state"
    ;;
  yes|no)
    [ -e "$d/refuse" ] && { echo "SECRET TOOL OUTPUT" >&2; exit 1; }
    state=pending; [ -e "$d/state-$2" ] && state="$(cat "$d/state-$2")"
    [ "$state" = pending ] || { echo "already $state" >&2; exit 1; }
    [ "$1" = yes ] && echo running > "$d/state-$2" || echo rejected > "$d/state-$2"
    echo started
    ;;
esac
"#;

    const ID: &str = "1793758374-ec32";
    const WORKER: &str = "1793758420-f375";
    const ACCESS: &str = "1793758500-acce";
    /// Plays `tailscale whois`: what it says of an address is in `whois-<ip>`, and nothing there is a failed lookup.
    const FAKE_TAILSCALE: &str = r#"#!/bin/sh
[ "$1 $2" = "whois --json" ] && exec cat "$(dirname "$0")/whois-$3"
exit 9
"#;

    struct Rig {
        dir: tempfile::TempDir,
        app: Router,
        token: String,
        ip: IpAddr,
        digest: String,
    }

    #[cfg_attr(feature = "dev-identity", allow(dead_code))]
    fn raw_access() -> RawDraft {
        RawDraft { id: ACCESS.into(), kind: "access".into(), state: "pending".into(), address: "desk:b1".into(), text: "Fill the form".into(), name: "30".into(), ..Default::default() }
    }

    fn raw_send() -> RawDraft {
        RawDraft { id: ID.into(), kind: "send".into(), state: "pending".into(), address: "t7".into(), text: "Run the tests".into(), ..Default::default() }
    }

    fn list_doc(updated_ms: u64) -> Value {
        json!({
            "updated_ms": updated_ms,
            "agents": 3,
            "needs": [{"address": "t1", "question": "SCREEN TAIL, NOT FOR THIS API"}],
            "machines": [{"name": "runner", "state": "connected"}],
            "drafts": [
                {"id": ID, "kind": "send", "state": "pending", "why": "He asked", "created_ms": 2, "address": "t7", "where": "Lumbridge / Gateway", "text": "Run the tests"},
                {"id": WORKER, "kind": "worker", "state": "pending", "why": "Tidy", "created_ms": 1, "machine": "runner", "folder": "/srv/x", "name": "tidy", "task": "Tidy up"},
                {"id": ACCESS, "kind": "access", "state": "pending", "why": "For the form", "created_ms": 3, "address": "desk:b1", "text": "Fill the form", "name": "30"},
                {"id": "1793758439-f578", "kind": "send", "state": "done", "address": "t7", "text": "old"},
                {"id": "not an id", "kind": "send", "state": "pending", "address": "t7", "text": "x"},
                {"id": "1793758569-c6b6", "kind": "mystery", "state": "pending", "text": "x"},
                {"id": "1793758699-7498", "kind": "send", "state": "pending", "address": "t7", "text": ""},
                "not even an object",
            ],
        })
    }

    fn rig(timeout: Duration) -> Rig {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("approve");
        crate::test_exe::write_exe(&bin, FAKE);
        let file = dir.path().join("needs-you.json");
        std::fs::write(&file, list_doc(now_ms()).to_string()).unwrap();
        let tailscale = dir.path().join("tailscale");
        crate::test_exe::write_exe(&tailscale, FAKE_TAILSCALE);

        let cfg = Config {
            login: "k@example.com".into(),
            allowed_nodes: vec![],
            tailnet: String::new(),
            tailscale: tailscale.to_string_lossy().into_owned(),
            machine: None,
            conn_idle: Duration::from_secs(180),
            ws_dead_after: Duration::from_secs(90),
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
        let mut state = AppState::new(cfg);
        state.needs = Needs::new(file, bin, timeout, false);
        state.needs.allow = test_allow();
        let code = state.auth.devices.begin_pair("phone").unwrap();
        let (_, token) = state.auth.devices.redeem(&code).unwrap();
        let ip: IpAddr = "100.64.0.1".parse().unwrap();
        // Admitted for the next minute, as a real request would leave it. What device it is gets asked again.
        state.auth.whois.put(ip, Ok(()));
        let r = Rig { dir, app: router().with_state(Arc::new(state)), token, ip, digest: raw_send().digest() };
        r.be("laptop");
        r
    }

    impl Rig {
        /// What tailscaled now says this source is.
        fn be(&self, node: &str) {
            let who = json!({"Node": {"Name": format!("{node}.example-tailnet.ts.net.")}, "UserProfile": {"LoginName": "k@example.com"}});
            std::fs::write(self.dir.path().join(format!("whois-{}", self.ip)), who.to_string()).unwrap();
        }
        #[cfg_attr(feature = "dev-identity", allow(dead_code))]
        async fn approve_access(&self) -> (StatusCode, Value) {
            self.call("POST", &format!("/api/assistant/drafts/{ACCESS}/approve"), Some(json!({"digest": raw_access().digest()})), true).await
        }
        async fn call(&self, method: &str, path: &str, body: Option<Value>, auth: bool) -> (StatusCode, Value) {
            let mut req = Request::builder().method(method).uri(path).header("content-type", "application/json");
            if auth {
                req = req.header("authorization", format!("Bearer {}", self.token));
            }
            let mut req = req.body(body.map_or_else(Body::empty, |b| Body::from(b.to_string()))).unwrap();
            req.extensions_mut().insert(ConnectInfo(SocketAddr::new(self.ip, 1)));
            let res = self.app.clone().oneshot(req).await.unwrap();
            let status = res.status();
            let bytes = axum::body::to_bytes(res.into_body(), 1 << 22).await.unwrap();
            (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
        }
        async fn approve(&self, id: &str) -> (StatusCode, Value) {
            self.call("POST", &format!("/api/assistant/drafts/{id}/approve"), Some(json!({"digest": self.digest})), true).await
        }
        fn calls(&self) -> Vec<String> {
            std::fs::read_to_string(self.dir.path().join("calls")).unwrap_or_default().lines().map(String::from).collect()
        }
        fn touch(&self, name: &str) {
            std::fs::write(self.dir.path().join(name), "").unwrap();
        }
    }

    fn rig10() -> Rig {
        rig(Duration::from_secs(10))
    }

    #[tokio::test]
    async fn every_handler_refuses_without_a_token_and_runs_nothing() {
        let r = rig10();
        for (method, path, body) in [
            ("GET", "/api/assistant/needs".to_string(), None),
            ("GET", format!("/api/assistant/drafts/{ID}"), None),
            ("POST", format!("/api/assistant/drafts/{ID}/approve"), Some(json!({"digest": r.digest}))),
            ("POST", format!("/api/assistant/drafts/{ID}/reject"), None),
        ] {
            let (status, _) = r.call(method, &path, body, false).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{method} {path}");
        }
        assert!(r.calls().is_empty());
    }

    #[tokio::test]
    async fn the_list_is_only_drafts_it_can_show_in_full_oldest_first() {
        let r = rig10();
        let (status, body) = r.call("GET", "/api/assistant/needs", None, true).await;
        assert_eq!(status, StatusCode::OK);
        let text = body.to_string();
        assert!(!text.contains("SCREEN TAIL"), "the needs rows stay out");
        assert!(!text.contains("machines"));
        let drafts = body["drafts"].as_array().unwrap();
        assert_eq!(drafts.iter().map(|d| d["id"].as_str().unwrap()).collect::<Vec<_>>(), [WORKER, ID, ACCESS]);
        assert_eq!(drafts[0]["to"], "tidy on runner");
        assert_eq!(drafts[0]["detail"], "/srv/x, new worktree, branch assistant/tidy");
        assert_eq!(drafts[0]["text"], "Tidy up");
        assert_eq!(drafts[1]["to"], "Lumbridge / Gateway");
        assert_eq!(drafts[1]["detail"], "t7");
        assert_eq!(drafts[1]["text"], "Run the tests");
        assert_eq!(drafts[1]["digest"], r.digest);
        assert_eq!(body["stale"], false);
        assert!(r.calls().is_empty(), "listing runs nothing");
    }

    #[tokio::test]
    async fn a_missing_file_or_tool_reads_as_nothing_pending() {
        let r = rig10();
        let file = r.dir.path().join("needs-you.json");
        let saved = std::fs::read(&file).unwrap();
        std::fs::remove_file(&file).unwrap();
        let (status, body) = r.call("GET", "/api/assistant/needs", None, true).await;
        assert_eq!((status, body), (StatusCode::OK, json!({"drafts": [], "stale": false, "approveHere": true})));
        let (status, body) = r.approve(ID).await;
        assert_eq!((status, body["error"].as_str()), (StatusCode::NOT_FOUND, Some("not_pending")));

        std::fs::write(&file, saved).unwrap();
        std::fs::remove_file(r.dir.path().join("approve")).unwrap();
        let (status, body) = r.call("GET", "/api/assistant/needs", None, true).await;
        assert_eq!((status, body), (StatusCode::OK, json!({"drafts": [], "stale": false, "approveHere": true})));
        let (status, body) = r.approve(ID).await;
        assert_eq!((status, body["error"].as_str()), (StatusCode::NOT_FOUND, Some("not_pending")));
    }

    #[tokio::test]
    async fn a_quiet_watcher_or_a_broken_file_says_stale() {
        let r = rig10();
        let file = r.dir.path().join("needs-you.json");
        std::fs::write(&file, list_doc(now_ms() - STALE_MS - 5000).to_string()).unwrap();
        let (_, body) = r.call("GET", "/api/assistant/needs", None, true).await;
        assert_eq!(body["stale"], true);
        assert_eq!(body["drafts"].as_array().unwrap().len(), 3, "still shown, and approving still checks the truth");
        std::fs::write(&file, "{ not json").unwrap();
        let (status, body) = r.call("GET", "/api/assistant/needs", None, true).await;
        assert_eq!((status, body), (StatusCode::OK, json!({"drafts": [], "stale": true, "approveHere": true})));
    }

    #[cfg(not(feature = "dev-identity"))]
    #[tokio::test]
    async fn approve_from_a_device_the_assistant_operates_is_refused_for_every_kind_and_runs_nothing() {
        for node in ["assistant-phone", "desk", "build-box"] {
            let r = rig10();
            r.be(node);
            for (status, body) in [r.approve(ID).await, r.approve_access().await] {
                assert_eq!((status, body["error"].as_str()), (StatusCode::FORBIDDEN, Some("not_from_here")), "{node}");
            }
            let (_, list) = r.call("GET", "/api/assistant/needs", None, true).await;
            assert_eq!(list["approveHere"], false, "{node}");
            assert_eq!(list["drafts"].as_array().unwrap().len(), 3, "{node}: still listed, to reject or approve elsewhere");
            assert!(r.calls().is_empty(), "{node}: the tool never ran");
        }
    }

    #[cfg(not(feature = "dev-identity"))]
    #[tokio::test]
    async fn approve_from_another_device_goes_for_every_kind() {
        let r = rig10();
        let (_, list) = r.call("GET", "/api/assistant/needs", None, true).await;
        assert_eq!(list["approveHere"], true);
        assert_eq!(r.approve(ID).await.0, StatusCode::OK);
        let (status, body) = r.approve_access().await;
        assert_eq!((status, &body), (StatusCode::OK, &json!({"state": "running", "repeat": false})));
        assert!(r.calls().contains(&format!("yes {ACCESS} --bg")));
    }

    #[tokio::test]
    async fn reject_works_from_every_device() {
        for node in ["assistant-phone", "desk", "build-box", "laptop"] {
            let r = rig10();
            r.be(node);
            for id in [ID, ACCESS] {
                let (status, body) = r.call("POST", &format!("/api/assistant/drafts/{id}/reject"), None, true).await;
                assert_eq!((status, &body), (StatusCode::OK, &json!({"state": "rejected", "repeat": false})), "{node} {id}");
            }
        }
    }

    #[cfg(not(feature = "dev-identity"))]
    #[tokio::test]
    async fn a_device_renamed_since_admission_is_judged_by_its_new_name() {
        // Admitted a moment ago as laptop, and the admission cache still says yes. Now it's build-box.
        let r = rig10();
        let (_, list) = r.call("GET", "/api/assistant/needs", None, true).await;
        assert_eq!(list["approveHere"], true);
        r.be("build-box");
        let (status, body) = r.approve(ID).await;
        assert_eq!((status, body["error"].as_str()), (StatusCode::FORBIDDEN, Some("not_from_here")));
        let (_, list) = r.call("GET", "/api/assistant/needs", None, true).await;
        assert_eq!(list["approveHere"], false);
        assert!(r.calls().is_empty());
    }

    #[cfg(not(feature = "dev-identity"))]
    #[tokio::test]
    async fn a_failed_lookup_means_no_approve() {
        let r = rig10();
        std::fs::remove_file(r.dir.path().join(format!("whois-{}", r.ip))).unwrap();
        let (status, body) = r.approve(ID).await;
        assert_eq!((status, body["error"].as_str()), (StatusCode::FORBIDDEN, Some("not_from_here")));
        let (_, list) = r.call("GET", "/api/assistant/needs", None, true).await;
        assert_eq!(list["approveHere"], false);
        assert!(r.calls().is_empty());
    }

    #[tokio::test]
    async fn approving_runs_the_tool_once_and_a_repeat_runs_nothing() {
        let r = rig10();
        let (status, body) = r.approve(ID).await;
        assert_eq!((status, &body), (StatusCode::OK, &json!({"state": "running", "repeat": false})));
        assert_eq!(r.calls(), [format!("show {ID}"), format!("yes {ID} --bg")]);
        // The list hasn't caught up; retry anyway.
        let (status, body) = r.approve(ID).await;
        assert_eq!((status, &body), (StatusCode::OK, &json!({"state": "running", "repeat": true})));
        assert_eq!(r.calls().len(), 2, "not run again");
        let (_, list) = r.call("GET", "/api/assistant/needs", None, true).await;
        assert_eq!(list["drafts"].as_array().unwrap().len(), 2, "gone from the list before the watcher notices");
    }

    #[tokio::test]
    async fn presses_at_the_same_moment_send_once() {
        let r = rig10();
        let (a, b, c) = tokio::join!(r.approve(ID), r.approve(ID), r.approve(ID));
        assert!([a.0, b.0, c.0].iter().all(|s| *s == StatusCode::OK));
        assert_eq!(r.calls().iter().filter(|c| c.starts_with("yes")).count(), 1);
    }

    #[tokio::test]
    async fn after_a_restart_the_files_are_still_the_truth() {
        // A fresh gateway remembers nothing, the list still shows it, and the draft already went.
        let r = rig10();
        std::fs::write(r.dir.path().join(format!("state-{ID}")), "running").unwrap();
        let (status, body) = r.approve(ID).await;
        assert_eq!((status, body["error"].as_str()), (StatusCode::CONFLICT, Some("already_handled")));
        assert!(!r.calls().iter().any(|c| c.starts_with("yes")));
    }

    #[tokio::test]
    async fn a_timed_out_approve_can_be_retried_and_still_sends_at_most_once() {
        // Short enough to show the timeout holds, long enough that the retry's two runs of the stand-in fit on a busy CI runner.
        let r = rig(Duration::from_millis(1500));
        r.touch("hang");
        let started = Instant::now();
        let (status, body) = r.approve(ID).await;
        assert_eq!((status, body["error"].as_str()), (StatusCode::GATEWAY_TIMEOUT, Some("timed_out")));
        assert!(started.elapsed() < Duration::from_secs(3), "the timeout holds");
        std::fs::remove_file(r.dir.path().join("hang")).unwrap();
        let (status, _) = r.approve(ID).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(r.calls().iter().filter(|c| c.starts_with("yes")).count(), 1);
    }

    #[tokio::test]
    async fn refuses_bad_ids_without_running_anything() {
        let r = rig10();
        for bad in ["..%2F..%2Fetc", "1793758374", "1793758374-EC32", "1793758374-ec3", "1793758374-ec32x", "-ec32", "a-ec32", "1793758374-ec32%20--bg", "%3Bid"] {
            let (status, body) = r.approve(bad).await;
            assert_eq!((status, body["error"].as_str()), (StatusCode::BAD_REQUEST, Some("bad_id")), "{bad}");
            let (status, _) = r.call("POST", &format!("/api/assistant/drafts/{bad}/reject"), None, true).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{bad}");
            let (status, _) = r.call("GET", &format!("/api/assistant/drafts/{bad}"), None, true).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{bad}");
        }
        let long = format!("{}-ec32", "1".repeat(MAX_ID));
        assert!(!valid_id(&long));
        assert!(valid_id(ID));
        assert!(r.calls().is_empty());
    }

    #[tokio::test]
    async fn refuses_an_id_that_isnt_in_the_file_without_running_anything() {
        let r = rig10();
        for id in ["1793759999-aaaa", "1793758439-f578" /* listed, but done */, "1793758569-c6b6" /* a kind it can't show */] {
            let (status, body) = r.approve(id).await;
            assert_eq!((status, body["error"].as_str()), (StatusCode::NOT_FOUND, Some("not_pending")), "{id}");
            let (status, _) = r.call("POST", &format!("/api/assistant/drafts/{id}/reject"), None, true).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{id}");
        }
        assert!(r.calls().is_empty());
    }

    #[tokio::test]
    async fn words_he_didnt_read_dont_go() {
        let r = rig10();
        // What the page was shown isn't what's asked for.
        let (status, body) = r.call("POST", &format!("/api/assistant/drafts/{ID}/approve"), Some(json!({"digest": "0".repeat(64)})), true).await;
        assert_eq!((status, body["error"].as_str()), (StatusCode::CONFLICT, Some("changed")));
        // The list says one thing and the draft on disk another: right digest for the list, wrong for the truth.
        std::fs::write(r.dir.path().join("show-says"), json!({"id": ID, "kind": "send", "state": "pending", "address": "t7", "text": "rm -rf"}).to_string()).unwrap();
        let (status, body) = r.approve(ID).await;
        assert_eq!((status, body["error"].as_str()), (StatusCode::CONFLICT, Some("changed")));
        // No digest at all.
        let (status, body) = r.call("POST", &format!("/api/assistant/drafts/{ID}/approve"), Some(json!({})), true).await;
        assert_eq!((status, body["error"].as_str()), (StatusCode::BAD_REQUEST, Some("bad_request")));
        assert!(!r.calls().iter().any(|c| c.starts_with("yes")));
    }

    fn json_of(d: &RawDraft) -> Value {
        json!({"id": d.id, "kind": d.kind, "state": d.state, "why": d.why, "created_ms": 5, "address": d.address, "name": d.name,
            "text": d.text, "sha256": d.sha256, "bytes": d.bytes, "fields": {"to": ["a@example.com"]}})
    }

    /// The rig, with only this draft in the list and in the approve command's files.
    fn rig_with(d: &RawDraft) -> Rig {
        let r = rig10();
        let mut doc = list_doc(now_ms());
        doc["drafts"] = json!([json_of(d)]);
        std::fs::write(r.dir.path().join("needs-you.json"), doc.to_string()).unwrap();
        std::fs::write(r.dir.path().join("show-says"), json_of(d).to_string()).unwrap();
        r
    }

    #[tokio::test]
    async fn every_new_kind_lists_and_approves_only_with_the_digest_he_read() {
        for kind in NEW_KINDS {
            let d = raw_new(kind);
            let r = rig_with(&d);
            let (_, list) = r.call("GET", "/api/assistant/needs", None, true).await;
            let listed = &list["drafts"][0];
            assert_eq!((listed["kind"].as_str(), listed["digest"].as_str()), (Some(kind), Some(d.digest().as_str())), "{kind}");
            assert!(listed.get("fields").is_none(), "{kind}: fields stay out");
            // The list and the page say one thing; the file now says another.
            let stale = d.digest();
            let mut changed = raw_new(kind);
            changed.text.push_str("\nAnd one more thing.");
            std::fs::write(r.dir.path().join("show-says"), json_of(&changed).to_string()).unwrap();
            let (status, body) = r.call("POST", &format!("/api/assistant/drafts/{}/approve", d.id), Some(json!({"digest": stale})), true).await;
            assert_eq!((status, body["error"].as_str()), (StatusCode::CONFLICT, Some("changed")), "{kind}");
            assert!(!r.calls().iter().any(|c| c.starts_with("yes")), "{kind}");
            // Back as the owner read it: it goes, once.
            std::fs::write(r.dir.path().join("show-says"), json_of(&d).to_string()).unwrap();
            let (status, _) = r.call("POST", &format!("/api/assistant/drafts/{}/approve", d.id), Some(json!({"digest": stale})), true).await;
            assert_eq!(status, StatusCode::OK, "{kind}");
            assert_eq!(r.calls().iter().filter(|c| **c == format!("yes {} --bg", d.id)).count(), 1, "{kind}");
        }
    }

    #[tokio::test]
    async fn a_malformed_or_unknown_draft_is_neither_listed_nor_approved() {
        for d in [
            RawDraft { address: "delete".into(), ..raw_new("resume") },
            RawDraft { name: "../x.png".into(), ..raw_new("ig_post") },
            RawDraft { sha256: "abc".into(), ..raw_new("ig_post") },
            RawDraft { name: String::new(), ..raw_new("mail_reply") },
            RawDraft { kind: "mail_forward".into(), ..raw_new("mail_reply") },
            RawDraft { address: "garage:logs/../x.md".into(), ..raw_new("service_record") },
        ] {
            let r = rig_with(&d);
            let (_, list) = r.call("GET", "/api/assistant/needs", None, true).await;
            assert_eq!(list["drafts"], json!([]), "{}", d.kind);
            let (status, _) = r.call("POST", &format!("/api/assistant/drafts/{}/approve", d.id), Some(json!({"digest": d.digest()})), true).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{}", d.kind);
            assert!(r.calls().is_empty(), "{}", d.kind);
        }
    }

    #[cfg(not(feature = "dev-identity"))]
    #[tokio::test]
    async fn every_new_kind_is_refused_from_a_device_the_assistant_operates_and_can_be_rejected_there() {
        for kind in NEW_KINDS {
            let d = raw_new(kind);
            let r = rig_with(&d);
            r.be("assistant-phone");
            let (status, body) = r.call("POST", &format!("/api/assistant/drafts/{}/approve", d.id), Some(json!({"digest": d.digest()})), true).await;
            assert_eq!((status, body["error"].as_str()), (StatusCode::FORBIDDEN, Some("not_from_here")), "{kind}");
            assert!(r.calls().is_empty(), "{kind}");
            let (status, _) = r.call("POST", &format!("/api/assistant/drafts/{}/reject", d.id), None, true).await;
            assert_eq!(status, StatusCode::OK, "{kind}");
        }
    }

    #[tokio::test]
    async fn a_stable_code_and_never_the_tools_words() {
        let r = rig10();
        r.touch("refuse");
        let (status, body) = r.approve(ID).await;
        assert_eq!((status, &body), (StatusCode::BAD_GATEWAY, &json!({"error": "failed"})));
        let (status, body) = r.call("POST", &format!("/api/assistant/drafts/{ID}/reject"), None, true).await;
        assert_eq!((status, &body), (StatusCode::BAD_GATEWAY, &json!({"error": "failed"})));
        // A failure isn't remembered as a decision: it can be tried again.
        std::fs::remove_file(r.dir.path().join("refuse")).unwrap();
        assert_eq!(r.approve(ID).await.0, StatusCode::OK);
        std::fs::write(r.dir.path().join(format!("state-{ID}")), "SECRET TOOL OUTPUT").unwrap();
        let (_, body) = r.call("GET", &format!("/api/assistant/drafts/{ID}"), None, true).await;
        assert_eq!(body, json!({"state": "failed"}), "an unknown state is a word we chose");
    }

    #[tokio::test]
    async fn reject_runs_no_and_can_be_repeated() {
        let r = rig10();
        let (status, body) = r.call("POST", &format!("/api/assistant/drafts/{ID}/reject"), None, true).await;
        assert_eq!((status, &body), (StatusCode::OK, &json!({"state": "rejected", "repeat": false})));
        assert_eq!(r.calls(), [format!("show {ID}"), format!("no {ID}")]);
        let (_, body) = r.call("POST", &format!("/api/assistant/drafts/{ID}/reject"), None, true).await;
        assert_eq!(body["repeat"], true);
        // Having said no, a yes doesn't undo it.
        let (status, body) = r.approve(ID).await;
        assert_eq!((status, body["error"].as_str()), (StatusCode::CONFLICT, Some("already_handled")));
        assert!(!r.calls().iter().any(|c| c.starts_with("yes")));
    }

    #[tokio::test]
    async fn status_is_a_word_and_handles_a_tool_that_cant_say() {
        let r = rig10();
        let (_, body) = r.call("GET", &format!("/api/assistant/drafts/{ID}"), None, true).await;
        assert_eq!(body, json!({"state": "pending"}));
        r.approve(ID).await;
        let (_, body) = r.call("GET", &format!("/api/assistant/drafts/{ID}"), None, true).await;
        assert_eq!(body, json!({"state": "running"}));
        r.touch("show-fails");
        let (status, body) = r.call("GET", &format!("/api/assistant/drafts/{ID}"), None, true).await;
        assert_eq!((status, body["error"].as_str()), (StatusCode::NOT_FOUND, Some("not_pending")));
    }

    #[tokio::test]
    async fn the_tool_gets_a_minimal_environment() {
        std::env::set_var("LUMBRIDGE_DATABASE_URL", "postgres://secret");
        let r = rig10();
        r.approve(ID).await;
        let seen = std::fs::read_to_string(r.dir.path().join("env")).unwrap();
        std::env::remove_var("LUMBRIDGE_DATABASE_URL");
        assert!(seen.contains("SECRET=unset"), "{seen}");
    }

    #[test]
    fn only_a_new_draft_is_news() {
        let mut known: HashSet<String> = ["a".to_string()].into();
        assert_eq!(fresh(&mut known, vec!["a".into(), "b".into()]), ["b"]);
        assert!(fresh(&mut known, vec!["a".into(), "b".into()]).is_empty());
        assert!(fresh(&mut known, vec![]).is_empty(), "it left the list");
        assert!(fresh(&mut known, vec!["b".into()]).is_empty(), "and coming back isn't new");
    }

    #[test]
    fn the_digest_covers_what_gets_acted_on_and_nothing_else() {
        let base = raw_send();
        let mut same = raw_send();
        same.why = "another reason".into();
        same.place = Some("elsewhere".into());
        same.state = "running".into();
        assert_eq!(base.digest(), same.digest());
        for change in [
            |d: &mut RawDraft| d.text = "Run the test".into(),
            |d: &mut RawDraft| d.address = "t8".into(),
            |d: &mut RawDraft| d.kind = "worker".into(),
            |d: &mut RawDraft| d.task = "x".into(),
            |d: &mut RawDraft| d.folder = "/x".into(),
            |d: &mut RawDraft| d.machine = "x".into(),
            |d: &mut RawDraft| d.name = "x".into(),
        ] {
            let mut d = raw_send();
            change(&mut d);
            assert_ne!(base.digest(), d.digest());
        }
    }
}
