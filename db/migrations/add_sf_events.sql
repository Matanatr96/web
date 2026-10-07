-- What's Going On in SF: events + user taste feedback (up / busy / down).

create table if not exists sf_events (
  id            text        primary key,
  source        text        not null,
  source_url    text        not null,
  title         text        not null,
  description   text,
  category      text        not null,
  tier          smallint    not null default 1,
  starts_at     timestamptz not null,
  ends_at       timestamptz,
  venue         text,
  neighborhood  text,
  price_text    text,
  is_free       boolean     not null default false,
  image_url     text,
  tags          text[]      not null default '{}',
  dedupe_key    text        not null,
  synced_at     timestamptz not null default now()
);

create index if not exists sf_events_starts_at_idx on sf_events (starts_at asc);
create index if not exists sf_events_category_idx on sf_events (category, starts_at asc);
create index if not exists sf_events_dedupe_key_idx on sf_events (dedupe_key);

alter table sf_events enable row level security;
drop policy if exists "Public can read sf_events" on sf_events;
create policy "Public can read sf_events"
  on sf_events for select using (true);

-- User feedback signals:
--   'up'   -> Interested / thumbs up (boosts event tags)
--   'busy' -> Good vibe, bad timing / can't make it (hides event, small positive nudge on tags)
--   'down' -> Not for me / thumbs down (penalizes event tags and hides event)
create table if not exists sf_event_feedback (
  event_id       text        primary key,
  signal         text        not null check (signal in ('up', 'down', 'busy')),
  tags_snapshot  text[]      not null default '{}',
  event_title    text,
  updated_at     timestamptz not null default now()
);

create index if not exists sf_event_feedback_updated_idx on sf_event_feedback (updated_at desc);

alter table sf_event_feedback enable row level security;
drop policy if exists "Public can read sf_event_feedback" on sf_event_feedback;
create policy "Public can read sf_event_feedback"
  on sf_event_feedback for select using (true);
