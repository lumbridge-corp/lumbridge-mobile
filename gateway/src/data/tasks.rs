use super::{check_text, db::Db, missed, nullable, ApiError, ApiResult, ListQuery, MAX_TEXT, MAX_TITLE};
use crate::auth::Device;
use axum::{
    extract::{Path, Query},
    http::StatusCode,
    Extension, Json,
};
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use tokio_postgres::Row;
use uuid::Uuid;

const COLUMNS: &str = "id, title, notes, due_on, done_at, pinned, sort_key, created_at, updated_at, deleted_at, version";

#[derive(Serialize)]
pub struct Task {
    id: Uuid,
    title: String,
    notes: String,
    due_on: Option<NaiveDate>,
    done_at: Option<DateTime<Utc>>,
    pinned: bool,
    sort_key: f64,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    deleted_at: Option<DateTime<Utc>>,
    version: i32,
}

impl From<Row> for Task {
    fn from(r: Row) -> Self {
        Self {
            id: r.get("id"),
            title: r.get("title"),
            notes: r.get("notes"),
            due_on: r.get("due_on"),
            done_at: r.get("done_at"),
            pinned: r.get("pinned"),
            sort_key: r.get("sort_key"),
            created_at: r.get("created_at"),
            updated_at: r.get("updated_at"),
            deleted_at: r.get("deleted_at"),
            version: r.get("version"),
        }
    }
}

/// Open tasks first (pinned, then soonest due, then newest), then completed ones, most recently done first. Open tasks
/// come first so a page limit can only ever drop old completed ones.
const ORDER: &str = "done_at is not null, (done_at is null and pinned) desc,
    case when done_at is null then due_on end asc nulls last,
    done_at desc nulls last, sort_key desc, id";

pub async fn list(_: Device, Extension(db): Extension<Db>, Query(q): Query<ListQuery>) -> ApiResult<Json<Vec<Task>>> {
    let (limit, offset) = q.page(500, 1000);
    let rows = if let Some(ts) = q.tsquery()? {
        let sql = format!(
            "select {COLUMNS} from tasks, (select to_tsquery('english', $1) || to_tsquery('simple', $1) as query) s
             where deleted_at is null and search @@ query
             order by ts_rank(search, query) desc, {ORDER} limit $2 offset $3"
        );
        db.query(&sql, &[&ts, &limit, &offset]).await?
    } else if q.deleted == Some(true) {
        let sql = format!(
            "select {COLUMNS} from tasks where deleted_at is not null order by deleted_at desc, id limit $1 offset $2"
        );
        db.query(&sql, &[&limit, &offset]).await?
    } else {
        let sql = format!("select {COLUMNS} from tasks where deleted_at is null order by {ORDER} limit $1 offset $2");
        db.query(&sql, &[&limit, &offset]).await?
    };
    Ok(Json(rows.into_iter().map(Task::from).collect()))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NewTask {
    /// Lets a client retry after a lost response without making a second task.
    id: Option<Uuid>,
    title: String,
    #[serde(default)]
    notes: String,
    due_on: Option<NaiveDate>,
    #[serde(default)]
    pinned: bool,
    sort_key: Option<f64>,
}

fn check_title(title: &str) -> ApiResult<()> {
    if title.trim().is_empty() {
        return Err(ApiError::Invalid("title_required"));
    }
    check_text(title, MAX_TITLE, "title_too_long")
}

pub async fn create(_: Device, Extension(db): Extension<Db>, Json(t): Json<NewTask>) -> ApiResult<(StatusCode, Json<Task>)> {
    check_title(&t.title)?;
    check_text(&t.notes, MAX_TEXT, "notes_too_long")?;
    let id = t.id.unwrap_or_else(Uuid::new_v4);
    let sql = format!(
        "insert into tasks (id, title, notes, due_on, pinned, sort_key)
         values ($1, $2, $3, $4, $5, coalesce($6::double precision, extract(epoch from clock_timestamp()) * 1000))
         on conflict (id) do nothing returning {COLUMNS}"
    );
    if let Some(row) = db.one(&sql, &[&id, &t.title, &t.notes, &t.due_on, &t.pinned, &t.sort_key]).await? {
        return Ok((StatusCode::CREATED, Json(row.into())));
    }
    Ok((StatusCode::OK, Json(current(&db, id).await?.ok_or(ApiError::NotFound)?)))
}

async fn current(db: &Db, id: Uuid) -> ApiResult<Option<Task>> {
    let sql = format!("select {COLUMNS} from tasks where id = $1");
    Ok(db.one(&sql, &[&id]).await?.map(Task::from))
}

pub async fn read(_: Device, Extension(db): Extension<Db>, Path(id): Path<Uuid>) -> ApiResult<Json<Task>> {
    let task = current(&db, id).await?.filter(|t| t.deleted_at.is_none()).ok_or(ApiError::NotFound)?;
    Ok(Json(task))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TaskPatch {
    /// The version this edit was based on.
    version: i32,
    title: Option<String>,
    notes: Option<String>,
    /// Absent leaves it; null clears it.
    #[serde(default, deserialize_with = "nullable")]
    due_on: Option<Option<NaiveDate>>,
    /// true completes (keeping the first completion time), false reopens.
    done: Option<bool>,
    pinned: Option<bool>,
    sort_key: Option<f64>,
}

pub async fn patch(_: Device, Extension(db): Extension<Db>, Path(id): Path<Uuid>, Json(p): Json<TaskPatch>) -> ApiResult<Json<Task>> {
    if p.title.is_none()
        && p.notes.is_none()
        && p.due_on.is_none()
        && p.done.is_none()
        && p.pinned.is_none()
        && p.sort_key.is_none()
    {
        return Err(ApiError::Invalid("nothing_to_change"));
    }
    if let Some(title) = &p.title {
        check_title(title)?;
    }
    if let Some(notes) = &p.notes {
        check_text(notes, MAX_TEXT, "notes_too_long")?;
    }
    let set_due = p.due_on.is_some();
    let due = p.due_on.flatten();
    let sql = format!(
        "update tasks set
           title = coalesce($3::text, title),
           notes = coalesce($4::text, notes),
           due_on = case when $5::boolean then $6::date else due_on end,
           done_at = case when $7::boolean is null then done_at
                          when $7::boolean then coalesce(done_at, now()) else null end,
           pinned = coalesce($8::boolean, pinned),
           sort_key = coalesce($9::double precision, sort_key),
           version = version + 1,
           updated_at = now()
         where id = $1 and version = $2 and deleted_at is null
         returning {COLUMNS}"
    );
    let row = db
        .one(&sql, &[&id, &p.version, &p.title, &p.notes, &set_due, &due, &p.done, &p.pinned, &p.sort_key])
        .await?;
    match row {
        Some(row) => Ok(Json(row.into())),
        None => Err(missed(current(&db, id).await?)),
    }
}

/// Soft delete. Doing it twice answers with the row, so a retry after a lost response isn't an error.
pub async fn remove(_: Device, Extension(db): Extension<Db>, Path(id): Path<Uuid>) -> ApiResult<Json<Task>> {
    let sql = format!(
        "update tasks set deleted_at = now(), version = version + 1
         where id = $1 and deleted_at is null returning {COLUMNS}"
    );
    match db.one(&sql, &[&id]).await? {
        Some(row) => Ok(Json(row.into())),
        None => Ok(Json(current(&db, id).await?.ok_or(ApiError::NotFound)?)),
    }
}

pub async fn restore(_: Device, Extension(db): Extension<Db>, Path(id): Path<Uuid>) -> ApiResult<Json<Task>> {
    let sql = format!(
        "update tasks set deleted_at = null, version = version + 1
         where id = $1 and deleted_at is not null returning {COLUMNS}"
    );
    match db.one(&sql, &[&id]).await? {
        Some(row) => Ok(Json(row.into())),
        None => Ok(Json(current(&db, id).await?.ok_or(ApiError::NotFound)?)),
    }
}
