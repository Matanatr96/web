-- Scanner config: single-row table holding tunable settings for the idle-scan cron.
-- The cron route reads this row each invocation and decides whether to actually
-- run (based on `enabled` and time elapsed since the last scan_run).

create table if not exists scanner_config (
  id                   smallint     primary key default 1,
  enabled              boolean      not null default true,
  scan_interval_min    smallint     not null default 30,   -- 15, 30, 45, or 60
  dedup_hours          smallint     not null default 4,    -- 1..24
  daily_email_cap      smallint     not null default 5,    -- 1..20
  max_per_type         smallint     not null default 8,    -- 1..20
  updated_at           timestamptz  not null default now(),
  constraint scanner_config_singleton check (id = 1),
  constraint scanner_config_interval_ck check (scan_interval_min between 15 and 240),
  constraint scanner_config_dedup_ck    check (dedup_hours between 1 and 24),
  constraint scanner_config_cap_ck      check (daily_email_cap between 1 and 20),
  constraint scanner_config_max_ck      check (max_per_type between 1 and 20)
);

-- Seed the singleton row (idempotent).
insert into scanner_config (id) values (1)
on conflict (id) do nothing;

alter table scanner_config enable row level security;

-- Track every scan attempt (including skips) so the UI can show recent activity
-- and the route can enforce the configured scan interval.
create table if not exists scanner_runs (
  id          bigserial    primary key,
  ran_at      timestamptz  not null default now(),
  outcome     text         not null,   -- 'sent' | 'no_picks' | 'daily_cap' | 'market_closed' | 'disabled' | 'interval_skip' | 'error'
  csps        smallint              default 0,
  ccs         smallint              default 0,
  forced      boolean      not null default false,
  detail      text
);

create index if not exists scanner_runs_ran_at_idx
  on scanner_runs (ran_at desc);

alter table scanner_runs enable row level security;
