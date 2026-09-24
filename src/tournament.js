import { VERSUS_TARGET, VERSUS_WIN_BY } from './versus.js';

// A shared four-player knockout bracket.  This module deliberately contains
// no networking or rendering: every browser can apply the same snapshot, and
// only the tournament room coordinator publishes authoritative results.
export const TOURNAMENT_SIZE = 4;

export const TOURNAMENT_PLAYERS = [
  { id: 'player-1', name: 'Player 1' },
  { id: 'player-2', name: 'Player 2' },
  { id: 'player-3', name: 'Player 3' },
  { id: 'player-4', name: 'Player 4' },
];

function playerId(player) {
  return typeof player === 'string' ? player : player?.id;
}

function normalisePlayers(players) {
  if (!Array.isArray(players) || players.length !== TOURNAMENT_SIZE) {
    throw new Error(`A tournament needs exactly ${TOURNAMENT_SIZE} players`);
  }

  const ids = new Set();
  return players.map((player, index) => {
    const id = String(playerId(player) ?? '').trim();
    if (!id || ids.has(id)) throw new Error('Tournament players need unique ids');
    ids.add(id);
    const fallback = `Player ${index + 1}`;
    return {
      id,
      name: String(typeof player === 'string' ? player : player.name ?? fallback)
        .trim()
        .slice(0, 24) || fallback,
    };
  });
}

function clonePlayer(player) {
  return player ? { id: player.id, name: player.name } : null;
}

export const RESULT_STATUS = {
  PENDING: 'pending',
  AGREED: 'agreed',
  DISPUTED: 'disputed',
  REJECTED: 'rejected',
};

function sameOutcome(a, b) {
  return Boolean(a) && Boolean(b) &&
    a.winnerId === b.winnerId &&
    a.score1 === b.score1 &&
    a.score2 === b.score2;
}

function cloneMatch(match) {
  return {
    id: match.id,
    round: match.round,
    slot: match.slot,
    player1: clonePlayer(match.player1),
    player2: clonePlayer(match.player2),
    score1: match.score1,
    score2: match.score2,
    winnerId: match.winnerId,
  };
}

export class Tournament {
  constructor(players = TOURNAMENT_PLAYERS, { target = VERSUS_TARGET, winBy = VERSUS_WIN_BY } = {}) {
    this.target = target;
    this.winBy = winBy;
    this.localPlayerId = null;
    this.reset(players);
  }

  reset(players = this.players ?? TOURNAMENT_PLAYERS) {
    this.players = normalisePlayers(players);
    this.pendingResults = new Map();
    this.disputedMatchIds = new Set();
    const [one, two, three, four] = this.players;
    this.matches = [
      this._match('semi-1', 0, 0, one, two),
      this._match('semi-2', 0, 1, three, four),
      this._match('final', 1, 0, null, null),
    ];
    this.finished = false;
    this.championId = null;
  }

  _match(id, round, slot, player1, player2) {
    return {
      id,
      round,
      slot,
      player1: clonePlayer(player1),
      player2: clonePlayer(player2),
      score1: 0,
      score2: 0,
      winnerId: null,
    };
  }

  getMatch(matchId) {
    return this.matches.find((match) => match.id === matchId) ?? null;
  }

  get currentMatch() {
    return this.matches.find(
      (match) => !match.winnerId && match.player1 && match.player2
    ) ?? null;
  }

  // Display convenience for the coaching HUD. The shared snapshot stays free
  // of per-browser state; main assigns localPlayerId after that browser joins.
  get opponent() {
    const match = this.matchFor(this.localPlayerId) ?? this.currentMatch;
    if (!match) return null;
    if (match.player1?.id === this.localPlayerId) return match.player2;
    if (match.player2?.id === this.localPlayerId) return match.player1;
    return match.player2 ?? match.player1 ?? null;
  }

  matchFor(player) {
    const id = playerId(player);
    return this.matches.find(
      (match) =>
        !match.winnerId &&
        match.player1 &&
        match.player2 &&
        (match.player1?.id === id || match.player2?.id === id)
    ) ?? null;
  }

  isReady(match) {
    return Boolean(match?.player1 && match?.player2 && !match.winnerId);
  }

  // Host-side point accounting. A match room's host calls this through the
  // coordinator only once it has the real two-player score.
  scorePoint(matchId, player) {
    const match = this.getMatch(matchId);
    const id = playerId(player);
    if (!this.isReady(match) || (match.player1.id !== id && match.player2.id !== id)) {
      return null;
    }

    const scoreKey = match.player1.id === id ? 'score1' : 'score2';
    const otherKey = scoreKey === 'score1' ? 'score2' : 'score1';
    match[scoreKey] += 1;
    if (match[scoreKey] < this.target || match[scoreKey] - match[otherKey] < this.winBy) {
      return null;
    }
    this.recordMatchResult({
      matchId,
      winnerId: id,
      score1: match.score1,
      score2: match.score2,
    });
    return id;
  }

  // A result is only believable if it clears the bracket's own win condition.
  // That makes it well-formed, not true — truth is settled by agreement below.
  _isPlausibleResult(match, { winnerId, score1, score2 } = {}) {
    if (winnerId !== match?.player1?.id && winnerId !== match?.player2?.id) return false;
    if (!Number.isInteger(score1) || !Number.isInteger(score2) || score1 < 0 || score2 < 0) {
      return false;
    }
    const winnerScore = winnerId === match.player1.id ? score1 : score2;
    const loserScore = winnerId === match.player1.id ? score2 : score1;
    return winnerScore >= this.target && winnerScore - loserScore >= this.winBy;
  }

  // Both players report how their match ended, and the bracket only advances
  // once the two agree. The match host owns the room and the scoreboard, so on
  // its own it could declare a win it did not play — and the loser has no way
  // to contest that. The guest is not blind, though: it applies every state
  // broadcast the host made during the game, so its report is a witness to what
  // the host already said in public. Agreement means the final claim does not
  // contradict anything the host broadcast on the way there.
  recordResultReport(report = {}) {
    const { matchId, reporterId, winnerId, score1, score2 } = report;
    const match = this.getMatch(matchId);
    if (!this.isReady(match)) return { status: RESULT_STATUS.REJECTED };
    if (match.player1.id !== reporterId && match.player2.id !== reporterId) {
      return { status: RESULT_STATUS.REJECTED };
    }
    const proposal = { winnerId, score1, score2 };
    if (!this._isPlausibleResult(match, proposal)) return { status: RESULT_STATUS.REJECTED };

    const reports = this.pendingResults.get(matchId) ?? new Map();
    reports.set(reporterId, proposal);
    this.pendingResults.set(matchId, reports);

    if (reports.size < 2) return { status: RESULT_STATUS.PENDING };

    const [first, second] = [...reports.values()];
    if (!sameOutcome(first, second)) {
      this.disputedMatchIds.add(matchId);
      return { status: RESULT_STATUS.DISPUTED, matchId };
    }
    this.pendingResults.delete(matchId);
    return this.recordMatchResult({ matchId, ...first })
      ? { status: RESULT_STATUS.AGREED, result: { matchId, ...first } }
      : { status: RESULT_STATUS.REJECTED };
  }

  get pendingResultCount() {
    return this.pendingResults.size;
  }

  // A disconnected opponent must not stall the bracket forever, so a lone
  // report is applied after a grace period. It is flagged `unconfirmed` and the
  // coordinator says so — a result nobody could corroborate is not the same as
  // one both players signed off on.
  resolveUnopposedResult(matchId) {
    const reports = this.pendingResults.get(matchId);
    if (!reports || reports.size === 0) return null;
    const [[reporterId, proposal]] = [...reports.entries()];
    this.pendingResults.delete(matchId);
    if (!this.recordMatchResult({ matchId, ...proposal })) return null;
    return { matchId, reporterId, ...proposal, unconfirmed: true };
  }

  // The coordinator's tie-break when the two players will not agree. Picking a
  // side is unavoidable; doing it explicitly, on the record, beats either
  // stalling forever or silently accepting whichever claim arrived first.
  resolveDisputedResult(matchId, preferredReporterId = null) {
    const reports = this.pendingResults.get(matchId);
    if (!reports || reports.size < 2) return null;
    const preferred = preferredReporterId ? reports.get(preferredReporterId) : null;
    const proposal = preferred ?? [...reports.values()][0];
    this.pendingResults.delete(matchId);
    this.disputedMatchIds.delete(matchId);
    if (!this.recordMatchResult({ matchId, ...proposal })) return null;
    return { matchId, ...proposal, disputed: true };
  }

  // Applies one finished real-world match. Returns false for a duplicate,
  // stale, malformed, or out-of-bracket report so a late packet cannot alter
  // a bracket that has already advanced.
  recordMatchResult({ matchId, winnerId, score1, score2 } = {}) {
    const match = this.getMatch(matchId);
    if (!this.isReady(match) || match.winnerId) return false;
    if (!this._isPlausibleResult(match, { winnerId, score1, score2 })) return false;

    match.score1 = score1;
    match.score2 = score2;
    match.winnerId = winnerId;
    const winner = winnerId === match.player1.id ? match.player1 : match.player2;

    if (match.id === 'semi-1') this.getMatch('final').player1 = clonePlayer(winner);
    else if (match.id === 'semi-2') this.getMatch('final').player2 = clonePlayer(winner);
    else if (match.id === 'final') {
      this.finished = true;
      this.championId = winnerId;
    }
    return true;
  }

  playerById(id) {
    return this.players.find((player) => player.id === id) ?? null;
  }

  snapshot() {
    return {
      target: this.target,
      winBy: this.winBy,
      players: this.players.map(clonePlayer),
      matches: this.matches.map(cloneMatch),
      finished: this.finished,
      championId: this.championId,
    };
  }

  // A lobby update is only accepted when it still describes a valid bracket.
  // Returning false lets callers ignore malformed remote broadcasts safely.
  apply(snapshot) {
    try {
      const players = normalisePlayers(snapshot?.players);
      const original = new Map(players.map((player) => [player.id, player]));
      const expected = ['semi-1', 'semi-2', 'final'];
      if (!Array.isArray(snapshot?.matches) || snapshot.matches.length !== expected.length) return false;

      const matches = expected.map((id, index) => {
        const source = snapshot.matches.find((match) => match?.id === id);
        if (!source) throw new Error('Missing tournament match');
        const toPlayer = (value) => {
          if (value == null) return null;
          const found = original.get(playerId(value));
          if (!found) throw new Error('Unknown tournament player');
          return clonePlayer(found);
        };
        const score1 = Number(source.score1);
        const score2 = Number(source.score2);
        if (!Number.isInteger(score1) || !Number.isInteger(score2) || score1 < 0 || score2 < 0) {
          throw new Error('Invalid tournament score');
        }
        const player1 = toPlayer(source.player1);
        const player2 = toPlayer(source.player2);
        const winnerId = source.winnerId == null ? null : String(source.winnerId);
        if (winnerId && winnerId !== player1?.id && winnerId !== player2?.id) {
          throw new Error('Invalid tournament winner');
        }
        return {
          id,
          round: index < 2 ? 0 : 1,
          slot: index < 2 ? index : 0,
          player1,
          player2,
          score1,
          score2,
          winnerId,
        };
      });

      const semifinalOne = matches[0];
      const semifinalTwo = matches[1];
      const final = matches[2];
      if (final.player1?.id && semifinalOne.winnerId !== final.player1.id) {
        throw new Error('Invalid first finalist');
      }
      if (final.player2?.id && semifinalTwo.winnerId !== final.player2.id) {
        throw new Error('Invalid second finalist');
      }
      if (final.winnerId && (!final.player1 || !final.player2)) {
        throw new Error('Invalid tournament champion');
      }

      this.players = players;
      this.matches = matches;
      this.target = Number.isInteger(snapshot.target) ? snapshot.target : VERSUS_TARGET;
      this.winBy = Number.isInteger(snapshot.winBy) ? snapshot.winBy : VERSUS_WIN_BY;
      this.finished = Boolean(snapshot.finished || final.winnerId);
      this.championId = final.winnerId ?? null;
      return true;
    } catch {
      return false;
    }
  }
}
