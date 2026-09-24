import * as THREE from 'three';
import { Paddle } from './paddle.js';
import { TABLE, NET, BALL, PHYSICS, PADDLE } from './constants.js';

// An opponent that rallies with you from the far end.
//
// It plays through the real physics rather than teleporting the ball. The
// opponent owns an ordinary Paddle, and all this class does is move it: to
// the right place, at the right moment, at the right speed. The contact
// itself is resolved by the same impulse code that handles your bat, so the
// return carries genuine spin, and a ball that clips the net or catches the
// edge behaves the way it should instead of being scripted.
//
// Getting the ball back
// ---------------------
// Two problems, solved in order:
//
//  1. *Where and when.* Roll the ball forward through the same forces the
//     simulation applies — gravity, drag, Magnus, the bounce off the table —
//     until it reaches the hitting plane. That gives an intercept point and
//     a time to be there.
//
//  2. *How hard, and facing where.* Pick a target on your half and solve the
//     launch that reaches it. Then invert the contact model: for a mirror
//     bounce the face normal is the bisector of the incoming and outgoing
//     directions, and the speed follows from
//
//         v_out·n = −e·v_in·n + (1 + e)·V_paddle·n
//
//     rearranged for V_paddle·n. Restitution depends on impact speed, so
//     that is iterated a few times to settle.

// Where it plays the ball. Kept close to the end line: measured across a
// range of realistic returns, a ball 25 cm past the table has already fallen
// to 0.4-0.6 m, so a plane further back plus a table-height floor made the
// opponent wave almost everything through.
const HIT_PLANE_Z = -(TABLE.LENGTH / 2) - 0.1;

// A low ball is dug out, not conceded — anything clear of the floor is fair
// game, the same as for a real player standing off the end of the table.
const HIT_HEIGHT_MIN = 0.28;

// Planned clearance over the tape, chosen from measured net-cord rates
// rather than by eye.
const NET_MARGIN = 0.15;

// How long the bat keeps travelling once it has reached the contact point.
const SWING_FOLLOW_THROUGH = 0.16; // seconds

// How early the stroke begins, measured in time to contact rather than
// distance — a hard shot crosses a fixed distance far quicker than a soft
// one, so a distance trigger starts the swing too late exactly when it
// matters most.
const SWING_LEAD = 0.20; // seconds of forward travel before contact
const SWING_STAGE_LEAD = 0.24; // stage the blade this far behind contact
const SWING_CONTACT_WINDOW = 0.12; // keep the face live around the crossing

// The flight estimate is refreshed this often while tracking. The one made
// before the bounce carries real error.
const REPREDICT_INTERVAL = 1 / 30; // seconds
const READY = new THREE.Vector3(0, TABLE.HEIGHT + 0.2, HIT_PLANE_Z);

// Difficulty is mostly how often a ball is let through and how hard the
// return comes back, not how competent the stroke is — a bad stroke reads as
// a broken opponent rather than an easy one.
//
// Rally length is brutally sensitive to this: with a per-exchange return
// rate p, the average rally runs p/(1−p), so 60% gives about 1.5 exchanges
// and 85% gives nearly 6. Measured rates against a spread of realistic
// shots: easy ~60%, normal ~85%, hard ~86% with far more pace.
export const OPPONENT_SKILL = {
  // `missChance` is now a small style adjustment, not the bot's main source of
  // failure. Legal-shot validation below means an easy bot can still return a
  // safe ball; reaction time, recovery and risk make it easier to beat.
  easy: {
    reach: 1.1, maxSpeed: 2.1, error: 0.20, missChance: 0.18, pace: 3.8,
    reaction: 0.16, recovery: 0.42, netMargin: 0.10, targetBias: 0.2, risk: 0.15,
  },
  normal: {
    reach: 1.7, maxSpeed: 3.2, error: 0.10, missChance: 0.04, pace: 4.4,
    reaction: 0.08, recovery: 0.30, netMargin: 0.13, targetBias: 0.38, risk: 0.30,
  },
  hard: {
    reach: 2.1, maxSpeed: 4.0, error: 0.05, missChance: 0.015, pace: 4.9,
    reaction: 0.035, recovery: 0.22, netMargin: 0.15, targetBias: 0.62, risk: 0.58,
  },
  // The fly's paddle placement comes from the connectome reservoir (or its
  // analytic fallback) instead of our predictor — see `brain` below. It gets
  // the physique of `hard` with almost nothing let through.
  fly: {
    reach: 2.2, maxSpeed: 4.6, error: 0, missChance: 0.008, pace: 4.7,
    reaction: 0.02, recovery: 0.18, netMargin: 0.16, targetBias: 0.7, risk: 0.72,
    useBrain: true,
  },
};

const RETURN_TARGET_MIN_Z = TABLE.LENGTH * 0.08;
const RETURN_TARGET_MAX_Z = TABLE.LENGTH * 0.43;
const RETURN_CANDIDATES = 14;

const clamp01 = (value) => THREE.MathUtils.clamp(value, 0, 1);

// Choose a legal return before the paddle swing is planned. This is deliberately
// exported as a pure function: it gives tests and offline bot evaluation the
// same candidate selector used in the game, without constructing a Three.js
// scene or a browser paddle.
export function chooseReturnPlan({ origin, incoming, spin, skill = OPPONENT_SKILL.normal, random = Math.random, tactic = null }) {
  const candidates = [];
  const preferredX = Number.isFinite(tactic?.targetX)
    ? THREE.MathUtils.clamp(tactic.targetX, -TABLE.WIDTH / 2 + 0.12, TABLE.WIDTH / 2 - 0.12)
    : 0;
  const preferredZ = Number.isFinite(tactic?.targetZ)
    ? THREE.MathUtils.clamp(tactic.targetZ, RETURN_TARGET_MIN_Z, RETURN_TARGET_MAX_Z)
    : TABLE.LENGTH * 0.28;
  const pace = Number.isFinite(tactic?.pace) ? tactic.pace : skill.pace;
  const risk = clamp01(Number.isFinite(tactic?.risk) ? tactic.risk : skill.risk ?? 0.3);

  for (let i = 0; i < RETURN_CANDIDATES; i += 1) {
    const lane = i === 0
      ? preferredX
      : THREE.MathUtils.clamp(
        (random() * 2 - 1) * (TABLE.WIDTH / 2 - 0.14) +
          preferredX * skill.targetBias + (random() - 0.5) * (skill.error ?? 0),
        -TABLE.WIDTH / 2 + 0.12,
        TABLE.WIDTH / 2 - 0.12
      );
    const depth = i === 0
      ? preferredZ
      : THREE.MathUtils.lerp(
        RETURN_TARGET_MIN_Z,
        RETURN_TARGET_MAX_Z,
        0.35 + random() * 0.65
      );
    const target = new THREE.Vector3(
      lane,
      TABLE.HEIGHT + BALL.RADIUS,
      depth
    );
    const speed = pace * THREE.MathUtils.clamp(1 + (random() - 0.5) * (0.18 + risk * 0.24), 0.72, 1.22);
    const velocity = solveReturn(origin, target, speed, spin);
    const shot = flyShot(origin, velocity, target.y, spin);
    const legal = isLegalReturn(shot, skill.netMargin ?? 0.08);
    const edgeMargin = Math.min(
      TABLE.WIDTH / 2 - BALL.RADIUS - Math.abs(shot.x),
      TABLE.LENGTH / 2 - BALL.RADIUS - shot.z
    );
    const placementError = Math.hypot(shot.x - target.x, shot.z - target.z);
    const paceScore = clamp01(velocity.length() / Math.max(skill.pace, 0.1));
    const riskScore = clamp01(Math.abs(shot.x) / (TABLE.WIDTH / 2) * 0.55 + shot.z / TABLE.LENGTH * 0.45);
    const score = legal
      ? 100 + Math.min(1, Math.max(0, shot.netClearance - skill.netMargin)) * 8
        - placementError * 18
        + edgeMargin * (2 + risk * 8)
        + paceScore * risk * 4
        + riskScore * skill.targetBias * 3
      : -100 - Math.max(0, -shot.netClearance) * 10 - placementError * 4;
    candidates.push({ target, velocity, shot, legal, score });
  }

  const legal = candidates.filter((candidate) => candidate.legal).sort((a, b) => b.score - a.score);
  if (legal.length) return legal[0];

  // A defensive retry is preferable to swinging at a mathematically invalid
  // target. Lower pace and aim through the middle with generous net margin.
  const safeTarget = new THREE.Vector3(0, TABLE.HEIGHT + BALL.RADIUS, TABLE.LENGTH * 0.20);
  for (const factor of [0.72, 0.58, 0.45]) {
    const velocity = solveReturn(origin, safeTarget, Math.max(1.8, pace * factor), spin);
    const shot = flyShot(origin, velocity, safeTarget.y, spin);
    if (isLegalReturn(shot, Math.max(0.04, skill.netMargin * 0.6))) {
      return { target: safeTarget, velocity, shot, legal: true, safe: true, score: 1 };
    }
  }

  // This is only reachable for an impossible incoming trajectory. Returning
  // the least-bad candidate keeps the paddle animation coherent and lets the
  // physics decide the point instead of producing NaN or a teleport.
  return candidates.sort((a, b) => b.score - a.score)[0] ?? {
    target: safeTarget,
    velocity: solveReturn(origin, safeTarget, 2.2, spin),
    shot: null,
    legal: false,
  };
}

export function isLegalReturn(shot, netMargin = 0.08) {
  return Boolean(
    shot?.landed &&
    shot.netClearance >= netMargin &&
    Number.isFinite(shot.x) &&
    Number.isFinite(shot.z) &&
    Math.abs(shot.x) <= TABLE.WIDTH / 2 - BALL.RADIUS &&
    shot.z >= BALL.RADIUS &&
    shot.z <= TABLE.LENGTH / 2 - BALL.RADIUS
  );
}

const _p = new THREE.Vector3();
const _v = new THREE.Vector3();
const _spin = new THREE.Vector3();
const _acc = new THREE.Vector3();
const _cross = new THREE.Vector3();
const _inDir = new THREE.Vector3();
const _outDir = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _swing = new THREE.Vector3();
const _bladeOffset = new THREE.Vector3();
const _swingPos = new THREE.Vector3();
const _faceQuat = new THREE.Quaternion();
const _faceDir = new THREE.Vector3();
const FORWARD = new THREE.Vector3(0, 0, 1); // the blade's own face axis
const TOWARD_PLAYER = new THREE.Vector3(0, 0, 1);

export class Opponent {
  constructor(skill = 'normal', { random = Math.random } = {}) {
    this.paddle = new Paddle();
    this.paddle.isOpponent = true;
    this.paddle.enabled = false; // only live while actually playing a ball
    this.mesh = this.paddle.mesh;
    this.skill = OPPONENT_SKILL[skill] ?? OPPONENT_SKILL.normal;
    this.random = random;
    this.skillName = OPPONENT_SKILL[skill] ? skill : 'normal';

    this.active = false;
    this.state = 'idle'; // idle | tracking | swinging | recover
    this.targetBall = null;
    // Optional FlyBrain controller. On the 'fly' difficulty it decides WHERE
    // the paddle waits (its readout maps ball state to a paddle target);
    // everything about how the stroke is played stays ours.
    this.brain = null;

    this._intercept = new THREE.Vector3().copy(READY);
    this._swingVel = new THREE.Vector3();
    this._recover = 0;
    this._willMiss = false;
    this._swingElapsed = 0;
    this._repredictIn = 0;
    this._interceptVel = new THREE.Vector3();
    this._interceptSpin = new THREE.Vector3();
    this._swingDir = new THREE.Vector3(0, 0, 1);
    this._swingSpeed = 0;
    this._rallyLength = 0;
    this._contactConfidence = 0;
    this._returnPlan = null;
    this._swingPrepared = false;
    this._swingStarted = false;

    // The blade sits at an offset inside the paddle mesh, so placing the
    // blade somewhere means placing the mesh at that point less the offset.
    this._blade = this.mesh.getObjectByName('blade');
    _bladeOffset.copy(this._blade.position);

    // The blade carries its own rotation inside the mesh, so orienting the
    // mesh is not the same as orienting the face. Keep the inverse of that
    // fixed local rotation to convert "face this way" into a mesh pose —
    // without it the bat connects but sends the ball somewhere else.
    this._bladeLocalInv = this._blade.quaternion.clone().invert();

    this.mesh.visible = false;
    this._place(READY, TOWARD_PLAYER);
  }

  setSkill(name) {
    this.skill = OPPONENT_SKILL[name] ?? OPPONENT_SKILL.normal;
    this.skillName = OPPONENT_SKILL[name] ? name : 'normal';
  }

  // Idempotent: this is called every frame from the game loop, so it must
  // only reset on an actual change. Clearing the target and state on every
  // call would put the opponent back to idle before it could ever act.
  setActive(active) {
    if (active === this.active) return;
    this.active = active;
    this.mesh.visible = active;
    this.paddle.enabled = false;
    this.state = 'idle';
    this.targetBall = null;
    if (!active) {
      this._rallyLength = 0;
      this._returnPlan = null;
      this._swingPrepared = false;
      this._swingStarted = false;
      this._place(READY, TOWARD_PLAYER);
    }
  }

  // Places the *blade* at a world point with its face along `faceNormal`.
  _place(bladeWorldPos, faceNormal) {
    _faceQuat.setFromUnitVectors(FORWARD, _faceDir.copy(faceNormal).normalize());
    // Undo the blade's own rotation so the face, not the mesh, ends up aimed
    this.mesh.quaternion.copy(_faceQuat).multiply(this._bladeLocalInv);
    _p.copy(_bladeOffset).applyQuaternion(this.mesh.quaternion);
    this.mesh.position.copy(bladeWorldPos).sub(_p);
    this.mesh.updateMatrixWorld(true);
  }

  update(dt, balls) {
    if (!this.active) return;

    if (this._recover > 0) {
      this._recover -= dt;
      if (this._recover <= 0) this.state = 'idle';
    }

    // Drop a ball we can no longer play
    if (this.targetBall && (!this.targetBall.active || this.targetBall.velocity.z > 0)) {
      this.targetBall = null;
      if (this.state !== 'recover') this.state = 'idle';
      this.paddle.enabled = false;
    }

    if (!this.targetBall) this._acquire(balls);

    if (this.targetBall) {
      this._chase(dt);
    } else {
      this._driftTo(READY, dt);
      this.paddle.enabled = false;
    }

    // Paddle derives its own velocity from the motion we just applied, so
    // the physics sees a genuinely swung bat rather than a teleported one.
    this.paddle.update(dt);
  }

  // Pick up any ball the player has hit that is heading our way.
  _acquire(balls) {
    for (const ball of balls) {
      if (!ball.active || !ball.touchedByPaddle) continue;
      if (ball.velocity.z >= 0) continue; // going away from us
      if (ball.mesh.position.z > TABLE.LENGTH / 2) continue;

      const plan = this._predict(ball);
      if (!plan) continue;

      this.targetBall = ball;
      this.state = 'tracking';
      this.brain?.reset?.();
      this._intercept.copy(plan.point);
      this._interceptVel.copy(plan.velocity);
      this._interceptSpin.copy(plan.spin);
      this._applyBrain(ball);
      this._timeToHit = plan.time;
      this._repredictIn = REPREDICT_INTERVAL;
      // Decide up front whether this one gets away, so the paddle can move
      // convincingly short rather than snapping at the last instant.
      const blade = this._blade.getWorldPosition(new THREE.Vector3());
      const requiredTravel = blade.distanceTo(plan.point);
      const availableTravel = Math.max(this.skill.maxSpeed * Math.max(plan.time, 0.001), 0.001);
      this._contactConfidence = THREE.MathUtils.clamp(
        (availableTravel + this.skill.reach * 0.16 - requiredTravel) / Math.max(availableTravel, 0.12),
        0,
        1
      );
      const latePenalty = 1 - this._contactConfidence;
      this._willMiss = this.random() < this.skill.missChance * (0.35 + latePenalty * 0.9);
      this._swingPrepared = false;
      this._swingStarted = false;
      if (!this._willMiss) {
        // Prepare the contact geometry as soon as the ball is acquired. The
        // old path waited until the last 60–100 ms, then moved from the
        // resting pose to a pre-swing pose in one frame. Paddle velocity saw
        // that jump instead of a stroke, so the physics quite correctly
        // rejected the contact as a bat moving away from the ball.
        this._planSwing(ball);
        this._swingPrepared = true;
      }
      return;
    }
  }

  // On the fly difficulty, the connectome readout decides where the paddle
  // stands. Only x and y are its to give — the hitting plane, the arrival
  // time and the stroke all stay on our physics, so the fly can be exactly
  // as odd as a fly without ever swinging at empty air.
  _applyBrain(ball) {
    // Only the real connectome model gets to steer. The class's built-in
    // analytic fallback extrapolates a straight line to the plane — no
    // bounce, no drag, no Magnus — which on our physics put the paddle a
    // third of a metre wide and pinned to its floor clamp. Absent the model,
    // our own predictor (already copied into _intercept) is the fallback.
    if (!this.skill.useBrain || !this.brain?.ready) return;
    const p = ball.mesh.position;
    const v = ball.velocity;
    const out = this.brain.step({ x: p.x, y: p.y, z: p.z, vx: v.x, vy: v.y, vz: v.z });
    if (!Number.isFinite(out?.targetX) || !Number.isFinite(out?.targetY)) return;
    // The readout was trained on a different court, so it proposes and our
    // physics disposes: the fly's character shows in how the paddle drifts
    // inside this window, and the window keeps it from swinging at air.
    this._intercept.x = THREE.MathUtils.clamp(
      out.targetX,
      this._intercept.x - 0.3,
      this._intercept.x + 0.3
    );
    this._intercept.y = THREE.MathUtils.clamp(
      out.targetY,
      this._intercept.y - 0.25,
      this._intercept.y + 0.25
    );
  }

  // Roll the ball forward through the same forces the simulation applies,
  // including the bounce, and report where it crosses the hitting plane.
  _predict(ball) {
    _p.copy(ball.mesh.position);
    _v.copy(ball.velocity);
    _spin.copy(ball.spin);

    const h = 1 / 240;
    for (let i = 0; i < 240 * 3; i++) {
      // A refreshed prediction can start after the nominal hitting plane when
      // a frame was dropped. Report the current pose immediately instead of
      // integrating three seconds into a stale trajectory.
      if (_p.z <= HIT_PLANE_Z) {
        if (_p.y < HIT_HEIGHT_MIN || _p.y < BALL.RADIUS) return null;
        return { point: _p.clone(), time: 0, velocity: _v.clone(), spin: _spin.clone() };
      }
      const speed = _v.length();
      _acc.set(0, PHYSICS.GRAVITY, 0);
      if (speed > 1e-4) {
        _acc.addScaledVector(_v, -PHYSICS.DRAG * speed);
        _cross.copy(_spin).cross(_v).multiplyScalar(PHYSICS.MAGNUS);
        _acc.add(_cross);
      }
      _v.addScaledVector(_acc, h);
      _p.addScaledVector(_v, h);
      _spin.multiplyScalar(Math.pow(BALL.SPIN_DECAY, h));

      // Bounce off the far half, roughly — enough for an intercept estimate
      const surface = TABLE.HEIGHT + BALL.RADIUS;
      if (
        _p.y < surface &&
        _v.y < 0 &&
        Math.abs(_p.x) <= TABLE.WIDTH / 2 &&
        Math.abs(_p.z) <= TABLE.LENGTH / 2
      ) {
        _p.y = surface;
        _v.y = -_v.y * BALL.RESTITUTION_TABLE;
      }

      if (_p.y < BALL.RADIUS) return null; // hits the floor before we reach it

      if (_p.z <= HIT_PLANE_Z) {
        if (_p.y < HIT_HEIGHT_MIN) return null; // too low to dig out
        // The velocity *at contact* matters as much as the position: the
        // stroke is built from the incoming direction, and by the time the
        // bat arrives that is not the direction the ball had when the shot
        // was planned.
        return { point: _p.clone(), time: i * h, velocity: _v.clone(), spin: _spin.clone() };
      }
    }
    return null;
  }

  // Where the bat needs to be, and when. The prediction is refreshed as the
  // ball flies rather than taken once on acquisition: the estimate made
  // before the bounce carries real error, and acting on a stale one is why
  // the bat used to arrive in roughly the right area and swing through
  // empty air.
  _chase(dt) {
    const ball = this.targetBall;
    this._timeToHit = Math.max(this._timeToHit - dt, 0);

    this._repredictIn -= dt;
    if (this._repredictIn <= 0) {
      this._repredictIn = REPREDICT_INTERVAL;
      const plan = this._predict(ball);
      if (plan) {
        this._intercept.copy(plan.point);
        this._interceptVel.copy(plan.velocity);
        this._interceptSpin.copy(plan.spin);
        // `_predict()` reports time from the current ball pose. Keeping the
        // raw value here reset the countdown on every refresh, so a ball that
        // took half a second to arrive could remain "half a second away"
        // forever and never enter the swing window. Arrival is monotonic for
        // one target ball; prediction may shorten it, never extend it.
        this._timeToHit = Math.min(this._timeToHit, Math.max(0, plan.time));
        this._applyBrain(ball);
        // Re-plan only before the stroke starts. Once the blade is moving,
        // changing its face every prediction tick makes a valid contact turn
        // into a glancing one.
        if (!this._swingStarted && !this._willMiss) {
          this._planSwing(ball);
          this._swingPrepared = true;
        }
      } else {
        this._applyBrain(ball);
      }
    }

    // Aim short of the real intercept when this ball is meant to get away
    const goal = _p.copy(this._intercept);
    if (this._willMiss) goal.x += Math.sign(goal.x || 1) * 0.45;

    // Out of reach counts as a miss too
    if (Math.abs(goal.x) > this.skill.reach) {
      this.paddle.enabled = false;
      this._driftTo(READY, dt);
      return;
    }

    if (this._willMiss) {
      this.paddle.enabled = false;
      this._driftTo(goal, dt);
      return;
    }

    // Start the stroke on time remaining, not on distance. Reaction time
    // delays easier bots without changing the legal-return solver: they stage
    // later and have a shorter live window, but the geometry is still valid.
    const swingLead = Math.max(0.055, SWING_LEAD - this.skill.reaction);
    if (this._timeToHit > swingLead) {
      this.paddle.enabled = false;
      // Stage behind the contact point. This makes the first live frame a
      // continuation of the approach instead of a teleport backwards from
      // the intercept to a wind-up pose.
      const stage = _p.copy(this._intercept)
        .addScaledVector(this._swingDir, -this._swingSpeed * Math.min(SWING_STAGE_LEAD, swingLead));
      this._driftTo(stage, dt);
      return;
    }

    if (this.state !== 'swinging') {
      this.state = 'swinging';
      this._swingElapsed = 0;
      if (!this._swingPrepared) {
        this._planSwing(ball);
        this._swingPrepared = true;
      }
      this._swingStarted = true;
    }
    this._swingElapsed += dt;

    // A swing is a stroke, not a launch: follow through for a fixed window,
    // then give up on the ball and walk back. Without the bound, a missed
    // swing integrated forever and sailed the bat over the player's head.
    if (this._swingElapsed > swingLead + Math.max(SWING_FOLLOW_THROUGH, SWING_CONTACT_WINDOW)) {
      this.paddle.enabled = false;
      this.targetBall = null;
      this.state = 'recover';
      this._recover = 0.25;
      return;
    }

    // Drive the bat *to the contact point at the contact time*, rather than
    // integrating from wherever it happened to be standing. Positioning it
    // as an offset back along the swing means it arrives exactly where the
    // ball will be, exactly when the ball is there, already moving at the
    // planned speed — and Paddle still derives that speed from the motion,
    // so the physics sees a real swing.
    this.paddle.enabled = true;
    _swingPos
      .copy(this._intercept)
      .addScaledVector(this._swingDir, -this._swingSpeed * this._timeToHit);
    this._place(_swingPos, this._swingNormal);
  }

  // Move toward a point at a limited speed, so the bat travels rather than
  // teleporting — a teleporting paddle reports absurd velocities and would
  // launch the ball into orbit.
  _driftTo(goal, dt) {
    const current = this._blade.getWorldPosition(_v);
    _swing.copy(goal).sub(current);
    const dist = _swing.length();
    if (dist > 1e-5) {
      const step = Math.min(dist, this.skill.maxSpeed * dt);
      _swing.multiplyScalar(step / dist);
      current.add(_swing);
    }
    this._place(current, TOWARD_PLAYER); // waiting: face square to the player
  }

  // Work out the face orientation and swing speed that send the ball to a
  // chosen spot on the player's half.
  _planSwing(ball) {
    const skill = this.skill;

    const tactic = this.brain?.chooseTactic?.({
      ball: {
        x: this._intercept.x,
        y: this._intercept.y,
        z: this._intercept.z,
        vx: this._interceptVel.x,
        vy: this._interceptVel.y,
        vz: this._interceptVel.z,
      },
      confidence: this._contactConfidence ?? 0.5,
      rally: this._rallyLength ?? 0,
      risk: skill.risk,
    });
    const plan = chooseReturnPlan({
      origin: this._intercept,
      incoming: this._interceptVel,
      spin: this._interceptSpin,
      skill,
      random: this.random,
      tactic,
    });
    const target = plan.target;
    const from = this._intercept;
    const outVel = plan.velocity;
    this._returnPlan = plan;

    // Incoming direction and speed as they will be at contact, not as they
    // are now — the bat meets the ball a moment later, by which point
    // gravity and the bounce have turned it.
    const inVel = this._interceptVel.lengthSq() > 1e-6
      ? this._interceptVel
      : ball.velocity;

    // A contact only changes the ball's velocity along the face normal —
    // the tangential part is carried through. So for the ball to leave with
    // a chosen velocity, the *change* must lie along the normal:
    //
    //     v_out − v_in = k·n     ⟹     n = normalise(v_out − v_in)
    //
    // Built from the unit directions instead, as it was, that identity only
    // holds when the speed is unchanged. With restitution below one and a
    // moving bat it never is, so the ball left at the wrong angle and most
    // returns failed to cross — the geometry was subtly wrong rather than
    // the aim being off.
    _normal.copy(outVel).sub(inVel);
    if (_normal.lengthSq() < 1e-8) _normal.set(0, 0, 1);
    _normal.normalize();

    // With the normal fixed, the required bat speed follows from
    // v_out·n = −e·v_in·n + (1 + e)·v_bat·n. Restitution depends on impact
    // speed, so settle it over a few passes.
    const vinN = inVel.dot(_normal);
    const voutN = outVel.dot(_normal);
    let vpN = voutN;
    for (let i = 0; i < 5; i++) {
      const e = restitution(Math.abs(vinN - vpN));
      vpN = (voutN + e * vinN) / (1 + e);
    }
    vpN = THREE.MathUtils.clamp(vpN, -PADDLE.MAX_SWING_SPEED, PADDLE.MAX_SWING_SPEED);

    this._swingVel.copy(_normal).multiplyScalar(vpN);
    this._swingSpeed = Math.abs(vpN);
    this._swingDir.copy(_normal).multiplyScalar(Math.sign(vpN) || 1);

    this._swingNormal = _normal.clone();

  }

  // Serves to start a rally: the ball appears just in front of the bat and
  // is played from there, so the exchange begins where the opponent is
  // standing rather than shooting out of a machine parked at the corner.
  serve(ball) {
    const from = new THREE.Vector3(
      (this.random() * 2 - 1) * 0.25,
      TABLE.HEIGHT + 0.22,
      HIT_PLANE_Z + 0.06
    );

    // Stand the bat behind the ball so the serve visibly comes off the face
    _swingPos.copy(from).add(new THREE.Vector3(0, -0.02, -0.11));
    this._place(_swingPos, TOWARD_PLAYER);
    this.paddle.enabled = false; // the serve is scripted; don't also strike it
    this.state = 'recover';
    this._recover = 0.3;
    this.targetBall = null;

    const target = new THREE.Vector3(
      (this.random() * 2 - 1) * (TABLE.WIDTH / 2 - 0.2),
      TABLE.HEIGHT + BALL.RADIUS,
      TABLE.LENGTH * 0.24 + this.random() * TABLE.LENGTH * 0.18
    );
    const velocity = solveReturn(from, target, this.skill.pace * 0.85);
    const spin = new THREE.Vector3((this.random() * 2 - 1) * 90, 0, 0);

    ball.serve(from, velocity, spin);
    return true;
  }

  // Called by the game when the opponent's bat actually connects.
  onHit() {
    this.state = 'recover';
    this._recover = this.skill.recovery;
    this._rallyLength = (this._rallyLength ?? 0) + 1;
    this.paddle.enabled = false;
    this.targetBall = null;
    this._swingPrepared = false;
    this._swingStarted = false;
  }
}

function restitution(impact) {
  const t = impact / BALL.RESTITUTION_PADDLE_REF;
  return (
    BALL.RESTITUTION_PADDLE_MIN +
    (BALL.RESTITUTION_PADDLE - BALL.RESTITUTION_PADDLE_MIN) / (1 + t * t)
  );
}

// Ballistic solve with drag, mirroring the launcher's approach: guess, fly
// the shot, correct, repeat. A closed-form solve lands short because drag
// takes metres off the range at these speeds.
// `spin` is the ball's rotation at contact. A contact along the face normal
// barely touches it, so it carries into the return — and relative to the new
// direction of travel it is now backspin, which floats the ball long. Left
// out of the flight model, the solver aimed for a target the ball sailed
// straight past; that was most of the remaining overshoots.
export function solveReturn(origin, target, speed, spin) {
  const dx = target.x - origin.x;
  const dz = target.z - origin.z;
  const dy = target.y - origin.y;
  const range = Math.hypot(dx, dz);
  const ux = dx / range;
  const uz = dz / range;

  let horizontal = speed;
  let vy = (dy + 0.5 * 9.81 * (range / speed) ** 2) / (range / speed);
  const velocity = new THREE.Vector3();

  // Correct both constraints every pass. Raising the arc for net clearance
  // and then skipping the range correction — which is what `continue` did
  // here — leaves a shot that clears the net beautifully and sails half a
  // metre past the end of the table. That was most of the opponent's
  // failures: the returns looked well struck and simply landed long.
  for (let i = 0; i < 10; i++) {
    velocity.set(ux * horizontal, vy, uz * horizontal);
    const shot = flyShot(origin, velocity, target.y, spin);

    let settled = true;

    // Clear the net with real margin. The planned shot and the shot the
    // contact actually produces differ a little — the inversion ignores
    // tangential effects and where on the face the ball lands.
    if (shot.netClearance < NET_MARGIN) {
      vy += (NET_MARGIN - shot.netClearance) * 2.2 + 0.04;
      settled = false;
    }

    if (shot.landed) {
      const flown = Math.hypot(shot.x - origin.x, shot.z - origin.z);
      if (flown > 1e-3) {
        const ratio = range / flown;
        if (Math.abs(ratio - 1) > 0.02) {
          // Long shots are pulled in by taking pace off *and* flattening the
          // arc; raising speed alone just trades one error for the other.
          horizontal *= THREE.MathUtils.clamp(ratio, 0.7, 1.4);
          if (ratio < 1) vy *= THREE.MathUtils.clamp(ratio, 0.8, 1);
          settled = false;
        }
      }
    } else {
      // Never came down inside the window: too flat to reach, or too hot.
      horizontal *= 0.9;
      settled = false;
    }

    if (settled) break;
  }

  return velocity.set(ux * horizontal, vy, uz * horizontal);
}

// The flight model is shared, not copied. ballistics.js is the one copy the
// coach and the launcher already use, and keeping a second implementation here
// is how the two drift: this one only detected a net crossing in the direction
// the opponent returns, and the other only in the direction the machine
// serves. One is always wrong for somebody.
import { flyShot } from './ballistics.js';
export { flyShot };
