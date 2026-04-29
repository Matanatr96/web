-- Seed fantasy_leagues with KFL Sleeper league IDs.
-- Apply db/fantasy_schema.sql first, then run this in the Supabase SQL editor.
-- Idempotent: re-running updates league_id/name if they ever change.

insert into fantasy_leagues (season, league_id, name) values
  (2021, '732312711840550912',  'KFL'),
  (2022, '784470107580674048',  'KFL'),
  (2023, '918363762489450496',  'KFL'),
  (2024, '1065080259017654272', 'KFL'),
  (2025, '1180631605378568192', 'KFL'),
  (2026, '1312124945739816960', 'KFL')
on conflict (season) do update
  set league_id = excluded.league_id,
      name      = excluded.name;
