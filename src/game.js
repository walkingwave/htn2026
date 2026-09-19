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
      if (ball.countedHit) return;
      ball.countedHit = true;
      this.hits++;
      this.streak++;
      this.bestStreak = Math.max(this.bestStreak, this.streak);
      this._changed('Hit');
      return;
    }

    // A bounce on the far half after the player struck it is a good return.
    if (
      event === 'table' &&
      ball.touchedByPaddle &&
      !ball.countedReturn &&
      ball.mesh.position.z < 0
    ) {
      ball.countedReturn = true;
      this.returns++;
      this._changed('On the table');
      return;
    }

    // Reaching the floor untouched is a miss, whichever mode we're in. This
    // catches balls that drop short as well as ones that fly past — the
    // fly-past check in update() alone would never fire on a dropped feed.
    if (
      event === 'floor' &&
      !ball.touchedByPaddle &&
      !ball.countedMiss &&
      !ball.countedHit
    ) {
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
// readable from the player's side without blocking the table.
export const SCOREBOARD_POSITION = {
  x: 0,
  y: TABLE.HEIGHT + 0.95,
  z: -(TABLE.LENGTH / 2 + 1.15),
};
