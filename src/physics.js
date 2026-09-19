import * as THREE from 'three';
import { TABLE, NET, BALL, PADDLE, PHYSICS } from './constants.js';

// Simple custom physics: fixed-timestep integration, table/floor/net bounce,
// paddle hit as a disc collision with momentum transfer from paddle velocity.
// Good enough for a trainer; swap for cannon-es/rapier later if needed.

const _rel = new THREE.Vector3();
const _n = new THREE.Vector3();
const _tmp = new THREE.Vector3();

export class PhysicsWorld {
  constructor() {
    this._accumulator = 0;
    // Callbacks the game layer can hook: (ball, eventName)
    this.onBounce = null; // 'table' | 'floor' | 'net' | 'paddle'
  }

  // dt = real frame time; steps physics at FIXED_DT.
  step(dt, balls, paddles) {
    this._accumulator += Math.min(dt, 0.1); // clamp to avoid spiral after tab pause
    while (this._accumulator >= PHYSICS.FIXED_DT) {
      for (const ball of balls) {
        if (ball.active) this._integrate(ball, paddles, PHYSICS.FIXED_DT);
      }
      this._accumulator -= PHYSICS.FIXED_DT;
    }
  }

  _integrate(ball, paddles, h) {
    const p = ball.mesh.position;
    const v = ball.velocity;

    // Gravity + linear air drag
    v.y += PHYSICS.GRAVITY * h;
    v.multiplyScalar(1 - PHYSICS.AIR_DRAG * h);
    p.addScaledVector(v, h);

    // Table bounce (only within table footprint)
    const onTable =
      Math.abs(p.x) <= TABLE.WIDTH / 2 && Math.abs(p.z) <= TABLE.LENGTH / 2;
    const surfaceY = TABLE.HEIGHT + BALL.RADIUS;
    if (onTable && p.y < surfaceY && v.y < 0) {
      p.y = surfaceY;
      v.y = -v.y * BALL.RESTITUTION_TABLE;
      this.onBounce?.(ball, 'table');
    }

    // Net collision (thin plane at z=0 above the table)
    const netHalfWidth = TABLE.WIDTH / 2 + NET.OVERHANG;
    if (
      Math.abs(p.x) <= netHalfWidth &&
      p.y >= TABLE.HEIGHT &&
      p.y <= TABLE.HEIGHT + NET.HEIGHT + BALL.RADIUS &&
      Math.abs(p.z) <= BALL.RADIUS
    ) {
      // Kill most forward momentum, drop the ball
      v.z *= -0.15;
      v.x *= 0.5;
      p.z = Math.sign(v.z || 1) * BALL.RADIUS * 1.01;
      this.onBounce?.(ball, 'net');
    }

    // Floor bounce
    if (p.y < BALL.RADIUS && v.y < 0) {
      p.y = BALL.RADIUS;
      v.y = -v.y * 0.5;
      v.x *= 0.7;
      v.z *= 0.7;
      this.onBounce?.(ball, 'floor');
    }

    // Paddle collisions
    for (const paddle of paddles) {
      this._collidePaddle(ball, paddle);
    }
  }

  _collidePaddle(ball, paddle) {
    _rel.copy(ball.mesh.position).sub(paddle.bladeCenter);
    _n.copy(paddle.bladeNormal);

    const distAlongNormal = _rel.dot(_n);
    // Distance from blade axis (in-plane)
    _tmp.copy(_rel).addScaledVector(_n, -distAlongNormal);
    const radialDist = _tmp.length();

    const halfThick = PADDLE.HEAD_THICKNESS / 2 + BALL.RADIUS;
    if (radialDist > PADDLE.HEAD_RADIUS || Math.abs(distAlongNormal) > halfThick) {
      return;
    }

    // Relative velocity along blade normal; only hit if approaching
    _tmp.copy(ball.velocity).sub(paddle.velocity);
    const approach = _tmp.dot(_n) * Math.sign(distAlongNormal || 1);
    if (approach >= 0) return;

    // Face the normal toward the ball side
    if (distAlongNormal < 0) _n.negate();

    // Reflect relative velocity, add paddle velocity back (momentum transfer)
    const vn = _tmp.dot(_n);
    _tmp.addScaledVector(_n, -(1 + BALL.RESTITUTION_PADDLE) * vn);
    ball.velocity.copy(_tmp).add(paddle.velocity);

    // Push ball out of the blade to prevent re-collision next step
    ball.mesh.position
      .copy(paddle.bladeCenter)
      .addScaledVector(_n, halfThick * 1.05)
      .add(_tmp.copy(_rel).addScaledVector(paddle.bladeNormal, -distAlongNormal));

    this.onBounce?.(ball, 'paddle');
  }
}
