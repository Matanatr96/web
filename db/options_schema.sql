-- Options + equity trades schema.
-- Run in the Supabase SQL editor after schema.sql.

create table if not exists options_trades (
  id                bigserial    primary key,
  tradier_id        bigint       not null,
  source            text         not null default 'prod' check (source in ('prod', 'sandbox')),
  underlying        text         not null,                 -- ticker, e.g. AAPL
  option_symbol     text         not null,                 -- OCC symbol, e.g. AAPL230120C00150000
  option_type       text         not null check (option_type in ('call', 'put')),
  strategy          text         not null check (strategy in ('covered_call', 'cash_secured_put', 'long_call', 'long_put')),
  side              text         not null check (side in ('sell_to_open', 'buy_to_close', 'buy_to_open', 'sell_to_close')),
  strike            numeric(10,2) not null,
  expiration_date   date         not null,
  quantity          integer      not null,
  avg_fill_price    numeric(10,4) not null,                -- premium per contract (per share)
  status            text         not null,                 -- filled, canceled, expired, assigned
  order_date        timestamptz  not null,
  transaction_date  timestamptz,
  created_at        timestamptz  not null default now(),
  updated_at        timestamptz  not null default now(),
  unique (tradier_id, source)
);

create index if not exists options_trades_underlying_idx    on options_trades (underlying);
create index if not exists options_trades_strategy_idx      on options_trades (strategy);
create index if not exists options_trades_source_idx        on options_trades (source);
create index if not exists options_trades_expiration_idx    on options_trades (expiration_date);
create index if not exists options_trades_order_date_idx    on options_trades (order_date desc);

create or replace function set_options_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists options_trades_set_updated_at on options_trades;
create trigger options_trades_set_updated_at
  before update on options_trades
  for each row execute function set_options_updated_at();

-- Public reads, no public writes.
alter table options_trades enable row level security;

drop policy if exists "Public can read options_trades" on options_trades;
create policy "Public can read options_trades"
  on options_trades for select
  using (true);

-- ---------------------------------------------------------------
-- Equity trades: individual stock buy/sell orders from Tradier.
-- ---------------------------------------------------------------

create table if not exists equity_trades (
  id                bigserial     primary key,
  tradier_id        bigint        not null,
  source            text          not null default 'prod' check (source in ('prod', 'sandbox')),
  symbol            text          not null,          -- ticker, e.g. AAPL
  side              text          not null check (side in ('buy', 'sell')),
  quantity          integer       not null,
  avg_fill_price    numeric(10,4) not null,          -- price per share
  status            text          not null,          -- filled, canceled, etc.
  order_date        timestamptz   not null,
  transaction_date  timestamptz,
  created_at        timestamptz   not null default now(),
  updated_at        timestamptz   not null default now(),
  unique (tradier_id, source)
);

create index if not exists equity_trades_symbol_idx     on equity_trades (symbol);
create index if not exists equity_trades_side_idx       on equity_trades (side);
create index if not exists equity_trades_source_idx     on equity_trades (source);
create index if not exists equity_trades_order_date_idx on equity_trades (order_date desc);

create or replace function set_equity_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists equity_trades_set_updated_at on equity_trades;
create trigger equity_trades_set_updated_at
  before update on equity_trades
  for each row execute function set_equity_updated_at();

alter table equity_trades enable row level security;

drop policy if exists "Public can read equity_trades" on equity_trades;
create policy "Public can read equity_trades"
  on equity_trades for select
  using (true);
