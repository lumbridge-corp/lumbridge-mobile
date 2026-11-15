//! A small Postgres pool that fails fast. No TLS: the gateway reaches the pooler over the tailnet, which WireGuard
//! encrypts, and pulling in OpenSSL for it is a cost with no benefit.

use super::ApiError;
use deadpool_postgres::{Manager, ManagerConfig, Pool, RecyclingMethod, Runtime, Timeouts};
use std::{str::FromStr, time::Duration};
use tokio_postgres::{types::ToSql, NoTls, Row};

/// Longest a request waits on the database in total before it answers 503.
const OP_TIMEOUT: Duration = Duration::from_secs(5);

/// The URL carries the password: never log it, and never log a parse error's text either.
pub fn parse_url(url: &str) -> Result<tokio_postgres::Config, ()> {
    let mut cfg = tokio_postgres::Config::from_str(url).map_err(|_| ())?;
    cfg.connect_timeout(Duration::from_secs(3))
        .keepalives_idle(Duration::from_secs(30))
        .tcp_user_timeout(Duration::from_secs(10))
        .application_name("lumbridge-mobile-server");
    Ok(cfg)
}

#[derive(Clone)]
pub struct Db(Option<Pool>);

impl Db {
    #[cfg(test)]
    pub fn none() -> Self {
        Self(None)
    }

    pub fn from_env() -> Self {
        let Ok(url) = std::env::var("LUMBRIDGE_DATABASE_URL") else {
            eprintln!("LUMBRIDGE_DATABASE_URL is not set: /api/notes, /api/tasks, /api/thoughts and /api/asks answer 503");
            return Self(None);
        };
        let Ok(cfg) = parse_url(&url) else {
            eprintln!("LUMBRIDGE_DATABASE_URL does not parse: /api/notes, /api/tasks, /api/thoughts and /api/asks answer 503");
            return Self(None);
        };
        let mgr = Manager::from_config(cfg, NoTls, ManagerConfig { recycling_method: RecyclingMethod::Fast });
        let pool = Pool::builder(mgr)
            .max_size(4)
            .timeouts(Timeouts {
                wait: Some(Duration::from_secs(3)),
                create: Some(Duration::from_secs(4)),
                recycle: Some(Duration::from_secs(2)),
            })
            .runtime(Runtime::Tokio1)
            .build();
        match pool {
            Ok(p) => Self(Some(p)),
            Err(_) => {
                eprintln!("could not build the database pool: /api/notes, /api/tasks, /api/thoughts and /api/asks answer 503");
                Self(None)
            }
        }
    }

    pub async fn query(&self, sql: &str, params: &[&(dyn ToSql + Sync)]) -> Result<Vec<Row>, ApiError> {
        let pool = self.0.as_ref().ok_or(ApiError::Unavailable)?;
        tokio::time::timeout(OP_TIMEOUT, async {
            let client = pool.get().await.map_err(|_| ApiError::Unavailable)?;
            let statement = client.prepare_cached(sql).await.map_err(pg_error)?;
            client.query(&statement, params).await.map_err(pg_error)
        })
        .await
        .map_err(|_| ApiError::Unavailable)?
    }

    /// A connection of its own, for work in a transaction. Wrap the whole of that work in `timed`.
    pub async fn client(&self) -> Result<deadpool_postgres::Object, ApiError> {
        let pool = self.0.as_ref().ok_or(ApiError::Unavailable)?;
        pool.get().await.map_err(|_| ApiError::Unavailable)
    }

    pub async fn one(&self, sql: &str, params: &[&(dyn ToSql + Sync)]) -> Result<Option<Row>, ApiError> {
        Ok(self.query(sql, params).await?.into_iter().next())
    }
}

/// The same deadline as `query`, for work done through `client`.
pub async fn timed<T>(work: impl std::future::Future<Output = Result<T, ApiError>>) -> Result<T, ApiError> {
    tokio::time::timeout(OP_TIMEOUT, work).await.map_err(|_| ApiError::Unavailable)?
}

/// Connection trouble and an unmigrated schema are "try again later"; anything else is a bug. Only the SQLSTATE is
/// logged, because a Postgres error's detail can quote the row.
pub fn pg_error(e: tokio_postgres::Error) -> ApiError {
    let Some(code) = e.code() else { return ApiError::Unavailable };
    let code = code.code();
    if code.starts_with("08") || code.starts_with("53") || code.starts_with("57") || code == "42P01" || code == "3F000" {
        eprintln!("database unavailable: SQLSTATE {code}");
        return ApiError::Unavailable;
    }
    eprintln!("database error: SQLSTATE {code}");
    ApiError::Internal
}
