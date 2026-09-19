import * as THREE from 'three';

// Where the paddle's pose comes from.
//
// The physics never asks. `Paddle` derives everything it needs — blade
// centre, face normal, linear and angular velocity — from its own world
// transform, so any input that can place a group in the world can drive the
// bat. That makes the input a swappable choice rather than something wired
// through the simulation:
//
//   controller  the tracked grip (default, most accurate)
//   hand        hand tracking, so you can hold your own real paddle
//   external    a pose fed in from elsewhere, e.g. a camera-based tracker
//               running on another machine
//
// `external` exists so the laptop-side vision work can drive this build
// without either side having to know about the other: call
// `setExternalPose(position, quaternion)` at whatever rate poses arrive and
// the rest of the game behaves identically.

export const PADDLE_SOURCE = {
  CONTROLLER: 'controller',
  HAND: 'hand',
  EXTERNAL: 'external',
};

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();

export class PaddleSourceRouter {
  constructor({ paddle, controllerGrip, handRig, externalRoot }) {
    this.paddle = paddle;
    this.controllerGrip = controllerGrip;
    this.handRig = handRig;
    this.externalRoot = externalRoot;

    this.mode = PADDLE_SOURCE.CONTROLLER;
    this.activeSource = null; // what is actually driving it right now
    this._externalFresh = 0; // seconds since the last external pose

    this.attach(this.controllerGrip);
  }

  attach(parent) {
    if (!parent || this.paddle.mesh.parent === parent) return;
    parent.add(this.paddle.mesh);
  }

  setMode(mode) {
    this.mode = mode;
  }

  // Called by whatever is receiving poses from outside this page.
  setExternalPose(position, quaternion) {
    this.externalRoot.position.copy(position);
    if (quaternion) this.externalRoot.quaternion.copy(quaternion);
    this.externalRoot.updateMatrixWorld(true);
    this._externalFresh = 0;
  }

  // Picks the parent for this frame and falls back when a source drops out.
  // Hand tracking in particular blinks out whenever the hand leaves the
  // headset's view, and silently freezing the bat mid-air is worse than
  // handing control back to the controller.
  update(dt) {
    this._externalFresh += dt;

    let source = this.mode;

    if (source === PADDLE_SOURCE.HAND) {
      const ok = this.handRig?.update() ?? false;
      if (!ok) source = PADDLE_SOURCE.CONTROLLER;
    } else if (source === PADDLE_SOURCE.EXTERNAL) {
      if (this._externalFresh > 0.4) source = PADDLE_SOURCE.CONTROLLER;
    }

    const parent =
      source === PADDLE_SOURCE.HAND
        ? this.handRig.group
        : source === PADDLE_SOURCE.EXTERNAL
          ? this.externalRoot
          : this.controllerGrip;

    this.attach(parent);
    this.activeSource = source;
    return source;
  }

  // Whether the requested source is actually working, for the UI to report.
  get healthy() {
    return this.activeSource === this.mode;
  }
}

// Convenience for external feeds that arrive as plain numbers.
export function poseFromArrays(positionArray, quaternionArray) {
  _pos.fromArray(positionArray);
  if (quaternionArray) _quat.fromArray(quaternionArray);
  else _quat.identity();
  return { position: _pos, quaternion: _quat };
}
