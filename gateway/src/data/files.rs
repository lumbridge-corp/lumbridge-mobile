//! Files: photos and documents. The bytes stay on the server under LUMBRIDGE_FILES_DIR (`<dir>/YYYY/MM/<id>.<ext>`, previews
//! `<id>.thumb.jpg` and `<id>.large.jpg` beside it, made by the filer); only text about them is in Postgres.
//!
//! An upload is the raw body, streamed to disk and hashed as it comes, at most MAX_BYTES. The id is chosen on the device, so a
//! retry after a lost answer gets the same row back, and so does the same bytes under a new id. What a file is comes from its
//! first bytes, never from the name or the Content-Type it was sent with, and nothing is ever served as something a browser
//! would run: only raster images inline, everything else as an attachment, always with nosniff (gate.rs).

use super::{check_text, db::Db, missed, nullable, search_terms, ApiError, ApiResult};
use crate::auth::Device;
use axum::{
    body::Body,
    extract::{Path, Query, Request},
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Extension, Json,
};
use chrono::{DateTime, Datelike, Utc};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path as FsPath, PathBuf};
use tokio::io::AsyncWriteExt;
use tokio_postgres::{Row, Transaction};
use tower::ServiceExt;
use tower_http::services::ServeFile;
use uuid::Uuid;

/// The most one file may be. A phone's photo is 2 to 8 MB; a scan or a short PDF fits too.
pub const MAX_BYTES: u64 = 50 * 1024 * 1024;
const MAX_NAME: usize = 1000;
pub const CATEGORIES: &[&str] = &["vehicle", "document", "receipt", "person", "place", "home", "work", "screenshot", "other"];

const COLUMNS: &str = "id, name, mime, bytes, sha256, path, status, description, ocr_text, category, identifiers::text as identifiers,
                       sensitive, error, taken_at, gps::text as gps, created_at, updated_at, deleted_at, version";

#[derive(Serialize)]
pub struct FileRow {
    id: Uuid,
    name: String,
    mime: String,
    bytes: i64,
    sha256: String,
    path: String,
    status: String,
    description: Option<String>,
    ocr_text: Option<String>,
    category: Option<String>,
    identifiers: serde_json::Value,
    sensitive: bool,
    error: Option<String>,
    taken_at: Option<DateTime<Utc>>,
    gps: Option<serde_json::Value>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    deleted_at: Option<DateTime<Utc>>,
    version: i32,
}

fn json_col(r: &Row, name: &str) -> Option<serde_json::Value> {
    r.get::<_, Option<String>>(name).and_then(|s| serde_json::from_str(&s).ok())
}

impl From<Row> for FileRow {
    fn from(r: Row) -> Self {
        Self {
            id: r.get("id"),
            name: r.get("name"),
            mime: r.get("mime"),
            bytes: r.get("bytes"),
            sha256: r.get("sha256"),
            path: r.get("path"),
            status: r.get("status"),
            description: r.get("description"),
            ocr_text: r.get("ocr_text"),
            category: r.get("category"),
            identifiers: json_col(&r, "identifiers").unwrap_or_else(|| serde_json::json!([])),
            sensitive: r.get("sensitive"),
            error: r.get("error"),
            taken_at: r.get("taken_at"),
            gps: json_col(&r, "gps"),
            created_at: r.get("created_at"),
            updated_at: r.get("updated_at"),
            deleted_at: r.get("deleted_at"),
            version: r.get("version"),
        }
    }
}

// ---- What a file is -----------------------------------------------------------------------------------------------

/// The type and the extension it's stored under, from its first bytes. Anything not recognised is just bytes.
pub fn sniff(head: &[u8]) -> (&'static str, &'static str) {
    let at = |i: usize, s: &[u8]| head.len() >= i + s.len() && &head[i..i + s.len()] == s;
    if at(0, &[0xFF, 0xD8, 0xFF]) {
        return ("image/jpeg", "jpg");
    }
    if at(0, b"\x89PNG\r\n\x1a\n") {
        return ("image/png", "png");
    }
    if at(0, b"GIF87a") || at(0, b"GIF89a") {
        return ("image/gif", "gif");
    }
    if at(0, b"RIFF") && at(8, b"WEBP") {
        return ("image/webp", "webp");
    }
    if at(0, b"%PDF-") {
        return ("application/pdf", "pdf");
    }
    // ISO base media: a box size, then "ftyp" and the major brand.
    if at(4, b"ftyp") && head.len() >= 12 {
        match &head[8..12] {
            b"heic" | b"heix" | b"heim" | b"heis" | b"hevc" | b"hevx" => return ("image/heic", "heic"),
            b"mif1" | b"msf1" => return ("image/heif", "heif"),
            b"avif" | b"avis" => return ("image/avif", "avif"),
            _ => {}
        }
    }
    ("application/octet-stream", "bin")
}

/// Shown in a page as an image and nothing else. SVG is deliberately not here: it can carry script.
fn inline_image(mime: &str) -> bool {
    matches!(mime, "image/jpeg" | "image/png" | "image/gif" | "image/webp" | "image/heic" | "image/heif" | "image/avif")
}

/// What every browser can draw, so it can stand in for a preview that isn't made yet.
fn browser_image(mime: &str) -> bool {
    matches!(mime, "image/jpeg" | "image/png" | "image/gif" | "image/webp")
}

/// A name as the owner would see it: trimmed, no control characters, not too long. Whatever is left is only ever shown as text.
fn clean_name(raw: &str) -> String {
    let s: String = raw.chars().filter(|c| !c.is_control()).collect();
    let s = s.trim();
    let mut out = String::new();
    for c in s.chars() {
        if out.len() + c.len_utf8() > MAX_NAME {
            break;
        }
        out.push(c);
    }
    out
}

/// For Content-Disposition: plain ASCII that can't end the quoted string or the header.
fn download_name(name: &str, ext: &str) -> String {
    let stem: String = name
        .rsplit_once('.')
        .map_or(name, |(s, _)| s)
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == ' ' { c } else { '_' })
        .take(80)
        .collect();
    let stem = stem.trim();
    format!("{}.{ext}", if stem.is_empty() { "file" } else { stem })
}

pub fn files_dir() -> Option<PathBuf> {
    if let Some(d) = std::env::var_os("LUMBRIDGE_FILES_DIR") {
        return Some(PathBuf::from(d));
    }
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join("files"))
}

/// Only paths this module made: `YYYY/MM/<uuid>.<ext>`. Anything else in the column can't make us open another file.
fn stored(dir: &FsPath, rel: &str) -> Option<PathBuf> {
    let parts: Vec<&str> = rel.split('/').collect();
    let [y, m, f] = parts.as_slice() else { return None };
    let ok = y.len() == 4
        && m.len() == 2
        && y.bytes().chain(m.bytes()).all(|b| b.is_ascii_digit())
        && f.split_once('.').is_some_and(|(id, ext)| Uuid::parse_str(id).is_ok() && !ext.is_empty() && ext.bytes().all(|b| b.is_ascii_alphanumeric()));
    ok.then(|| dir.join(y).join(m).join(f))
}

fn preview(original: &FsPath, id: Uuid, size: &str) -> PathBuf {
    original.with_file_name(format!("{id}.{size}.jpg"))
}

// ---- The API --------------------------------------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FilesQuery {
    q: Option<String>,
    category: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
    deleted: Option<bool>,
}

fn check_category(c: &str) -> ApiResult<()> {
    if CATEGORIES.contains(&c) {
        Ok(())
    } else {
        Err(ApiError::Invalid("invalid_category"))
    }
}

/// Newest first, or best match first when searching. The text read from a file is cut to a snippet here; read one for all of it.
pub async fn list(_: Device, Extension(db): Extension<Db>, Query(q): Query<FilesQuery>) -> ApiResult<Json<Vec<FileRow>>> {
    let limit = q.limit.unwrap_or(60).clamp(1, 300);
    let offset = q.offset.unwrap_or(0).max(0);
    if let Some(c) = &q.category {
        check_category(c)?;
    }
    let ts = search_terms(q.q.as_deref().unwrap_or(""))?;
    let deleted = q.deleted == Some(true);
    let cols = COLUMNS.replace("ocr_text,", "left(ocr_text, 300) as ocr_text,");
    let sql = format!(
        "select {cols} from (
           select f.*, case when $1::text is null then 0 else ts_rank(search, to_tsquery('english', $1) || to_tsquery('simple', $1)) end as rank
           from files f
           where (deleted_at is not null) = $2
             and ($3::text is null or category = $3)
             and ($1::text is null or search @@ (to_tsquery('english', $1) || to_tsquery('simple', $1)))
         ) f
         order by rank desc, case when $2 then deleted_at else created_at end desc, id
         limit $4 offset $5"
    );
    let rows = db.query(&sql, &[&ts, &deleted, &q.category, &limit, &offset]).await?;
    Ok(Json(rows.into_iter().map(FileRow::from).collect()))
}

async fn current(db: &Db, id: Uuid) -> ApiResult<Option<FileRow>> {
    let sql = format!("select {COLUMNS} from files where id = $1");
    Ok(db.one(&sql, &[&id]).await?.map(FileRow::from))
}

async fn live_with_sha(db: &Db, sha: &str) -> ApiResult<Option<FileRow>> {
    let sql = format!("select {COLUMNS} from files where sha256 = $1 and deleted_at is null");
    Ok(db.one(&sql, &[&sha]).await?.map(FileRow::from))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UploadQuery {
    /// Chosen on the device before anything else, so a retry can't make a second file.
    id: Uuid,
    #[serde(default)]
    name: String,
}

struct Incoming {
    path: PathBuf,
    done: bool,
}

/// A half-written upload is removed whatever way the handler ends.
impl Drop for Incoming {
    fn drop(&mut self) {
        if !self.done {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

fn private_dir(p: &FsPath) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(p)
}

/// `POST /api/files?id=<uuid>&name=<name>` with the file as the body. 201 with the new row; 200 with the existing one when
/// this id or these exact bytes are already here.
pub async fn upload(_: Device, Extension(db): Extension<Db>, Query(u): Query<UploadQuery>, req: Request) -> Result<Response, ApiError> {
    if let Some(row) = current(&db, u.id).await? {
        return Ok((StatusCode::OK, Json(row)).into_response());
    }
    let name = clean_name(&u.name);
    check_text(&name, MAX_NAME * 4, "name_too_long")?;
    if req.headers().get(header::CONTENT_LENGTH).and_then(|v| v.to_str().ok()?.parse::<u64>().ok()).is_some_and(|n| n > MAX_BYTES) {
        return Err(ApiError::TooLarge);
    }
    let dir = files_dir().ok_or(ApiError::Unavailable)?;
    let tmp_dir = dir.join(".incoming");
    private_dir(&tmp_dir).map_err(|e| disk(&e))?;
    let mut incoming = Incoming { path: tmp_dir.join(format!("{}.{}", u.id, Uuid::new_v4().simple())), done: false };
    let mut out = {
        use std::os::unix::fs::OpenOptionsExt;
        let f = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&incoming.path).map_err(|e| disk(&e))?;
        tokio::fs::File::from_std(f)
    };
    let mut hash = Sha256::new();
    let mut head: Vec<u8> = Vec::with_capacity(64);
    let mut total: u64 = 0;
    let mut stream = req.into_body().into_data_stream();
    while let Some(chunk) = stream.next().await {
        // A dropped connection: nothing is kept, and the device sends it again.
        let chunk = chunk.map_err(|_| ApiError::Invalid("upload_interrupted"))?;
        total += chunk.len() as u64;
        if total > MAX_BYTES {
            return Err(ApiError::TooLarge);
        }
        if head.len() < 64 {
            head.extend_from_slice(&chunk[..chunk.len().min(64 - head.len())]);
        }
        hash.update(&chunk);
        out.write_all(&chunk).await.map_err(|e| disk(&e))?;
    }
    if total == 0 {
        return Err(ApiError::Invalid("empty_file"));
    }
    out.sync_all().await.map_err(|e| disk(&e))?;
    drop(out);
    let sha: String = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
    if let Some(row) = live_with_sha(&db, &sha).await? {
        return Ok((StatusCode::OK, Json(row)).into_response());
    }
    let (mime, ext) = sniff(&head);
    let now = Utc::now();
    let rel = format!("{:04}/{:02}/{}.{ext}", now.year(), now.month(), u.id);
    let fin = stored(&dir, &rel).ok_or(ApiError::Internal)?;
    let total = i64::try_from(total).map_err(|_| ApiError::Internal)?;
    // The row first: a retry racing this one, or the same bytes arriving under another id, finds it and stops there. Only the
    // one that inserted moves its bytes into place.
    let sql = format!(
        "insert into files (id, name, mime, bytes, sha256, path) values ($1, $2, $3, $4, $5, $6)
         on conflict do nothing returning {COLUMNS}"
    );
    let Some(row) = db.one(&sql, &[&u.id, &name, &mime, &total, &sha, &rel]).await? else {
        let row = match current(&db, u.id).await? {
            Some(r) => Some(r),
            None => live_with_sha(&db, &sha).await?,
        };
        return Ok((StatusCode::OK, Json(row.ok_or(ApiError::Internal)?)).into_response());
    };
    let placed = fin.parent().map(private_dir).unwrap_or(Ok(())).and_then(|()| std::fs::rename(&incoming.path, &fin));
    if let Err(e) = placed {
        // Without its bytes the row is a lie: take it back, and the device tries again.
        let _ = db.query("delete from files where id = $1", &[&u.id]).await;
        return Err(disk(&e));
    }
    incoming.done = true;
    Ok((StatusCode::CREATED, Json(FileRow::from(row))).into_response())
}

fn disk(e: &std::io::Error) -> ApiError {
    eprintln!("files: disk: {}", e.kind());
    ApiError::Unavailable
}

pub async fn read(_: Device, Extension(db): Extension<Db>, Path(id): Path<Uuid>) -> ApiResult<Json<FileRow>> {
    let row = current(&db, id).await?.filter(|f| f.deleted_at.is_none()).ok_or(ApiError::NotFound)?;
    Ok(Json(row))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FilePatch {
    version: i32,
    name: Option<String>,
    category: Option<String>,
    sensitive: Option<bool>,
}

/// The owner renames it, moves it to another category, or says it is or isn't private. The rest is the filer's.
pub async fn patch(_: Device, Extension(db): Extension<Db>, Path(id): Path<Uuid>, Json(p): Json<FilePatch>) -> ApiResult<Json<FileRow>> {
    if p.name.is_none() && p.category.is_none() && p.sensitive.is_none() {
        return Err(ApiError::Invalid("nothing_to_change"));
    }
    let name = p.name.as_deref().map(clean_name);
    if name.as_deref() == Some("") {
        return Err(ApiError::Invalid("empty_name"));
    }
    if let Some(c) = &p.category {
        check_category(c)?;
    }
    let sql = format!(
        "update files set name = coalesce($3, name), category = coalesce($4, category), sensitive = coalesce($5, sensitive),
                version = version + 1, updated_at = now()
         where id = $1 and version = $2 and deleted_at is null
         returning {COLUMNS}"
    );
    match db.one(&sql, &[&id, &p.version, &name, &p.category, &p.sensitive]).await? {
        Some(row) => Ok(Json(row.into())),
        None => Err(missed(current(&db, id).await?)),
    }
}

/// Soft delete, idempotent. The bytes stay on the server, so restore can bring it all back.
pub async fn remove(_: Device, Extension(db): Extension<Db>, Path(id): Path<Uuid>) -> ApiResult<Json<FileRow>> {
    let sql = format!(
        "update files set deleted_at = now(), version = version + 1
         where id = $1 and deleted_at is null returning {COLUMNS}"
    );
    match db.one(&sql, &[&id]).await? {
        Some(row) => Ok(Json(row.into())),
        None => Ok(Json(current(&db, id).await?.ok_or(ApiError::NotFound)?)),
    }
}

/// Refused when the same bytes have been added again since: there'd be two of one file.
pub async fn restore(_: Device, Extension(db): Extension<Db>, Path(id): Path<Uuid>) -> ApiResult<Json<FileRow>> {
    let sql = format!(
        "update files f set deleted_at = null, version = version + 1
         where id = $1 and deleted_at is not null
           and not exists (select 1 from files o where o.sha256 = f.sha256 and o.deleted_at is null)
         returning {COLUMNS}"
    );
    if let Some(row) = db.one(&sql, &[&id]).await? {
        return Ok(Json(row.into()));
    }
    let row = current(&db, id).await?.ok_or(ApiError::NotFound)?;
    if row.deleted_at.is_some() {
        return Err(ApiError::Invalid("added_again"));
    }
    Ok(Json(row))
}

/// The filer gave up on it; the owner asks it to try again.
pub async fn retry(_: Device, Extension(db): Extension<Db>, Path(id): Path<Uuid>) -> ApiResult<Json<FileRow>> {
    let sql = format!(
        "update files set status = 'new', error = null, version = version + 1, updated_at = now()
         where id = $1 and status = 'failed' and deleted_at is null returning {COLUMNS}"
    );
    if let Some(row) = db.one(&sql, &[&id]).await? {
        return Ok(Json(row.into()));
    }
    Ok(Json(current(&db, id).await?.filter(|f| f.deleted_at.is_none()).ok_or(ApiError::NotFound)?))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContentQuery {
    size: Option<String>,
}

/// `?size=thumb|large|original`. Range requests work (tower-http's ServeFile). A preview that isn't made yet is the original
/// when a browser can draw that, else 404 `no_preview`.
pub async fn content(_: Device, Extension(db): Extension<Db>, Path(id): Path<Uuid>, Query(c): Query<ContentQuery>, req: Request) -> Result<Response, ApiError> {
    let size = c.size.as_deref().unwrap_or("original");
    if !matches!(size, "thumb" | "large" | "original") {
        return Err(ApiError::Invalid("invalid_size"));
    }
    let row = current(&db, id).await?.ok_or(ApiError::NotFound)?;
    let dir = files_dir().ok_or(ApiError::Unavailable)?;
    let original = stored(&dir, &row.path).ok_or(ApiError::NotFound)?;
    let (file, mime) = match size {
        "original" => (original, row.mime.clone()),
        _ => {
            let p = preview(&original, id, size);
            if p.is_file() {
                (p, "image/jpeg".to_string())
            } else if browser_image(&row.mime) {
                (original, row.mime.clone())
            } else {
                return Err(ApiError::NoPreview);
            }
        }
    };
    let (parts, _) = req.into_parts();
    let mut res = ServeFile::new(&file).oneshot(Request::from_parts(parts, Body::empty())).await.map_err(|_| ApiError::Internal)?.into_response();
    if res.status() == StatusCode::NOT_FOUND {
        return Err(ApiError::NotFound);
    }
    let h = res.headers_mut();
    let inline = inline_image(&mime);
    let ty = if inline || mime == "application/pdf" { mime.as_str() } else { "application/octet-stream" };
    h.insert(header::CONTENT_TYPE, HeaderValue::from_str(ty).map_err(|_| ApiError::Internal)?);
    let ext = file.extension().and_then(|e| e.to_str()).unwrap_or("bin");
    let disposition = format!("{}; filename=\"{}\"", if inline { "inline" } else { "attachment" }, download_name(&row.name, ext));
    h.insert(header::CONTENT_DISPOSITION, HeaderValue::from_str(&disposition).map_err(|_| ApiError::Internal)?);
    Ok(res)
}

// ---- For the filer and the assistant (cli.rs) -----------------------------------------------------------------------

/// What the filer may write. Absent leaves a field; null clears it.
#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct Filed {
    status: Option<String>,
    #[serde(default, deserialize_with = "nullable")]
    description: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullable")]
    ocr_text: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullable")]
    category: Option<Option<String>>,
    identifiers: Option<Vec<serde_json::Map<String, serde_json::Value>>>,
    sensitive: Option<bool>,
    #[serde(default, deserialize_with = "nullable")]
    error: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullable")]
    taken_at: Option<Option<DateTime<Utc>>>,
    #[serde(default, deserialize_with = "nullable")]
    gps: Option<Option<serde_json::Map<String, serde_json::Value>>>,
}

impl Filed {
    pub fn check(&self) -> Result<(), String> {
        if let Some(s) = &self.status {
            if !matches!(s.as_str(), "new" | "filed" | "failed") {
                return Err(format!("status must be new, filed or failed, not {s:?}"));
            }
        }
        if let Some(Some(c)) = &self.category {
            if !CATEGORIES.contains(&c.as_str()) {
                return Err(format!("category must be one of {}", CATEGORIES.join(", ")));
            }
        }
        for (what, v, max) in [("description", &self.description, 4000), ("ocr_text", &self.ocr_text, 200_000), ("error", &self.error, 1000)] {
            if let Some(Some(s)) = v {
                check_text(s, max, "too_long").map_err(|_| format!("{what} is too long or has a NUL"))?;
            }
        }
        if let Some(ids) = &self.identifiers {
            if ids.len() > 50 {
                return Err("at most 50 identifiers".into());
            }
            for i in ids {
                if !i.get("kind").is_some_and(|k| k.is_string()) || !i.get("value").is_some_and(|v| v.is_string()) {
                    return Err("each identifier needs a string kind and value".into());
                }
                if serde_json::to_string(i).map_or(true, |s| s.len() > 2000 || s.contains("\\u0000")) {
                    return Err("an identifier is too long".into());
                }
            }
        }
        if let Some(Some(g)) = &self.gps {
            let num = |k: &str| g.get(k).and_then(|v| v.as_f64());
            match (num("lat"), num("lon")) {
                (Some(lat), Some(lon)) if (-90.0..=90.0).contains(&lat) && (-180.0..=180.0).contains(&lon) => {}
                _ => return Err("gps needs lat and lon in range".into()),
            }
        }
        Ok(())
    }
}

/// `lumbridge-mobile-server files update <id>`: only these fields, and nothing that deletes.
pub async fn update(tx: &Transaction<'_>, id: Uuid, f: &Filed) -> Result<Option<FileRow>, tokio_postgres::Error> {
    let set = |o: &Option<Option<String>>| o.is_some();
    let val = |o: &Option<Option<String>>| o.clone().flatten();
    let ids = f.identifiers.as_ref().map(|v| serde_json::Value::from(v.iter().cloned().map(serde_json::Value::Object).collect::<Vec<_>>()).to_string());
    let gps = f.gps.as_ref().map(|g| g.as_ref().map(|m| serde_json::Value::Object(m.clone()).to_string()));
    let sql = format!(
        "update files set
           status = coalesce($2, status),
           description = case when $3 then $4 else description end,
           ocr_text = case when $5 then $6 else ocr_text end,
           category = case when $7 then $8 else category end,
           identifiers = coalesce($9::text::jsonb, identifiers),
           sensitive = coalesce($10, sensitive),
           error = case when $11 then $12 else error end,
           taken_at = case when $13 then $14 else taken_at end,
           gps = case when $15 then $16::text::jsonb else gps end,
           version = version + 1, updated_at = now()
         where id = $1 returning {COLUMNS}"
    );
    let taken_set = f.taken_at.is_some();
    let taken = f.taken_at.flatten();
    let gps_set = gps.is_some();
    let gps_val = gps.flatten();
    let row = tx
        .query_opt(
            &sql,
            &[
                &id,
                &f.status,
                &set(&f.description),
                &val(&f.description),
                &set(&f.ocr_text),
                &val(&f.ocr_text),
                &set(&f.category),
                &val(&f.category),
                &ids,
                &f.sensitive,
                &set(&f.error),
                &val(&f.error),
                &taken_set,
                &taken,
                &gps_set,
                &gps_val,
            ],
        )
        .await?;
    Ok(row.map(FileRow::from))
}

/// Oldest first: the filer works through them in the order they came.
pub async fn pending(tx: &Transaction<'_>, limit: i64) -> Result<Vec<FileRow>, tokio_postgres::Error> {
    let sql = format!("select {COLUMNS} from files where status = 'new' and deleted_at is null order by created_at, id limit $1");
    Ok(tx.query(&sql, &[&limit]).await?.into_iter().map(FileRow::from).collect())
}

pub async fn recent(tx: &Transaction<'_>, limit: i64, since: Option<DateTime<Utc>>) -> Result<Vec<FileRow>, tokio_postgres::Error> {
    let sql = format!(
        "select {COLUMNS} from files
         where deleted_at is null and ($2::timestamptz is null or created_at >= $2)
         order by created_at desc, id limit $1"
    );
    Ok(tx.query(&sql, &[&limit, &since]).await?.into_iter().map(FileRow::from).collect())
}

pub async fn matching(tx: &Transaction<'_>, ts: &str, limit: i64) -> Result<Vec<FileRow>, tokio_postgres::Error> {
    let sql = format!(
        "select {COLUMNS} from files
         where deleted_at is null and search @@ (to_tsquery('english', $1) || to_tsquery('simple', $1))
         order by ts_rank(search, to_tsquery('english', $1) || to_tsquery('simple', $1)) desc, created_at desc, id limit $2"
    );
    Ok(tx.query(&sql, &[&ts, &limit]).await?.into_iter().map(FileRow::from).collect())
}

pub async fn one(tx: &Transaction<'_>, id: Uuid) -> Result<Option<FileRow>, tokio_postgres::Error> {
    let sql = format!("select {COLUMNS} from files where id = $1 and deleted_at is null");
    Ok(tx.query_opt(&sql, &[&id]).await?.map(FileRow::from))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniffs_by_content() {
        assert_eq!(sniff(&[0xFF, 0xD8, 0xFF, 0xE1]).0, "image/jpeg");
        assert_eq!(sniff(b"\x89PNG\r\n\x1a\n....").0, "image/png");
        assert_eq!(sniff(b"RIFF\0\0\0\0WEBPVP8 ").0, "image/webp");
        assert_eq!(sniff(b"\0\0\0\x18ftypheic\0\0\0\0").0, "image/heic");
        assert_eq!(sniff(b"\0\0\0\x18ftypmif1\0\0\0\0").0, "image/heif");
        assert_eq!(sniff(b"%PDF-1.7\n").0, "application/pdf");
        for active in [&b"<svg xmlns='http://www.w3.org/2000/svg'><script>"[..], b"<!doctype html><script>", b"<html>", b"GIF8", b""] {
            assert_eq!(sniff(active), ("application/octet-stream", "bin"), "{:?}", String::from_utf8_lossy(active));
        }
    }

    #[test]
    fn names_are_text_and_downloads_are_plain() {
        assert_eq!(clean_name("  VIN\u{0}\u{1b}[31m photo.jpg\n"), "VIN[31m photo.jpg");
        assert_eq!(download_name("<img src=x onerror=alert(1)>.jpg", "jpg"), "_img src_x onerror_alert_1__.jpg");
        assert_eq!(download_name("\"; filename=evil.html", "bin"), "__ filename_evil.bin");
        assert_eq!(download_name("", "pdf"), "file.pdf");
        assert!(clean_name(&"é".repeat(2000)).len() <= MAX_NAME);
    }

    #[test]
    fn only_our_own_paths_open() {
        let d = FsPath::new("/f");
        let id = Uuid::new_v4();
        assert_eq!(stored(d, &format!("2026/11/{id}.jpg")), Some(PathBuf::from(format!("/f/2026/11/{id}.jpg"))));
        for bad in [format!("../11/{id}.jpg"), format!("2026/11/../{id}.jpg"), "2026/11/x.jpg".into(), format!("/2026/11/{id}.jpg"), format!("2026/11/{id}.j/g"), format!("2026/11/{id}.")] {
            assert_eq!(stored(d, &bad), None, "{bad}");
        }
    }

    #[test]
    fn filer_fields_are_checked() {
        let f = |s: &str| serde_json::from_str::<Filed>(s).map_err(|e| e.to_string()).and_then(|f| f.check());
        assert!(f(r#"{"status":"filed","category":"vehicle","identifiers":[{"kind":"vin","value":"5YJXCAE2XGF000000","verified":true}],"gps":{"lat":34.1,"lon":-118.3}}"#).is_ok());
        assert!(f(r#"{"description":null,"taken_at":null,"gps":null}"#).is_ok());
        for bad in [r#"{"status":"deleted"}"#, r#"{"category":"weapons"}"#, r#"{"deleted_at":"2026-01-01T00:00:00Z"}"#, r#"{"identifiers":[{"kind":"vin"}]}"#, r#"{"gps":{"lat":200,"lon":0}}"#, r#"{"id":"x"}"#] {
            assert!(f(bad).is_err(), "{bad}");
        }
    }
}
