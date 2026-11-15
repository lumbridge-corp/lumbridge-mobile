-- Asks: the assistant's questions for the owner, for the For you list at the top of Tasks. She writes `title` and `body` (lumbridge-mobile-server
-- asks create); the owner answers once, from the app: accepted, denied, or replied with `reply`. `delivered_at` is set once Hermes has
-- taken the answer, so an answer that hasn't reached her yet is the rows with `answered_at` and no `delivered_at`.

create table asks (
  id           uuid primary key default gen_random_uuid(),
  title        text not null check (btrim(title) <> '' and char_length(title) <= 120),
  body         text not null default '',
  status       text not null default 'pending' check (status in ('pending', 'accepted', 'denied', 'replied')),
  reply        text,
  answered_at  timestamptz,
  delivered_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  version      integer not null default 1,
  -- An answer is whole: a time, and words when it's a reply. Nothing is delivered before it's answered.
  check ((status = 'pending') = (answered_at is null)),
  check ((status = 'replied') = (reply is not null)),
  check (reply is null or btrim(reply) <> ''),
  check (delivered_at is null or answered_at is not null)
);
create index asks_pending_idx on asks (created_at desc) where status = 'pending';
create index asks_answered_idx on asks (answered_at desc) where answered_at is not null;
create index asks_undelivered_idx on asks (answered_at) where answered_at is not null and delivered_at is null;
