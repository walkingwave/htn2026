-- Online multiplayer schema for flyball: single-elimination tournaments plus a
-- lightweight record of 1v1 matches. Apply this to the same Supabase project as
-- schema.sql. Real-time paddle/ball sync goes over Supabase Realtime broadcast
-- channels (no rows needed); these tables persist bracket structure + results.
--
-- Design notes:
--   * A tournament has N participants (2..32). The bracket is single-elimination.
--   * `matches` rows are the bracket slots: (round, slot) with two participant
--     slots that fill in as earlier rounds resolve. Reporting a winner advances
--     them into the parent match's open slot.
--   * `share_code` is the human-friendly join code (mirrors the 1v1 room code).
--   * RLS here is intentionally permissive (anon-friendly, matching the existing
--     leaderboard). Tighten before a public launch: authenticate players and
--     restrict result reporting to match participants / an organizer.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Tournaments
-- ---------------------------------------------------------------------------
create table if not exists public.tournaments (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 60),
  share_code text not null unique check (char_length(share_code) between 4 and 12),
  organizer_id uuid references auth.users(id) on delete set null,
  size integer not null check (size between 2 and 32),
  status text not null default 'lobby' check (status in ('lobby', 'live', 'complete')),
  target_points integer not null default 7 check (target_points between 1 and 21),
  winner_participant_id uuid,
  created_at timestamptz not null default now()
);
create index if not exists tournaments_share_code_idx on public.tournaments (share_code);

-- ---------------------------------------------------------------------------
-- Participants (players who joined a tournament lobby)
-- ---------------------------------------------------------------------------
create table if not exists public.tournament_participants (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  display_name text not null check (char_length(display_name) between 1 and 32),
  seed integer,
  eliminated boolean not null default false,
  joined_at timestamptz not null default now(),
  unique (tournament_id, display_name)
);
create index if not exists participants_tournament_idx on public.tournament_participants (tournament_id);

-- ---------------------------------------------------------------------------
-- Matches (bracket slots)
-- ---------------------------------------------------------------------------
create table if not exists public.tournament_matches (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  round integer not null check (round >= 1),        -- 1 = first round
  slot integer not null check (slot >= 0),          -- position within the round
  room_code text,                                   -- Realtime room for this match
  p1_id uuid references public.tournament_participants(id) on delete set null,
  p2_id uuid references public.tournament_participants(id) on delete set null,
  p1_score integer not null default 0 check (p1_score >= 0),
  p2_score integer not null default 0 check (p2_score >= 0),
  winner_id uuid references public.tournament_participants(id) on delete set null,
  -- Where this match's winner advances (parent bracket slot + which side).
  next_match_id uuid references public.tournament_matches(id) on delete set null,
  next_slot integer check (next_slot in (1, 2)),
  status text not null default 'pending' check (status in ('pending', 'ready', 'live', 'done')),
  updated_at timestamptz not null default now(),
  unique (tournament_id, round, slot)
);
create index if not exists matches_tournament_idx on public.tournament_matches (tournament_id, round, slot);

-- ---------------------------------------------------------------------------
-- Row level security (permissive anon access to match existing leaderboard)
-- ---------------------------------------------------------------------------
alter table public.tournaments enable row level security;
alter table public.tournament_participants enable row level security;
alter table public.tournament_matches enable row level security;

drop policy if exists "read tournaments" on public.tournaments;
create policy "read tournaments" on public.tournaments for select using (true);
drop policy if exists "write tournaments" on public.tournaments;
create policy "write tournaments" on public.tournaments for all using (true) with check (true);

drop policy if exists "read participants" on public.tournament_participants;
create policy "read participants" on public.tournament_participants for select using (true);
drop policy if exists "write participants" on public.tournament_participants;
create policy "write participants" on public.tournament_participants for all using (true) with check (true);

drop policy if exists "read matches" on public.tournament_matches;
create policy "read matches" on public.tournament_matches for select using (true);
drop policy if exists "write matches" on public.tournament_matches;
create policy "write matches" on public.tournament_matches for all using (true) with check (true);

-- Optional: enable Realtime row broadcasts so lobby/bracket views live-update.
-- alter publication supabase_realtime add table public.tournaments;
-- alter publication supabase_realtime add table public.tournament_participants;
-- alter publication supabase_realtime add table public.tournament_matches;
