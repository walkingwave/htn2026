-- Legacy leaderboard storage for existing Supabase projects.
-- New deployments use Tiger Cloud as the canonical leaderboard and telemetry
-- database (see tiger/schema.sql). Supabase is reserved for Realtime
-- multiplayer; this schema is retained so existing projects are not broken.
--
-- If you apply this to a new project, it is not required for the current app.
--
-- Apply to a Supabase project, then set VITE_SUPABASE_URL and
-- VITE_SUPABASE_ANON_KEY (see .env.example).

create table if not exists public.leaderboard_entries (
  id uuid primary key default gen_random_uuid(),
  player_name text not null check (char_length(player_name) between 1 and 24),
  score integer not null check (score >= 0),
  best_streak integer not null default 0 check (best_streak >= 0),
  -- One board per game: they ask completely different things of the player.
  category text not null check (category in ('arcade', 'coach', 'versus')),
  created_at timestamptz not null default now()
);

create index if not exists leaderboard_entries_category_score_idx
  on public.leaderboard_entries (category, score desc);

alter table public.leaderboard_entries enable row level security;

-- Anyone can read the board and post to it: the client ships an anon key and
-- there are no accounts. The bounds below are the only thing standing between
-- the table and a nonsense score, which is the right trade for a trainer that
-- has to work at a table with no sign-in — but tighten this (authenticate the
-- player, rate-limit inserts) before anything real hangs on the numbers.
drop policy if exists "public can read the leaderboard" on public.leaderboard_entries;
create policy "public can read the leaderboard"
  on public.leaderboard_entries for select using (true);

drop policy if exists "public can post a score" on public.leaderboard_entries;
create policy "public can post a score"
  on public.leaderboard_entries for insert with check (
    score between 0 and 1000000 and best_streak between 0 and 10000
  );
