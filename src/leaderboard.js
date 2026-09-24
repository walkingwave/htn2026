// Scores worth keeping after you take the headset off.
//
// Tiger Cloud is the canonical store for shared leaderboard data. The browser
// talks to Vercel Functions rather than opening a database connection, keeping
// the Tiger connection string server-only. localStorage remains the fallback
// for offline/local play.
//
// A submission sends the run's raw stats, not a score. The server derives the
// score from them with the same formula the client used (see
// leaderboardScore.js), so a tampered payload cannot ask for a number.

import { isWorthRecording, normaliseSummary, scoreFor } from './leaderboardScore.js';

export { isWorthRecording, scoreFor };

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

function localEntry(entry, error) {
  const local = { ...entry, created_at: new Date().toISOString() };
  writeLocal(local);
  return { ...local, storage: 'local', ...(error ? { error } : {}) };
}

export async function submitScore(playerName, summary, category) {
  const clean = normaliseSummary(summary);
  const entry = {
    player_name: (playerName || 'Player').trim().slice(0, 24) || 'Player',
    score: scoreFor(clean, category),
    best_streak: clean.bestStreak ?? 0,
    category,
  };

  try {
    // The proof is a short-lived token this deployment hands out. A submission
    // without one is recorded as unverified rather than dropped, so an instance
    // that has not set SCORE_PROOF_SECRET still works.
    const proofResponse = await fetch('/api/leaderboard?proof=1');
    const proof = proofResponse.ok ? (await proofResponse.json().catch(() => null))?.proof : null;

    const response = await fetch('/api/leaderboard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...entry, summary: clean, proof }),
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
