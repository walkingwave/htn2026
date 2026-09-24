// The leaderboard score, derived from a run's raw stats rather than accepted
// as a number anyone posts.
//
// This lives in its own module because both sides have to agree on it: the
// browser computes the score it expects, and the server recomputes the same
// thing from the same inputs. A client that posts `score: 1000000` gets
// nothing, because the server never reads a score field — it works out what
// the run was actually worth. That does not make cheating impossible without
// accounts and a server-side simulation, but it removes the one-line attack
// that would otherwise own the board.

export const LEADERBOARD_CATEGORIES = ['arcade', 'coach', 'versus', 'tournament'];

// What a real session on a real table can plausibly produce. These are
// deliberately generous — nobody should lose a run they genuinely played —
// but they are far below the column's 1,000,000 ceiling, so a script that
// posts straight to the API cannot reach the top of the table with raw stats
// alone.
const COMPONENT_LIMITS = {
  hits: 100_000,
  returns: 50_000,
  misses: 100_000,
  bestStreak: 5_000,
  longestRally: 2_000,
  targetsHit: 5_000,
  accuracy: 100,
  lessonBest: 100,
  lessonAttempts: 5_000,
  pointsWon: 2_000,
};

const BOOLEAN_COMPONENTS = ['matchWon'];

// Returns the summary with every component checked, or throws with a reason.
// Rejecting beats clamping here: silently trimming a real player's stats would
// understate their run, and accepting them would defeat the point.
export function normaliseSummary(summary = {}) {
  if (!summary || typeof summary !== 'object') throw new Error('A run summary is required.');

  const clean = {};
  for (const [key, limit] of Object.entries(COMPONENT_LIMITS)) {
    const number = Number(summary[key] ?? 0);
    if (!Number.isFinite(number)) throw new Error(`Run statistic "${key}" is not a number.`);
    if (number < 0 || number > limit) {
      throw new Error(`Run statistic "${key}" is outside the plausible range for a session.`);
    }
    clean[key] = Math.round(number);
  }
  for (const key of BOOLEAN_COMPONENTS) {
    clean[key] = Boolean(summary[key]);
  }
  return clean;
}

export function scoreFor(summary, category) {
  if (category === 'coach') {
    return Math.max(0, Math.round(summary.lessonBest * 12 + summary.lessonAttempts * 3));
  }
  if (category === 'versus' || category === 'tournament') {
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

// A run nobody played is not a score. The server applies this too, so an empty
// submission cannot occupy a top-25 slot with a zero.
export function isWorthRecording(summary, category) {
  if (!summary) return false;
  if (category === 'coach') return summary.lessonAttempts > 0;
  if (category === 'versus' || category === 'tournament') {
    return summary.pointsWon > 0 || Boolean(summary.matchWon);
  }
  return summary.hits > 0;
}
