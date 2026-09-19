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

function buildPaddleMesh() {
  const group = new THREE.Group();

  const wood = new THREE.MeshStandardMaterial({ color: 0xb98b53, roughness: 0.65 });
  const grip = new THREE.MeshStandardMaterial({ color: 0x7a2f2f, roughness: 0.8 });
  const rubberRed = new THREE.MeshStandardMaterial({ color: 0xc0281f, roughness: 0.85 });
  const rubberBlack = new THREE.MeshStandardMaterial({ color: 0x131315, roughness: 0.85 });
  const edgeTape = new THREE.MeshStandardMaterial({ color: 0xe8e8ec, roughness: 0.6 });

  // Flared handle
  const handle = new THREE.Mesh(
    new THREE.CylinderGeometry(
      PADDLE.HANDLE_RADIUS,
      PADDLE.HANDLE_RADIUS * 1.25,
      PADDLE.HANDLE_LENGTH,
      16
    ),
    grip
  );
  handle.rotation.x = Math.PI / 2;
  handle.castShadow = true;
  group.add(handle);

  // Neck joining handle to blade
  const neck = new THREE.Mesh(
    new THREE.BoxGeometry(0.036, 0.012, 0.04),
    wood
  );
  neck.position.set(0, 0, -PADDLE.HANDLE_LENGTH / 2 - 0.015);
  group.add(neck);

  const blade = new THREE.Group();
  blade.name = 'blade';

  const r = PADDLE.HEAD_RADIUS;
  const core = new THREE.Mesh(
    new THREE.CylinderGeometry(r, r, PADDLE.HEAD_THICKNESS, 40),
    wood
  );
  core.rotation.x = Math.PI / 2;
  core.castShadow = true;
  blade.add(core);

  // Rubber sheets, inset slightly so the wood edge reads as edge tape
  const faceGeo = new THREE.CylinderGeometry(r * 0.97, r * 0.97, 0.0018, 40);
  for (const [mat, sign] of [
    [rubberRed, 1],
    [rubberBlack, -1],
  ]) {
    const face = new THREE.Mesh(faceGeo, mat);
    face.rotation.x = Math.PI / 2;
    face.position.z = sign * (PADDLE.HEAD_THICKNESS / 2 + 0.001);
    blade.add(face);
  }

  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(r, 0.0035, 8, 44),
    edgeTape
  );
  blade.add(rim);

  // The blade extends forward from the fist along the grip's −Z, and its
  // face normal points out to the side (grip +X) — the orientation a bat
  // actually sits in when you hold the handle, so a natural forehand swing
  // presents the rubber to the ball.
  blade.position.set(0, 0.018, -(PADDLE.HANDLE_LENGTH / 2 + r * 0.82));
  blade.rotation.y = Math.PI / 2;
  group.add(blade);

  return group;
}
