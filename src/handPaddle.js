import * as THREE from 'three';

// Attaches the virtual bat to a *tracked hand* rather than a controller, so
// you can hold your own real paddle and play with it.
//
// This is the on-device route to "play with a real paddle": the headset's
// own hand tracking finds your hand, and the virtual blade is mounted where
// the real blade is. No controller, no camera plumbing, no second machine.
// It also means the thing in your hand can be any paddle — the tracking is
// following the hand, not the object, so it never has to recognise it.
//
// Building the grip frame
// -----------------------
// Joint *orientations* in WebXR hand input follow a convention that is easy
// to get subtly wrong and that varies in practice between runtimes. Joint
// *positions* are unambiguous, so the frame is derived from three of them:
//
//   forward  wrist → middle finger metacarpal (down the length of the hand)
//   side     index metacarpal → pinky metacarpal (across the knuckles)
//   normal   forward × side (out through the palm)
//
// A real bat sits with its handle along `forward` and its face along the
// palm normal, which is exactly this frame.

const JOINTS = {
  wrist: 'wrist',
  middle: 'middle-finger-metacarpal',
  index: 'index-finger-metacarpal',
  pinky: 'pinky-finger-metacarpal',
};

const _wrist = new THREE.Vector3();
const _middle = new THREE.Vector3();
const _index = new THREE.Vector3();
const _pinky = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _side = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _basis = new THREE.Matrix4();

export class HandPaddleRig {
  // `hand` is three's XRHandSpace from renderer.xr.getHand(i).
  constructor(hand, handedness) {
    this.hand = hand;
    this.handedness = handedness;

    // The paddle mesh is parented here; the physics reads its world
    // transform exactly as it does when mounted on a controller grip, so
    // nothing downstream needs to know which input is driving it.
    this.group = new THREE.Group();
    this.tracked = false;
  }

  _joint(name) {
    return this.hand?.joints?.[name];
  }

  // True only when every joint the frame needs has a live pose this frame.
  get available() {
    const joints = this.hand?.joints;
    if (!joints) return false;
    for (const key of Object.values(JOINTS)) {
      const joint = joints[key];
      if (!joint || joint.position === undefined) return false;
      // three leaves joints at the origin before the first tracked frame
      if (joint.position.lengthSq() === 0) return false;
    }
    return true;
  }

  update() {
    if (!this.available) {
      this.tracked = false;
      return false;
    }

    this._joint(JOINTS.wrist).getWorldPosition(_wrist);
    this._joint(JOINTS.middle).getWorldPosition(_middle);
    this._joint(JOINTS.index).getWorldPosition(_index);
    this._joint(JOINTS.pinky).getWorldPosition(_pinky);

    _forward.subVectors(_middle, _wrist);
    if (_forward.lengthSq() < 1e-8) {
      this.tracked = false;
      return false;
    }
    _forward.normalize();

    _side.subVectors(_pinky, _index);
    if (_side.lengthSq() < 1e-8) {
      this.tracked = false;
      return false;
    }
    _side.normalize();

    // Palm normal, then re-square `side` against it so the basis stays
    // orthonormal even when the knuckle line isn't perpendicular.
    _normal.crossVectors(_forward, _side).normalize();
    _side.crossVectors(_normal, _forward).normalize();

    // The paddle mesh is authored for a controller grip: handle along −Z,
    // face normal along +X. Map that onto the hand frame so the blade lands
    // where the real one is — ahead of the fist, face out through the palm.
    _basis.makeBasis(_normal, _side, _forward.clone().negate());

    this.group.position.copy(_wrist);
    this.group.quaternion.setFromRotationMatrix(_basis);
    this.group.updateMatrixWorld(true);

    this.tracked = true;
    return true;
  }
}
