-- Notes and tasks. Soft delete everywhere; `version` is bumped on every change and drives conflict detection.
-- Search covers both stemmed English ("runs" finds "running") and raw words (typing "runni" finds "running"),
-- and only the first 100k characters: a tsvector is capped at 1 MB and a long note must still save.

create table notes (
  id         uuid primary key default gen_random_uuid(),
  title      text not null default '',
  body       text not null default '',
  pinned     boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version    integer not null default 1,
  search     tsvector generated always as (
    setweight(to_tsvector('english'::regconfig, left(title, 1000)), 'A') ||
    setweight(to_tsvector('simple'::regconfig,  left(title, 1000)), 'A') ||
    setweight(to_tsvector('english'::regconfig, left(body, 100000)), 'B') ||
    setweight(to_tsvector('simple'::regconfig,  left(body, 100000)), 'B')
  ) stored
);
create index notes_list_idx on notes (pinned desc, updated_at desc) where deleted_at is null;
create index notes_deleted_idx on notes (deleted_at desc) where deleted_at is not null;
create index notes_search_idx on notes using gin (search);

create table tasks (
  id         uuid primary key default gen_random_uuid(),
  title      text not null check (title <> ''),
  notes      text not null default '',
  due_on     date,
  done_at    timestamptz,
  pinned     boolean not null default false,
  -- Higher sorts first among tasks with the same pin and due date; the default puts new tasks on top.
  sort_key   double precision not null default (extract(epoch from clock_timestamp()) * 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  version    integer not null default 1,
  search     tsvector generated always as (
    setweight(to_tsvector('english'::regconfig, left(title, 1000)), 'A') ||
    setweight(to_tsvector('simple'::regconfig,  left(title, 1000)), 'A') ||
    setweight(to_tsvector('english'::regconfig, left(notes, 100000)), 'B') ||
    setweight(to_tsvector('simple'::regconfig,  left(notes, 100000)), 'B')
  ) stored
);
create index tasks_open_idx on tasks (pinned desc, due_on, sort_key desc) where deleted_at is null and done_at is null;
create index tasks_done_idx on tasks (done_at desc) where deleted_at is null and done_at is not null;
create index tasks_deleted_idx on tasks (deleted_at desc) where deleted_at is not null;
create index tasks_search_idx on tasks using gin (search);
