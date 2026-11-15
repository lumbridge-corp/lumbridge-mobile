-- Files: photos and documents the owner drops in or takes, filed by a separate filer. Shaped like notes: soft delete, `version`
-- bumped on every change. The bytes never come here: originals and previews are on the server under LUMBRIDGE_FILES_DIR, at `path`.
-- `status` is new until the filer has read it, then filed, or failed after several tries (the app's retry sets it back to new).
-- `sha256` is unique among live rows, so the same photo added twice is one file.

create table files (
  id          uuid primary key,
  name        text not null default '',
  mime        text not null,
  bytes       bigint not null check (bytes >= 0),
  sha256      text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  path        text not null,
  status      text not null default 'new' check (status in ('new', 'filed', 'failed')),
  description text,
  ocr_text    text,
  category    text check (category in ('vehicle', 'document', 'receipt', 'person', 'place', 'home', 'work', 'screenshot', 'other')),
  identifiers jsonb not null default '[]'::jsonb check (jsonb_typeof(identifiers) = 'array'),
  sensitive   boolean not null default false,
  error       text,
  taken_at    timestamptz,
  gps         jsonb check (gps is null or jsonb_typeof(gps) = 'object'),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  version     integer not null default 1,
  search      tsvector generated always as (
    setweight(to_tsvector('simple'::regconfig, left(name, 1000)), 'A') ||
    setweight(to_tsvector('english'::regconfig, coalesce(left(description, 10000), '')), 'A') ||
    setweight(to_tsvector('simple'::regconfig, coalesce(category, '')), 'B') ||
    setweight(to_tsvector('simple'::regconfig, left(identifiers::text, 10000)), 'B') ||
    setweight(to_tsvector('english'::regconfig, coalesce(left(ocr_text, 100000), '')), 'C') ||
    setweight(to_tsvector('simple'::regconfig, coalesce(left(ocr_text, 100000), '')), 'C')
  ) stored
);
create unique index files_sha_live_idx on files (sha256) where deleted_at is null;
create index files_list_idx on files (created_at desc) where deleted_at is null;
create index files_deleted_idx on files (deleted_at desc) where deleted_at is not null;
create index files_pending_idx on files (created_at) where status = 'new' and deleted_at is null;
create index files_search_idx on files using gin (search);
