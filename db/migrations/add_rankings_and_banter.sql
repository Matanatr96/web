-- Add power rankings to weekly summaries
alter table fantasy_weekly_summaries
  add column if not exists rankings jsonb;

-- Banter ingested from Signal group chat
create table if not exists fantasy_banter (
  id           bigserial primary key,
  season       int         not null,
  week         int         not null,
  sender_name  text        not null,
  message      text        not null,
  sent_at      timestamptz not null,
  imported_at  timestamptz not null default now(),
  unique (sender_name, sent_at)
);

create index if not exists fantasy_banter_season_week_idx
  on fantasy_banter (season, week);

alter table fantasy_banter enable row level security;
drop policy if exists "Public can read fantasy_banter" on fantasy_banter;
create policy "Public can read fantasy_banter"
  on fantasy_banter for select using (true);
