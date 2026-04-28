-- Restaurant ratings schema.
-- Run this in the Supabase SQL editor (or via psql) before importing data.

create table if not exists restaurants (
  id            bigserial primary key,
  name          text         not null,
  city          text         not null,
  category      text         not null,        -- Food | Drink | Dessert
  cuisine       text         not null,
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

-- Photos: array of public Supabase Storage URLs.
-- Before using photo uploads, create a public Storage bucket named "restaurant-photos"
-- in the Supabase dashboard (Storage → New bucket → name: restaurant-photos, public: true).
alter table restaurants add column if not exists photos text[];

create index if not exists restaurants_city_idx     on restaurants (city);
create index if not exists restaurants_cuisine_idx  on restaurants (cuisine);
create index if not exists restaurants_category_idx on restaurants (category);
create index if not exists restaurants_overall_idx  on restaurants (overall desc);

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
