-- Tiger Cloud / TimescaleDB schema.
-- Apply this to the Tiger Cloud PostgreSQL database before enabling the
-- Vercel leaderboard and telemetry routes.

create table if not exists public.leaderboard_entries (
  id bigint generated always as identity primary key,
  player_name text not null check (char_length(player_name) between 1 and 24),
  score integer not null check (score between 0 and 1000000),
  best_streak integer not null default 0 check (best_streak between 0 and 10000),
  category text not null check (category in ('arcade', 'coach', 'versus', 'tournament')),
  created_at timestamptz not null default now()
);

-- Existing hackathon databases may have been created before tournament was a
-- category. Refresh the named generated check so they can accept its scores.
alter table public.leaderboard_entries
  drop constraint if exists leaderboard_entries_category_check;
alter table public.leaderboard_entries
  add constraint leaderboard_entries_category_check
  check (category in ('arcade', 'coach', 'versus', 'tournament'));

create index if not exists leaderboard_entries_category_score_idx
  on public.leaderboard_entries (category, score desc, created_at asc);

-- Scores are derived server-side from the posted run statistics, and a
-- submission only counts as verified when it carried a valid score proof. The
-- column records which it was: an instance without SCORE_PROOF_SECRET keeps
-- working, it just records that its scores were not confirmed.
alter table public.leaderboard_entries
  add column if not exists verified boolean not null default false;

create index if not exists leaderboard_entries_player_idx
  on public.leaderboard_entries (player_name, category);

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
