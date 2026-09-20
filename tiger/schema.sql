-- Tiger Cloud / TimescaleDB schema.
-- Apply this to the Tiger Cloud PostgreSQL database before enabling the
-- Vercel leaderboard and telemetry routes.

create table if not exists public.leaderboard_entries (
  id bigint generated always as identity primary key,
  player_name text not null check (char_length(player_name) between 1 and 24),
  score integer not null check (score between 0 and 1000000),
  best_streak integer not null default 0 check (best_streak between 0 and 10000),
  category text not null check (category in ('arcade', 'coach', 'versus')),
  created_at timestamptz not null default now()
);

create index if not exists leaderboard_entries_category_score_idx
  on public.leaderboard_entries (category, score desc, created_at asc);

create table if not exists public.coaching_events (
  recorded_at timestamptz not null default now(),
  id bigint generated always as identity,
  player_id text not null,
  event_type text not null,
  scenario text,
  total double precision,
  path double precision,
  sync double precision,
  face double precision,
  timing double precision,
  payload jsonb not null default '{}'::jsonb,
  primary key (recorded_at, id)
);

select create_hypertable('coaching_events', 'recorded_at', if_not_exists => true);

create index if not exists coaching_events_player_time_idx
  on public.coaching_events (player_id, recorded_at desc);

create index if not exists coaching_events_type_time_idx
  on public.coaching_events (event_type, recorded_at desc);
