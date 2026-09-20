import { supabase } from './supabaseClient.js';

// Scores worth keeping after you take the headset off.
//
// Supabase when it is configured, localStorage when it isn't — the same
// arrangement the rest of the networking uses, and for the same reason: the
// feature should work at a table with no accounts and no keys, and reach
// further when someone has set it up.
//
// There is no seeded demo data. An empty board says nobody has played yet,
// which is true and useful; inventing rivals would not be.

const LOCAL_KEY = 'pingpong-trainer.scores.v1';
const TABLE = 'leaderboard_entries';
const LIMIT = 25;

function readLocal() {
  try {
    const stored = JSON.parse(localStorage.getItem(LOCAL_KEY) ?? '[]');
    return Array.isArray(stored) ? stored : [];
  } catch {
    return []; // private browsing, or a corrupt entry
  }
}

function writeLocal(entry) {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify([entry, ...readLocal()].slice(0, 200)));
  } catch {
    // Blocked storage shouldn't cost you the run you just played.
  }
}

// What a run was worth. Each game is scored on what it is actually asking of
// you, so the numbers are only ever compared within a category.
export function scoreFor(summary, category) {
  if (category === 'coach') {
    // A lesson is graded out of 100 per stroke; reward the best trace you
    // managed, and a little for the work of getting there.
    return Math.max(0, Math.round(summary.lessonBest * 12 + summary.lessonAttempts * 3));
  }
  if (category === 'versus') {
    // Points you took off a real opponent, and the match if you won it.
    return Math.max(0, Math.round(summary.pointsWon * 100 + (summary.matchWon ? 500 : 0)));
  }
  // Arcade: returns are the thing, streaks show control, misses cost.
  return Math.max(
    0,
    Math.round(
      summary.returns * 12 +
        summary.bestStreak * 30 +
        summary.longestRally * 20 +
        summary.accuracy * 8 +
        summary.targetsHit * 18 -
        summary.misses * 15
    )
  );
}

// Whether a run is worth recording at all. Walking into the menu and straight
// back out should not put a zero on the board.
export function isWorthRecording(summary, category) {
  if (category === 'coach') return summary.lessonAttempts > 0;
  if (category === 'versus') return summary.pointsWon > 0 || summary.matchWon;
  return summary.hits > 0;
}

export async function submitScore(playerName, summary, category) {
  const entry = {
    player_name: (playerName || 'Player').trim().slice(0, 24) || 'Player',
    score: scoreFor(summary, category),
    best_streak: summary.bestStreak ?? 0,
    category,
  };

  if (!supabase) {
    const local = { ...entry, created_at: new Date().toISOString() };
    writeLocal(local);
    return { ...local, storage: 'local' };
  }

  const { data, error } = await supabase.from(TABLE).insert(entry).select().single();
  if (error) {
    // A network blip shouldn't lose the run: keep it locally and say so.
    const local = { ...entry, created_at: new Date().toISOString() };
    writeLocal(local);
    return { ...local, storage: 'local', error };
  }
  return { ...data, storage: 'supabase' };
}

export async function getLeaderboard(category) {
  const local = readLocal()
    .filter((entry) => entry.category === category)
    .sort((a, b) => b.score - a.score)
    .slice(0, LIMIT);

  if (!supabase) return local;

  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('category', category)
    .order('score', { ascending: false })
    .limit(LIMIT);

  // Falling back to what's on this machine beats an empty screen when the
  // backend is unreachable.
  return error ? local : data;
}
