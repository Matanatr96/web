-- Restaurant visit log: one row per logged visit, with per-visit ratings and
-- an optional comment. The restaurant's canonical ratings on `restaurants`
-- are a recency-weighted mean across these visits, recomputed in app code
-- whenever a visit is inserted/updated/deleted.

create table if not exists restaurant_visits (
  id            bigserial primary key,
  restaurant_id bigint        not null references restaurants(id) on delete cascade,
  visited_on    date          not null,
  comment       text,
  food          numeric(4,2),
  value         numeric(4,2),
  service       numeric(4,2),
  ambiance      numeric(4,2),
  vegan_options numeric(4,2),
  overall       numeric(4,2),
  created_at    timestamptz   not null default now()
);

create index if not exists restaurant_visits_restaurant_idx on restaurant_visits (restaurant_id);
create index if not exists restaurant_visits_visited_idx on restaurant_visits (visited_on desc);

alter table restaurant_visits enable row level security;
drop policy if exists "Public can read restaurant_visits" on restaurant_visits;
create policy "Public can read restaurant_visits"
  on restaurant_visits for select using (true);

-- Cached count of visits per restaurant. Kept in sync by the logVisit server
-- action so the main restaurants page doesn't need a join to display it.
alter table restaurants add column if not exists visit_count int not null default 0;

-- Seed: for every restaurant that doesn't yet have any visits, insert one
-- visit row using the current ratings as the initial snapshot. Dated by
-- last_visited if set, otherwise the restaurant's creation date. This
-- preserves existing rating history when the weighted-mean computation
-- takes over.
insert into restaurant_visits
  (restaurant_id, visited_on, food, value, service, ambiance, vegan_options, overall)
select
  r.id,
  coalesce(r.last_visited, r.created_at::date),
  r.food, r.value, r.service, r.ambiance, r.vegan_options, r.overall
from restaurants r
where not exists (
  select 1 from restaurant_visits v where v.restaurant_id = r.id
);

-- Backfill the cached visit_count.
update restaurants r set visit_count = (
  select count(*) from restaurant_visits v where v.restaurant_id = r.id
);
