create table if not exists public.leaderboard_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  player_name text not null check (char_length(player_name) between 1 and 32),
  score integer not null check (score >= 0),
  max_rally integer not null check (max_rally >= 0),
  difficulty text not null default 'standard',
  category text not null default 'fundamentals' check (category in ('fundamentals', 'boss')),
  created_at timestamptz not null default now()
);
create index if not exists leaderboard_entries_category_score_idx on public.leaderboard_entries (category, score desc, max_rally desc);
alter table public.leaderboard_entries enable row level security;
drop policy if exists "public can read leaderboard" on public.leaderboard_entries;
create policy "public can read leaderboard" on public.leaderboard_entries for select using (true);
drop policy if exists "public can submit leaderboard" on public.leaderboard_entries;
create policy "public can submit leaderboard" on public.leaderboard_entries for insert with check (
  (user_id is null or user_id = auth.uid())
  and score between 0 and 1000000
  and max_rally between 0 and 10000
);
-- Production deployments should additionally rate-limit submissions or route them through the server-side validation endpoint used by ../fly.
