-- Receipt splitter: diners, receipts, items, per-item diner assignments.

create table if not exists diners (
  id            bigserial primary key,
  name          text        not null unique,
  is_self       boolean     not null default false,
  last_used_at  timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

create index if not exists diners_last_used_idx on diners (last_used_at desc);

alter table diners enable row level security;
drop policy if exists "Public can read diners" on diners;
create policy "Public can read diners"
  on diners for select using (true);

-- Seed Anush as self. Idempotent.
insert into diners (name, is_self)
  values ('Anush', true)
  on conflict (name) do update set is_self = excluded.is_self;

create table if not exists receipts (
  id            bigserial primary key,
  restaurant_id bigint      references restaurants(id) on delete set null,
  visited_on    date,
  subtotal      numeric(10,2) not null,
  tax           numeric(10,2) not null default 0,
  tip           numeric(10,2) not null default 0,
  total         numeric(10,2) not null,
  parse_model   text,
  created_at    timestamptz   not null default now()
);

create index if not exists receipts_restaurant_idx on receipts (restaurant_id);
create index if not exists receipts_visited_idx on receipts (visited_on desc);

alter table receipts enable row level security;
drop policy if exists "Public can read receipts" on receipts;
create policy "Public can read receipts"
  on receipts for select using (true);

create table if not exists receipt_items (
  id          bigserial primary key,
  receipt_id  bigint        not null references receipts(id) on delete cascade,
  name        text          not null,
  price       numeric(10,2) not null,
  qty         numeric(6,2)  not null default 1,
  position    int           not null default 0
);

create index if not exists receipt_items_receipt_idx on receipt_items (receipt_id);

alter table receipt_items enable row level security;
drop policy if exists "Public can read receipt_items" on receipt_items;
create policy "Public can read receipt_items"
  on receipt_items for select using (true);

-- One row per (item, diner). share is the fraction of the item that diner owes
-- (e.g. 0.5 if two people split a dish). Shares for an item should sum to 1.
create table if not exists receipt_item_diners (
  item_id   bigint        not null references receipt_items(id) on delete cascade,
  diner_id  bigint        not null references diners(id) on delete cascade,
  share     numeric(6,4)  not null,
  primary key (item_id, diner_id)
);

create index if not exists receipt_item_diners_diner_idx on receipt_item_diners (diner_id);

alter table receipt_item_diners enable row level security;
drop policy if exists "Public can read receipt_item_diners" on receipt_item_diners;
create policy "Public can read receipt_item_diners"
  on receipt_item_diners for select using (true);
