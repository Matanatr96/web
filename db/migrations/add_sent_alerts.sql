-- Dedup + rate-limit log for CSP idle-capital alerts.
-- The scanner inserts a row each time it emails an alert; pre-send it queries
-- this table to enforce "max 5 alerts/day" and "don't re-send same (ticker,strike)
-- within 4 hours".

create table if not exists sent_alerts (
  id          bigserial    primary key,
  ticker      text         not null,
  alert_type  text         not null,  -- 'idle_capital' for v1
  strike      numeric,
  expiration  date,
  sent_at     timestamptz  not null default now(),
  payload     jsonb
);

create index if not exists sent_alerts_sent_at_idx
  on sent_alerts (sent_at desc);

create index if not exists sent_alerts_lookup_idx
  on sent_alerts (ticker, alert_type, sent_at desc);

alter table sent_alerts enable row level security;
