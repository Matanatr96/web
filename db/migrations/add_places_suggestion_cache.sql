-- Cache for Google Places "untried" suggestions on the restaurants Suggestions
-- quiz. Keyed by (city, cuisine, category) with a 30-day TTL enforced in app
-- code. Stores the filtered + ranked result list as jsonb so the API route
-- just returns it directly on cache hit.

create table if not exists places_suggestion_cache (
  cache_key  text        primary key,
  results    jsonb       not null,
  cached_at  timestamptz not null default now()
);

alter table places_suggestion_cache enable row level security;
drop policy if exists "Public can read places_suggestion_cache" on places_suggestion_cache;
create policy "Public can read places_suggestion_cache"
  on places_suggestion_cache for select using (true);
