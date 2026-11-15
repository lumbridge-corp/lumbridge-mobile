//! Notes, tasks, thoughts and files, the assistant's asks, and agents' note proposals, in the Postgres schema the role's
//! search_path names (db/bootstrap.sql). See db/ and docs/DATA.md.
//!
//! LUMBRIDGE_DATABASE_URL unset or the database unreachable: these routes answer 503 and nothing else in the gateway
//! notices. Every handler takes `Device` first, so an unauthenticated request learns nothing, not even that state.

pub mod asks;
pub mod db;
pub mod files;
pub mod migrate;
pub mod notes;
pub mod proposals;
mod tasks;
pub mod thoughts;

use crate::AppState;
use axum::{
    extract::DefaultBodyLimit,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Extension, Json, Router,
};
use serde::{Deserialize, Deserializer};
use std::sync::Arc;

/// A note body or a task's notes. The request limit sits just above it so the JSON framing still fits.
pub const MAX_TEXT: usize = 1024 * 1024;
const MAX_REQUEST: usize = MAX_TEXT + 64 * 1024;
/// Bytes: 1000 characters of anything.
pub const MAX_TITLE: usize = 4000;
const MAX_QUERY: usize = 500;

/// `db` is the gateway's one pool, which `asks::watcher` shares.
pub fn router(db: db::Db) -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/notes", get(notes::list).post(notes::create))
        .route("/api/notes/:id", get(notes::read).patch(notes::patch).delete(notes::remove))
        .route("/api/notes/:id/restore", post(notes::restore))
        .route("/api/tasks", get(tasks::list).post(tasks::create))
        .route("/api/tasks/:id", get(tasks::read).patch(tasks::patch).delete(tasks::remove))
        .route("/api/tasks/:id/restore", post(tasks::restore))
        .route("/api/thoughts", get(thoughts::list).post(thoughts::create))
        .route("/api/thoughts/:id", get(thoughts::read).patch(thoughts::patch).delete(thoughts::remove))
        .route("/api/thoughts/:id/restore", post(thoughts::restore))
        .route("/api/thoughts/:id/note", post(thoughts::to_note))
        .route("/api/asks", get(asks::list))
        .route("/api/asks/:id/answer", post(asks::answer))
        .route("/api/note-proposals", get(proposals::list).post(proposals::create_route))
        .route("/api/note-proposals/:id/decide", post(proposals::decide))
        .route("/api/files/:id", get(files::read).patch(files::patch).delete(files::remove))
        .route("/api/files/:id/restore", post(files::restore))
        .route("/api/files/:id/retry", post(files::retry))
        .route("/api/files/:id/content", get(files::content))
        .layer(DefaultBodyLimit::max(MAX_REQUEST))
        // The upload streams its body to disk itself and counts it against files::MAX_BYTES as it goes.
        .route("/api/files", get(files::list).post(files::upload))
        .layer(Extension(db))
}

#[derive(Debug)]
pub enum ApiError {
    Unavailable,
    NotFound,
    Invalid(&'static str),
    /// Over files::MAX_BYTES.
    TooLarge,
    /// A file with no preview yet that a browser couldn't draw from the original either.
    NoPreview,
    /// PATCH based on an old version: the current row goes back to the client.
    Conflict(serde_json::Value),
    /// A refusal with its own status, such as `not_from_here`.
    Refused(StatusCode, &'static str),
    Internal,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let err = |code, error: &str| (code, Json(serde_json::json!({ "error": error }))).into_response();
        match self {
            ApiError::Unavailable => err(StatusCode::SERVICE_UNAVAILABLE, "database_unavailable"),
            ApiError::NotFound => err(StatusCode::NOT_FOUND, "not_found"),
            ApiError::Invalid(why) => err(StatusCode::UNPROCESSABLE_ENTITY, why),
            ApiError::TooLarge => err(StatusCode::PAYLOAD_TOO_LARGE, "too_large"),
            ApiError::NoPreview => err(StatusCode::NOT_FOUND, "no_preview"),
            ApiError::Conflict(row) => (StatusCode::CONFLICT, Json(row)).into_response(),
            ApiError::Refused(code, why) => err(code, why),
            ApiError::Internal => err(StatusCode::INTERNAL_SERVER_ERROR, "internal"),
        }
    }
}

pub type ApiResult<T> = Result<T, ApiError>;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ListQuery {
    pub q: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
    /// `true` lists the soft-deleted rows instead, newest first, for undo after the toast is gone.
    pub deleted: Option<bool>,
}

impl ListQuery {
    pub fn page(&self, default_limit: i64, max_limit: i64) -> (i64, i64) {
        (self.limit.unwrap_or(default_limit).clamp(1, max_limit), self.offset.unwrap_or(0).max(0))
    }

    pub fn tsquery(&self) -> ApiResult<Option<String>> {
        search_terms(self.q.as_deref().unwrap_or(""))
    }
}

/// A search as a tsquery, or None to mean "no search". Each word becomes a prefix match so results narrow as the owner types.
/// Only letters and digits survive, so the string can't carry tsquery syntax.
pub fn search_terms(q: &str) -> ApiResult<Option<String>> {
    let q = q.trim();
    if q.is_empty() {
        return Ok(None);
    }
    if q.len() > MAX_QUERY {
        return Err(ApiError::Invalid("query_too_long"));
    }
    let words: Vec<String> =
        q.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).take(16).map(|w| format!("{w}:*")).collect();
    // A query of only punctuation has nothing to search for; match nothing rather than everything.
    Ok(Some(words.join(" & ")))
}

/// Text that Postgres will accept and that fits. NUL is the one character a `text` column refuses.
pub fn check_text(s: &str, max: usize, too_long: &'static str) -> ApiResult<()> {
    if s.len() > max {
        Err(ApiError::Invalid(too_long))
    } else if s.contains('\0') {
        Err(ApiError::Invalid("invalid_text"))
    } else {
        Ok(())
    }
}

/// For fields where absent ("leave it") and null ("clear it") mean different things. Use with `#[serde(default)]`.
pub fn nullable<'de, T: Deserialize<'de>, D: Deserializer<'de>>(d: D) -> Result<Option<Option<T>>, D::Error> {
    Option::<T>::deserialize(d).map(Some)
}

/// PATCH found nothing to update: it's either a conflict (current row goes back) or gone.
pub fn missed<T: serde::Serialize>(current: Option<T>) -> ApiError {
    match current {
        Some(row) => serde_json::to_value(row).map_or(ApiError::Internal, ApiError::Conflict),
        None => ApiError::NotFound,
    }
}
