import * as THREE from 'three';
import { PADDLE } from './constants.js';

const _worldPos = new THREE.Vector3();
const _worldQuat = new THREE.Quaternion();
const _prevQuatInv = new THREE.Quaternion();
const _deltaQuat = new THREE.Quaternion();
const _axis = new THREE.Vector3();
const _arm = new THREE.Vector3();

// A paddle attached to a WebXR controller grip. It tracks its own linear and
// angular velocity, which the physics step needs: the blade's speed sets how
// hard the ball comes off, and the speed of the surface across the ball — a
// product of the swing's rotation — is what puts spin on it.
export class Paddle {
  constructor() {
    this.mesh = buildPaddleMesh();

    this.velocity = new THREE.Vector3(); // linear, m/s
    this.angularVelocity = new THREE.Vector3(); // rad/s
    this.bladeCenter = new THREE.Vector3();
    this.bladeNormal = new THREE.Vector3();

    // False until two frames have been sampled — velocity is meaningless
    // before that, and a bogus first value can launch a ball across the room.
    this.tracking = false;

    // Whether this hand is actually holding the bat (see handedness setting).
    this.enabled = true;

    this._blade = this.mesh.getObjectByName('blade');
    this._prevPos = new THREE.Vector3();
    this._prevQuat = new THREE.Quaternion();
    this._samples = 0;
  }

  attachTo(controllerGrip) {
    controllerGrip.add(this.mesh);
  }

  // Call once per render frame with real elapsed time.
  update(dt) {
    this._blade.getWorldPosition(_worldPos);
    this._blade.getWorldQuaternion(_worldQuat);

    this.bladeCenter.copy(_worldPos);
    this.bladeNormal.set(0, 0, 1).applyQuaternion(_worldQuat);

    if (this._samples > 0 && dt > 1e-5) {
      this.velocity.copy(_worldPos).sub(this._prevPos).divideScalar(dt);

      // Hand tracking drops and recovers, and a single missed frame reads as
      // a huge jump in position — i.e. an enormous velocity that would fire
      // the ball across the room. Clamp to something well above a real
      // stroke so only glitches are rejected.
      const speed = this.velocity.length();
      if (speed > PADDLE.MAX_SWING_SPEED) {
        this.velocity.multiplyScalar(PADDLE.MAX_SWING_SPEED / speed);
      }

      // Angular velocity from the rotation between frames
      _prevQuatInv.copy(this._prevQuat).invert();
      _deltaQuat.copy(_worldQuat).multiply(_prevQuatInv).normalize();
      let angle = 2 * Math.acos(THREE.MathUtils.clamp(_deltaQuat.w, -1, 1));
      const s = Math.sqrt(Math.max(1 - _deltaQuat.w * _deltaQuat.w, 0));
      if (s < 1e-5) {
        this.angularVelocity.set(0, 0, 0);
      } else {
        if (angle > Math.PI) angle -= 2 * Math.PI; // shortest arc
        _axis.set(_deltaQuat.x / s, _deltaQuat.y / s, _deltaQuat.z / s);
        this.angularVelocity.copy(_axis).multiplyScalar(angle / dt);

        const rate = this.angularVelocity.length();
        if (rate > PADDLE.MAX_SWING_SPIN) {
          this.angularVelocity.multiplyScalar(PADDLE.MAX_SWING_SPIN / rate);
        }
      }

      this.tracking = true;
    }

    this._prevPos.copy(_worldPos);
    this._prevQuat.copy(_worldQuat);
    this._samples++;
  }

  // Velocity of the blade surface at a world-space point.
  velocityAt(point, out) {
    _arm.copy(point).sub(this.bladeCenter);
    out.copy(this.angularVelocity).cross(_arm).add(this.velocity);
    return out;
  }
}

// A real bat is one flat piece of wood whose outline runs continuously from
// the blade into the handle, with rubber sheets laid on each face. Building
// it from stacked cylinders and a torus never reads right, so the silhouette
// is drawn as a 2D profile and extruded — the blade thin, the handle thicker
// and flared, cut from the same outline.
function buildPaddleMesh() {
  const group = new THREE.Group();

  const wood = new THREE.MeshStandardMaterial({ color: 0xc49a62, roughness: 0.6 });
  const grip = new THREE.MeshStandardMaterial({ color: 0x6f2320, roughness: 0.85 });
  const rubberRed = new THREE.MeshStandardMaterial({
    color: 0xc0281f,
    roughness: 0.95,
    metalness: 0,
  });
  const rubberBlack = new THREE.MeshStandardMaterial({
    color: 0x111113,
    roughness: 0.95,
    metalness: 0,
  });

  const R = PADDLE.HEAD_RADIUS;
  const bladeThickness = 0.007; // the wood itself; rubber sits on top
  const neckHalf = 0.015;
  const shoulderY = -Math.sqrt(Math.max(R * R - neckHalf * neckHalf, 0));

  // --- Blade: a slightly egg-shaped disc running down into a short neck ---
  const bladeShape = new THREE.Shape();
  const a0 = Math.atan2(shoulderY, neckHalf);
  bladeShape.moveTo(neckHalf, shoulderY);
  bladeShape.absarc(0, 0, R, a0, Math.PI * 2 + Math.atan2(shoulderY, -neckHalf), false);
  bladeShape.lineTo(-neckHalf, shoulderY - 0.022);
  bladeShape.lineTo(neckHalf, shoulderY - 0.022);
  bladeShape.closePath();

  const bladeGeo = new THREE.ExtrudeGeometry(bladeShape, {
    depth: bladeThickness,
    bevelEnabled: true,
    bevelThickness: 0.0016,
    bevelSize: 0.0016,
    bevelSegments: 2,
    curveSegments: 48,
  });
  bladeGeo.translate(0, 0, -bladeThickness / 2);
  // Slightly elongated along the handle axis, as real blades are
  bladeGeo.scale(1, 1.06, 1);
  // The profile is drawn with the handle running down −Y; rotate so it runs
  // down −X instead, which maps to "back toward the hand" once the blade is
  // turned to face sideways. Rotating about Z leaves the face normal (+Z)
  // untouched, so the physics normal is unaffected.
  bladeGeo.rotateZ(-Math.PI / 2);

  const blade = new THREE.Group();
  blade.name = 'blade';

  const core = new THREE.Mesh(bladeGeo, wood);
  core.castShadow = true;
  blade.add(core);

  // --- Rubber sheets, covering the face nearly to the edge ---
  const rubberShape = new THREE.Shape();
  const rr = R - 0.0035;
  rubberShape.absarc(0, 0, rr, 0, Math.PI * 2, false);
  const rubberGeo = new THREE.ExtrudeGeometry(rubberShape, {
    depth: 0.0017,
    bevelEnabled: true,
    bevelThickness: 0.0006,
    bevelSize: 0.0009,
    bevelSegments: 1,
    curveSegments: 48,
  });
  rubberGeo.scale(1, 1.06, 1);
  rubberGeo.rotateZ(-Math.PI / 2);

  for (const [mat, sign] of [
    [rubberRed, 1],
    [rubberBlack, -1],
  ]) {
    const face = new THREE.Mesh(rubberGeo, mat);
    face.position.z = sign * (bladeThickness / 2);
    if (sign < 0) face.rotation.y = Math.PI; // extrusion grows along +Z
    blade.add(face);
  }

  // --- Handle: same silhouette language, thicker and flared ---------------
  const L = PADDLE.HANDLE_LENGTH;
  const wTop = 0.0165; // half width at the shoulder, where it leaves the neck
  const wWaist = 0.0122; // pinched where the fingers sit
  const wEnd = 0.0235; // flared so the hand can't slide off the end

  const handleDepth = 0.0145;
  const handleShape = new THREE.Shape();
  handleShape.moveTo(wTop, 0);
  handleShape.bezierCurveTo(wWaist, -L * 0.22, wWaist, -L * 0.62, wEnd, -L * 0.94);
  handleShape.quadraticCurveTo(wEnd, -L, wEnd - 0.007, -L);
  handleShape.lineTo(-(wEnd - 0.007), -L);
  handleShape.quadraticCurveTo(-wEnd, -L, -wEnd, -L * 0.94);
  handleShape.bezierCurveTo(-wWaist, -L * 0.62, -wWaist, -L * 0.22, -wTop, 0);
  handleShape.closePath();

  const handleGeo = new THREE.ExtrudeGeometry(handleShape, {
    depth: handleDepth,
    bevelEnabled: true,
    bevelThickness: 0.0045,
    bevelSize: 0.0045,
    bevelSegments: 4,
    curveSegments: 24,
  });
  handleGeo.translate(0, 0, -handleDepth / 2);
  handleGeo.rotateZ(-Math.PI / 2); // same reorientation as the blade

  const handle = new THREE.Mesh(handleGeo, grip);
  handle.castShadow = true;
  // Butts up against the neck, running back toward the hand
  handle.position.x = shoulderY - 0.018;
  blade.add(handle);

  // The blade extends forward from the fist along the grip's −Z, and its
  // face normal points out to the side (grip +X) — the orientation a bat
  // actually sits in when you hold the handle, so a natural forehand swing
  // presents the rubber to the ball. The blade group's origin is the head
  // centre, which is also what the physics treats as the contact disc, so
  // the whole bat hangs off that point.
  blade.position.set(0, 0.016, -(PADDLE.HANDLE_LENGTH * 0.55 + R * 0.55));
  blade.rotation.y = Math.PI / 2;
  group.add(blade);

  return group;
}
