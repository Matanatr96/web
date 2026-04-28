-- Wheel strategy watchlist: tickers you want to track for CSP/CC opportunities.
-- Run in the Supabase SQL editor.

create table if not exists watchlist (
  id         bigserial    primary key,
  ticker     text         not null unique,
  created_at timestamptz  not null default now()
);

-- Admin-only table; no public reads needed.
alter table watchlist enable row level security;
