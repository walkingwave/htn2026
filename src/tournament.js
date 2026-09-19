// Single-elimination tournament engine. Pure state + transitions — no DOM, no
// network — so it can be unit-tested and rendered by any view (terminal DOM
// here, could be world-space canvas later).
//
// A field of N players is padded to the next power of two with byes. Standard
// bracket seeding spreads the byes onto the top seeds so they auto-advance the
// first round. Reporting a winner propagates them into the parent match; when
// the final resolves, `champion` is set.

const nextPow2 = (n) => {
  let p = 1;
  while (p < n) p *= 2;
  return Math.max(2, p);
};

// Bracket seeding order for a power-of-two size: position i holds this seed
// index. Built by the classic fold: [0] -> [0,1] -> [0,3,1,2] -> ...
function seedPositions(size) {
  let seeds = [0];
  while (seeds.length < size) {
    const n = seeds.length * 2;
    const next = [];
    for (const s of seeds) {
      next.push(s);
      next.push(n - 1 - s);
    }
    seeds = next;
  }
  return seeds;
}

let _uid = 0;
const normalizePlayers = (players) =>
  players.map((p, i) =>
    typeof p === 'string' ? { id: `p${i}`, name: p } : { id: p.id ?? `p${i}`, name: p.name }
  );

export function createTournament(players, { name = 'Tournament' } = {}) {
  const field = normalizePlayers(players);
  if (field.length < 2) throw new Error('A tournament needs at least 2 players.');

  const size = nextPow2(field.length);
  const order = seedPositions(size);
  // Bracket positions in play order; a position beyond the field size is a bye.
  const positions = order.map((seedIndex) => field[seedIndex] ?? null);

  const rounds = [];
  let matchId = 0;

  const round0 = [];
  for (let i = 0; i < size; i += 2) {
    round0.push({
      id: matchId++, round: 0, slot: i / 2,
      p1: positions[i], p2: positions[i + 1], winner: null, score: null,
    });
  }
  rounds.push(round0);

  let prev = round0;
  let r = 1;
  while (prev.length > 1) {
    const cur = [];
    for (let i = 0; i < prev.length; i += 2) {
      cur.push({ id: matchId++, round: r, slot: i / 2, p1: null, p2: null, winner: null, score: null });
    }
    rounds.push(cur);
    prev = cur;
    r += 1;
  }

  const t = { name, size, players: field, rounds, champion: null, _uid: _uid++ };
  autoAdvanceByes(t);
  return t;
}

function findMatch(t, matchId) {
  for (const round of t.rounds) {
    for (const m of round) if (m.id === matchId) return m;
  }
  return null;
}

// A match's winner flows into round+1, slot floor(slot/2), taking the p1 slot
// for even source slots and p2 for odd.
function parentSlot(match) {
  return { round: match.round + 1, slot: Math.floor(match.slot / 2), side: match.slot % 2 === 0 ? 'p1' : 'p2' };
}

function propagate(t, match) {
  if (!match.winner) return;
  if (match.round >= t.rounds.length - 1) {
    t.champion = match.winner;
    return;
  }
  const { round, slot, side } = parentSlot(match);
  const parent = t.rounds[round][slot];
  parent[side] = match.winner;
}

// Round-0 matches with only one real player are byes — the present player
// advances automatically.
function autoAdvanceByes(t) {
  for (const m of t.rounds[0]) {
    if (m.winner) continue;
    if (m.p1 && !m.p2) { m.winner = m.p1; m.score = 'bye'; propagate(t, m); }
    else if (m.p2 && !m.p1) { m.winner = m.p2; m.score = 'bye'; propagate(t, m); }
  }
}

// Record a winner for a ready match. `winnerId` must be one of the two players.
// Returns the champion if the match just decided the tournament, else null.
export function reportResult(t, matchId, winnerId, score = null) {
  const m = findMatch(t, matchId);
  if (!m || m.winner) return t.champion;
  if (!m.p1 || !m.p2) return t.champion; // not ready
  const winner = [m.p1, m.p2].find((p) => p && p.id === winnerId);
  if (!winner) return t.champion;
  m.winner = winner;
  m.score = score;
  propagate(t, m);
  return t.champion;
}

// Matches that can be played right now: both players present, no winner yet.
export function currentMatches(t) {
  const playable = [];
  for (const round of t.rounds) {
    for (const m of round) {
      if (!m.winner && m.p1 && m.p2) playable.push(m);
    }
  }
  return playable;
}

export function isComplete(t) {
  return Boolean(t.champion);
}

export function roundName(t, roundIndex) {
  const fromEnd = t.rounds.length - 1 - roundIndex;
  if (fromEnd === 0) return 'Final';
  if (fromEnd === 1) return 'Semifinals';
  if (fromEnd === 2) return 'Quarterfinals';
  return `Round ${roundIndex + 1}`;
}

// A compact monospace view of the bracket for the terminal UI. Each line is a
// match; the active (playable) matches are marked with a caret.
export function renderBracketLines(t) {
  const lines = [];
  const playableIds = new Set(currentMatches(t).map((m) => m.id));
  t.rounds.forEach((round, ri) => {
    lines.push({ type: 'round', text: roundName(t, ri).toUpperCase() });
    for (const m of round) {
      const name = (p) => (p ? p.name : '—');
      const mark = (p) => (m.winner && p && m.winner.id === p.id ? '✓' : ' ');
      lines.push({
        type: 'match',
        id: m.id,
        playable: playableIds.has(m.id),
        p1: name(m.p1), p2: name(m.p2),
        w1: mark(m.p1), w2: mark(m.p2),
        score: m.score,
      });
    }
  });
  return lines;
}
