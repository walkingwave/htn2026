// Scores worth keeping after you take the headset off.
//
// Tiger Cloud is the canonical store for shared leaderboard data. The browser
// talks to Vercel Functions rather than opening a database connection, keeping
// the Tiger connection string server-only. localStorage remains the fallback
// for offline/local play.

const LOCAL_KEY = 'paddlelab-xr.scores.v1';
const LEGACY_LOCAL_KEY = 'pingpong-trainer.scores.v1';
const LIMIT = 25;

function readLocal() {
  try {
    const stored = JSON.parse(
      localStorage.getItem(LOCAL_KEY) ?? localStorage.getItem(LEGACY_LOCAL_KEY) ?? '[]'
    );
    return Array.isArray(stored) ? stored : [];
  } catch {
    return [];
  }
}

function writeLocal(entry) {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify([entry, ...readLocal()].slice(0, 200)));
  } catch {
    // Blocked storage should not cost the player the run they just played.
  }
}

export function scoreFor(summary, category) {
  if (category === 'coach') {
    return Math.max(0, Math.round(summary.lessonBest * 12 + summary.lessonAttempts * 3));
  }
  if (category === 'versus' || category === 'tournament') {
    // Both modes are scored only from points won in real table play.
    return Math.max(0, Math.round(summary.pointsWon * 100 + (summary.matchWon ? 500 : 0)));
  }
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

export function isWorthRecording(summary, category) {
  if (category === 'coach') return summary.lessonAttempts > 0;
  if (category === 'versus' || category === 'tournament') return summary.pointsWon > 0 || summary.matchWon;
  return summary.hits > 0;
}

function localEntry(entry, error) {
  const local = { ...entry, created_at: new Date().toISOString() };
  writeLocal(local);
  return { ...local, storage: 'local', ...(error ? { error } : {}) };
}

export async function submitScore(playerName, summary, category) {
  const entry = {
    player_name: (playerName || 'Player').trim().slice(0, 24) || 'Player',
    score: scoreFor(summary, category),
    best_streak: summary.bestStreak ?? 0,
    category,
  };

  try {
    const response = await fetch('/api/leaderboard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
    });
    if (!response.ok) throw new Error(`Tiger leaderboard request failed (${response.status})`);
    const data = await response.json();
    return { ...data.entry, storage: data.storage || 'tiger' };
  } catch (error) {
    return localEntry(entry, error);
  }
}

export async function getLeaderboard(category) {
  const local = readLocal()
    .filter((entry) => entry.category === category)
    .sort((a, b) => b.score - a.score)
    .slice(0, LIMIT);

  try {
    const response = await fetch(`/api/leaderboard?category=${encodeURIComponent(category)}`);
    if (!response.ok) throw new Error(`Tiger leaderboard request failed (${response.status})`);
    const data = await response.json();
    return Array.isArray(data.entries) ? data.entries : local;
  } catch {
    return local;
  }
}
