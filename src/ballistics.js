import * as THREE from 'three';
import { TABLE, NET, BALL, PHYSICS } from './constants.js';

// Flight and contact maths shared by anything that needs to answer "how do I
// hit this ball to land it there" — the launcher, the rally opponent, and
// the coach, which has to derive the stroke it teaches rather than having it
// hand-authored.
//
// Keeping one copy matters because these have to agree with PhysicsWorld. A
// second implementation that drifts produces shots that look solved and
// land somewhere else.

const _p = new THREE.Vector3();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _a = new THREE.Vector3();
const _cross = new THREE.Vector3();

// Restitution of the ball against the rubber, which falls as the impact
// hardens. Mirrors the curve PhysicsWorld applies.
export function paddleRestitution(impact) {
  const t = impact / BALL.RESTITUTION_PADDLE_REF;
  return (
    BALL.RESTITUTION_PADDLE_MIN +
    (BALL.RESTITUTION_PADDLE - BALL.RESTITUTION_PADDLE_MIN) / (1 + t * t)
  );
}

// Flies a ball and reports where it lands and how close it came to the tape.
// Includes drag and Magnus: without them the answer is wrong by enough to
// put a shot into the net or off the end.
export function flyShot(origin, velocity, targetY, spin) {
  _p.copy(origin);
  _v.copy(velocity);
  _s.set(0, 0, 0);
  if (spin) _s.copy(spin);

  const h = 1 / 240;
  let netClearance = Infinity;

  for (let i = 0; i < 240 * 3; i++) {
    const prevZ = _p.z;
    const prevY = _p.y;

    const speed = _v.length();
    _a.set(0, PHYSICS.GRAVITY, 0);
    if (speed > 1e-4) {
      _a.addScaledVector(_v, -PHYSICS.DRAG * speed);
      if (_s.lengthSq() > 1e-6) {
        _cross.copy(_s).cross(_v).multiplyScalar(PHYSICS.MAGNUS);
        _a.add(_cross);
      }
    }
    _v.addScaledVector(_a, h);
    _p.addScaledVector(_v, h);
    _s.multiplyScalar(Math.pow(BALL.SPIN_DECAY, h));

    if (prevZ < 0 !== _p.z < 0) {
      const t = Math.abs(prevZ) / Math.max(Math.abs(prevZ - _p.z), 1e-6);
      netClearance = prevY + (_p.y - prevY) * t - (TABLE.HEIGHT + NET.HEIGHT);
    }
    if (_v.y < 0 && _p.y <= targetY) {
      return { landed: true, x: _p.x, z: _p.z, netClearance, time: i * h };
    }
  }
  return { landed: false, x: _p.x, z: _p.z, netClearance, time: Infinity };
}

// The launch from `origin` that lands on `target`, found by flying trial
// shots and correcting. A closed-form solve lands short because drag takes
// metres off the range at these speeds.
//
// Both constraints are corrected on every pass. Fixing the arc for net
// clearance and skipping the range correction that pass — the obvious way
// to write this — produces shots that clear the net beautifully and sail
// past the end of the table.
export function solveLaunchTo(origin, target, speed, spin, netMargin = 0.12) {
  const dx = target.x - origin.x;
  const dz = target.z - origin.z;
  const dy = target.y - origin.y;
  const range = Math.hypot(dx, dz);
  if (range < 1e-4) return new THREE.Vector3();

  const ux = dx / range;
  const uz = dz / range;

  let horizontal = speed;
  let vy = (dy + 0.5 * 9.81 * (range / speed) ** 2) / (range / speed);
  const velocity = new THREE.Vector3();

  for (let i = 0; i < 10; i++) {
    velocity.set(ux * horizontal, vy, uz * horizontal);
    const shot = flyShot(origin, velocity, target.y, spin);
    let settled = true;

    if (shot.netClearance < netMargin) {
      vy += (netMargin - shot.netClearance) * 2.2 + 0.04;
      settled = false;
    }

    if (shot.landed) {
      const flown = Math.hypot(shot.x - origin.x, shot.z - origin.z);
      if (flown > 1e-3) {
        const ratio = range / flown;
        if (Math.abs(ratio - 1) > 0.02) {
          horizontal *= THREE.MathUtils.clamp(ratio, 0.7, 1.4);
          if (ratio < 1) vy *= THREE.MathUtils.clamp(ratio, 0.8, 1);
          settled = false;
        }
      }
    } else {
      horizontal *= 0.9;
      settled = false;
    }

    if (settled) break;
  }

  return velocity.set(ux * horizontal, vy, uz * horizontal);
}

// The bat pose and speed that turn `inVel` into `outVel`.
//
// A contact only changes the ball's velocity along the face normal — the
// tangential part carries through — so for the ball to leave with a chosen
// velocity, the *change* must lie along the normal:
//
//     v_out − v_in = k·n   ⟹   n = normalise(v_out − v_in)
//
// Built from the unit directions instead, that identity only holds when the
// speed is unchanged, which with restitution below one it never is.
export function solveContact(inVel, outVel) {
  const normal = outVel.clone().sub(inVel);
  if (normal.lengthSq() < 1e-8) normal.set(0, 0, 1);
  normal.normalize();

  const vinN = inVel.dot(normal);
  const voutN = outVel.dot(normal);

  // Restitution depends on impact speed, so settle it over a few passes.
  let speed = voutN;
  for (let i = 0; i < 5; i++) {
    const e = paddleRestitution(Math.abs(vinN - speed));
    speed = (voutN + e * vinN) / (1 + e);
  }
  return { normal, speed };
}

// Rolls a ball forward until it reaches a plane, reporting its state there.
// Used to find where a fed ball will be when the stroke should meet it.
export function advanceToPlane(position, velocity, spin, planeZ, minY = 0.3) {
  _p.copy(position);
  _v.copy(velocity);
  _s.copy(spin ?? _cross.set(0, 0, 0));

  const h = 1 / 240;
  const towardPlane = Math.sign(planeZ - position.z) || 1;

  for (let i = 0; i < 240 * 4; i++) {
    const speed = _v.length();
    _a.set(0, PHYSICS.GRAVITY, 0);
    if (speed > 1e-4) {
      _a.addScaledVector(_v, -PHYSICS.DRAG * speed);
      if (_s.lengthSq() > 1e-6) {
        _cross.copy(_s).cross(_v).multiplyScalar(PHYSICS.MAGNUS);
        _a.add(_cross);
      }
    }
    _v.addScaledVector(_a, h);
    _p.addScaledVector(_v, h);
    _s.multiplyScalar(Math.pow(BALL.SPIN_DECAY, h));

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

    if (_p.y < BALL.RADIUS) return null; // on the floor before it got there
    if ((_p.z - planeZ) * towardPlane >= 0) {
      if (_p.y < minY) return null;
      return {
        position: _p.clone(),
        velocity: _v.clone(),
        spin: _s.clone(),
        time: i * h,
      };
    }
  }
  return null;
}
