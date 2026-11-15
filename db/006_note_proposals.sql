-- Note proposals: notes an agent (Claude Code, the assistant) thinks the owner should keep. They do nothing until the owner keeps one from For you,
-- which makes the note in the same transaction and sets `note_id`; or drops it. `proposed_by` is the device that sent it, as the
-- gateway authenticated it, never what the request said. Every word but the owner's edit was written by an agent, and can quote a stranger.

create table note_proposals (
  id          uuid primary key default gen_random_uuid(),
  title       text not null check (btrim(title) <> '' and char_length(title) <= 200),
  body        text not null check (btrim(body) <> '' and char_length(body) <= 20000),
  -- One line on why it's worth keeping, and where it came from (a trace URL, a session id).
  why         text not null default '' check (char_length(why) <= 1000),
  source      text not null default '' check (char_length(source) <= 1000),
  proposed_by text not null check (btrim(proposed_by) <> '' and char_length(proposed_by) <= 64),
  status      text not null default 'pending' check (status in ('pending', 'accepted', 'denied')),
  note_id     uuid references notes (id),
  decided_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  version     integer not null default 1,
  -- As notes are searched, so a duplicate can be found before it's proposed again.
  search      tsvector generated always as (
    setweight(to_tsvector('english'::regconfig, title), 'A') ||
    setweight(to_tsvector('simple'::regconfig,  title), 'A') ||
    setweight(to_tsvector('english'::regconfig, body), 'B') ||
    setweight(to_tsvector('simple'::regconfig,  body), 'B')
  ) stored,
  -- A decision is whole: a time, and a note when it's kept. Nothing but a kept one has a note.
  check ((status = 'pending') = (decided_at is null)),
  check ((status = 'accepted') = (note_id is not null))
);
create index note_proposals_pending_idx on note_proposals (created_at desc) where status = 'pending';
create index note_proposals_by_idx on note_proposals (proposed_by, created_at desc);
create index note_proposals_search_idx on note_proposals using gin (search);
