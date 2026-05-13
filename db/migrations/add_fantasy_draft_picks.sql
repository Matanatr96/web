create table if not exists fantasy_draft_picks (
  id          bigserial primary key,
  season      int  not null,
  league_id   text not null,
  draft_id    text not null,
  owner_id    text not null references fantasy_owners(user_id),
  player_id   text not null,
  player_name text not null,
  position    text,
  team        text,
  round       int  not null,
  pick_number int  not null,
  adp         numeric(6,2),
  created_at  timestamptz not null default now(),
  unique (draft_id, pick_number)
);

create index if not exists fantasy_draft_picks_season_idx on fantasy_draft_picks (season);
create index if not exists fantasy_draft_picks_owner_idx  on fantasy_draft_picks (owner_id);

alter table fantasy_draft_picks enable row level security;
drop policy if exists "Public can read fantasy_draft_picks" on fantasy_draft_picks;
create policy "Public can read fantasy_draft_picks"
  on fantasy_draft_picks for select using (true);
