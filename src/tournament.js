import { VERSUS_TARGET } from './versus.js';

export const TOURNAMENT_PLAYERS = ['You', 'Ada', 'Blake', 'Casey'];

// The bracket is a playable single-player elimination ladder. There are no
// fabricated AI-vs-AI results: every match containing the local player is
// played through the normal table physics before its winner advances.
export class Tournament {
  constructor(players = TOURNAMENT_PLAYERS) {
    if (players.length !== 4) throw new Error('A tournament needs exactly four players');
    this.players = players.map((name, id) => ({ id, name }));
    this.target = VERSUS_TARGET;
    this.reset();
  }

  reset() {
    const [you, ada, blake, casey] = this.players;
    this.matches = [
      this._match(0, 0, you, ada),
      this._match(1, 0, null, blake),
      this._match(2, 0, null, casey),
    ];
    this.currentMatchId = '0-0';
    this.finished = false;
  }

  _match(round, slot, player1, player2) {
    return { id: `${round}-${slot}`, round, slot, player1, player2, score1: 0, score2: 0, winner: null };
  }

  get currentMatch() {
    return this.matches.find((match) => match.id === this.currentMatchId) ?? null;
  }

  get opponent() {
    const match = this.currentMatch;
    if (!match) return null;
    return match.player1?.id === 0 ? match.player2 : match.player1;
  }

  hasPlayer(playerId) {
    const match = this.currentMatch;
    return Boolean(match && (match.player1?.id === playerId || match.player2?.id === playerId));
  }

  scorePoint(playerId) {
    const match = this.currentMatch;
    if (!match || match.winner || !this.hasPlayer(playerId)) return null;
    if (match.player1?.id === playerId) match.score1++;
    else match.score2++;

    const score = match.player1?.id === playerId ? match.score1 : match.score2;
    const other = match.player1?.id === playerId ? match.score2 : match.score1;
    if (score < this.target || score - other < 2) return null;

    match.winner = playerId;
    // A local tournament ends when the human is eliminated; there is no
    // fabricated result for the remaining bracket.
    if (playerId !== 0) {
      this.finished = true;
      return playerId;
    }
    const next = this.matches.find((candidate) => candidate.round === match.round + 1);
    if (!next) {
      this.finished = true;
    } else {
      next.player1 = this.players.find((player) => player.id === playerId);
      this.currentMatchId = next.id;
    }
    return playerId;
  }

  snapshot() {
    return {
      target: this.target,
      currentMatchId: this.currentMatchId,
      finished: this.finished,
      matches: this.matches.map((match) => ({
        ...match,
        player1: match.player1?.name ?? 'TBD',
        player2: match.player2?.name ?? 'TBD',
      })),
    };
  }
}
