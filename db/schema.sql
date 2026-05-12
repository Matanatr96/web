-- Restaurant ratings schema.
-- Run this in the Supabase SQL editor (or via psql) before importing data.

create table if not exists restaurants (
  id            bigserial primary key,
  name          text         not null,
  city          text         not null,
  category      text         not null,        -- Food | Drink | Dessert
  -- cuisine moved to restaurant_cuisines (many-to-many). Kept here as a
  -- nullable column on older databases until the migration block below
  -- backfills the join table and drops it.
  overall       numeric(4,2) not null,
  food          numeric(4,2),
  value         numeric(4,2),
  service       numeric(4,2),
  ambiance      numeric(4,2),
  vegan_options numeric(4,2),
  note          text,
  address       text,
  lat           double precision,
  lng           double precision,
  place_id      text,
  created_at    timestamptz  not null default now(),
  updated_at    timestamptz  not null default now()
);

-- For existing databases, add the geo columns if they don't yet exist.
alter table restaurants add column if not exists address  text;
alter table restaurants add column if not exists lat      double precision;
alter table restaurants add column if not exists lng      double precision;
alter table restaurants add column if not exists place_id text;

-- last_visited: optional date the restaurant was most recently visited.
alter table restaurants add column if not exists last_visited date;

-- Photos: array of public Supabase Storage URLs.
-- Before using photo uploads, create a public Storage bucket named "restaurant-photos"
-- in the Supabase dashboard (Storage → New bucket → name: restaurant-photos, public: true).
alter table restaurants add column if not exists photos text[];

create index if not exists restaurants_city_idx     on restaurants (city);
create index if not exists restaurants_category_idx on restaurants (category);
create index if not exists restaurants_overall_idx  on restaurants (overall desc);

-- Many-to-many: a restaurant can serve multiple cuisines. cuisine_name is
-- stored as text (not a FK) so admin renames in the cuisines table don't
-- block reads here; consistency is enforced by the admin UI.
create table if not exists restaurant_cuisines (
  restaurant_id bigint not null references restaurants(id) on delete cascade,
  cuisine_name  text   not null,
  primary key (restaurant_id, cuisine_name)
);
create index if not exists restaurant_cuisines_cuisine_idx on restaurant_cuisines (cuisine_name);

alter table restaurant_cuisines enable row level security;
drop policy if exists "Public can read restaurant_cuisines" on restaurant_cuisines;
create policy "Public can read restaurant_cuisines"
  on restaurant_cuisines for select using (true);

-- One-time migration from the old `cuisine` column. Backfills the join table
-- with each restaurant's existing cuisine, then drops the column. Idempotent:
-- the block is a no-op if the column no longer exists.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'restaurants' and column_name = 'cuisine'
  ) then
    insert into restaurant_cuisines (restaurant_id, cuisine_name)
      select id, cuisine from restaurants where cuisine is not null and cuisine <> ''
    on conflict (restaurant_id, cuisine_name) do nothing;
    drop index if exists restaurants_cuisine_idx;
    alter table restaurants drop column cuisine;
  end if;
end $$;

-- Prevent duplicate Google Places entries; nulls are excluded so un-geocoded rows are unaffected.
create unique index if not exists restaurants_place_id_unique on restaurants (place_id) where place_id is not null;

-- Auto-update updated_at on row changes.
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists restaurants_set_updated_at on restaurants;
create trigger restaurants_set_updated_at
  before update on restaurants
  for each row execute function set_updated_at();

-- Row Level Security: allow public reads, deny public writes.
-- The service role key bypasses RLS entirely, so admin writes still work via the server.
alter table restaurants enable row level security;

drop policy if exists "Public can read restaurants" on restaurants;
create policy "Public can read restaurants"
  on restaurants for select
  using (true);

-- Cuisine options managed by admins.
create table if not exists cuisines (
  id   bigserial primary key,
  name text not null unique
);

alter table cuisines enable row level security;

drop policy if exists "Public can read cuisines" on cuisines;
create policy "Public can read cuisines"
  on cuisines for select
  using (true);

-- Seed with default cuisines (skips duplicates on re-run).
insert into cuisines (name) values
  ('American'), ('Arabic'), ('Asian'), ('Bagel'), ('Bakery'),
  ('Bangladeshi'), ('Bowl'), ('Breakfast'), ('Brunch'), ('Burger'),
  ('Burmese'), ('Cafe'), ('Chinese'), ('Donut'), ('Ice Cream'),
  ('Indian'), ('Indian Street'), ('Israeli'), ('Italian'), ('Japanese'),
  ('Korean'), ('Latin'), ('Malaysian'), ('Mediterranean'), ('Mexican'),
  ('Nepalese'), ('Pho'), ('Pizza'), ('Sandwich'), ('Sushi'),
  ('Szechuan'), ('Taco'), ('Taiwanese'), ('Thai'), ('Tulum'),
  ('Venezuelan'), ('Vietnamese'), ('Wings')
on conflict (name) do nothing;
