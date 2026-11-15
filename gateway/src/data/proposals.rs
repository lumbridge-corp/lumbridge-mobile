//! Note proposals: notes an agent thinks the owner should keep. Agents (Claude Code over MCP, mcp.rs; the assistant with
//! `lumbridge-mobile-server proposals create`) write them; the owner keeps, edits and keeps, or drops each one from For you. A proposal
//! does nothing until it's kept, and keeping it makes the note in the same transaction.
//!
//! **Whose words are whose.** Everything in a proposal but `proposed_by` was written by an agent, and can quote a stranger: as with
//! an ask (asks.rs), none of it reaches a lock screen. A push says only how many are waiting (push.rs). `proposed_by` is the
//! device the gateway authenticated, never anything the request said: `NewProposal` has no such field, and refuses one.
//!
//! **Bounded.** At most `MAX_PENDING` wait at once, across every agent, so one stuck in a loop can't bury For you.

use super::{
    check_text,
    db::{pg_error, timed, Db},
    notes::{self, Note},
    ApiError, ApiResult, MAX_TEXT, MAX_TITLE,
};
use crate::{auth::Caller, devices::Role, AppState};
use axum::{
    extract::{rejection::JsonRejection, ConnectInfo, Path, Query, State},
    http::StatusCode,
    Extension, Json,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashSet, net::SocketAddr, sync::Arc, time::Duration};
use tokio_postgres::{Row, Transaction};
use uuid::Uuid;

const COLUMNS: &str = "id, title, body, why, source, proposed_by, status, note_id, decided_at, created_at, updated_at, version";
/// Characters. db/006_note_proposals.sql holds the same limits.
pub const MAX_TITLE_CHARS: usize = 200;
pub const MAX_BODY_CHARS: usize = 20_000;
pub const MAX_WHY_CHARS: usize = 1000;
pub const MAX_SOURCE_CHARS: usize = 1000;
/// Waiting at once, from every agent together. More is a loop, not a day's ideas.
pub const MAX_PENDING: i64 = 30;
const DEFAULT_LIMIT: i64 = 50;
const MAX_LIMIT: i64 = 200;
/// Only `create` takes it, so two at once can't both see 29 waiting.
const CREATE_LOCK: i64 = 0x006e_6f74_6573_7072;
const TICK: Duration = Duration::from_secs(5);

#[derive(Serialize, Debug, Clone)]
pub struct Proposal {
    pub id: Uuid,
    pub title: String,
    pub body: String,
    pub why: String,
    pub source: String,
    pub proposed_by: String,
    pub status: String,
    pub note_id: Option<Uuid>,
    pub decided_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub version: i32,
}

impl From<Row> for Proposal {
    fn from(r: Row) -> Self {
        Self {
            id: r.get("id"),
            title: r.get("title"),
            body: r.get("body"),
            why: r.get("why"),
            source: r.get("source"),
            proposed_by: r.get("proposed_by"),
            status: r.get("status"),
            note_id: r.get("note_id"),
            decided_at: r.get("decided_at"),
            created_at: r.get("created_at"),
            updated_at: r.get("updated_at"),
            version: r.get("version"),
        }
    }
}

/// What an agent sends. There is no `proposed_by`: who sent it is the device, and a body that says otherwise is refused.
#[derive(Deserialize, Debug, Clone)]
#[serde(deny_unknown_fields)]
pub struct NewProposal {
    /// Lets an agent retry after a lost response without proposing twice.
    #[serde(default)]
    pub id: Option<Uuid>,
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub why: String,
    #[serde(default)]
    pub source: String,
}

/// Why a proposal wasn't made: a code for the API, and words for an agent to read.
#[derive(Debug)]
pub enum Fail {
    Invalid(&'static str, String),
    TooManyPending(i64),
    /// The id is another device's proposal.
    IdTaken,
    Db(ApiError),
}

impl From<tokio_postgres::Error> for Fail {
    fn from(e: tokio_postgres::Error) -> Self {
        Fail::Db(pg_error(e))
    }
}

impl From<ApiError> for Fail {
    fn from(e: ApiError) -> Self {
        Fail::Db(e)
    }
}

impl From<Fail> for ApiError {
    fn from(f: Fail) -> Self {
        match f {
            Fail::Invalid(code, _) => ApiError::Invalid(code),
            Fail::TooManyPending(_) => ApiError::Refused(StatusCode::TOO_MANY_REQUESTS, "too_many_pending"),
            Fail::IdTaken => ApiError::Refused(StatusCode::CONFLICT, "id_taken"),
            Fail::Db(e) => e,
        }
    }
}

impl Fail {
    pub fn message(&self) -> String {
        match self {
            Fail::Invalid(_, why) => why.clone(),
            Fail::TooManyPending(n) => {
                format!("{n} note proposals are already waiting for the owner; at most {MAX_PENDING} can be. Try again after they have been gone through.")
            }
            Fail::IdTaken => "that id belongs to another device's proposal".into(),
            Fail::Db(ApiError::Unavailable) => "The notes database isn't reachable right now".into(),
            Fail::Db(_) => "the database refused that".into(),
        }
    }
}

/// A new proposal, trimmed, or why not.
pub fn check_new(n: &NewProposal) -> Result<NewProposal, Fail> {
    let bad = |code, why: String| Err(Fail::Invalid(code, why));
    let title = n.title.trim();
    if title.is_empty() {
        return bad("empty_title", "the title is empty".into());
    }
    if title.chars().count() > MAX_TITLE_CHARS {
        return bad("title_too_long", format!("the title is over {MAX_TITLE_CHARS} characters"));
    }
    if title.chars().any(char::is_control) {
        return bad("title_not_one_line", "the title must be one line".into());
    }
    let body = n.body.trim();
    if body.is_empty() {
        return bad("empty_body", "the body is empty".into());
    }
    if body.chars().count() > MAX_BODY_CHARS {
        return bad("body_too_long", format!("the body is over {MAX_BODY_CHARS} characters"));
    }
    let why = n.why.trim();
    if why.chars().count() > MAX_WHY_CHARS {
        return bad("why_too_long", format!("why is over {MAX_WHY_CHARS} characters"));
    }
    let source = n.source.trim();
    if source.chars().count() > MAX_SOURCE_CHARS {
        return bad("source_too_long", format!("source is over {MAX_SOURCE_CHARS} characters"));
    }
    if source.chars().any(char::is_control) {
        return bad("source_not_one_line", "source must be one line".into());
    }
    if [body, why].iter().any(|s| s.contains('\0')) {
        return bad("invalid_text", "the text holds a NUL".into());
    }
    Ok(NewProposal { id: n.id, title: title.into(), body: body.into(), why: why.into(), source: source.into() })
}

/// Makes a checked proposal from `by`, in the caller's transaction, which the caller commits. True if it's new; false if this
/// device sent the same id before, and that one is the answer.
pub async fn create(tx: &Transaction<'_>, by: &str, n: &NewProposal) -> Result<(bool, Proposal), Fail> {
    tx.execute("select pg_advisory_xact_lock($1)", &[&CREATE_LOCK]).await?;
    if let Some(id) = n.id {
        let sql = format!("select {COLUMNS} from note_proposals where id = $1");
        if let Some(row) = tx.query_opt(&sql, &[&id]).await? {
            let p = Proposal::from(row);
            return if p.proposed_by == by { Ok((false, p)) } else { Err(Fail::IdTaken) };
        }
    }
    let waiting: i64 = tx.query_one("select count(*) from note_proposals where status = 'pending'", &[]).await?.get(0);
    if waiting >= MAX_PENDING {
        return Err(Fail::TooManyPending(waiting));
    }
    let id = n.id.unwrap_or_else(Uuid::new_v4);
    let sql = format!(
        "insert into note_proposals (id, title, body, why, source, proposed_by) values ($1, $2, $3, $4, $5, $6)
         returning {COLUMNS}"
    );
    let row = tx.query_one(&sql, &[&id, &n.title, &n.body, &n.why, &n.source, &by]).await?;
    Ok((true, row.into()))
}

/// `create` with its own transaction from the pool: what the API and MCP call.
pub async fn propose(db: &Db, by: &str, n: &NewProposal) -> Result<(bool, Proposal), Fail> {
    let n = check_new(n)?;
    timed(async {
        let mut client = db.client().await?;
        let tx = client.transaction().await.map_err(pg_error)?;
        let made = create(&tx, by, &n).await;
        if made.is_ok() {
            tx.commit().await.map_err(pg_error)?;
        }
        Ok(made)
    })
    .await
    .map_err(Fail::Db)?
}

pub async fn create_route(c: Caller, Extension(db): Extension<Db>, body: Result<Json<NewProposal>, JsonRejection>) -> ApiResult<(StatusCode, Json<Proposal>)> {
    // An unknown field, `proposed_by` above all, is refused rather than ignored, so an agent learns it can't say who it is.
    let Json(n) = body.map_err(|_| ApiError::Invalid("bad_request"))?;
    let (new, p) = propose(&db, &c.name, &n).await?;
    Ok((if new { StatusCode::CREATED } else { StatusCode::OK }, Json(p)))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ListQuery {
    /// `pending` (the default), `accepted`, `denied` or `all`.
    status: Option<String>,
    q: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
    /// Only the ones this device proposed. The only way an agent may list them.
    mine: Option<bool>,
}

/// Newest first. `by` narrows it to one device's; `ts` is a tsquery from `search_terms`.
pub async fn fetch(db: &Db, by: Option<&str>, status: &str, ts: Option<&str>, limit: i64, offset: i64) -> ApiResult<Vec<Proposal>> {
    if !["pending", "accepted", "denied", "all"].contains(&status) {
        return Err(ApiError::Invalid("invalid_status"));
    }
    let sql = format!(
        "select {COLUMNS} from note_proposals
         where ($1::text is null or proposed_by = $1) and ($2::text = 'all' or status = $2)
           and ($3::text is null or search @@ (to_tsquery('english', $3) || to_tsquery('simple', $3)))
         order by created_at desc, id limit $4 offset $5"
    );
    let rows = db.query(&sql, &[&by, &status, &ts, &limit, &offset]).await?;
    Ok(rows.into_iter().map(Proposal::from).collect())
}

pub async fn list(c: Caller, Extension(db): Extension<Db>, Query(q): Query<ListQuery>) -> ApiResult<Json<Vec<Proposal>>> {
    let mine = q.mine == Some(true);
    if c.role == Role::Agent && !mine {
        return Err(ApiError::Refused(StatusCode::FORBIDDEN, "agent_not_allowed"));
    }
    let ts = super::search_terms(q.q.as_deref().unwrap_or(""))?;
    let limit = q.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let offset = q.offset.unwrap_or(0).max(0);
    let by = mine.then_some(c.name.as_str());
    Ok(Json(fetch(&db, by, q.status.as_deref().unwrap_or("pending"), ts.as_deref(), limit, offset).await?))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Decision {
    /// `accept` or `deny`.
    decision: String,
    /// The version this decision was based on.
    version: i32,
    /// For `accept`: the owner's edit, used instead of the proposed text.
    title: Option<String>,
    body: Option<String>,
}

/// The last line of a note made from a proposal: who proposed it, when, and from where.
pub fn footer(p: &Proposal) -> String {
    let day = p.created_at.format("%Y-%m-%d");
    if p.source.is_empty() {
        format!("— proposed by {}, {day}", p.proposed_by)
    } else {
        format!("— proposed by {}, {day}; source: {}", p.proposed_by, p.source)
    }
}

/// Keeps or drops a proposal, in one transaction. Kept, the note is made from the owner's edit if there is one, else the proposed text.
pub async fn decide_in(tx: &Transaction<'_>, id: Uuid, d: &Decision) -> ApiResult<(Proposal, Option<Note>)> {
    let sql = format!("select {COLUMNS} from note_proposals where id = $1 for update");
    let p = Proposal::from(tx.query_opt(&sql, &[&id]).await.map_err(pg_error)?.ok_or(ApiError::NotFound)?);
    if p.status != "pending" {
        return Err(ApiError::Conflict(json!({"error": "already_decided", "proposal": p})));
    }
    if p.version != d.version {
        return Err(ApiError::Conflict(json!({"error": "version_conflict", "proposal": p})));
    }
    let note = if d.decision == "accept" {
        let title = d.title.as_deref().unwrap_or(&p.title).trim();
        let body = d.body.as_deref().unwrap_or(&p.body).trim_end();
        let body = format!("{body}\n\n{}", footer(&p));
        let sql = format!("insert into notes (title, body) values ($1, $2) returning {}", notes::COLUMNS);
        Some(Note::from(tx.query_one(&sql, &[&title, &body]).await.map_err(pg_error)?))
    } else {
        None
    };
    let status = if note.is_some() { "accepted" } else { "denied" };
    let note_id = note.as_ref().map(|n| n.id);
    let sql = format!(
        "update note_proposals set status = $2, note_id = $3, decided_at = now(), updated_at = now(), version = version + 1
         where id = $1 returning {COLUMNS}"
    );
    let p = Proposal::from(tx.query_one(&sql, &[&id, &status, &note_id]).await.map_err(pg_error)?);
    Ok((p, note))
}

pub async fn decide(
    c: Caller,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    State(state): State<Arc<AppState>>,
    Extension(db): Extension<Db>,
    Path(id): Path<Uuid>,
    body: Result<Json<Decision>, JsonRejection>,
) -> ApiResult<Json<Value>> {
    // Only the owner decides. The gate already keeps agents out of here; this says so again where it matters most.
    if c.role != Role::Owner {
        return Err(ApiError::Refused(StatusCode::FORBIDDEN, "agent_not_allowed"));
    }
    let Json(d) = body.map_err(|_| ApiError::Invalid("bad_request"))?;
    match d.decision.as_str() {
        "accept" => {
            // Keeping one writes to the notes, and the assistant could tap Keep on its own idea from a device it operates. Dropping
            // only takes something away, as with Reject on a draft.
            if !crate::reach::from_owners_hands(&state, peer.map(|Extension(ConnectInfo(addr))| addr)).await {
                return Err(ApiError::Refused(StatusCode::FORBIDDEN, "not_from_here"));
            }
        }
        "deny" if d.title.is_none() && d.body.is_none() => {}
        "deny" => return Err(ApiError::Invalid("edit_needs_accept")),
        _ => return Err(ApiError::Invalid("invalid_decision")),
    }
    if let Some(t) = &d.title {
        check_text(t, MAX_TITLE, "title_too_long")?;
    }
    if let Some(b) = &d.body {
        // Room for the footer.
        check_text(b, MAX_TEXT - 4096, "body_too_long")?;
    }
    let (p, note) = timed(async {
        let mut client = db.client().await?;
        let tx = client.transaction().await.map_err(pg_error)?;
        let done = decide_in(&tx, id, &d).await?;
        tx.commit().await.map_err(pg_error)?;
        Ok(done)
    })
    .await?;
    Ok(Json(json!({"proposal": p, "note": note})))
}

/// Buzzes when new proposals arrive, with how many are waiting and nothing else. What's waiting when the gateway starts isn't
/// news. `LUMBRIDGE_PROPOSALS_TICK_MS` is for tests.
pub async fn watcher(state: Arc<AppState>) {
    let tick = super::asks::env_ms("LUMBRIDGE_PROPOSALS_TICK_MS", TICK);
    let db = state.db.clone();
    let mut known: Option<HashSet<Uuid>> = None;
    loop {
        if let Ok(rows) = db.query("select id from note_proposals where status = 'pending'", &[]).await {
            let ids: HashSet<Uuid> = rows.iter().map(|r| r.get(0)).collect();
            if known.as_ref().is_some_and(|before| ids.difference(before).next().is_some()) {
                crate::push::note_ideas(&state, ids.len());
            }
            known = Some(ids);
        }
        tokio::time::sleep(tick).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn new(title: &str, body: &str) -> NewProposal {
        NewProposal { id: None, title: title.into(), body: body.into(), why: String::new(), source: String::new() }
    }

    fn code(n: NewProposal) -> &'static str {
        match check_new(&n) {
            Err(Fail::Invalid(code, _)) => code,
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_proposal_is_checked_and_trimmed() {
        let ok = check_new(&NewProposal { why: " worth it \n".into(), source: " https://x.example/t/1 ".into(), ..new("  Roof  ", "\n Leaks at the north corner.\n\n") }).unwrap();
        assert_eq!((ok.title.as_str(), ok.body.as_str(), ok.why.as_str(), ok.source.as_str()), ("Roof", "Leaks at the north corner.", "worth it", "https://x.example/t/1"));
        assert_eq!(code(new(" ", "x")), "empty_title");
        assert_eq!(code(new("x", " \n")), "empty_body");
        assert_eq!(code(new(&"x".repeat(MAX_TITLE_CHARS + 1), "x")), "title_too_long");
        assert!(check_new(&new(&"é".repeat(MAX_TITLE_CHARS), "x")).is_ok(), "characters, not bytes");
        assert_eq!(code(new("two\nlines", "x")), "title_not_one_line");
        assert_eq!(code(new("x", &"x".repeat(MAX_BODY_CHARS + 1))), "body_too_long");
        assert_eq!(code(new("x", "a\0b")), "invalid_text");
        assert_eq!(code(NewProposal { why: "w".repeat(MAX_WHY_CHARS + 1), ..new("x", "y") }), "why_too_long");
        assert_eq!(code(NewProposal { source: "s".repeat(MAX_SOURCE_CHARS + 1), ..new("x", "y") }), "source_too_long");
        assert_eq!(code(NewProposal { source: "a\nb".into(), ..new("x", "y") }), "source_not_one_line");
    }

    #[test]
    fn who_proposed_it_cannot_come_from_the_body() {
        let spoofed = json!({"title": "x", "body": "y", "proposed_by": "sam-phone"});
        assert!(serde_json::from_value::<NewProposal>(spoofed).is_err());
    }

    #[test]
    fn the_footer_says_who_when_and_where_from() {
        let mut p = Proposal {
            id: Uuid::nil(),
            title: "t".into(),
            body: "b".into(),
            why: String::new(),
            source: "https://langfuse.example/trace/1".into(),
            proposed_by: "claude-build".into(),
            status: "pending".into(),
            note_id: None,
            decided_at: None,
            created_at: DateTime::parse_from_rfc3339("2026-11-05T23:30:00Z").unwrap().with_timezone(&Utc),
            updated_at: Utc::now(),
            version: 1,
        };
        assert_eq!(footer(&p), "— proposed by claude-build, 2026-11-05; source: https://langfuse.example/trace/1");
        p.source.clear();
        assert_eq!(footer(&p), "— proposed by claude-build, 2026-11-05");
    }
}
