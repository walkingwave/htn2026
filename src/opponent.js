import * as THREE from 'three';
import { Paddle } from './paddle.js';
import { TABLE, BALL, PHYSICS, PADDLE } from './constants.js';

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
const READY = new THREE.Vector3(0, TABLE.HEIGHT + 0.2, HIT_PLANE_Z);

export const OPPONENT_SKILL = {
  easy: { reach: 1.1, maxSpeed: 1.9, error: 0.20, missChance: 0.22, pace: 4.0 },
  normal: { reach: 1.5, maxSpeed: 2.8, error: 0.11, missChance: 0.10, pace: 4.6 },
  hard: { reach: 2.0, maxSpeed: 3.8, error: 0.05, missChance: 0.03, pace: 5.3 },
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
      this._timeToHit = plan.time;
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
        return { point: _p.clone(), time: i * h };
      }
    }
    return null;
  }

  _chase(dt) {
    const ball = this.targetBall;
    const timeLeft = Math.max(this._timeToHit - dt, 0);
    this._timeToHit = timeLeft;

    // Aim short of the real intercept when this ball is meant to get away
    const goal = _p.copy(this._intercept);
    if (this._willMiss) goal.x += Math.sign(goal.x || 1) * 0.45;

    // Out of reach counts as a miss too
    if (Math.abs(goal.x) > this.skill.reach) {
      this.paddle.enabled = false;
      this._driftTo(READY, dt);
      return;
    }

    const closing = ball.mesh.position.z - HIT_PLANE_Z;
    const nearContact = closing < 0.45 && ball.velocity.z < 0;

    if (nearContact && !this._willMiss) {
      if (this.state !== 'swinging') {
        this.state = 'swinging';
        this._planSwing(ball);
      }
      // Drive the blade through the contact point along the swing
      this.paddle.enabled = true;
      const pos = this._blade.getWorldPosition(new THREE.Vector3());
      pos.addScaledVector(this._swingVel, dt);
      this._place(pos, this._swingNormal);
    } else {
      this.paddle.enabled = false;
      this._driftTo(goal, dt);
    }
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
      TABLE.LENGTH * 0.26 + Math.random() * TABLE.LENGTH * 0.2
    );

    const from = this._intercept;
    const outVel = solveReturn(from, target, skill.pace);

    _inDir.copy(ball.velocity).normalize();
    _outDir.copy(outVel).normalize();

    // Mirror construction: the face normal bisects incoming and outgoing.
    _normal.copy(_outDir).sub(_inDir);
    if (_normal.lengthSq() < 1e-8) _normal.set(0, 0, 1);
    _normal.normalize();

    // Invert the contact for the speed along that normal. Restitution
    // depends on impact speed, so settle it over a few passes.
    const vinN = ball.velocity.dot(_normal);
    const voutN = outVel.dot(_normal);
    let vpN = 0;
    for (let i = 0; i < 4; i++) {
      const impact = Math.abs(vinN - vpN);
      const e = restitution(impact);
      vpN = (voutN + e * vinN) / (1 + e);
    }
    vpN = THREE.MathUtils.clamp(vpN, -PADDLE.MAX_SWING_SPEED, PADDLE.MAX_SWING_SPEED);

    this._swingVel.copy(_normal).multiplyScalar(vpN);

    this._swingNormal = _normal.clone();

    this._recover = 0.35;
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
function solveReturn(origin, target, speed) {
  const dx = target.x - origin.x;
  const dz = target.z - origin.z;
  const dy = target.y - origin.y;
  const range = Math.hypot(dx, dz);
  const ux = dx / range;
  const uz = dz / range;

  let horizontal = speed;
  let vy = (dy + 0.5 * 9.81 * (range / speed) ** 2) / (range / speed);
  const velocity = new THREE.Vector3();

  for (let i = 0; i < 6; i++) {
    velocity.set(ux * horizontal, vy, uz * horizontal);
    const shot = flyShot(origin, velocity, target.y);

    // Clear the net with real margin. The planned shot and the shot the
    // contact actually produces differ a little — the inversion ignores
    // tangential effects and where on the face the ball lands — and at a
    // 6 cm margin that slop put roughly a quarter of returns into the net.
    if (shot.netClearance < NET_MARGIN) {
      vy += (NET_MARGIN - shot.netClearance) * 2.2 + 0.05;
      continue;
    }
    if (!shot.landed) break;

    const flown = Math.hypot(shot.x - origin.x, shot.z - origin.z);
    if (flown < 1e-3) break;
    const ratio = range / flown;
    if (Math.abs(ratio - 1) < 0.02) break;
    horizontal *= THREE.MathUtils.clamp(ratio, 0.75, 1.35);
  }

  return velocity.set(ux * horizontal, vy, uz * horizontal);
}

const _fp = new THREE.Vector3();
const _fv = new THREE.Vector3();
const _fa = new THREE.Vector3();

function flyShot(origin, velocity, targetY) {
  _fp.copy(origin);
  _fv.copy(velocity);
  const h = 1 / 240;
  let netClearance = Infinity;

  for (let i = 0; i < 240 * 3; i++) {
    const prevZ = _fp.z;
    const prevY = _fp.y;
    const speed = _fv.length();
    _fa.set(0, PHYSICS.GRAVITY, 0);
    if (speed > 1e-4) _fa.addScaledVector(_fv, -PHYSICS.DRAG * speed);
    _fv.addScaledVector(_fa, h);
    _fp.addScaledVector(_fv, h);

    if (prevZ < 0 && _fp.z >= 0) {
      const t = Math.abs(prevZ) / Math.max(Math.abs(prevZ - _fp.z), 1e-6);
      netClearance = prevY + (_fp.y - prevY) * t - (TABLE.HEIGHT + 0.1525);
    }
    if (_fv.y < 0 && _fp.y <= targetY) {
      return { landed: true, x: _fp.x, z: _fp.z, netClearance };
    }
  }
  return { landed: false, x: _fp.x, z: _fp.z, netClearance };
}
