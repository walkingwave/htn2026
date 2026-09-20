// Pure match state for online versus — no rendering, no networking. The host
// owns an instance and mutates it; both sides render from snapshots so the
// scoreboard stays consistent even with dropped packets.

// Table tennis games run to 11, win by 2 (deuce continues until a 2-point gap).
export const VERSUS_TARGET = 11;
export const VERSUS_WIN_BY = 2;

export class VersusMatch {
  constructor({ target = VERSUS_TARGET } = {}) {
    this.target = target;
    this.reset();
  }

  reset() {
    this.scoreHost = 0;
    this.scoreGuest = 0;
    this.server = 'host'; // who serves the next point
    this.winner = null; // 'host' | 'guest' | null
    this.rally = 0;
  }

  // Record a point for the scorer ('host' | 'guest'). The scorer serves next.
  // Returns the winner if the match just ended, else null. First to `target`,
  // win by 2 — at 10-10 (deuce) play continues until someone leads by two.
  scorePoint(scorer) {
    if (this.winner) return this.winner;
    if (scorer === 'host') this.scoreHost += 1;
    else this.scoreGuest += 1;
    this.server = scorer;
    this.rally = 0;
    if (
      this.scoreHost >= this.target &&
      this.scoreHost - this.scoreGuest >= VERSUS_WIN_BY
    ) {
      this.winner = 'host';
    } else if (
      this.scoreGuest >= this.target &&
      this.scoreGuest - this.scoreHost >= VERSUS_WIN_BY
    ) {
      this.winner = 'guest';
    }
    return this.winner;
  }

  snapshot() {
    return {
      scoreHost: this.scoreHost,
      scoreGuest: this.scoreGuest,
      server: this.server,
      winner: this.winner,
      target: this.target,
    };
  }

  apply(snap) {
    if (!snap) return;
    this.scoreHost = snap.scoreHost ?? this.scoreHost;
    this.scoreGuest = snap.scoreGuest ?? this.scoreGuest;
    this.server = snap.server ?? this.server;
    this.winner = snap.winner ?? null;
    this.target = snap.target ?? this.target;
  }
}
