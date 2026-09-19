import * as THREE from 'three';
import { TABLE, PLAY_AREA } from './constants.js';

// Serves balls toward the player at an interval. This is the "trainer":
// tune interval/spread/speed to build drills later.
export class BallMachine {
  constructor(balls) {
    this.balls = balls; // pooled Ball instances
    this.interval = 2.5; // seconds between serves
    this.speed = 4.2; // m/s launch speed
    this.spread = 0.45; // max lateral offset of target point (m)
    this.enabled = false;
    this._timer = 1.0; // small delay before first serve
    this.onServe = null;

    this.mesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.25, 0.25, 0.25),
      new THREE.MeshStandardMaterial({ color: 0x44cc66 })
    );
    this.mesh.position.set(0, TABLE.HEIGHT + 0.3, PLAY_AREA.SERVER_Z);
  }

  update(dt) {
    if (!this.enabled) return;
    this._timer -= dt;
    if (this._timer <= 0) {
      this._timer = this.interval;
      this.serve();
    }
  }

  serve() {
    const ball = this.balls.find((b) => !b.active);
    if (!ball) return; // pool exhausted; oldest balls will land + deactivate

    // Aim at a random point on the player's half of the table
    const targetX = (Math.random() * 2 - 1) * this.spread;
    const targetZ = TABLE.LENGTH / 4 + Math.random() * (TABLE.LENGTH / 4);

    const origin = this.mesh.position.clone();
    const dir = new THREE.Vector3(targetX, 0, targetZ).sub(origin);
    const dist = dir.length();
    dir.normalize();

    // Give it an upward arc proportional to distance
    const velocity = dir.multiplyScalar(this.speed);
    velocity.y = 1.2 + dist * 0.25;

    ball.serve(origin, velocity);
    this.onServe?.(ball);
  }
}
