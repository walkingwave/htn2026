import { TABLE, PLAY_AREA } from './constants.js';

// Scoring for the trainer. There's no opponent, so "doing well" is measured
// as: did you make contact, and did the return land on the far half?

export class Game {
  constructor() {
    this.served = 0;
    this.hits = 0;
    this.returns = 0; // hits that landed back on the opponent's half
    this.misses = 0;
    this.streak = 0;
    this.bestStreak = 0;
    this.targetsHit = 0; // target-practice mode only
    this.rally = 0; // exchanges in the rally currently in play
    this.longestRally = 0;
    this.lessonScore = 0; // last coached stroke, as a percentage
    this.lessonBest = 0;
    this.lessonAttempts = 0;
    this.lastEvent = 'Ready';
    this.revision = 0; // bumped whenever a displayed value changes
  }

  get accuracy() {
    const played = this.hits + this.misses;
    return played === 0 ? 0 : Math.round((this.returns / played) * 100);
  }

  _changed(message) {
    this.lastEvent = message;
    this.revision++;
  }

  onServe() {
    this.served++;
    this.revision++;
  }

  // Called for every physics contact.
  // Touching the ball is not the same as putting it back on the table, so a
  // hit only opens the question — the shot stays unresolved until it either
  // lands on the far half or doesn't. The streak counts good returns, and
  // breaks the moment one goes astray.
  onContact(ball, event) {
    if (event === 'paddle') {
      if (ball.countedHit) return;
      ball.countedHit = true;
      ball.awaitingOutcome = true; // resolved on the next bounce
      this.hits++;
      this._changed('Hit');
      return;
    }

    if (event === 'table' && ball.awaitingOutcome) {
      ball.awaitingOutcome = false;
      if (ball.mesh.position.z < 0) {
        // Over the net and down on their side: a good return.
        ball.countedReturn = true;
        this.returns++;
        this.streak++;
        this.bestStreak = Math.max(this.bestStreak, this.streak);
        this._changed('On the table');
      } else {
        // Came down on your own half — it never crossed.
        this.streak = 0;
        this._changed('Not over');
      }
      return;
    }

    if (event === 'floor') {
      // A struck ball that reaches the floor without having landed on the
      // far half went long, wide, or into the net. Either way the streak is
      // over; it is not a miss, because you did make contact.
      if (ball.awaitingOutcome) {
        ball.awaitingOutcome = false;
        this.streak = 0;
        this._changed('Off the table');
        return;
      }

      // Reaching the floor untouched is a miss, whichever mode we're in.
      // This catches balls that drop short as well as ones that fly past —
      // the fly-past check in update() alone would never fire on a feed
      // that was simply left.
      if (!ball.touchedByPaddle && !ball.countedMiss && !ball.countedHit) {
        ball.countedMiss = true;
        this.misses++;
        this.streak = 0;
        this._changed('Missed');
      }
    }
  }

  // A coached stroke has been traced and graded.
  onLessonScore(score) {
    this.lessonScore = score.total;
    this.lessonBest = Math.max(this.lessonBest, score.total);
    this.lessonAttempts++;
    this._changed(`${score.total}% ${score.note}`);
  }

  onTargetHit() {
    this.targetsHit++;
    this._changed('Target hit!');
  }

  // One exchange: you hit it, the opponent got it back.
  onRallyExchange() {
    this.rally++;
    this.longestRally = Math.max(this.longestRally, this.rally);
    this._changed(`Rally ${this.rally}`);
  }

  endRally(reason) {
    if (this.rally === 0) return;
    this.rally = 0;
    this._changed(reason);
  }

  // Called once per frame so balls that sail past unhit register as misses.
  update(balls) {
    for (const ball of balls) {
      if (!ball.active || ball.countedMiss || ball.countedHit) continue;
      if (ball.mesh.position.z > PLAY_AREA.PLAYER_Z + 0.5) {
        ball.countedMiss = true;
        this.misses++;
        this.streak = 0;
        this._changed('Missed');
      }
    }
  }

  reset() {
    this.served = 0;
    this.hits = 0;
    this.returns = 0;
    this.misses = 0;
    this.streak = 0;
    this.bestStreak = 0;
    this.targetsHit = 0;
    this.rally = 0;
    this.longestRally = 0;
    this.lessonScore = 0;
    this.lessonBest = 0;
    this.lessonAttempts = 0;
    this._changed('Reset');
  }
}

// Where the scoreboard hangs: beyond the far end, angled up slightly so it's
// readable from the player's side without blocking the table. Hung high enough
// that the (now much larger) panel clears the ball machine standing in front
// of it, and sits a few degrees above eye level rather than in the rally line.
export const SCOREBOARD_POSITION = {
  x: 0,
  y: TABLE.HEIGHT + 0.98,
  z: -(TABLE.LENGTH / 2 + 1.15),
};
