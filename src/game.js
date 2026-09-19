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
  onContact(ball, event) {
    if (event === 'paddle') {
      // No-volley (games only): you must let the ball bounce on your half
      // before hitting it. Target-practice feeds (isFeed) are a toss you drive
      // on the full, so they're exempt.
      if (!ball.isFeed && !ball.everBouncedPlayerHalf && !ball.countedMiss && !ball.countedHit) {
        ball.countedMiss = true;
        this.misses++;
        this.streak = 0;
        this._changed('No volley — let it bounce');
        return;
      }
      // A return resets the double-bounce counter: the "second bounce" rule
      // only fires when the player *failed* to put a paddle on it in between.
      ball.playerHalfBouncesSincePaddle = 0;
      if (ball.countedHit) return;
      ball.countedHit = true;
      this.hits++;
      this.streak++;
      this.bestStreak = Math.max(this.bestStreak, this.streak);
      this._changed('Hit');
      return;
    }

    if (event === 'table') {
      const onPlayerHalf = ball.mesh.position.z > 0;
      if (onPlayerHalf) {
        // This is a legal receiving bounce, so the feed can no longer be
        // written off as a dead feed. Track how many have landed since the
        // last paddle touch to enforce the double-bounce rule.
        ball.everBouncedPlayerHalf = true;
        ball.playerHalfBouncesSincePaddle++;

        if (
          ball.playerHalfBouncesSincePaddle >= 2 &&
          !ball.countedMiss &&
          !ball.countedHit
        ) {
          // Second bounce on the player's half with no return between them:
          // the point is lost. main.js recycles the ball and runs the 3-2-1.
          ball.countedMiss = true;
          this.misses++;
          this.streak = 0;
          this._changed('Double bounce');
        }
        return;
      }

      // A bounce on the far half after the player struck it is a good return.
      if (ball.touchedByPaddle && !ball.countedReturn) {
        ball.countedReturn = true;
        this.returns++;
        this._changed('On the table');
      }
      return;
    }

    // Reaching the floor untouched is a miss, whichever mode we're in. This
    // catches balls that drop short as well as ones that fly past — the
    // fly-past check in update() alone would never fire on a dropped feed.
    // Exception: a ball that never made a legal bounce on the player's half
    // is a dead feed (the machine sent it off the table), not a player miss,
    // so it leaves the streak untouched and main.js recycles it silently.
    if (
      event === 'floor' &&
      !ball.touchedByPaddle &&
      !ball.countedMiss &&
      !ball.countedHit
    ) {
      if (!ball.everBouncedPlayerHalf) return; // dead feed — not the player's fault
      ball.countedMiss = true;
      this.misses++;
      this.streak = 0;
      this._changed('Missed');
    }
  }

  onTargetHit() {
    this.targetsHit++;
    this._changed('Target hit!');
  }

  // Called once per frame so balls that sail past unhit register as misses.
  update(balls) {
    for (const ball of balls) {
      if (!ball.active || ball.countedMiss || ball.countedHit) continue;
      if (ball.mesh.position.z > PLAY_AREA.PLAYER_Z + 0.5) {
        // A ball that sailed straight past without ever bouncing on the
        // player's half is a dead feed, not a miss — don't punish the streak.
        if (!ball.everBouncedPlayerHalf) continue;
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
