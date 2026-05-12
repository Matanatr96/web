-- Oracle of Regret: player-level scores + weekly summaries.
-- Run in the Supabase SQL editor after fantasy_schema.sql.

-- One row per player per owner per week. Captures starters and bench.
create table if not exists fantasy_player_scores (
  id          bigserial primary key,
  season      int     not null,
  week        int     not null,
  owner_id    text    not null references fantasy_owners(user_id),
  player_id   text    not null,
  player_name text    not null,
  position    text,
  team        text,
  points      numeric(6,2) not null default 0,
  is_starter  boolean not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (season, week, owner_id, player_id)
);

create index if not exists fantasy_player_scores_season_week_idx
  on fantasy_player_scores (season, week);
create index if not exists fantasy_player_scores_owner_idx
  on fantasy_player_scores (owner_id);

drop trigger if exists fantasy_player_scores_set_updated_at on fantasy_player_scores;
create trigger fantasy_player_scores_set_updated_at
  before update on fantasy_player_scores
  for each row execute function set_updated_at();

alter table fantasy_player_scores enable row level security;
drop policy if exists "Public can read fantasy_player_scores" on fantasy_player_scores;
create policy "Public can read fantasy_player_scores"
  on fantasy_player_scores for select using (true);

-- One row per (season, week). Persisted LLM-generated summary.
create table if not exists fantasy_weekly_summaries (
  id           bigserial primary key,
  season       int  not null,
  week         int  not null,
  summary      text not null,
  haiku        text,
  -- Snapshot of computed stats used to generate the summary.
  stats        jsonb not null,
  generated_at timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (season, week)
);

drop trigger if exists fantasy_weekly_summaries_set_updated_at on fantasy_weekly_summaries;
create trigger fantasy_weekly_summaries_set_updated_at
  before update on fantasy_weekly_summaries
  for each row execute function set_updated_at();

alter table fantasy_weekly_summaries enable row level security;
drop policy if exists "Public can read fantasy_weekly_summaries" on fantasy_weekly_summaries;
create policy "Public can read fantasy_weekly_summaries"
  on fantasy_weekly_summaries for select using (true);
