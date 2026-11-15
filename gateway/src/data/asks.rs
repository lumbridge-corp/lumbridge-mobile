//! Asks: what the assistant needs from the owner, answered from the For you list at the top of Tasks. The assistant writes them
//! with `lumbridge-mobile-server asks create` (cli.rs); the owner accepts, denies or replies, once; the answer goes back to the
//! assistant in its pinned session (`voice::tell`), without holding up the tap.
//!
//! **Whose words are whose.** An ask's title and body were written by the assistant, and can carry text a stranger got to it. The
//! owner's reply is the one thing here that is really from the owner. So the assistant's words go back to it quoted, as its own
//! question, and only `reply` is passed on as the owner's; and none of the assistant's ever reaches a lock screen (push.rs).
//!
//! **Options.** An ask can carry up to 20 `options` (the roles it would apply for, say), and then the owner answers `pick` with the
//! keys of the ones they want (`picked`, status `accepted`), or `deny` for none of them, or replies. An option's words are the
//! assistant's and can quote a posting a stranger wrote: the app shows them as text only, and a link only if it's `https:`.
//!
//! **Nothing said gets lost, and nothing goes twice.** The answer is saved first. Delivery then sets `delivered_at` once Hermes has
//! taken it, and `watcher` retries whatever has `answered_at` and no `delivered_at`, so a Hermes restart or a gateway restart loses
//! nothing. One delivery per ask is in flight at a time (`Relay::sending`); if Hermes took one and recording that failed, only the
//! record is retried (`Relay::told`). The one gap left is the gateway dying between Hermes taking an answer and the write, which
//! sends that answer again after the restart.

use super::{check_text, db::Db, ApiError, ApiResult};
use crate::{auth::Device, AppState};
use axum::{
    extract::{rejection::JsonRejection, ConnectInfo, Path, Query, State},
    http::StatusCode,
    Extension, Json,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::HashSet,
    net::SocketAddr,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio_postgres::{Client, Row, Transaction};
use uuid::Uuid;

const COLUMNS: &str =
    "id, title, body, status, reply, answered_at, delivered_at, created_at, updated_at, version, options::text as options, picked";
/// Characters: one short line on a phone.
pub const MAX_TITLE_CHARS: usize = 120;
const MAX_BODY_CHARS: usize = 20_000;
/// What one turn to Hermes may hold (voice.rs takes 16 000 from the owner), less room for the words around it.
const MAX_REPLY_CHARS: usize = 15_000;
/// More than this waiting is a confused agent, not a day's questions.
pub const MAX_PENDING: i64 = 20;
pub const MAX_OPTIONS: usize = 20;
const MAX_KEY_CHARS: usize = 40;
const MAX_LABEL_CHARS: usize = 120;
const MAX_DETAIL_CHARS: usize = 400;
const MAX_LINK_CHARS: usize = 500;
const ANSWERED_LIMIT: i64 = 50;
/// Only `asks create` takes it, so two at once can't both see 19 waiting.
const CREATE_LOCK: i64 = 0x006b_6172_7469_6173;
const TICK: Duration = Duration::from_secs(5);
const RETRY_EVERY: Duration = Duration::from_secs(30);

#[derive(Serialize, Debug)]
pub struct Ask {
    pub id: Uuid,
    pub title: String,
    pub body: String,
    pub status: String,
    pub reply: Option<String>,
    pub answered_at: Option<DateTime<Utc>>,
    pub delivered_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub version: i32,
    /// Null for a plain ask.
    pub options: Option<Vec<Choice>>,
    /// The keys the owner picked, when the owner answered `pick`.
    pub picked: Option<Vec<String>>,
}

/// One of an ask's options, as the assistant wrote it.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Choice {
    pub key: String,
    pub label: String,
    #[serde(default)]
    pub detail: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
}

fn options_of(r: &Row) -> Option<Vec<Choice>> {
    r.get::<_, Option<String>>("options").and_then(|s| serde_json::from_str(&s).ok())
}

impl From<Row> for Ask {
    fn from(r: Row) -> Self {
        Self {
            id: r.get("id"),
            title: r.get("title"),
            body: r.get("body"),
            status: r.get("status"),
            reply: r.get("reply"),
            answered_at: r.get("answered_at"),
            delivered_at: r.get("delivered_at"),
            created_at: r.get("created_at"),
            updated_at: r.get("updated_at"),
            version: r.get("version"),
            options: options_of(&r),
            picked: r.get("picked"),
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AsksQuery {
    /// `1` adds what was answered in the last week, newest answer first, after the pending ones.
    answered: Option<String>,
}

/// Pending, newest first: the list the owner works through.
pub async fn list(_: Device, Extension(db): Extension<Db>, Query(q): Query<AsksQuery>) -> ApiResult<Json<Vec<Ask>>> {
    let sql = format!("select {COLUMNS} from asks where status = 'pending' order by created_at desc, id");
    let mut asks: Vec<Ask> = db.query(&sql, &[]).await?.into_iter().map(Ask::from).collect();
    if matches!(q.answered.as_deref(), Some("1" | "true")) {
        let sql = format!(
            "select {COLUMNS} from asks where answered_at > now() - interval '7 days'
             order by answered_at desc, id limit $1"
        );
        asks.extend(db.query(&sql, &[&ANSWERED_LIMIT]).await?.into_iter().map(Ask::from));
    }
    Ok(Json(asks))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Answer {
    verdict: String,
    #[serde(default)]
    text: Option<String>,
    /// For `pick`: which of the ask's options.
    #[serde(default)]
    keys: Option<Vec<String>>,
}

/// What an answer leaves: the status, the owner's words if it's a reply, and the keys if the owner picked.
#[derive(Debug, PartialEq)]
struct Verdict {
    status: &'static str,
    reply: Option<String>,
    picked: Option<Vec<String>>,
}

/// `options` is the ask's option keys, or None for a plain ask.
fn check_answer(a: &Answer, options: Option<&[String]>) -> ApiResult<Verdict> {
    let text = a.text.as_deref().map(str::trim).unwrap_or("");
    let bad_keys = || ApiError::Refused(StatusCode::BAD_REQUEST, "bad_keys");
    let status = match a.verdict.as_str() {
        "accept" | "pick" => "accepted",
        "deny" => "denied",
        "reply" => "replied",
        _ => return Err(ApiError::Invalid("invalid_verdict")),
    };
    if status != "replied" && !text.is_empty() {
        // Words with a yes or a no would be dropped without the owner's knowing. A reply is how the owner says more.
        return Err(ApiError::Invalid("text_needs_reply"));
    }
    if a.verdict == "pick" {
        let (Some(options), Some(keys)) = (options, &a.keys) else { return Err(bad_keys()) };
        let unique: HashSet<&String> = keys.iter().collect();
        if keys.is_empty() || unique.len() != keys.len() || !keys.iter().all(|k| options.contains(k)) {
            return Err(bad_keys());
        }
        return Ok(Verdict { status, reply: None, picked: Some(keys.clone()) });
    }
    if a.keys.is_some() {
        return Err(bad_keys());
    }
    if a.verdict == "accept" && options.is_some() {
        // A yes to a list says nothing: the owner picks which, or none of them.
        return Err(ApiError::Refused(StatusCode::BAD_REQUEST, "pick_which"));
    }
    if status != "replied" {
        return Ok(Verdict { status, reply: None, picked: None });
    }
    if text.is_empty() {
        return Err(ApiError::Invalid("empty_reply"));
    }
    if text.chars().count() > MAX_REPLY_CHARS {
        return Err(ApiError::Invalid("reply_too_long"));
    }
    check_text(text, usize::MAX, "reply_too_long")?;
    Ok(Verdict { status, reply: Some(text.to_string()), picked: None })
}

pub async fn answer(
    _: Device,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    State(state): State<Arc<AppState>>,
    Extension(db): Extension<Db>,
    Path(id): Path<Uuid>,
    body: Result<Json<Answer>, JsonRejection>,
) -> ApiResult<Json<Ask>> {
    // The assistant can operate these devices, so it could otherwise answer its own question. Before anything else, as with Approve.
    if !crate::reach::from_owners_hands(&state, peer.map(|Extension(ConnectInfo(addr))| addr)).await {
        return Err(ApiError::Refused(StatusCode::FORBIDDEN, "not_from_here"));
    }
    let Json(body) = body.map_err(|_| ApiError::Invalid("bad_request"))?;
    // An ask's options never change, so what they are now is what they are when the answer lands.
    let Some(row) = db.one("select options::text as options from asks where id = $1", &[&id]).await? else {
        return Err(ApiError::NotFound);
    };
    let keys: Option<Vec<String>> = options_of(&row).map(|o| o.into_iter().map(|c| c.key).collect());
    let Verdict { status, reply, picked } = check_answer(&body, keys.as_deref())?;
    let sql = format!(
        "update asks set status = $2, reply = $3, picked = $4, answered_at = now(), updated_at = now(), version = version + 1
         where id = $1 and status = 'pending' returning {COLUMNS}"
    );
    let Some(row) = db.one(&sql, &[&id, &status, &reply, &picked]).await? else {
        // Answered already, from here or another device: that answer stands, and the client sees it.
        let current = db.one(&format!("select {COLUMNS} from asks where id = $1"), &[&id]).await?;
        let Some(current) = current else { return Err(ApiError::NotFound) };
        return Err(ApiError::Conflict(json!({ "error": "already_answered", "ask": Ask::from(current) })));
    };
    let ask = Ask::from(row);
    send_answer(&state, &db, Answered::of(&ask));
    Ok(Json(ask))
}

// ---- telling the assistant ---------------------------------------------------------------------------------------------

/// What goes back to her about one answer.
#[derive(Clone, Debug)]
struct Answered {
    id: Uuid,
    title: String,
    status: String,
    reply: Option<String>,
    /// Whether the ask had options: a deny then means none of them.
    options: bool,
    picked: Option<Vec<String>>,
}

impl Answered {
    fn of(a: &Ask) -> Self {
        Self {
            id: a.id,
            title: a.title.clone(),
            status: a.status.clone(),
            reply: a.reply.clone(),
            options: a.options.is_some(),
            picked: a.picked.clone(),
        }
    }
}

/// The title is hers, so it's quoted as her question. `reply` is the owner's own words, the only ones here.
fn message(a: &Answered) -> String {
    let verdict = match (a.status.as_str(), &a.reply, &a.picked) {
        ("replied", Some(reply), _) => format!("replied: {reply}"),
        ("accepted", _, Some(picked)) => format!("picked {}.", picked.join(", ")),
        ("accepted", _, None) => "accepted.".into(),
        _ if a.options => "none of these.".into(),
        _ => "denied.".into(),
    };
    format!("{} answered your question \"{}\": {verdict}", crate::config::owner_name().unwrap_or("The owner"), a.title)
}


#[derive(Default)]
pub struct Relay {
    /// Answers on their way to Hermes now, so the tap that answered and the retry can't both send one.
    sending: Mutex<HashSet<Uuid>>,
    /// Hermes took these and writing `delivered_at` failed: only the write is retried, never the send.
    told: Mutex<HashSet<Uuid>>,
}

/// Sends it on its own task, unless it's already on its way.
fn send_answer(state: &Arc<AppState>, db: &Db, a: Answered) {
    if !state.asks.sending.lock().unwrap().insert(a.id) {
        return;
    }
    let (state, db) = (state.clone(), db.clone());
    tokio::spawn(async move {
        deliver(&state, &db, &a).await;
        state.asks.sending.lock().unwrap().remove(&a.id);
    });
}

async fn deliver(state: &AppState, db: &Db, a: &Answered) {
    let told = state.asks.told.lock().unwrap().contains(&a.id);
    if !told {
        if crate::voice::tell(&state.voice, &message(a)).await.is_err() {
            return; // the retry has it
        }
        state.asks.told.lock().unwrap().insert(a.id);
    }
    let marked = db.one("update asks set delivered_at = now() where id = $1 and delivered_at is null returning id", &[&a.id]).await;
    if marked.is_ok() {
        state.asks.told.lock().unwrap().remove(&a.id);
    }
}

pub(super) fn env_ms(name: &str, default: Duration) -> Duration {
    std::env::var(name).ok().and_then(|v| v.parse::<u64>().ok()).map_or(default, |ms| Duration::from_millis(ms.max(50)))
}

/// Buzzes once for each new ask, and sends again what hasn't reached the assistant. Like drafts, what's waiting when the gateway starts
/// isn't news. `LUMBRIDGE_ASKS_TICK_MS` and `LUMBRIDGE_ASKS_RETRY_MS` are for tests.
pub async fn watcher(state: Arc<AppState>) {
    let tick = env_ms("LUMBRIDGE_ASKS_TICK_MS", TICK);
    let retry_every = env_ms("LUMBRIDGE_ASKS_RETRY_MS", RETRY_EVERY);
    let db = state.db.clone();
    let mut known: Option<HashSet<Uuid>> = None;
    let mut retried: Option<Instant> = None;
    loop {
        if let Ok(rows) = db.query("select id from asks where status = 'pending'", &[]).await {
            let ids: HashSet<Uuid> = rows.iter().map(|r| r.get(0)).collect();
            if let Some(before) = &known {
                for id in ids.difference(before) {
                    crate::push::ask_arrived(&state, &id.to_string());
                }
            }
            // An ask never goes back to pending, so what has left can be forgotten.
            known = Some(ids);
        }
        if retried.is_none_or(|at| at.elapsed() >= retry_every) {
            retried = Some(Instant::now());
            let sql = "select id, title, status, reply, options is not null, picked from asks
                       where answered_at is not null and delivered_at is null order by answered_at limit 50";
            if let Ok(rows) = db.query(sql, &[]).await {
                for r in rows {
                    let a = Answered { id: r.get(0), title: r.get(1), status: r.get(2), reply: r.get(3), options: r.get(4), picked: r.get(5) };
                    send_answer(&state, &db, a);
                }
            }
        }
        tokio::time::sleep(tick).await;
    }
}

// ---- for the assistant: cli.rs -----------------------------------------------------------------------------------------

/// A new ask as she wrote it, or why not. The title is shown on one line, in full, so it must be one.
pub fn check_new(title: &str, body: &str, options: Option<Vec<Choice>>) -> Result<(String, String, Option<Vec<Choice>>), String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("the title is empty".into());
    }
    if title.chars().count() > MAX_TITLE_CHARS {
        return Err(format!("the title is over {MAX_TITLE_CHARS} characters"));
    }
    if title.chars().any(char::is_control) {
        return Err("the title must be one line".into());
    }
    if body.chars().count() > MAX_BODY_CHARS {
        return Err(format!("the body is over {MAX_BODY_CHARS} characters"));
    }
    if body.contains('\0') {
        return Err("the body holds a NUL".into());
    }
    let options = options.map(check_options).transpose()?;
    Ok((title.to_string(), body.trim_end().to_string(), options))
}

/// An ask's options, trimmed, or why not. db/005_ask_options.sql holds the same rules.
pub fn check_options(options: Vec<Choice>) -> Result<Vec<Choice>, String> {
    if options.is_empty() || options.len() > MAX_OPTIONS {
        return Err(format!("options must be 1 to {MAX_OPTIONS}"));
    }
    let mut keys = HashSet::new();
    let mut out = Vec::with_capacity(options.len());
    for c in options {
        let (key, label, detail) = (c.key.trim().to_string(), c.label.trim().to_string(), c.detail.trim().to_string());
        let line = |s: &str, what: &str, max: usize| {
            if s.is_empty() {
                Err(format!("an option's {what} is empty"))
            } else if s.chars().count() > max {
                Err(format!("an option's {what} is over {max} characters"))
            } else if s.chars().any(char::is_control) {
                Err(format!("an option's {what} must be one line"))
            } else {
                Ok(())
            }
        };
        line(&key, "key", MAX_KEY_CHARS)?;
        line(&label, "label", MAX_LABEL_CHARS)?;
        if detail.chars().count() > MAX_DETAIL_CHARS {
            return Err(format!("an option's detail is over {MAX_DETAIL_CHARS} characters"));
        }
        if detail.contains('\0') {
            return Err("an option's detail holds a NUL".into());
        }
        let link = c.link.map(|l| l.trim().to_string());
        if let Some(l) = &link {
            if !is_https_link(l) {
                return Err(format!("an option's link must be an https:// URL of at most {MAX_LINK_CHARS} characters"));
            }
        }
        if !keys.insert(key.clone()) {
            return Err(format!("two options have the key {key:?}"));
        }
        out.push(Choice { key, label, detail, link });
    }
    Ok(out)
}

/// `https://`, a host, and nothing a browser would read past: no spaces or control characters.
fn is_https_link(l: &str) -> bool {
    let Some(rest) = l.strip_prefix("https://") else { return false };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    l.chars().count() <= MAX_LINK_CHARS && !host.is_empty() && !l.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// `lumbridge-mobile-server asks create`. Refuses past `MAX_PENDING` waiting, under a lock so two at once can't both get in.
pub async fn create(client: &mut Client, title: &str, body: &str, options: Option<Vec<Choice>>) -> Result<Ask, String> {
    let (title, body, options) = check_new(title, body, options)?;
    let options = options.map(|o| serde_json::to_string(&o)).transpose().map_err(|e| e.to_string())?;
    let describe = super::migrate::describe;
    let tx = client.transaction().await.map_err(describe)?;
    tx.execute("select pg_advisory_xact_lock($1)", &[&CREATE_LOCK]).await.map_err(describe)?;
    let waiting: i64 = tx.query_one("select count(*) from asks where status = 'pending'", &[]).await.map_err(describe)?.get(0);
    if waiting >= MAX_PENDING {
        return Err(format!("{waiting} asks are already waiting for the owner; at most {MAX_PENDING} can be"));
    }
    let sql = format!("insert into asks (title, body, options) values ($1, $2, $3::text::jsonb) returning {COLUMNS}");
    let row = tx.query_one(&sql, &[&title, &body, &options]).await.map_err(describe)?;
    tx.commit().await.map_err(describe)?;
    Ok(row.into())
}

/// `lumbridge-mobile-server asks recent`, newest first. Only ever called inside the read-only transaction in cli.rs.
pub async fn recent(tx: &Transaction<'_>, limit: i64) -> Result<Vec<Ask>, tokio_postgres::Error> {
    let sql = format!("select {COLUMNS} from asks order by created_at desc, id limit $1");
    Ok(tx.query(&sql, &[&limit]).await?.into_iter().map(Ask::from).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn answer(verdict: &str, text: Option<&str>) -> Answer {
        Answer { verdict: verdict.into(), text: text.map(String::from), keys: None }
    }

    fn pick(keys: &[&str]) -> Answer {
        Answer { verdict: "pick".into(), text: None, keys: Some(keys.iter().map(|k| k.to_string()).collect()) }
    }

    fn code(a: Answer, options: Option<&[String]>) -> &'static str {
        match check_answer(&a, options) {
            Err(ApiError::Invalid(code)) => code,
            Err(ApiError::Refused(StatusCode::BAD_REQUEST, code)) => code,
            other => panic!("{other:?}"),
        }
    }

    fn plain(status: &'static str, reply: Option<&str>) -> Verdict {
        Verdict { status, reply: reply.map(String::from), picked: None }
    }

    #[test]
    fn answers_each_way_and_a_reply_needs_words() {
        assert_eq!(check_answer(&answer("accept", None), None).unwrap(), plain("accepted", None));
        assert_eq!(check_answer(&answer("deny", Some("  ")), None).unwrap(), plain("denied", None));
        assert_eq!(check_answer(&answer("reply", Some(" Thursday, after 3 \n")), None).unwrap(), plain("replied", Some("Thursday, after 3")));
        assert_eq!(code(answer("reply", None), None), "empty_reply");
        assert_eq!(code(answer("reply", Some(" \n ")), None), "empty_reply");
        assert_eq!(code(answer("accept", Some("but only if")), None), "text_needs_reply");
        assert_eq!(code(answer("maybe", None), None), "invalid_verdict");
        assert_eq!(code(answer("reply", Some(&"x".repeat(MAX_REPLY_CHARS + 1))), None), "reply_too_long");
        assert_eq!(code(answer("reply", Some("a\0b")), None), "invalid_text");
    }

    #[test]
    fn a_pick_names_some_of_the_options_and_nothing_else() {
        let keys: Vec<String> = ["459", "436", "12"].iter().map(|k| k.to_string()).collect();
        let options = Some(keys.as_slice());
        assert_eq!(
            check_answer(&pick(&["459", "12"]), options).unwrap(),
            Verdict { status: "accepted", reply: None, picked: Some(vec!["459".into(), "12".into()]) }
        );
        assert_eq!(code(pick(&[]), options), "bad_keys");
        assert_eq!(code(pick(&["459", "459"]), options), "bad_keys");
        assert_eq!(code(pick(&["459", "999"]), options), "bad_keys");
        assert_eq!(code(answer("pick", None), options), "bad_keys");
        assert_eq!(code(pick(&["459"]), None), "bad_keys", "a plain ask has nothing to pick");
        assert_eq!(code(answer("accept", None), options), "pick_which");
        let mut deny_with_keys = pick(&["459"]);
        deny_with_keys.verdict = "deny".into();
        assert_eq!(code(deny_with_keys, options), "bad_keys");
        assert_eq!(check_answer(&answer("deny", None), options).unwrap(), plain("denied", None));
        assert_eq!(check_answer(&answer("reply", Some("Only the first")), options).unwrap(), plain("replied", Some("Only the first")));
        let mut words = pick(&["459"]);
        words.text = Some("and draft fast".into());
        assert_eq!(code(words, options), "text_needs_reply");
    }

    #[test]
    fn what_the_assistant_hears() {
        let a = |status: &str, reply: Option<&str>| Answered {
            id: Uuid::nil(),
            title: "Book the dentist for Thursday?".into(),
            status: status.into(),
            reply: reply.map(String::from),
            options: false,
            picked: None,
        };
        assert_eq!(message(&a("accepted", None)), "The owner answered your question \"Book the dentist for Thursday?\": accepted.");
        assert_eq!(message(&a("denied", None)), "The owner answered your question \"Book the dentist for Thursday?\": denied.");
        assert_eq!(
            message(&a("replied", Some("Friday instead"))),
            "The owner answered your question \"Book the dentist for Thursday?\": replied: Friday instead"
        );
        let listed = |status: &str, picked: Option<&[&str]>| Answered {
            title: "Pick roles for your first applications".into(),
            options: true,
            picked: picked.map(|p| p.iter().map(|k| k.to_string()).collect()),
            ..a(status, None)
        };
        assert_eq!(message(&listed("accepted", Some(&["459", "436"]))), "The owner answered your question \"Pick roles for your first applications\": picked 459, 436.");
        assert_eq!(message(&listed("denied", None)), "The owner answered your question \"Pick roles for your first applications\": none of these.");
    }

    #[test]
    fn a_new_ask_is_one_short_line() {
        assert_eq!(check_new("  Call the bank?  ", "Body\n\n", None).unwrap(), ("Call the bank?".into(), "Body".into(), None));
        assert!(check_new(" \n", "", None).unwrap_err().contains("empty"));
        assert!(check_new(&"x".repeat(MAX_TITLE_CHARS + 1), "", None).unwrap_err().contains("120"));
        assert!(check_new(&"é".repeat(MAX_TITLE_CHARS), "", None).is_ok(), "characters, not bytes");
        assert!(check_new("two\nlines", "", None).unwrap_err().contains("one line"));
        assert!(check_new("ok", &"x".repeat(MAX_BODY_CHARS + 1), None).is_err());
        assert!(check_new("ok", "a\0b", None).is_err());
    }

    fn choice(key: &str, label: &str, link: Option<&str>) -> Choice {
        Choice { key: key.into(), label: label.into(), detail: String::new(), link: link.map(String::from) }
    }

    #[test]
    fn options_are_checked_and_trimmed() {
        let ok = check_options(vec![
            Choice { detail: " Remote, EU hours \n".into(), ..choice(" 459 ", " Platform engineer ", Some("https://jobs.example.com/459?ref=x")) },
            choice("436", "SRE", None),
        ])
        .unwrap();
        assert_eq!(ok[0], Choice { key: "459".into(), label: "Platform engineer".into(), detail: "Remote, EU hours".into(), link: Some("https://jobs.example.com/459?ref=x".into()) });
        let err = |o: Vec<Choice>| check_options(o).unwrap_err();
        assert!(err(vec![]).contains("1 to 20"));
        assert!(err((0..21).map(|i| choice(&i.to_string(), "x", None)).collect()).contains("1 to 20"));
        assert!(check_options((0..20).map(|i| choice(&i.to_string(), "x", None)).collect()).is_ok());
        assert!(err(vec![choice("a", "x", None), choice(" a", "y", None)]).contains("two options"));
        assert!(err(vec![choice(" ", "x", None)]).contains("key is empty"));
        assert!(err(vec![choice(&"k".repeat(41), "x", None)]).contains("40"));
        assert!(check_options(vec![choice(&"é".repeat(40), "x", None)]).is_ok(), "characters, not bytes");
        assert!(err(vec![choice("a", "", None)]).contains("label is empty"));
        assert!(err(vec![choice("a", &"x".repeat(121), None)]).contains("120"));
        assert!(err(vec![choice("a", "two\nlines", None)]).contains("one line"));
        assert!(err(vec![Choice { detail: "x".repeat(401), ..choice("a", "x", None) }]).contains("400"));
        for bad in ["http://jobs.example.com/1", "javascript:alert(1)", "https://", "https:///path", "https://a b", "//jobs.example.com", "https://x\ty.com"] {
            assert!(err(vec![choice("a", "x", Some(bad))]).contains("https://"), "{bad:?}");
        }
        assert!(err(vec![choice("a", "x", Some(&format!("https://x.com/{}", "p".repeat(490))))]).contains("500"));
    }

    #[cfg(not(feature = "dev-identity"))]
    #[tokio::test]
    async fn an_answer_from_a_device_the_assistant_operates_is_refused_before_anything_else() {
        use crate::config::Config;
        use axum::{body::Body, http::Request};
        use tower::ServiceExt;
        let dir = tempfile::tempdir().unwrap();
        // `tailscale whois` as a file per address, as in needs.rs.
        let tailscale = dir.path().join("tailscale");
        crate::test_exe::write_exe(&tailscale, "#!/bin/sh\n[ \"$1 $2\" = \"whois --json\" ] && exec cat \"$(dirname \"$0\")/whois-$3\"\nexit 9\n");
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
        let state = AppState::new(cfg);
        let code = state.auth.devices.begin_pair("phone").unwrap();
        let (_, token) = state.auth.devices.redeem(&code).unwrap();
        let ip = "100.64.0.1";
        state.auth.whois.put(ip.parse().unwrap(), Ok(()));
        // No database: an answer that got past the check would be a 503.
        let app = super::super::router(Db::none()).with_state(Arc::new(state));
        let call = |node: &str, answer: serde_json::Value| {
            let who = json!({"Node": {"Name": format!("{node}.example-tailnet.ts.net.")}, "UserProfile": {"LoginName": "k@example.com"}});
            std::fs::write(dir.path().join(format!("whois-{ip}")), who.to_string()).unwrap();
            let mut req = Request::builder()
                .method("POST")
                .uri(format!("/api/asks/{}/answer", Uuid::new_v4()))
                .header("content-type", "application/json")
                .header("authorization", format!("Bearer {token}"))
                .body(Body::from(answer.to_string()))
                .unwrap();
            req.extensions_mut().insert(ConnectInfo(SocketAddr::new(ip.parse().unwrap(), 1)));
            app.clone().oneshot(req)
        };
        // Pick these and None of these the same as the rest.
        let answers = [json!({"verdict": "accept"}), json!({"verdict": "pick", "keys": ["459"]}), json!({"verdict": "deny"})];
        for node in ["assistant-phone", "desk", "build-box"] {
            for answer in &answers {
                let res = call(node, answer.clone()).await.unwrap();
                assert_eq!(res.status(), StatusCode::FORBIDDEN, "{node} {answer}");
                let body = axum::body::to_bytes(res.into_body(), 1 << 16).await.unwrap();
                assert_eq!(serde_json::from_slice::<serde_json::Value>(&body).unwrap(), json!({"error": "not_from_here"}), "{node}");
            }
        }
        for answer in &answers {
            assert_eq!(call("laptop", answer.clone()).await.unwrap().status(), StatusCode::SERVICE_UNAVAILABLE, "the laptop gets as far as the database");
        }
    }
}
