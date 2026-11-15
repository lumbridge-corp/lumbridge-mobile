use super::{check_text, db::Db, missed, ApiError, ApiResult, ListQuery, MAX_TEXT, MAX_TITLE};
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

pub(super) const COLUMNS: &str = "id, title, body, pinned, created_at, updated_at, deleted_at, version";
const SUMMARY: &str = "id, title, left(body, 240) as preview, pinned, created_at, updated_at, deleted_at, version";

#[derive(Serialize)]
pub struct Note {
    pub id: Uuid,
    pub title: String,
    pub body: String,
    pub pinned: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub deleted_at: Option<DateTime<Utc>>,
    pub version: i32,
}

impl From<Row> for Note {
    fn from(r: Row) -> Self {
        Self {
            id: r.get("id"),
            title: r.get("title"),
            body: r.get("body"),
            pinned: r.get("pinned"),
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
    pub id: Uuid,
    pub title: String,
    pub preview: String,
    pub pinned: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub deleted_at: Option<DateTime<Utc>>,
    pub version: i32,
}

impl From<Row> for Summary {
    fn from(r: Row) -> Self {
        Self {
            id: r.get("id"),
            title: r.get("title"),
            preview: r.get("preview"),
            pinned: r.get("pinned"),
            created_at: r.get("created_at"),
            updated_at: r.get("updated_at"),
            deleted_at: r.get("deleted_at"),
            version: r.get("version"),
        }
    }
}

/// Best match first, each with the part of its body around the match. `$1` is a tsquery from `search_terms`.
const SEARCH: &str = "select id, title, ts_headline('english', left(body, 100000), query,
          'MaxWords=30, MinWords=12, MaxFragments=1, StartSel=\"\", StopSel=\"\"') as preview,
        pinned, created_at, updated_at, deleted_at, version
 from (select n.*, ts_rank(search, query) as rank, query
       from notes n, (select to_tsquery('english', $1) || to_tsquery('simple', $1) as query) s
       where deleted_at is null and search @@ query
       order by rank desc, updated_at desc, id limit $2 offset $3) hits
 order by rank desc, updated_at desc, id";

/// The list's search, for MCP's `notes_search` too.
pub async fn search(db: &Db, ts: &str, limit: i64, offset: i64) -> ApiResult<Vec<Summary>> {
    Ok(db.query(SEARCH, &[&ts, &limit, &offset]).await?.into_iter().map(Summary::from).collect())
}

pub async fn list(_: Device, Extension(db): Extension<Db>, Query(q): Query<ListQuery>) -> ApiResult<Json<Vec<Summary>>> {
    let (limit, offset) = q.page(100, 500);
    if let Some(ts) = q.tsquery()? {
        return Ok(Json(search(&db, &ts, limit, offset).await?));
    }
    let rows = if q.deleted == Some(true) {
        let sql = format!(
            "select {SUMMARY} from notes where deleted_at is not null order by deleted_at desc, id limit $1 offset $2"
        );
        db.query(&sql, &[&limit, &offset]).await?
    } else {
        let sql = format!(
            "select {SUMMARY} from notes where deleted_at is null
             order by pinned desc, updated_at desc, id limit $1 offset $2"
        );
        db.query(&sql, &[&limit, &offset]).await?
    };
    Ok(Json(rows.into_iter().map(Summary::from).collect()))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NewNote {
    /// Lets a client retry after a lost response without making a second note.
    id: Option<Uuid>,
    #[serde(default)]
    title: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    pinned: bool,
}

pub async fn create(_: Device, Extension(db): Extension<Db>, Json(n): Json<NewNote>) -> ApiResult<(StatusCode, Json<Note>)> {
    check_text(&n.title, MAX_TITLE, "title_too_long")?;
    check_text(&n.body, MAX_TEXT, "body_too_long")?;
    let id = n.id.unwrap_or_else(Uuid::new_v4);
    let sql = format!(
        "insert into notes (id, title, body, pinned) values ($1, $2, $3, $4)
         on conflict (id) do nothing returning {COLUMNS}"
    );
    if let Some(row) = db.one(&sql, &[&id, &n.title, &n.body, &n.pinned]).await? {
        return Ok((StatusCode::CREATED, Json(row.into())));
    }
    // The id exists: this is a retry, or a note deleted meanwhile. Either way the row is the answer.
    Ok((StatusCode::OK, Json(current(&db, id).await?.ok_or(ApiError::NotFound)?)))
}

pub async fn current(db: &Db, id: Uuid) -> ApiResult<Option<Note>> {
    let sql = format!("select {COLUMNS} from notes where id = $1");
    Ok(db.one(&sql, &[&id]).await?.map(Note::from))
}

pub async fn read(_: Device, Extension(db): Extension<Db>, Path(id): Path<Uuid>) -> ApiResult<Json<Note>> {
    let note = current(&db, id).await?.filter(|n| n.deleted_at.is_none()).ok_or(ApiError::NotFound)?;
    Ok(Json(note))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NotePatch {
    /// The version this edit was based on.
    version: i32,
    title: Option<String>,
    body: Option<String>,
    pinned: Option<bool>,
}

pub async fn patch(_: Device, Extension(db): Extension<Db>, Path(id): Path<Uuid>, Json(p): Json<NotePatch>) -> ApiResult<Json<Note>> {
    if p.title.is_none() && p.body.is_none() && p.pinned.is_none() {
        return Err(ApiError::Invalid("nothing_to_change"));
    }
    if let Some(title) = &p.title {
        check_text(title, MAX_TITLE, "title_too_long")?;
    }
    if let Some(body) = &p.body {
        check_text(body, MAX_TEXT, "body_too_long")?;
    }
    // A pin doesn't count as an edit: pinning must not reorder the list by "last edited".
    let sql = format!(
        "update notes set
           title = coalesce($3::text, title),
           body = coalesce($4::text, body),
           pinned = coalesce($5::boolean, pinned),
           version = version + 1,
           updated_at = case when coalesce($3::text, title) = title and coalesce($4::text, body) = body
                             then updated_at else now() end
         where id = $1 and version = $2 and deleted_at is null
         returning {COLUMNS}"
    );
    match db.one(&sql, &[&id, &p.version, &p.title, &p.body, &p.pinned]).await? {
        Some(row) => Ok(Json(row.into())),
        None => Err(missed(current(&db, id).await?)),
    }
}

/// Soft delete. Doing it twice answers with the row, so a retry after a lost response isn't an error.
pub async fn remove(_: Device, Extension(db): Extension<Db>, Path(id): Path<Uuid>) -> ApiResult<Json<Note>> {
    let sql = format!(
        "update notes set deleted_at = now(), version = version + 1
         where id = $1 and deleted_at is null returning {COLUMNS}"
    );
    match db.one(&sql, &[&id]).await? {
        Some(row) => Ok(Json(row.into())),
        None => Ok(Json(current(&db, id).await?.ok_or(ApiError::NotFound)?)),
    }
}

pub async fn restore(_: Device, Extension(db): Extension<Db>, Path(id): Path<Uuid>) -> ApiResult<Json<Note>> {
    let sql = format!(
        "update notes set deleted_at = null, version = version + 1
         where id = $1 and deleted_at is not null returning {COLUMNS}"
    );
    match db.one(&sql, &[&id]).await? {
        Some(row) => Ok(Json(row.into())),
        None => Ok(Json(current(&db, id).await?.ok_or(ApiError::NotFound)?)),
    }
}

// ---- for the assistant: cli.rs. Only ever called inside its read-only transaction. ---------------------------------------

/// `lumbridge-mobile-server notes search`.
pub async fn matching(tx: &Transaction<'_>, ts: &str, limit: i64) -> Result<Vec<Summary>, tokio_postgres::Error> {
    Ok(tx.query(SEARCH, &[&ts, &limit, &0i64]).await?.into_iter().map(Summary::from).collect())
}

/// `lumbridge-mobile-server notes read`: a note that isn't deleted.
pub async fn one(tx: &Transaction<'_>, id: Uuid) -> Result<Option<Note>, tokio_postgres::Error> {
    let sql = format!("select {COLUMNS} from notes where id = $1 and deleted_at is null");
    Ok(tx.query_opt(&sql, &[&id]).await?.map(Note::from))
}

/// `lumbridge-mobile-server notes recent`: whole notes changed since then, last changed first, for an index to catch up on.
pub async fn recent(tx: &Transaction<'_>, limit: i64, since: Option<DateTime<Utc>>) -> Result<Vec<Note>, tokio_postgres::Error> {
    let sql = format!(
        "select {COLUMNS} from notes where deleted_at is null and ($2::timestamptz is null or updated_at >= $2)
         order by updated_at desc, id limit $1"
    );
    Ok(tx.query(&sql, &[&limit, &since]).await?.into_iter().map(Note::from).collect())
}
