# Notes, tasks, thoughts, asks, note proposals and files

The owner's own data, in one schema of a PostgreSQL database you run. Single user: no accounts, sharing or teams.

```text
web/src/views/{notes,tasks,thoughts,for-you}.ts ─ /api/notes, /api/tasks, /api/thoughts, /api/asks, /api/note-proposals ─ gateway/src/data ─ Postgres
```

- **Role:** `db/bootstrap.sql`, run once by an admin, makes role `lumbridge_app` and schema `lumbridge`, owned by the role, with the role's
  `search_path` set to it. The role has no CREATE on the database. Pass it a SCRAM verifier, not a password, so no plain password reaches the
  server's logs. Every statement in `db/` and in the server leaves the schema to that `search_path`.
- **Secret:** the connection URL is `LUMBRIDGE_DATABASE_URL`, best kept in an environment file readable only by the server's user.
  The server talks to Postgres without TLS, so keep that hop on loopback or an encrypted network (a tailnet).
- **Backups** are yours: the schema is ordinary tables, so `pg_dump -n lumbridge` covers it.

## Migrations

`db/NNN_*.sql`, listed in `gateway/src/data/migrate.rs`, each in its own transaction, recorded with a checksum in
`schema_migrations`. Applied by hand, never at gateway start, after the tests pass:

```sh
LUMBRIDGE_DATABASE_URL=... lumbridge-mobile-server migrate --status
LUMBRIDGE_DATABASE_URL=... lumbridge-mobile-server migrate
```

An applied file must never change: add a new one. A migration runs as `lumbridge_app`, so it can't touch other schemas. Databases that ran the files before 0.1.0, when
they named their schema, are recognised by the earlier checksums in `migrate.rs`.

## API

`GET/POST /api/notes`, `GET/PATCH/DELETE /api/notes/:id`, `POST /api/notes/:id/restore`; the same for `/api/tasks`.
`GET` takes `q` (full text; every word must match, the last one as typed), `limit`, `offset`, and `deleted=true`.

- **PATCH** takes the `version` it was based on. On an old version it answers **409 with the current row** and changes nothing.
  A row deleted elsewhere also answers 409, so the client can see `deleted_at`.
- **POST** may carry its own `id`. A retry with the same id answers 200 with the existing row instead of making a second one.
- **DELETE** is soft and idempotent. `deleted_at` rows drop out of lists and search and stay restorable; nothing purges them.
- A pin doesn't change a note's `updated_at`, so pinning doesn't reorder "last edited".
- **Thoughts** are the same, ordered by `created_at` even when searching, with `POST` also taking `source`, `duration_ms` and `created_at` (when
  it was said, which can be well before it arrives; never later than now). An empty body is refused. `POST /api/thoughts/:id/note` makes a note
  from the text and sets `note_id`, in one statement, so a retry or a second device can't make two: 201 the first time, then 200 with the same row.
- **Asks** (`db/003_asks.sql`) are the assistant's questions for the owner: `title` (one line, at most 120 characters) and `body` are hers, `status` is
  `pending`, `accepted`, `denied` or `replied` (with `reply`, the owner's words), `answered_at`, and `delivered_at` once Hermes has the answer. No soft
  delete. `GET /api/asks` is pending ones newest first; `?answered=1` adds the last week's answered ones. `POST /api/asks/:id/answer` takes
  `{"verdict": "accept" | "deny" | "reply", "text"}`; `reply` needs text and the others refuse it. It answers once: a second time is 409
  `{"error": "already_answered", "ask": <the row that stands>}` and changes nothing. From a device the assistant operates (`LUMBRIDGE_ASSISTANT_NODES`) it's 403 `not_from_here`. See For you in
  `docs/ARCHITECTURE.md`.
  An ask can carry `options` (`db/005_ask_options.sql`): 1 to 20 `{"key" (≤ 40), "label" (≤ 120), "detail" (≤ 400), "link" (https, ≤ 500,
  optional)}`, keys unique, null for a plain ask. The owner answers it with `{"verdict": "pick", "keys": [...]}` (non-empty, unique, all from
  `options`, else 400 `bad_keys`), which stores `accepted` and `picked`; `deny` is "None of these"; `reply` keeps `picked` null; `accept` is 400
  `pick_which`. The database holds `options` and `picked` to the same rules. The app shows option text as text only, links only if `https:`.
- **Note proposals** (`db/006_note_proposals.sql`, `gateway/src/data/proposals.rs`) are notes an agent thinks the owner should keep: `title` (one line,
  1–200 characters, not blank), `body` (1–20 000), `why` and `source` (each ≤ 1 000; source one line, such as a trace URL or a session id), all
  the agent's words; `proposed_by`, the device name the gateway authenticated, never taken from the request; `status` `pending`, `accepted` or
  `denied`; `note_id` (the note made, set exactly when accepted) and `decided_at` (set exactly when not pending). Searched like notes.
  `POST /api/note-proposals {title, body, why?, source?, id?}` from any device: 201, or 200 with the existing row when this device retries the
  same `id` (409 `id_taken` when it's another device's). Any other field, `proposed_by` above all, is 422. At most **30 pending** across all
  devices, under an advisory lock: the 31st is 429 `too_many_pending`. `GET /api/note-proposals?status=pending|accepted|denied|all&q=&limit=&offset=&mine=true`,
  newest first (`pending` by default): the owner's devices see all of them, `mine=true` only the ones this device proposed; an agent device only ever
  with `mine=true`. `POST /api/note-proposals/:id/decide {decision: accept|deny, version, title?, body?}` is the owner's devices only (403
  `agent_not_allowed`); `accept` is also 403 `not_from_here` from a device the assistant operates, like an ask's answer, while `deny` works there. Accept
  makes the note in the same transaction (the owner's edited `title`/`body` if given, else the proposed ones) with a last line
  `— proposed by <device>, <YYYY-MM-DD>; source: <source>` (no `; source:` part when there is none), and answers `{proposal, note}`. A stale
  `version` is 409 `{"error": "version_conflict", "proposal"}`, deciding twice 409 `{"error": "already_decided", "proposal"}`; neither changes
  anything. Without migration 006 these routes answer 503 like any other data route.
- **Files** (`db/004_files.sql`): only text about a file is here: name, sniffed `mime`, `bytes`, `sha256`, `path`, `status` (`new`, `filed`,
  `failed`), and what the filer read: `description`, `ocr_text`, `category`, `identifiers` (a JSON array of `{kind, value, verified?, label?}`),
  `sensitive`, `error`, `taken_at`, `gps`. The bytes stay on the server host under `LUMBRIDGE_FILES_DIR` (`~/files/YYYY/MM/<id>.<ext>`, 0700/0600, previews
  `<id>.thumb.jpg` and `<id>.large.jpg` beside it), never in the database. `POST /api/files?id=<uuid>&name=<name>` takes the raw body, streamed to disk
  and hashed, at most 50 MB (413 above): 201 the first time, 200 with the existing row for the same id **or the same bytes** (`sha256` is unique
  among live rows). Its type comes from its first bytes (JPEG, PNG, GIF, WebP, HEIC/HEIF/AVIF, PDF), anything else is `application/octet-stream`,
  so an SVG or HTML file is just bytes. `GET /api/files` takes `q`, `category`, `limit`, `offset`, `deleted=true`; newest first, best match first
  when searching, `ocr_text` cut to 300 characters. `PATCH /api/files/:id` takes `version` and any of `name`, `category`, `sensitive`;
  `DELETE` is soft and keeps the bytes; `restore` refuses (`added_again`) when the same bytes were added since; `POST /api/files/:id/retry`
  sends a failed one back to the filer. `GET /api/files/:id/content?size=thumb|large|original` takes the device token like every /api route,
  supports ranges, falls back to the original for a preview not made yet when a browser can draw it (else 404 `no_preview`), serves only
  raster images inline and everything else as an attachment, always with `nosniff` and `Content-Security-Policy: sandbox`.
- **503** when `LUMBRIDGE_DATABASE_URL` is unset or the database can't answer within 5 s. The rest of the gateway doesn't care.

## Client rules

- Every keystroke goes to localStorage first (`lumbridge.notes.draft.<id>`); the draft is removed only when the server has
  confirmed that exact text. A dropped WebSocket doesn't close notes or tasks (`needsNoCore` in `main.ts`).
- A conflict never overwrites anything. If only one side changed the text, or both wrote the same text, it resolves itself
  (`resolve` in `web/src/data/notes-sync.ts`). Otherwise both are shown; whichever is not chosen is saved as a new note.
- Captured tasks wait in `lumbridge.tasks.pending` with an id chosen on the device, so retrying can't make two.
- The service worker doesn't cache `/api/`: drafts are the only copy of the owner's data on a device.
- A thought is written to IndexedDB (`lumbridge-thoughts`) before anything else, with an id chosen on the device: audio by the chunk, then the text
  of each. Its audio is removed only when the server has answered the save. See Thoughts in `docs/ARCHITECTURE.md`.

## The assistant reads thoughts

`lumbridge-mobile-server thoughts recent [--limit N] [--since <iso>]` and `lumbridge-mobile-server thoughts search <query> [--limit N]` print a JSON array, newest
first, without deleted ones (default 20, at most 200). They need only `LUMBRIDGE_DATABASE_URL`. They run in a read-only transaction, so the
database itself refuses a write. Failing prints why on stderr, nothing on stdout, and exits 1.

## The assistant asks

`lumbridge-mobile-server asks create` reads `{"title", "body"}` as JSON on stdin and prints the new row. It also takes `options` (see Asks above, checked the same way before the database is asked). It refuses an empty title, one over 120 characters
or on more than one line, a body over 20 000 characters, and a 21st pending ask (under an advisory lock, so a burst can't get past 20).
`lumbridge-mobile-server asks recent [--limit N]` prints asks, newest first, with their status and reply, in a read-only transaction. Both need only
`LUMBRIDGE_DATABASE_URL`, and fail like `thoughts`: why on stderr, nothing on stdout, exit 1.

## The assistant reads notes and proposes them

`lumbridge-mobile-server notes search <query> [--limit N]` (best match first, with a snippet), `notes read <id>` and `notes recent [--since <date>]
[--limit N]` (whole notes changed since then, last changed first, for the assistant's recall) print JSON in a read-only transaction like `thoughts`,
never a deleted note. `lumbridge-mobile-server proposals create` reads `{"title", "body", "why", "source"}` on stdin, checked as the API checks them, and
prints the new proposal, from `assistant` whatever stdin says (a `proposed_by` field is refused). The 30-pending cap holds here too.

## The filer and the assistant read files

`lumbridge-mobile-server files pending [--limit N]` (status `new`, oldest first), `files recent [--limit N] [--since <iso>]`, `files search <query>
[--limit N]` and `files read <id>` print JSON and run in a read-only transaction like `thoughts`. `files update <id>` takes a JSON object on stdin
with any of `status`, `description`, `ocr_text`, `category`, `identifiers`, `sensitive`, `error`, `taken_at`, `gps`, refuses any other field, and
writes only those. Nothing in the CLI can delete. A filer you run (one that makes previews and describes each file) is the one caller of `pending` and `update`.

## Tests

`scripts/dev-db.sh` starts a throwaway Postgres in a container (127.0.0.1:5498; `LUMBRIDGE_PG_PORT` picks another, see the README), or
`scripts/ci-db.sh` from PostgreSQL binaries without Docker. `LUMBRIDGE_TEST_REQUIRE_DB=1 cargo test --features dev-identity` runs the real
binary against it, a fresh database per test, past the server's front door. Without that variable the tests skip, saying so, if the
database is down. Client logic: `npm test`. In a browser, `web/e2e/data.mjs` and `web/e2e/down.mjs` (usage at their top); never aim them
at a real install. `tests/thoughts-verify.mjs`, `tests/foryou-verify.mjs` and `tests/proposals-verify.mjs` make their own database on the
throwaway Postgres and use fake speech (and, for For you, a fake chat service). `tests/files-verify.mjs` makes its own database and files
folder, and stands in for the filer with `files update`.
