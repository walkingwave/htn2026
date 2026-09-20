import * as THREE from 'three';
import { BALL } from './constants.js';
import { ballTexture } from './textures.js';

// Geometry and material are built once and shared across the whole pool.
let sharedGeometry = null;
let sharedMaterial = null;

function shared() {
  if (!sharedGeometry) {
    sharedGeometry = new THREE.SphereGeometry(BALL.RADIUS, 24, 16);
    sharedMaterial = new THREE.MeshStandardMaterial({
      map: ballTexture(),
      roughness: 0.45,
      metalness: 0.0,
    });
  }
  return { geometry: sharedGeometry, material: sharedMaterial };
}

const _axis = new THREE.Vector3();
const _spinStep = new THREE.Quaternion();

export class Ball {
  constructor() {
    const { geometry, material } = shared();
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.castShadow = true;

    this.velocity = new THREE.Vector3();
    this.spin = new THREE.Vector3(); // angular velocity, rad/s
    this.active = false; // inactive balls are hidden and skip physics
    this.mesh.visible = false;
    this.restingOn = null; // 'table' | 'floor' once the ball has settled
    this.retireIn = null; // seconds until this ball returns to the pool
    this.touchedByPaddle = false; // did the player actually hit this one?
    this.isFeed = false; // tossed up for the player rather than launched at them

    // Single-player bounce bookkeeping (see game.js / main.js). A "legal"
    // feed is one that has bounced at least once on the player's receiving
    // half (world z > 0); a ball that leaves play without ever doing so is a
    // dead feed (the machine's fault) and must not score as a miss. The
    // per-paddle counter drives the double-bounce rule.
    this.everBouncedPlayerHalf = false; // any table bounce on the player's half
    this.playerHalfBouncesSincePaddle = 0; // resets on every paddle contact

    // Scoring bookkeeping, owned here so that serving a ball is the single
    // point where a ball's life resets. Hanging these off the retire path
    // instead would mean any other route back into the pool leaves a ball
    // permanently unable to score.
    this.scoredTarget = false;
    this.countedHit = false;
    this.countedReturn = false;
    this.countedMiss = false;
    // Versus serves wait as a vertical bounce until the server strikes them.
    // Reset alongside every other per-rally flag so a pooled ball cannot carry
    // a previous server's state into a drill or the next point.
    this.isServeHold = false;
    this.serveOwner = null;
    this.serveBounceSpeed = null;
  }

  serve(position, velocity, spin) {
    this.mesh.position.copy(position);
    this.velocity.copy(velocity);
    this.spin.copy(spin ?? _axis.set(0, 0, 0));
    this.mesh.quaternion.identity();
    this.active = true;
    this.mesh.visible = true;
    this.restingOn = null;
    this.retireIn = null;
    this.touchedByPaddle = false;
    this.isFeed = false;
    this.everBouncedPlayerHalf = false;
    this.playerHalfBouncesSincePaddle = 0;
    this.scoredTarget = false;
    this.countedHit = false;
    this.countedReturn = false;
    this.countedMiss = false;
    this.isServeHold = false;
    this.serveOwner = null;
    this.serveBounceSpeed = null;
  }

  deactivate() {
    this.active = false;
    this.mesh.visible = false;
  }

  // Spins the mesh so the painted seam and logo actually rotate. Without this
  // the ball's spin state — the thing the trainer is teaching you to read —
  // would be completely invisible.
  updateVisualSpin(dt) {
    const rate = this.spin.length();
    if (rate < 1e-3) return;
    _axis.copy(this.spin).divideScalar(rate);
    _spinStep.setFromAxisAngle(_axis, rate * dt);
    this.mesh.quaternion.premultiply(_spinStep);
  }
}
