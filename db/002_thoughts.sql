-- Thoughts: the raw inbox from the owner's head, spoken or typed. Shaped like notes: soft delete, `version` bumped on every change.
-- `created_at` is when the owner said it, which can be well before the row arrives if the device was waiting on the speech service.
-- `note_id` is set once a thought has been turned into a note. Audio is never stored here.

create table thoughts (
  id          uuid primary key default gen_random_uuid(),
  body        text not null default '',
  source      text not null default 'typed' check (source in ('voice', 'typed')),
  duration_ms integer check (duration_ms >= 0),
  note_id     uuid references notes (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  version     integer not null default 1,
  search      tsvector generated always as (
    setweight(to_tsvector('english'::regconfig, left(body, 100000)), 'B') ||
    setweight(to_tsvector('simple'::regconfig,  left(body, 100000)), 'B')
  ) stored
);
create index thoughts_list_idx on thoughts (created_at desc) where deleted_at is null;
create index thoughts_deleted_idx on thoughts (deleted_at desc) where deleted_at is not null;
create index thoughts_search_idx on thoughts using gin (search);
create index thoughts_note_idx on thoughts (note_id) where note_id is not null;
