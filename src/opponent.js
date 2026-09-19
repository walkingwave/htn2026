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
const SWING_LEAD = 0.14; // seconds

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
  easy: { reach: 1.1, maxSpeed: 2.1, error: 0.20, missChance: 0.34, pace: 3.8 },
  normal: { reach: 1.7, maxSpeed: 3.2, error: 0.10, missChance: 0.07, pace: 4.4 },
  hard: { reach: 2.1, maxSpeed: 4.0, error: 0.05, missChance: 0.02, pace: 4.9 },
};

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
  constructor(skill = 'normal') {
    this.paddle = new Paddle();
    this.paddle.isOpponent = true;
    this.paddle.enabled = false; // only live while actually playing a ball
    this.mesh = this.paddle.mesh;
    this.skill = OPPONENT_SKILL[skill] ?? OPPONENT_SKILL.normal;

    this.active = false;
    this.state = 'idle'; // idle | tracking | swinging | recover
    this.targetBall = null;

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
    if (!active) this._place(READY, TOWARD_PLAYER);
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
      this._intercept.copy(plan.point);
      this._interceptVel.copy(plan.velocity);
      this._interceptSpin.copy(plan.spin);
      this._timeToHit = plan.time;
      this._repredictIn = REPREDICT_INTERVAL;
      // Decide up front whether this one gets away, so the paddle can move
      // convincingly short rather than snapping at the last instant.
      this._willMiss = Math.random() < this.skill.missChance;
      return;
    }
  }

  // Roll the ball forward through the same forces the simulation applies,
  // including the bounce, and report where it crosses the hitting plane.
  _predict(ball) {
    _p.copy(ball.mesh.position);
    _v.copy(ball.velocity);
    _spin.copy(ball.spin);

    const h = 1 / 240;
    for (let i = 0; i < 240 * 3; i++) {
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
        this._timeToHit = plan.time;
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

    // Start the stroke on time remaining, not on distance. A fast ball
    // covers the old fixed distance threshold in a fraction of the time a
    // slow one does, so the bat was starting far too late for hard shots.
    if (this._timeToHit > SWING_LEAD) {
      this.paddle.enabled = false;
      this._driftTo(goal, dt);
      return;
    }

    if (this.state !== 'swinging') {
      this.state = 'swinging';
      this._swingElapsed = 0;
      this._planSwing(ball);
    }
    this._swingElapsed += dt;

    // A swing is a stroke, not a launch: follow through for a fixed window,
    // then give up on the ball and walk back. Without the bound, a missed
    // swing integrated forever and sailed the bat over the player's head.
    if (this._swingElapsed > SWING_LEAD + SWING_FOLLOW_THROUGH) {
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

    const target = new THREE.Vector3(
      (Math.random() * 2 - 1) * (TABLE.WIDTH / 2 - 0.12) +
        (Math.random() * 2 - 1) * skill.error,
      TABLE.HEIGHT + BALL.RADIUS,
      TABLE.LENGTH * 0.2 + Math.random() * TABLE.LENGTH * 0.18
    );

    const from = this._intercept;
    const outVel = solveReturn(from, target, skill.pace, this._interceptSpin);

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

    this._recover = 0.35;
  }

  // Serves to start a rally: the ball appears just in front of the bat and
  // is played from there, so the exchange begins where the opponent is
  // standing rather than shooting out of a machine parked at the corner.
  serve(ball) {
    const from = new THREE.Vector3(
      (Math.random() * 2 - 1) * 0.25,
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
      (Math.random() * 2 - 1) * (TABLE.WIDTH / 2 - 0.2),
      TABLE.HEIGHT + BALL.RADIUS,
      TABLE.LENGTH * 0.24 + Math.random() * TABLE.LENGTH * 0.18
    );
    const velocity = solveReturn(from, target, this.skill.pace * 0.85);
    const spin = new THREE.Vector3((Math.random() * 2 - 1) * 90, 0, 0);

    ball.serve(from, velocity, spin);
    return true;
  }

  // Called by the game when the opponent's bat actually connects.
  onHit() {
    this.state = 'recover';
    this._recover = 0.4;
    this.paddle.enabled = false;
    this.targetBall = null;
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
function solveReturn(origin, target, speed, spin) {
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

const _fp = new THREE.Vector3();
const _fv = new THREE.Vector3();
const _fa = new THREE.Vector3();
const _fs = new THREE.Vector3();
const _fcross = new THREE.Vector3();

function flyShot(origin, velocity, targetY, spin) {
  _fp.copy(origin);
  _fv.copy(velocity);
  _fs.set(0, 0, 0);
  if (spin) _fs.copy(spin);
  const h = 1 / 240;
  let netClearance = Infinity;

  for (let i = 0; i < 240 * 3; i++) {
    const prevZ = _fp.z;
    const prevY = _fp.y;
    const speed = _fv.length();
    _fa.set(0, PHYSICS.GRAVITY, 0);
    if (speed > 1e-4) {
      _fa.addScaledVector(_fv, -PHYSICS.DRAG * speed);
      if (_fs.lengthSq() > 1e-6) {
        _fcross.copy(_fs).cross(_fv).multiplyScalar(PHYSICS.MAGNUS);
        _fa.add(_fcross);
      }
    }
    _fv.addScaledVector(_fa, h);
    _fp.addScaledVector(_fv, h);
    _fs.multiplyScalar(Math.pow(BALL.SPIN_DECAY, h));

    if (prevZ < 0 && _fp.z >= 0) {
      const t = Math.abs(prevZ) / Math.max(Math.abs(prevZ - _fp.z), 1e-6);
      netClearance = prevY + (_fp.y - prevY) * t - (TABLE.HEIGHT + NET.HEIGHT);
    }
    if (_fv.y < 0 && _fp.y <= targetY) {
      return { landed: true, x: _fp.x, z: _fp.z, netClearance };
    }
  }
  return { landed: false, x: _fp.x, z: _fp.z, netClearance };
}
