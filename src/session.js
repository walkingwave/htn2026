export const DIFFICULTIES = {
  beginner: { label: 'Foundation', detail: 'Slower serves with a wide target window.', interval: 3.2, speed: 3.6, spread: 0.55, bossLevel: 1 },
  standard: { label: 'Standard', detail: 'A balanced fundamentals drill.', interval: 2.5, speed: 4.2, spread: 0.45, bossLevel: 2 },
  boss: { label: 'Boss run', detail: 'Faster, tighter serves. How long can you survive?', interval: 1.55, speed: 5.2, spread: 0.35, bossLevel: 3 },
};

export const DRILLS = {
  target: { label: 'Hit the zone', detail: 'Return the ball into the highlighted target on the fly side.', coach: 'Aim through the center of the ball and finish toward the gold zone.' },
  rally: { label: 'Rally builder', detail: 'Keep the exchange alive and build clean consecutive returns.', coach: 'Small, early movements beat big swings. Reset after every contact.' },
  fly: { label: 'Face the fly', detail: 'Read the fly boss and return its changing placements.', coach: 'Watch the fly paddle, not the ball. Prepare before it crosses the net.' },
};

export class TrainerSession {
  constructor() { this.reset(); }
  reset(difficulty = 'standard', drill = 'rally') {
    this.difficulty = difficulty; this.drill = drill; this.startedAt = 0; this.lastHitAt = 0; this.elapsedMs = 0;
    this.score = 0; this.rally = 0; this.longestRally = 0; this.returns = 0; this.serves = 0; this.tableBounces = 0;
    this.netErrors = 0; this.misses = 0; this.targetHits = 0; this.targetAttempts = 0; this.hits = [];
    this.bossLevel = DIFFICULTIES[difficulty].bossLevel; this.active = false; this.finished = false;
  }
  start(now = performance.now()) { this.startedAt = now; this.lastHitAt = now; this.active = true; this.finished = false; }
  update(now = performance.now()) { if (this.active) this.elapsedMs = now - this.startedAt; }
  serve() { if (this.active) this.serves += 1; }
  record(event, details = {}, now = performance.now()) {
    if (!this.active) return;
    this.update(now);
    if (event === 'paddle') {
      this.rally += 1; this.returns += 1; this.longestRally = Math.max(this.longestRally, this.rally);
      this.score += 10 + Math.min(this.rally, 20); this.hits.push(now - this.lastHitAt); this.lastHitAt = now;
    } else if (event === 'table') {
      this.tableBounces += 1;
      const p = details.position;
      if (this.drill === 'target' && p && p.z < 0) {
        this.targetAttempts += 1;
        if (Math.abs(p.x) <= 0.32 && p.z >= -1.05 && p.z <= -0.35) { this.targetHits += 1; this.score += 45; }
      }
    } else if (event === 'net') { this.netErrors += 1; this.endRally(); }
    else if (event === 'floor') { this.misses += 1; this.endRally(); }
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
    return { difficulty: this.difficulty, drill: this.drill, score: this.score, rally: this.rally, longestRally: this.longestRally, returns: this.returns, serves: this.serves, tableBounces: this.tableBounces, netErrors: this.netErrors, misses: this.misses, accuracy, reactionMs, survivalSeconds, bossLevel: this.bossLevel, targetHits: this.targetHits, targetAttempts: this.targetAttempts, targetAccuracy };
  }
}
