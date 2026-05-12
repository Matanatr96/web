alter table fantasy_weekly_summaries
  add column if not exists posted_to_signal_at timestamptz;
