//! `lumbridge-mobile-server pair|devices|revoke`, run on the server as the user the gateway runs as. They edit the same file the running server reads, so no
//! restart. Needs only LUMBRIDGE_STATE_DIR. `pair` prints the link on stdout and nothing else: scripts/pair.sh captures it.
//!
//! `lumbridge-mobile-server thoughts recent|search` is what the assistant's tool calls. It prints JSON on stdout, needs only
//! LUMBRIDGE_DATABASE_URL, and runs in a read-only transaction, so the database itself refuses any write.
//!
//! `lumbridge-mobile-server files pending|update|recent|search|read` is for the filer (a separate program on the server), and for the assistant. Only `update`
//! writes, and only the fields `files::Filed` names; nothing here can delete. The rest run read-only like `thoughts`.
//!
//! `lumbridge-mobile-server asks create|recent` is how the assistant asks the owner something (data/asks.rs). `create` reads `{"title","body"}`, and
//! `options` for an ask answered by picking, on stdin and prints the new row; `recent` prints asks with their answers, read-only like `thoughts`.
//!
//! `lumbridge-mobile-server notes search|read|recent` is the assistant reading the owner's notes, and `recent --since` is how its recall indexes them:
//! read-only like `thoughts`. `lumbridge-mobile-server proposals create` is how it proposes one (data/proposals.rs): `{"title", "body",
//! "why", "source"}` on stdin, and it's from LUMBRIDGE_ASSISTANT_DEVICE (default `assistant`), whatever stdin says.
//!
//! `pair <name> --agent` pairs an agent device (devices.rs, `Role`): one that may only read notes and propose new ones.

use crate::data::{asks, db::parse_url, files, migrate::describe, notes, proposals, search_terms, thoughts};
use crate::devices::{Role, Store};
use chrono::{DateTime, NaiveDate, Utc};
use std::time::Duration;
use tokio_postgres::{Client, NoTls, TransactionBuilder};

const USAGE: &str = "usage: lumbridge-mobile-server [pair <device-name> [--agent] | devices | revoke <device-name> | thoughts recent [--limit N] [--since <iso>] | thoughts search <query> [--limit N] | files ... | asks create | asks recent [--limit N] | notes ... | proposals create]";
const NOTES_USAGE: &str = "usage: lumbridge-mobile-server notes search <query> [--limit N] | notes read <id> | notes recent [--since <date>] [--limit N]";
const PROPOSALS_USAGE: &str = "usage: lumbridge-mobile-server proposals create < {\"title\": \"...\", \"body\": \"...\", \"why\": \"...\", \"source\": \"...\"}";
/// Who `proposals create` is from: the CLI is the assistant's, on the server. LUMBRIDGE_ASSISTANT_DEVICE names it, as stored in
/// `proposed_by`; default `assistant`.
fn cli_proposer() -> String {
    std::env::var("LUMBRIDGE_ASSISTANT_DEVICE").ok().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "assistant".into())
}
const FILES_USAGE: &str = "usage: lumbridge-mobile-server files pending [--limit N] | files update <id> (JSON on stdin) | files recent [--limit N] [--since <iso>] | files search <query> [--limit N] | files read <id>";
const THOUGHTS_USAGE: &str = "usage: lumbridge-mobile-server thoughts recent [--limit N] [--since <iso>] | thoughts search <query> [--limit N]";
const ASKS_USAGE: &str = "usage: lumbridge-mobile-server asks create < {\"title\": \"...\", \"body\": \"...\", \"options\": [{\"key\", \"label\", \"detail\", \"link\"}]} | asks recent [--limit N]";
/// A title, a body and the options, with room for JSON's escapes.
const MAX_ASK_INPUT: u64 = 256 * 1024;
const DEFAULT_LIMIT: i64 = 20;
const MAX_LIMIT: i64 = 200;
/// A tool waiting on this shouldn't wait on a database that's gone.
const THOUGHTS_TIMEOUT: Duration = Duration::from_secs(20);

fn store() -> Result<Store, String> {
    let dir = std::env::var("LUMBRIDGE_STATE_DIR").map_err(|_| "LUMBRIDGE_STATE_DIR is required".to_string())?;
    Ok(Store::new(&dir))
}

/// A UTC timestamp from unix seconds (Howard Hinnant's civil_from_days).
fn when(secs: u64) -> String {
    let days = (secs / 86400) as i64 + 719468;
    let era = days.div_euclid(146097);
    let doe = days.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    let s = secs % 86400;
    format!("{year:04}-{month:02}-{day:02} {:02}:{:02}Z", s / 3600, s % 3600 / 60)
}

fn run_inner(args: &[String]) -> Result<(), String> {
    let strs: Vec<&str> = args.iter().map(String::as_str).collect();
    match strs.as_slice() {
        ["pair", name] | ["pair", name, "--agent"] => {
            let role = if strs.len() == 3 { Role::Agent } else { Role::Owner };
            // The address phones open: LUMBRIDGE_PUBLIC_URL, else the first https:// origin in LUMBRIDGE_ORIGINS.
            let base = std::env::var("LUMBRIDGE_PUBLIC_URL")
                .ok()
                .filter(|u| !u.trim().is_empty())
                .or_else(|| {
                    std::env::var("LUMBRIDGE_ORIGINS").ok()?.split(',').map(str::trim).find(|o| o.starts_with("https://")).map(String::from)
                })
                .ok_or("set LUMBRIDGE_PUBLIC_URL (or LUMBRIDGE_ORIGINS): the address the pairing link opens")?;
            let code = store()?.begin_pair_as(name, role)?;
            println!("{}/#pair={code}", base.trim_end_matches('/'));
            Ok(())
        }
        ["devices"] => {
            // ROLE last, so what reads NAME and STATE from the front still does.
            println!("{:<28} {:<8} {:<18} {:<18} ROLE", "NAME", "STATE", "CREATED", "LAST SEEN");
            for d in store()?.list()? {
                let state = if d.revoked { "revoked" } else { "active" };
                let seen = d.last_seen.map(when).unwrap_or_else(|| "never".into());
                println!("{:<28} {:<8} {:<18} {seen:<18} {}", d.name, state, when(d.created), d.role.as_str());
            }
            Ok(())
        }
        ["revoke", name] => {
            if store()?.revoke(name)? {
                println!("revoked {name}; its open sessions end within 5 seconds");
                Ok(())
            } else {
                Err(format!("no device or pending code named {name}"))
            }
        }
        #[cfg(feature = "dev-identity")]
        ["dev-add", name] | ["dev-add", name, "--agent"] => {
            let role = if strs.len() == 3 { Role::Agent } else { Role::Owner };
            let mut token = String::new();
            std::io::stdin().read_line(&mut token).map_err(|e| e.to_string())?;
            store()?.add_token(name, token.trim(), role)
        }
        _ => Err(USAGE.into()),
    }
}

pub fn run(args: &[String]) -> i32 {
    match run_inner(args) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("{e}");
            1
        }
    }
}

#[derive(Debug, PartialEq)]
enum ThoughtsQuery {
    Recent { limit: i64, since: Option<DateTime<Utc>> },
    Search { query: String, limit: i64 },
}

fn parse_since(s: &str) -> Result<DateTime<Utc>, String> {
    if let Ok(t) = DateTime::parse_from_rfc3339(s) {
        return Ok(t.with_timezone(&Utc));
    }
    let day = NaiveDate::parse_from_str(s, "%Y-%m-%d").map_err(|_| format!("--since: not a date: {s}"))?;
    Ok(day.and_hms_opt(0, 0, 0).ok_or("--since: not a date")?.and_utc())
}

fn parse_thoughts(args: &[String]) -> Result<ThoughtsQuery, String> {
    let (what, rest) = args.split_first().ok_or(THOUGHTS_USAGE)?;
    let (mut limit, mut since, mut words) = (DEFAULT_LIMIT, None, Vec::new());
    let mut rest = rest.iter();
    while let Some(arg) = rest.next() {
        match arg.as_str() {
            "--limit" => {
                let n = rest.next().ok_or(THOUGHTS_USAGE)?;
                limit = n.parse::<i64>().map_err(|_| format!("--limit: not a number: {n}"))?.clamp(1, MAX_LIMIT);
            }
            "--since" if what == "recent" => since = Some(parse_since(rest.next().ok_or(THOUGHTS_USAGE)?)?),
            flag if flag.starts_with("--") => return Err(THOUGHTS_USAGE.into()),
            word => words.push(word),
        }
    }
    match what.as_str() {
        "recent" if words.is_empty() => Ok(ThoughtsQuery::Recent { limit, since }),
        "search" if !words.is_empty() => Ok(ThoughtsQuery::Search { query: words.join(" "), limit }),
        _ => Err(THOUGHTS_USAGE.into()),
    }
}

/// This is what stops the subcommand writing, whatever its SQL says.
fn read_only(client: &mut Client) -> TransactionBuilder<'_> {
    client.build_transaction().read_only(true)
}

async fn read_thoughts(query: ThoughtsQuery) -> Result<String, String> {
    let url = std::env::var("LUMBRIDGE_DATABASE_URL").map_err(|_| "LUMBRIDGE_DATABASE_URL is required".to_string())?;
    let cfg = parse_url(&url).map_err(|_| "LUMBRIDGE_DATABASE_URL does not parse".to_string())?;
    let (mut client, connection) = cfg.connect(NoTls).await.map_err(describe)?;
    tokio::spawn(connection);
    let tx = read_only(&mut client).start().await.map_err(describe)?;
    let rows = match query {
        ThoughtsQuery::Recent { limit, since } => thoughts::recent(&tx, limit, since).await,
        ThoughtsQuery::Search { query, limit } => {
            let ts = search_terms(&query).map_err(|_| "the search is too long".to_string())?;
            thoughts::matching(&tx, ts.as_deref().unwrap_or(""), limit).await
        }
    }
    .map_err(describe)?;
    serde_json::to_string(&rows).map_err(|e| e.to_string())
}

pub async fn thoughts(args: &[String]) -> i32 {
    let done = match parse_thoughts(args) {
        Ok(query) => tokio::time::timeout(THOUGHTS_TIMEOUT, read_thoughts(query)).await.unwrap_or_else(|_| Err("the database didn't answer".into())),
        Err(usage) => Err(usage),
    };
    match done {
        Ok(json) => {
            println!("{json}");
            0
        }
        Err(e) => {
            eprintln!("thoughts: {e}");
            1
        }
    }
}

#[derive(Debug, PartialEq)]
enum FilesCommand {
    Pending { limit: i64 },
    Update { id: uuid::Uuid },
    Read { id: uuid::Uuid },
    Query(ThoughtsQuery),
}

fn parse_files(args: &[String]) -> Result<FilesCommand, String> {
    let id = |s: &String| uuid::Uuid::parse_str(s).map_err(|_| format!("not a file id: {s}"));
    match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["pending"] => Ok(FilesCommand::Pending { limit: DEFAULT_LIMIT }),
        ["pending", "--limit", n] => {
            Ok(FilesCommand::Pending { limit: n.parse::<i64>().map_err(|_| format!("--limit: not a number: {n}"))?.clamp(1, MAX_LIMIT) })
        }
        ["update", _] => Ok(FilesCommand::Update { id: id(&args[1])? }),
        ["read", _] => Ok(FilesCommand::Read { id: id(&args[1])? }),
        ["recent", ..] | ["search", ..] => parse_thoughts(args).map(FilesCommand::Query).map_err(|_| FILES_USAGE.into()),
        _ => Err(FILES_USAGE.into()),
    }
}

async fn run_files(cmd: FilesCommand) -> Result<String, String> {
    let url = std::env::var("LUMBRIDGE_DATABASE_URL").map_err(|_| "LUMBRIDGE_DATABASE_URL is required".to_string())?;
    let cfg = parse_url(&url).map_err(|_| "LUMBRIDGE_DATABASE_URL does not parse".to_string())?;
    let filed = if let FilesCommand::Update { .. } = cmd {
        let mut input = String::new();
        std::io::Read::read_to_string(&mut std::io::Read::take(std::io::stdin(), 1024 * 1024), &mut input).map_err(|e| e.to_string())?;
        let f: files::Filed = serde_json::from_str(&input).map_err(|e| format!("stdin: {e}"))?;
        f.check()?;
        Some(f)
    } else {
        None
    };
    let (mut client, connection) = cfg.connect(NoTls).await.map_err(describe)?;
    tokio::spawn(connection);
    let out = match cmd {
        FilesCommand::Update { id } => {
            let tx = client.transaction().await.map_err(describe)?;
            let row = files::update(&tx, id, filed.as_ref().ok_or("no input")?).await.map_err(describe)?.ok_or_else(|| format!("no file {id}"))?;
            tx.commit().await.map_err(describe)?;
            json(&row)?
        }
        cmd => {
            let tx = read_only(&mut client).start().await.map_err(describe)?;
            match cmd {
                FilesCommand::Pending { limit } => json(&files::pending(&tx, limit).await.map_err(describe)?)?,
                FilesCommand::Read { id } => json(&files::one(&tx, id).await.map_err(describe)?.ok_or_else(|| format!("no file {id}"))?)?,
                FilesCommand::Query(ThoughtsQuery::Recent { limit, since }) => json(&files::recent(&tx, limit, since).await.map_err(describe)?)?,
                FilesCommand::Query(ThoughtsQuery::Search { query, limit }) => {
                    let ts = search_terms(&query).map_err(|_| "the search is too long".to_string())?;
                    json(&files::matching(&tx, ts.as_deref().unwrap_or(""), limit).await.map_err(describe)?)?
                }
                FilesCommand::Update { .. } => unreachable!(),
            }
        }
    };
    Ok(out)
}

fn json<T: serde::Serialize>(v: &T) -> Result<String, String> {
    serde_json::to_string(v).map_err(|e| e.to_string())
}

pub async fn files(args: &[String]) -> i32 {
    let done = match parse_files(args) {
        Ok(cmd) => tokio::time::timeout(THOUGHTS_TIMEOUT, run_files(cmd)).await.unwrap_or_else(|_| Err("the database didn't answer".into())),
        Err(usage) => Err(usage),
    };
    match done {
        Ok(json) => {
            println!("{json}");
            0
        }
        Err(e) => {
            eprintln!("files: {e}");
            1
        }
    }
}

#[derive(Debug, PartialEq)]
enum AsksCommand {
    Create,
    Recent { limit: i64 },
}

fn parse_asks(args: &[String]) -> Result<AsksCommand, String> {
    let strs: Vec<&str> = args.iter().map(String::as_str).collect();
    match strs.as_slice() {
        ["create"] => Ok(AsksCommand::Create),
        ["recent"] => Ok(AsksCommand::Recent { limit: DEFAULT_LIMIT }),
        ["recent", "--limit", n] => Ok(AsksCommand::Recent {
            limit: n.parse::<i64>().map_err(|_| format!("--limit: not a number: {n}"))?.clamp(1, MAX_LIMIT),
        }),
        _ => Err(ASKS_USAGE.into()),
    }
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct NewAsk {
    title: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    options: Option<Vec<asks::Choice>>,
}

fn read_new_ask() -> Result<NewAsk, String> {
    use std::io::Read;
    let mut input = String::new();
    std::io::stdin().take(MAX_ASK_INPUT + 1).read_to_string(&mut input).map_err(|_| "stdin isn't UTF-8 text".to_string())?;
    if input.len() as u64 > MAX_ASK_INPUT {
        return Err("the ask is too big".into());
    }
    serde_json::from_str(&input).map_err(|e| format!("stdin must be {{\"title\", \"body\", \"options\"}} as JSON: {e}"))
}

async fn run_asks(command: AsksCommand, new: Option<NewAsk>) -> Result<String, String> {
    let url = std::env::var("LUMBRIDGE_DATABASE_URL").map_err(|_| "LUMBRIDGE_DATABASE_URL is required".to_string())?;
    let cfg = parse_url(&url).map_err(|_| "LUMBRIDGE_DATABASE_URL does not parse".to_string())?;
    let (mut client, connection) = cfg.connect(NoTls).await.map_err(describe)?;
    tokio::spawn(connection);
    match (command, new) {
        (AsksCommand::Create, Some(new)) => {
            let ask = asks::create(&mut client, &new.title, &new.body, new.options).await?;
            serde_json::to_string(&ask).map_err(|e| e.to_string())
        }
        (AsksCommand::Recent { limit }, _) => {
            let tx = read_only(&mut client).start().await.map_err(describe)?;
            let rows = asks::recent(&tx, limit).await.map_err(describe)?;
            serde_json::to_string(&rows).map_err(|e| e.to_string())
        }
        (AsksCommand::Create, None) => Err(ASKS_USAGE.into()),
    }
}

pub async fn asks(args: &[String]) -> i32 {
    let done = match parse_asks(args) {
        Ok(command) => {
            // Checked before the database is asked anything, so a bad ask fails the same with it up or down.
            let new = match command {
                AsksCommand::Create => read_new_ask().and_then(|n| asks::check_new(&n.title, &n.body, n.options.clone()).map(|_| Some(n))),
                AsksCommand::Recent { .. } => Ok(None),
            };
            match new {
                Ok(new) => tokio::time::timeout(THOUGHTS_TIMEOUT, run_asks(command, new))
                    .await
                    .unwrap_or_else(|_| Err("the database didn't answer".into())),
                Err(e) => Err(e),
            }
        }
        Err(usage) => Err(usage),
    };
    match done {
        Ok(json) => {
            println!("{json}");
            0
        }
        Err(e) => {
            eprintln!("asks: {e}");
            1
        }
    }
}

#[derive(Debug, PartialEq)]
enum NotesCommand {
    Search { query: String, limit: i64 },
    Read { id: uuid::Uuid },
    Recent { limit: i64, since: Option<DateTime<Utc>> },
}

fn parse_notes(args: &[String]) -> Result<NotesCommand, String> {
    match args.first().map(String::as_str) {
        Some("read") if args.len() == 2 => {
            Ok(NotesCommand::Read { id: uuid::Uuid::parse_str(&args[1]).map_err(|_| format!("not a note id: {}", args[1]))? })
        }
        Some("search" | "recent") => match parse_thoughts(args).map_err(|_| NOTES_USAGE.to_string())? {
            ThoughtsQuery::Search { query, limit } => Ok(NotesCommand::Search { query, limit }),
            ThoughtsQuery::Recent { limit, since } => Ok(NotesCommand::Recent { limit, since }),
        },
        _ => Err(NOTES_USAGE.into()),
    }
}

async fn read_notes(cmd: NotesCommand) -> Result<String, String> {
    let url = std::env::var("LUMBRIDGE_DATABASE_URL").map_err(|_| "LUMBRIDGE_DATABASE_URL is required".to_string())?;
    let cfg = parse_url(&url).map_err(|_| "LUMBRIDGE_DATABASE_URL does not parse".to_string())?;
    let (mut client, connection) = cfg.connect(NoTls).await.map_err(describe)?;
    tokio::spawn(connection);
    let tx = read_only(&mut client).start().await.map_err(describe)?;
    match cmd {
        NotesCommand::Search { query, limit } => {
            let ts = search_terms(&query).map_err(|_| "the search is too long".to_string())?;
            json(&notes::matching(&tx, ts.as_deref().unwrap_or(""), limit).await.map_err(describe)?)
        }
        NotesCommand::Read { id } => json(&notes::one(&tx, id).await.map_err(describe)?.ok_or_else(|| format!("no note {id}"))?),
        NotesCommand::Recent { limit, since } => json(&notes::recent(&tx, limit, since).await.map_err(describe)?),
    }
}

/// Prints the JSON and says 0, or the error and says 1.
fn finish(what: &str, done: Result<String, String>) -> i32 {
    match done {
        Ok(json) => {
            println!("{json}");
            0
        }
        Err(e) => {
            eprintln!("{what}: {e}");
            1
        }
    }
}

pub async fn notes(args: &[String]) -> i32 {
    let done = match parse_notes(args) {
        Ok(cmd) => tokio::time::timeout(THOUGHTS_TIMEOUT, read_notes(cmd)).await.unwrap_or_else(|_| Err("the database didn't answer".into())),
        Err(usage) => Err(usage),
    };
    finish("notes", done)
}

fn read_new_proposal() -> Result<proposals::NewProposal, String> {
    use std::io::Read;
    let mut input = String::new();
    std::io::stdin().take(MAX_ASK_INPUT + 1).read_to_string(&mut input).map_err(|_| "stdin isn't UTF-8 text".to_string())?;
    if input.len() as u64 > MAX_ASK_INPUT {
        return Err("the proposal is too big".into());
    }
    let n = serde_json::from_str(&input).map_err(|e| format!("stdin must be {{\"title\", \"body\", \"why\", \"source\"}} as JSON: {e}"))?;
    proposals::check_new(&n).map_err(|f| f.message())
}

async fn create_proposal(n: proposals::NewProposal) -> Result<String, String> {
    let url = std::env::var("LUMBRIDGE_DATABASE_URL").map_err(|_| "LUMBRIDGE_DATABASE_URL is required".to_string())?;
    let cfg = parse_url(&url).map_err(|_| "LUMBRIDGE_DATABASE_URL does not parse".to_string())?;
    let (mut client, connection) = cfg.connect(NoTls).await.map_err(describe)?;
    tokio::spawn(connection);
    let tx = client.transaction().await.map_err(describe)?;
    let (_, p) = proposals::create(&tx, &cli_proposer(), &n).await.map_err(|f| f.message())?;
    tx.commit().await.map_err(describe)?;
    json(&p)
}

pub async fn proposals(args: &[String]) -> i32 {
    let done = match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        // Checked before the database is asked anything, so a bad one fails the same with it up or down.
        ["create"] => match read_new_proposal() {
            Ok(n) => tokio::time::timeout(THOUGHTS_TIMEOUT, create_proposal(n)).await.unwrap_or_else(|_| Err("the database didn't answer".into())),
            Err(e) => Err(e),
        },
        _ => Err(PROPOSALS_USAGE.into()),
    };
    finish("proposals", done)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn files_arguments() {
        let p = |a: &[&str]| parse_files(&a.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        let id = uuid::Uuid::new_v4();
        assert_eq!(p(&["pending"]), Ok(FilesCommand::Pending { limit: DEFAULT_LIMIT }));
        assert_eq!(p(&["pending", "--limit", "5"]), Ok(FilesCommand::Pending { limit: 5 }));
        assert_eq!(p(&["update", &id.to_string()]), Ok(FilesCommand::Update { id }));
        assert_eq!(p(&["read", &id.to_string()]), Ok(FilesCommand::Read { id }));
        assert_eq!(p(&["search", "model", "x", "vin"]), Ok(FilesCommand::Query(ThoughtsQuery::Search { query: "model x vin".into(), limit: DEFAULT_LIMIT })));
        for bad in [&[][..], &["delete", "x"], &["update"], &["update", "nope"], &["purge"], &["pending", "--limit"], &["recent", "word"]] {
            assert!(p(bad).is_err(), "{bad:?}");
        }
    }

    fn parsed(args: &[&str]) -> Result<ThoughtsQuery, String> {
        parse_thoughts(&args.iter().map(|a| a.to_string()).collect::<Vec<_>>())
    }

    #[test]
    fn thoughts_arguments() {
        assert_eq!(parsed(&["recent"]), Ok(ThoughtsQuery::Recent { limit: DEFAULT_LIMIT, since: None }));
        assert_eq!(parsed(&["recent", "--limit", "5000"]), Ok(ThoughtsQuery::Recent { limit: MAX_LIMIT, since: None }));
        let at = DateTime::parse_from_rfc3339("2026-11-04T10:00:00Z").unwrap().with_timezone(&Utc);
        assert_eq!(parsed(&["recent", "--since", "2026-11-04T05:00:00-05:00"]), Ok(ThoughtsQuery::Recent { limit: DEFAULT_LIMIT, since: Some(at) }));
        let midnight = DateTime::parse_from_rfc3339("2026-11-04T00:00:00Z").unwrap().with_timezone(&Utc);
        assert_eq!(parsed(&["recent", "--since", "2026-11-04"]), Ok(ThoughtsQuery::Recent { limit: DEFAULT_LIMIT, since: Some(midnight) }));
        assert_eq!(parsed(&["search", "roof", "leak", "--limit", "3"]), Ok(ThoughtsQuery::Search { query: "roof leak".into(), limit: 3 }));
        for bad in [&[][..], &["delete"], &["search"], &["recent", "word"], &["recent", "--limit", "x"], &["recent", "--since", "soon"], &["search", "x", "--since", "2026-11-04"], &["recent", "--write"]] {
            assert!(parsed(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn notes_arguments() {
        let p = |a: &[&str]| parse_notes(&a.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        let id = uuid::Uuid::new_v4();
        assert_eq!(p(&["search", "roof", "leak", "--limit", "3"]), Ok(NotesCommand::Search { query: "roof leak".into(), limit: 3 }));
        assert_eq!(p(&["read", &id.to_string()]), Ok(NotesCommand::Read { id }));
        let midnight = DateTime::parse_from_rfc3339("2026-11-04T00:00:00Z").unwrap().with_timezone(&Utc);
        assert_eq!(p(&["recent", "--since", "2026-11-04"]), Ok(NotesCommand::Recent { limit: DEFAULT_LIMIT, since: Some(midnight) }));
        for bad in [&[][..], &["read"], &["read", "nope"], &["search"], &["delete", "x"], &["recent", "word"], &["read", "a", "b"]] {
            assert!(p(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn asks_arguments() {
        let parsed = |a: &[&str]| parse_asks(&a.iter().map(|x| x.to_string()).collect::<Vec<_>>());
        assert_eq!(parsed(&["create"]), Ok(AsksCommand::Create));
        assert_eq!(parsed(&["recent"]), Ok(AsksCommand::Recent { limit: DEFAULT_LIMIT }));
        assert_eq!(parsed(&["recent", "--limit", "0"]), Ok(AsksCommand::Recent { limit: 1 }));
        for bad in [&[][..], &["answer"], &["create", "x"], &["recent", "--limit"], &["recent", "--limit", "x"]] {
            assert!(parsed(bad).is_err(), "{bad:?}");
        }
    }

    #[tokio::test]
    async fn its_transaction_refuses_writes() {
        let port = std::env::var("LUMBRIDGE_PG_PORT").unwrap_or_else(|_| "5498".into());
        let url = format!("postgres://postgres:lumbridge-throwaway@127.0.0.1:{port}/postgres");
        let Ok((mut client, connection)) = parse_url(&url).unwrap().connect(NoTls).await else {
            eprintln!("SKIPPED: lumbridge-dev-db is down (scripts/dev-db.sh)");
            assert!(std::env::var_os("LUMBRIDGE_TEST_REQUIRE_DB").is_none(), "lumbridge-dev-db is required");
            return;
        };
        tokio::spawn(connection);
        let tx = read_only(&mut client).start().await.unwrap();
        let refused = tx.batch_execute("create table thoughts_cli_must_not_exist (id int)").await.unwrap_err();
        assert_eq!(refused.code().map(|c| c.code()), Some("25006"), "read_only_sql_transaction");
    }

    #[test]
    fn dates_read_right() {
        assert_eq!(when(0), "1970-01-01 00:00Z");
        assert_eq!(when(1_788_480_000), "2026-09-04 00:00Z");
        assert_eq!(when(1_709_164_800 + 3661), "2024-02-29 01:01Z");
    }
}
