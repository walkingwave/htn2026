export const DIFFICULTIES = {
  beginner: { label: 'Foundation', detail: 'Slower serves with a wide target window.', interval: 3.2, speed: 3.6, spread: 0.55, bossLevel: 1 },
  standard: { label: 'Standard', detail: 'A balanced fundamentals drill.', interval: 2.5, speed: 4.2, spread: 0.45, bossLevel: 2 },
  boss: { label: 'Boss run', detail: 'Faster, tighter serves. How long can you survive?', interval: 1.55, speed: 5.2, spread: 0.35, bossLevel: 3 },
};

export const TARGET_REPETITIONS = 5;
// Ranked runs are survival-style: players get a fixed number of dropped balls
// (player-side floor misses) before the run ends.
export const RANKED_LIVES = 3;
export const TARGET_MOVES = [
  { id: 'forehand-cross', label: 'Forehand cross-court', shortLabel: 'FH cross', cue: 'Turn your shoulders and finish toward the far right corner.', x: 0.42, z: -0.82, radius: 0.23 },
  { id: 'backhand-line', label: 'Backhand down the line', shortLabel: 'BH line', cue: 'Keep the face quiet and send it straight down the left line.', x: -0.47, z: -1.05, radius: 0.22 },
  { id: 'forehand-line', label: 'Forehand down the line', shortLabel: 'FH line', cue: 'Brush forward, then finish toward the far left corner.', x: -0.42, z: -1.08, radius: 0.22 },
  { id: 'backhand-cross', label: 'Backhand cross-court', shortLabel: 'BH cross', cue: 'Prepare early and finish across your body to the right.', x: 0.42, z: -0.78, radius: 0.23 },
  { id: 'short-touch', label: 'Short touch', shortLabel: 'Short touch', cue: 'Soften the hands and land the ball just over the net.', x: -0.34, z: -0.30, radius: 0.20 },
  { id: 'deep-drive', label: 'Deep drive', shortLabel: 'Deep drive', cue: 'Use your legs and send a high, deep ball to the corner.', x: 0.35, z: -1.18, radius: 0.21 },
];

export const DRILLS = {
  target: { label: 'Hit the zone', detail: 'Complete six coached shots, five clean repetitions of each.', coach: 'Follow the gold target. Complete five clean shots before the next move unlocks.' },
  rally: { label: 'Rally builder', detail: 'Keep the exchange alive and build clean consecutive returns.', coach: 'Small, early movements beat big swings. Reset after every contact.' },
  fly: { label: 'Face the fly', detail: 'Play a real exchange: the fly intercepts returns and sends them back.', coach: 'Watch the fly paddle, prepare early, and place your next ball away from it.' },
};

export class TrainerSession {
  constructor() { this.reset(); }

  reset(difficulty = 'standard', drill = 'rally') {
    this.difficulty = difficulty;
    this.drill = drill;
    // Preserve the session mode (casual/ranked) across drill switches/resets.
    this.mode = this.mode ?? 'casual';
    this.startedAt = 0;
    this.lastHitAt = 0;
    this.elapsedMs = 0;
    this.score = 0;
    this.rally = 0;
    this.longestRally = 0;
    this.returns = 0;
    this.flyReturns = 0;
    this.serves = 0;
    this.tableBounces = 0;
    this.netErrors = 0;
    this.misses = 0;
    this.flyMisses = 0;
    this.targetHits = 0;
    this.targetAttempts = 0;
    this.targetMoveIndex = 0;
    this.moveSuccesses = 0;
    this.completedMoves = 0;
    this.hits = [];
    this.bossLevel = DIFFICULTIES[difficulty].bossLevel;
    this.active = false;
    this.finished = false;
  }

  start(now = performance.now()) { this.startedAt = now; this.lastHitAt = now; this.active = true; this.finished = false; }
  update(now = performance.now()) { if (this.active) this.elapsedMs = now - this.startedAt; }
  serve() { if (this.active) this.serves += 1; }
  getCurrentTargetMove() { return this.drill === 'target' ? TARGET_MOVES[this.targetMoveIndex] ?? null : null; }
  isTargetHit(position, move = this.getCurrentTargetMove()) {
    if (!position || !move || position.z >= 0) return false;
    return Math.hypot(position.x - move.x, position.z - move.z) <= move.radius;
  }

  record(event, details = {}, now = performance.now()) {
    const result = { event, targetHit: false, targetMiss: false, moveAdvanced: false, drillComplete: false };
    if (!this.active) return result;
    this.update(now);
    if (event === 'paddle') {
      if (details.owner === 'fly') {
        this.flyReturns += 1;
      } else {
        this.rally += 1;
        this.returns += 1;
        this.longestRally = Math.max(this.longestRally, this.rally);
        this.score += 10 + Math.min(this.rally, 20);
        this.hits.push(now - this.lastHitAt);
        this.lastHitAt = now;
      }
    } else if (event === 'table') {
      this.tableBounces += 1;
      const move = this.getCurrentTargetMove();
      if (this.drill === 'target' && details.position?.z < 0 && move) {
        this.targetAttempts += 1;
        if (this.isTargetHit(details.position, move)) {
          this.targetHits += 1;
          this.moveSuccesses += 1;
          this.score += 45;
          result.targetHit = true;
          result.move = move;
          result.moveSuccesses = this.moveSuccesses;
          if (this.moveSuccesses >= TARGET_REPETITIONS) {
            this.completedMoves += 1;
            this.score += 100;
            this.targetMoveIndex += 1;
            this.moveSuccesses = 0;
            result.moveAdvanced = true;
            result.nextMove = this.getCurrentTargetMove();
            result.drillComplete = this.targetMoveIndex >= TARGET_MOVES.length;
          }
        } else {
          result.targetMiss = true;
          result.move = move;
          result.moveSuccesses = this.moveSuccesses;
        }
      }
    } else if (event === 'net') {
      if (details.owner === 'fly' || details.position?.z < 0) this.flyMisses += 1;
      else { this.netErrors += 1; this.endRally(); }
    } else if (event === 'floor') {
      if (details.owner === 'fly' || details.position?.z < 0) this.flyMisses += 1;
      else { this.misses += 1; this.endRally(); result.playerMiss = true; result.misses = this.misses; }
    }
    return result;
  }

  endRally() { this.longestRally = Math.max(this.longestRally, this.rally); this.rally = 0; }
  finish(now = performance.now()) { this.update(now); this.endRally(); this.active = false; this.finished = true; return this.summary(); }

  summary() {
    const attempts = Math.max(this.serves, this.returns + this.misses + this.netErrors);
    const accuracy = attempts ? Math.round((this.returns / attempts) * 100) : 0;
    const reactionTimes = this.hits.slice(1);
    const reactionMs = reactionTimes.length ? Math.round(reactionTimes.reduce((a, b) => a + b, 0) / reactionTimes.length) : null;
    const targetAccuracy = this.targetAttempts ? Math.round((this.targetHits / this.targetAttempts) * 100) : 0;
    const survivalSeconds = Math.round(this.elapsedMs / 100) / 10;
    const currentMove = this.getCurrentTargetMove();
    return {
      difficulty: this.difficulty, drill: this.drill, mode: this.mode, score: this.score, rally: this.rally,
      longestRally: this.longestRally, returns: this.returns, flyReturns: this.flyReturns,
      serves: this.serves, tableBounces: this.tableBounces, netErrors: this.netErrors,
      misses: this.misses, flyMisses: this.flyMisses, accuracy, reactionMs, survivalSeconds,
      bossLevel: this.bossLevel, targetHits: this.targetHits, targetAttempts: this.targetAttempts,
      targetAccuracy, completedMoves: this.completedMoves, totalMoves: TARGET_MOVES.length,
      currentMoveNumber: currentMove ? this.targetMoveIndex + 1 : TARGET_MOVES.length,
      currentMoveLabel: currentMove?.label ?? 'Sequence complete',
      currentMoveCue: currentMove?.cue ?? 'Great work. Review your consistency, then repeat at the next speed.',
      moveSuccesses: this.moveSuccesses, moveRequired: TARGET_REPETITIONS,
      targetComplete: this.drill === 'target' && this.completedMoves === TARGET_MOVES.length,
    };
  }
}
