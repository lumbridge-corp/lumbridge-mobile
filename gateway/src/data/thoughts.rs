use super::{check_text, db::Db, missed, ApiError, ApiResult, ListQuery, MAX_TEXT};
use crate::auth::Device;
use axum::{
    extract::{Path, Query},
    http::StatusCode,
    Extension, Json,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio_postgres::{Row, Transaction};
use uuid::Uuid;

const COLUMNS: &str = "id, body, source, duration_ms, note_id, created_at, updated_at, deleted_at, version";
const SUMMARY: &str = "id, left(body, 600) as preview, source, duration_ms, note_id, created_at, updated_at, deleted_at, version";

#[derive(Serialize)]
pub struct Thought {
    id: Uuid,
    body: String,
    source: String,
    duration_ms: Option<i32>,
    note_id: Option<Uuid>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    deleted_at: Option<DateTime<Utc>>,
    version: i32,
}

impl From<Row> for Thought {
    fn from(r: Row) -> Self {
        Self {
            id: r.get("id"),
            body: r.get("body"),
            source: r.get("source"),
            duration_ms: r.get("duration_ms"),
            note_id: r.get("note_id"),
            created_at: r.get("created_at"),
            updated_at: r.get("updated_at"),
            deleted_at: r.get("deleted_at"),
            version: r.get("version"),
        }
    }
}

/// A row in the list: the start of the body, or the part of it around a search match.
#[derive(Serialize)]
pub struct Summary {
    id: Uuid,
    preview: String,
    source: String,
    duration_ms: Option<i32>,
    note_id: Option<Uuid>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    deleted_at: Option<DateTime<Utc>>,
    version: i32,
}

impl From<Row> for Summary {
    fn from(r: Row) -> Self {
        Self {
            id: r.get("id"),
            preview: r.get("preview"),
            source: r.get("source"),
            duration_ms: r.get("duration_ms"),
            note_id: r.get("note_id"),
            created_at: r.get("created_at"),
            updated_at: r.get("updated_at"),
            deleted_at: r.get("deleted_at"),
            version: r.get("version"),
        }
    }
}

/// Newest first even when searching: this is an inbox, and the screen groups it by day.
pub async fn list(_: Device, Extension(db): Extension<Db>, Query(q): Query<ListQuery>) -> ApiResult<Json<Vec<Summary>>> {
    let (limit, offset) = q.page(100, 500);
    let rows = if let Some(ts) = q.tsquery()? {
        let sql =
            "select id, ts_headline('english', left(body, 100000), query,
                      'MaxWords=60, MinWords=20, MaxFragments=1, StartSel=\"\", StopSel=\"\"') as preview,
                    source, duration_ms, note_id, created_at, updated_at, deleted_at, version
             from (select t.*, query
                   from thoughts t, (select to_tsquery('english', $1) || to_tsquery('simple', $1) as query) s
                   where deleted_at is null and search @@ query
                   order by created_at desc, id limit $2 offset $3) hits
             order by created_at desc, id";
        db.query(sql, &[&ts, &limit, &offset]).await?
    } else if q.deleted == Some(true) {
        let sql = format!(
            "select {SUMMARY} from thoughts where deleted_at is not null order by deleted_at desc, id limit $1 offset $2"
        );
        db.query(&sql, &[&limit, &offset]).await?
    } else {
        let sql = format!(
            "select {SUMMARY} from thoughts where deleted_at is null order by created_at desc, id limit $1 offset $2"
        );
        db.query(&sql, &[&limit, &offset]).await?
    };
    Ok(Json(rows.into_iter().map(Summary::from).collect()))
}

fn check_body(body: &str) -> ApiResult<()> {
    check_text(body, MAX_TEXT, "body_too_long")?;
    if body.trim().is_empty() {
        return Err(ApiError::Invalid("empty_body"));
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NewThought {
    /// Chosen on the device, so a retry after a lost response can't make a second thought.
    id: Option<Uuid>,
    body: String,
    #[serde(default = "typed")]
    source: String,
    duration_ms: Option<i32>,
    /// When it was said. It can be hours before this request, if the device was waiting on the speech service.
    created_at: Option<DateTime<Utc>>,
}

fn typed() -> String {
    "typed".into()
}

pub async fn create(_: Device, Extension(db): Extension<Db>, Json(t): Json<NewThought>) -> ApiResult<(StatusCode, Json<Thought>)> {
    check_body(&t.body)?;
    if t.source != "voice" && t.source != "typed" {
        return Err(ApiError::Invalid("invalid_source"));
    }
    if t.duration_ms.is_some_and(|ms| ms < 0) {
        return Err(ApiError::Invalid("invalid_duration"));
    }
    let id = t.id.unwrap_or_else(Uuid::new_v4);
    // A device's clock can be ahead; a thought from the future would sit on top of the list for as long as it's wrong.
    let sql = format!(
        "insert into thoughts (id, body, source, duration_ms, created_at)
         values ($1, $2, $3, $4, least(coalesce($5::timestamptz, now()), now()))
         on conflict (id) do nothing returning {COLUMNS}"
    );
    if let Some(row) = db.one(&sql, &[&id, &t.body, &t.source, &t.duration_ms, &t.created_at]).await? {
        return Ok((StatusCode::CREATED, Json(row.into())));
    }
    // The id exists: this is a retry, or a thought deleted meanwhile. Either way the row is the answer.
    Ok((StatusCode::OK, Json(current(&db, id).await?.ok_or(ApiError::NotFound)?)))
}

async fn current(db: &Db, id: Uuid) -> ApiResult<Option<Thought>> {
    let sql = format!("select {COLUMNS} from thoughts where id = $1");
    Ok(db.one(&sql, &[&id]).await?.map(Thought::from))
}

pub async fn read(_: Device, Extension(db): Extension<Db>, Path(id): Path<Uuid>) -> ApiResult<Json<Thought>> {
    let thought = current(&db, id).await?.filter(|t| t.deleted_at.is_none()).ok_or(ApiError::NotFound)?;
    Ok(Json(thought))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ThoughtPatch {
    /// The version this edit was based on.
    version: i32,
    body: Option<String>,
}

pub async fn patch(_: Device, Extension(db): Extension<Db>, Path(id): Path<Uuid>, Json(p): Json<ThoughtPatch>) -> ApiResult<Json<Thought>> {
    let Some(body) = &p.body else { return Err(ApiError::Invalid("nothing_to_change")) };
    check_body(body)?;
    let sql = format!(
        "update thoughts set body = $3, version = version + 1, updated_at = now()
         where id = $1 and version = $2 and deleted_at is null
         returning {COLUMNS}"
    );
    match db.one(&sql, &[&id, &p.version, body]).await? {
        Some(row) => Ok(Json(row.into())),
        None => Err(missed(current(&db, id).await?)),
    }
}

/// Soft delete. Doing it twice answers with the row, so a retry after a lost response isn't an error.
pub async fn remove(_: Device, Extension(db): Extension<Db>, Path(id): Path<Uuid>) -> ApiResult<Json<Thought>> {
    let sql = format!(
        "update thoughts set deleted_at = now(), version = version + 1
         where id = $1 and deleted_at is null returning {COLUMNS}"
    );
    match db.one(&sql, &[&id]).await? {
        Some(row) => Ok(Json(row.into())),
        None => Ok(Json(current(&db, id).await?.ok_or(ApiError::NotFound)?)),
    }
}

pub async fn restore(_: Device, Extension(db): Extension<Db>, Path(id): Path<Uuid>) -> ApiResult<Json<Thought>> {
    let sql = format!(
        "update thoughts set deleted_at = null, version = version + 1
         where id = $1 and deleted_at is not null returning {COLUMNS}"
    );
    match db.one(&sql, &[&id]).await? {
        Some(row) => Ok(Json(row.into())),
        None => Ok(Json(current(&db, id).await?.ok_or(ApiError::NotFound)?)),
    }
}

/// Makes a note from the thought's text and sets `note_id`, in one statement, so a retry or a second device can't make two
/// notes: the row lock makes the other one see `note_id` already set, and it finds nothing to do.
/// Like a pin, this isn't an edit, so `updated_at` stays.
pub async fn to_note(_: Device, Extension(db): Extension<Db>, Path(id): Path<Uuid>) -> ApiResult<(StatusCode, Json<Thought>)> {
    let sql = "with t as (select id, body from thoughts where id = $1 and deleted_at is null and note_id is null for update),
                    n as (insert into notes (body) select body from t returning id)
               update thoughts th set note_id = n.id, version = th.version + 1 from n, t where th.id = t.id
               returning th.id, th.body, th.source, th.duration_ms, th.note_id, th.created_at, th.updated_at, th.deleted_at, th.version";
    if let Some(row) = db.one(sql, &[&id]).await? {
        return Ok((StatusCode::CREATED, Json(row.into())));
    }
    let thought = current(&db, id).await?.filter(|t| t.deleted_at.is_none()).ok_or(ApiError::NotFound)?;
    Ok((StatusCode::OK, Json(thought)))
}

/// `lumbridge-mobile-server thoughts recent`, for the assistant. Only ever called inside the read-only transaction in cli.rs.
pub async fn recent(tx: &Transaction<'_>, limit: i64, since: Option<DateTime<Utc>>) -> Result<Vec<Thought>, tokio_postgres::Error> {
    let sql = format!(
        "select {COLUMNS} from thoughts
         where deleted_at is null and ($2::timestamptz is null or created_at >= $2)
         order by created_at desc, id limit $1"
    );
    Ok(tx.query(&sql, &[&limit, &since]).await?.into_iter().map(Thought::from).collect())
}

/// `lumbridge-mobile-server thoughts search`, for the assistant. `ts` is a tsquery from `super::search_terms`.
pub async fn matching(tx: &Transaction<'_>, ts: &str, limit: i64) -> Result<Vec<Thought>, tokio_postgres::Error> {
    let sql = format!(
        "select {COLUMNS} from thoughts
         where deleted_at is null and search @@ (to_tsquery('english', $1) || to_tsquery('simple', $1))
         order by created_at desc, id limit $2"
    );
    Ok(tx.query(&sql, &[&ts, &limit]).await?.into_iter().map(Thought::from).collect())
}
