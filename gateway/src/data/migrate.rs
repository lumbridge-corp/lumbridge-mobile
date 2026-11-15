//! `lumbridge-mobile-server migrate [--status]`: applies db/NNN_*.sql in order, each in its own transaction, and records what
//! ran in schema_migrations. Runs as lumbridge_app, which owns the schema but has no CREATE on the database, so
//! db/bootstrap.sql has to have run first. Never runs at gateway start: a migration is a decision, not a side effect.

use super::db::parse_url;
use tokio_postgres::{Client, NoTls};

pub const MIGRATIONS: &[(&str, &str)] = &[
    ("001_notes_tasks.sql", include_str!("../../../db/001_notes_tasks.sql")),
    ("002_thoughts.sql", include_str!("../../../db/002_thoughts.sql")),
    ("003_asks.sql", include_str!("../../../db/003_asks.sql")),
    ("004_files.sql", include_str!("../../../db/004_files.sql")),
    ("005_ask_options.sql", include_str!("../../../db/005_ask_options.sql")),
    ("006_note_proposals.sql", include_str!("../../../db/006_note_proposals.sql")),
];

/// Any id will do so long as it's stable: only other runs of this runner take this advisory lock.
const LOCK: i64 = 0x006b_6172_7469_6f73;

pub async fn apply(client: &mut Client, migrations: &[(&str, &str)]) -> Result<Vec<String>, String> {
    // The role's own search_path names the schema (db/bootstrap.sql); every statement here and in db/ leaves it unqualified.
    let schema = client.query_one("select current_schema()", &[]).await.map_err(describe)?;
    if schema.get::<_, Option<String>>(0).is_none_or(|s| s == "public") {
        return Err("no schema of its own on this role's search_path; an admin runs db/bootstrap.sql first".into());
    }
    client.execute("select pg_advisory_lock($1)", &[&LOCK]).await.map_err(describe)?;
    let result = apply_locked(client, migrations).await;
    let _ = client.execute("select pg_advisory_unlock($1)", &[&LOCK]).await;
    result
}

async fn apply_locked(client: &mut Client, migrations: &[(&str, &str)]) -> Result<Vec<String>, String> {
    client
        .batch_execute(
            "create table if not exists schema_migrations (
               name text primary key, checksum text not null, applied_at timestamptz not null default now())",
        )
        .await
        .map_err(describe)?;
    let mut applied = Vec::new();
    for (name, sql) in migrations {
        let done = client
            .query_opt(
                "select checksum = md5($2::text) from schema_migrations where name = $1",
                &[name, sql],
            )
            .await
            .map_err(describe)?;
        match done.map(|row| row.get::<_, bool>(0)) {
            Some(true) => continue,
            Some(false) if earlier_text(client, name).await? => continue,
            Some(false) => return Err(format!("{name} was applied, then its file changed; add a new migration instead")),
            None => {}
        }
        let tx = client.transaction().await.map_err(describe)?;
        tx.batch_execute(sql).await.map_err(|e| format!("{name}: {}", describe(e)))?;
        tx.execute("insert into schema_migrations (name, checksum) values ($1, md5($2::text))", &[name, sql])
            .await
            .map_err(describe)?;
        tx.commit().await.map_err(describe)?;
        applied.push(name.to_string());
    }
    Ok(applied)
}

/// md5 of the text of a migration before 0.1.0, when every statement named its schema. The files changed to leave the schema to
/// the role's search_path and do exactly what they did, so a database that ran the earlier text is up to date.
const EARLIER: &[(&str, &str)] = &[
    ("001_notes_tasks.sql", "81821b656cc1597c0126a00a6ebdb900"),
    ("002_thoughts.sql", "0c314ea7658690baa3be5caba4807c82"),
    ("003_asks.sql", "d6fbacddd764fa8ac19db584512d2286"),
    ("004_files.sql", "ba3b71a2db42998c48dbed6177ae3ada"),
    ("005_ask_options.sql", "bf9a35b4c8422f49360d47ce6242ea94"),
    ("006_note_proposals.sql", "28a066982dca6abc994a5472a1f448a0"),
];

async fn earlier_text(client: &Client, name: &str) -> Result<bool, String> {
    let Some((_, md5)) = EARLIER.iter().find(|(n, _)| *n == name) else { return Ok(false) };
    let row = client
        .query_one("select checksum = $2 from schema_migrations where name = $1", &[&name, md5])
        .await
        .map_err(describe)?;
    Ok(row.get::<_, bool>(0))
}

async fn applied_names(client: &Client) -> Result<Vec<String>, String> {
    let table = client
        .query_one("select to_regclass('schema_migrations') is not null", &[])
        .await
        .map_err(describe)?;
    if !table.get::<_, bool>(0) {
        return Ok(Vec::new());
    }
    let rows = client.query("select name from schema_migrations order by name", &[]).await.map_err(describe)?;
    Ok(rows.iter().map(|r| r.get(0)).collect())
}

/// Only the server's message and code: tokio-postgres's Display can include connection details.
pub fn describe(e: tokio_postgres::Error) -> String {
    match e.as_db_error() {
        Some(db) => format!("{} ({})", db.message(), db.code().code()),
        None => "could not talk to the database".into(),
    }
}

pub async fn cli(status_only: bool) -> Result<(), String> {
    let url = std::env::var("LUMBRIDGE_DATABASE_URL").map_err(|_| "LUMBRIDGE_DATABASE_URL is required".to_string())?;
    let cfg = parse_url(&url).map_err(|_| "LUMBRIDGE_DATABASE_URL does not parse".to_string())?;
    let (mut client, connection) = cfg.connect(NoTls).await.map_err(describe)?;
    tokio::spawn(connection);
    if status_only {
        let done = applied_names(&client).await?;
        for (name, _) in MIGRATIONS {
            println!("{} {name}", if done.iter().any(|d| d == name) { "applied" } else { "pending" });
        }
        return Ok(());
    }
    let applied = apply(&mut client, MIGRATIONS).await?;
    if applied.is_empty() {
        println!("up to date");
    }
    for name in applied {
        println!("applied {name}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn every_file_in_db_is_listed_in_order() {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../db");
        let on_disk: BTreeSet<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .filter(|n| n.ends_with(".sql") && n != "bootstrap.sql")
            .collect();
        let listed: Vec<String> = MIGRATIONS.iter().map(|(n, _)| n.to_string()).collect();
        assert_eq!(on_disk.into_iter().collect::<Vec<_>>(), listed);
    }

    /// The throwaway Postgres (scripts/dev-db.sh, scripts/ci-db.sh): 127.0.0.1, port LUMBRIDGE_PG_PORT or 5498.
    fn pg(login: &str, db: &str) -> String {
        let port = std::env::var("LUMBRIDGE_PG_PORT").unwrap_or_else(|_| "5498".into());
        format!("postgres://{login}@127.0.0.1:{port}/{db}")
    }
    const ADMIN_LOGIN: &str = "postgres:lumbridge-throwaway";

    /// A fresh database with lumbridge_app and its schema, made the way production's were. None if lumbridge-dev-db is down.
    async fn fresh() -> Option<(Client, String)> {
        let admin = connect(&pg(ADMIN_LOGIN, "postgres")).await?;
        let name = format!("lumbridge_mig_{}", uuid::Uuid::new_v4().simple());
        admin.batch_execute(&format!("create database {name}")).await.unwrap();
        let on_it = connect(&pg(ADMIN_LOGIN, &name)).await.unwrap();
        // Production's shape (db/bootstrap.sql). The role is shared by every test database; only the first creation works.
        let _ = on_it.batch_execute("create role lumbridge_app login noinherit password 'dev'; alter role lumbridge_app set search_path = lumbridge").await;
        on_it.batch_execute("create schema lumbridge authorization lumbridge_app; revoke all on schema lumbridge from public").await.unwrap();
        Some((connect(&pg("lumbridge_app:dev", &name)).await.unwrap(), name))
    }

    async fn connect(url: &str) -> Option<Client> {
        let (client, connection) = parse_url(url).unwrap().connect(NoTls).await.ok()?;
        tokio::spawn(connection);
        Some(client)
    }

    async fn drop_db(name: String, client: Client) {
        drop(client);
        let admin = connect(&pg(ADMIN_LOGIN, "postgres")).await.unwrap();
        admin.batch_execute(&format!("drop database {name} with (force)")).await.unwrap();
    }

    #[tokio::test]
    async fn applies_once_records_and_rolls_back_failures() {
        let Some((mut c, name)) = fresh().await else {
            eprintln!("SKIPPED: lumbridge-dev-db is down (scripts/dev-db.sh)");
            assert!(std::env::var_os("LUMBRIDGE_TEST_REQUIRE_DB").is_none(), "lumbridge-dev-db is required");
            return;
        };
        let all = vec!["001_notes_tasks.sql", "002_thoughts.sql", "003_asks.sql", "004_files.sql", "005_ask_options.sql", "006_note_proposals.sql"];
        // Production as it stands, with rows in it, and then what's new on top.
        assert_eq!(apply(&mut c, &MIGRATIONS[..5]).await.unwrap(), all[..5]);
        c.batch_execute("insert into notes (title, body) values ('kept', 'a note from before'); insert into asks (title) values ('a question')")
            .await
            .unwrap();
        assert_eq!(apply(&mut c, MIGRATIONS).await.unwrap(), all[5..]);
        assert_eq!(c.query_one("select count(*) from notes", &[]).await.unwrap().get::<_, i64>(0), 1);
        assert!(apply(&mut c, MIGRATIONS).await.unwrap().is_empty(), "second run is a no-op");
        assert_eq!(applied_names(&c).await.unwrap(), all);

        // A failing migration leaves nothing behind and stops the ones after it.
        let bad = [
            ("100_bad.sql", "create table half_done (id int); select nonsense_column;"),
            ("101_after.sql", "create table after_bad (id int);"),
        ];
        let err = apply(&mut c, &bad).await.unwrap_err();
        assert!(err.starts_with("100_bad.sql"), "{err}");
        let gone = c
            .query_one("select to_regclass('half_done') is null and to_regclass('after_bad') is null", &[])
            .await
            .unwrap();
        assert!(gone.get::<_, bool>(0), "the failed migration rolled back");
        assert_eq!(applied_names(&c).await.unwrap().len(), MIGRATIONS.len());

        // An applied migration whose file changed is refused, not re-run.
        let edited = [("001_notes_tasks.sql", "select 1;")];
        assert!(apply(&mut c, &edited).await.unwrap_err().contains("its file changed"));
        drop_db(name, c).await;
    }

    #[tokio::test]
    async fn app_role_has_no_reach_beyond_its_schema() {
        let Some((c, name)) = fresh().await else { return };
        assert!(c.batch_execute("create schema nope").await.is_err(), "no CREATE on the database");
        assert!(c.batch_execute("create table public.nope (id int)").await.is_err(), "no CREATE in public");
        drop_db(name, c).await;
    }

    #[tokio::test]
    async fn refuses_without_the_schema() {
        let Some(admin) = connect(&pg(ADMIN_LOGIN, "postgres")).await else { return };
        let name = format!("lumbridge_mig_{}", uuid::Uuid::new_v4().simple());
        admin.batch_execute(&format!("create database {name}")).await.unwrap();
        let mut on_it = connect(&pg(ADMIN_LOGIN, &name)).await.unwrap();
        assert!(apply(&mut on_it, MIGRATIONS).await.unwrap_err().contains("bootstrap.sql"));
        drop_db(name, on_it).await;
    }
}
