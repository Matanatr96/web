-- Fantasy football schema (Sleeper API).
-- Run in the Supabase SQL editor before running scripts/sync-fantasy.ts.

-- One row per season; maps a season year to its Sleeper league_id.
create table if not exists fantasy_leagues (
  season             int  primary key,
  league_id          text not null,
  name               text,
  playoff_week_start int,
  -- Raw Sleeper /winners_bracket response. Each entry: {r, m, t1, t2, w, l, p, t1_from, t2_from}
  winners_bracket    jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Add columns to existing tables if they predate this change.
alter table fantasy_leagues add column if not exists playoff_week_start int;
alter table fantasy_leagues add column if not exists winners_bracket    jsonb;

-- One row per Sleeper user that has ever been in the league.
-- user_id is stable across seasons; display_name may change.
create table if not exists fantasy_owners (
  user_id      text primary key,
  display_name text not null,
  avatar       text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- One row per (season, week, owner). Stores the head-to-head result.
create table if not exists fantasy_matchups (
  id              bigserial primary key,
  season          int     not null,
  week            int     not null,
  owner_id        text    not null references fantasy_owners(user_id),
  opponent_id     text    references fantasy_owners(user_id),
  points          numeric(7,2) not null,
  opponent_points numeric(7,2) not null,
  result          char(1) not null check (result in ('W','L','T')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (season, week, owner_id)
);

create index if not exists fantasy_matchups_season_idx on fantasy_matchups (season);
create index if not exists fantasy_matchups_owner_idx  on fantasy_matchups (owner_id);

-- Reuse the project's set_updated_at() trigger function (defined in schema.sql).
drop trigger if exists fantasy_leagues_set_updated_at on fantasy_leagues;
create trigger fantasy_leagues_set_updated_at
  before update on fantasy_leagues
  for each row execute function set_updated_at();

drop trigger if exists fantasy_owners_set_updated_at on fantasy_owners;
create trigger fantasy_owners_set_updated_at
  before update on fantasy_owners
  for each row execute function set_updated_at();

drop trigger if exists fantasy_matchups_set_updated_at on fantasy_matchups;
create trigger fantasy_matchups_set_updated_at
  before update on fantasy_matchups
  for each row execute function set_updated_at();

-- RLS: public reads, no public writes (service key bypasses).
alter table fantasy_leagues  enable row level security;
alter table fantasy_owners   enable row level security;
alter table fantasy_matchups enable row level security;

drop policy if exists "Public can read fantasy_leagues" on fantasy_leagues;
create policy "Public can read fantasy_leagues"
  on fantasy_leagues for select using (true);

drop policy if exists "Public can read fantasy_owners" on fantasy_owners;
create policy "Public can read fantasy_owners"
  on fantasy_owners for select using (true);

drop policy if exists "Public can read fantasy_matchups" on fantasy_matchups;
create policy "Public can read fantasy_matchups"
  on fantasy_matchups for select using (true);
