-- Tennis: rally & match sessions recorded on phone/iOS, processed on Modal (tennis-vision rally_api.py),
-- written only by /api/tennis/webhook (service key). Video clips stream directly from Modal Volume (/clips).

create table if not exists tennis_matches (
  id               uuid        primary key,                 -- client-generated UUID4 (web action / iOS)
  title            text,
  played_on        date        not null default current_date,
  session_type     text        not null default 'rally'
                     check (session_type in ('rally', 'match')),
  source           text        not null check (source in ('web', 'ios')),
  status           text        not null default 'uploading'
                     check (status in ('uploading', 'processing', 'ready', 'failed')),
  court            jsonb,                                     -- court.json v1
  doubles          boolean     not null default false,
  fps              numeric(6,3),
  rallies_expected int,
  rallies_done     int         not null default 0,
  score            jsonb,                                     -- Match mode: scorekeeper.py output
  stats            jsonb       not null default '{}',         -- summarizeSession cache (streaks, depth %, mph, biomech)
  error            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists tennis_matches_played_idx on tennis_matches (played_on desc, created_at desc);

create table if not exists tennis_rallies (
  id          bigserial   primary key,
  match_id    uuid        not null references tennis_matches(id) on delete cascade,
  rally_idx   int         not null,
  start_s     numeric(9,3) not null,
  end_s       numeric(9,3) not null,
  shot_count  int         not null default 0,                 -- total hits in this rally
  in_streak   int         not null default 0,                 -- consecutive in/close shots before first out
  bookmarked  boolean     not null default false,             -- starred via Watch or web UI
  clip_url    text,                                           -- Modal byte-range URL: /clips/{match_id}/{rally_idx}.mp4
  ball_track  jsonb,                                          -- [[t_ms,u,v],...] int, native fps
  drift_px    numeric(6,2),
  unique (match_id, rally_idx)                                -- also indexes the FK
);

create table if not exists tennis_shots (
  id              bigserial   primary key,
  match_id        uuid        not null references tennis_matches(id) on delete cascade,
  rally_idx       int         not null,
  shot_idx        int         not null,
  hitter          text        check (hitter in ('near', 'far')),
  stroke          text,                                       -- fh|bh|serve|volley|slice|feed...
  direction       text        check (direction in ('cross', 'dtl', 'middle')),
  depth_zone      text        check (depth_zone in ('deep', 'short', 'out_long', 'out_wide', 'net', 'unknown')),
  t_hit_s         numeric(9,3),
  t_bounce_s      numeric(9,4),                               -- sub-frame t*
  hit_x           numeric(6,3), hit_y numeric(6,3),
  bounce_x        numeric(6,3), bounce_y numeric(6,3),        -- court metres (Hr plane)
  speed_mph       numeric(5,1),
  net_clearance_m numeric(5,3),
  call            text        not null default 'unknown' check (call in ('in', 'out', 'close', 'unknown')),
  margin_m        numeric(6,3),
  sigma_m         numeric(6,3),
  live_call       text        check (live_call in ('in', 'out', 'close', 'unknown')),
  unique (match_id, rally_idx, shot_idx)
);

create table if not exists tennis_points (
  id          bigserial   primary key,
  match_id    uuid        not null references tennis_matches(id) on delete cascade,
  point_idx   int         not null,
  winner      text        not null check (winner in ('me', 'opp')),
  server      text        check (server in ('me', 'opp')),
  source      text        not null check (source in ('watch', 'auto', 'web')),
  bookmarked  boolean     not null default false,
  at_s        numeric(9,3),
  unique (match_id, point_idx)
);

alter table tennis_matches enable row level security;
alter table tennis_rallies enable row level security;
alter table tennis_shots   enable row level security;
alter table tennis_points  enable row level security;
drop policy if exists "Public can read tennis_matches" on tennis_matches;
create policy "Public can read tennis_matches" on tennis_matches for select using (true);
drop policy if exists "Public can read tennis_rallies" on tennis_rallies;
create policy "Public can read tennis_rallies" on tennis_rallies for select using (true);
drop policy if exists "Public can read tennis_shots" on tennis_shots;
create policy "Public can read tennis_shots" on tennis_shots for select using (true);
drop policy if exists "Public can read tennis_points" on tennis_points;
create policy "Public can read tennis_points" on tennis_points for select using (true);
