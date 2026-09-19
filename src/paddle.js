import * as THREE from 'three';
import { PADDLE } from './constants.js';

// A paddle that attaches to a WebXR controller grip space and tracks its own
// velocity (needed to transfer momentum to the ball on hit).
export class Paddle {
  constructor() {
    this.mesh = buildPaddleMesh();

    // Velocity tracking
    this.velocity = new THREE.Vector3();
    this._prevPos = new THREE.Vector3();
    this._worldPos = new THREE.Vector3();
    this._initialized = false;

    // Blade center in world space, updated each frame
    this.bladeCenter = new THREE.Vector3();
    this.bladeNormal = new THREE.Vector3();
    this._blade = this.mesh.getObjectByName('blade');
  }

  attachTo(controllerGrip) {
    controllerGrip.add(this.mesh);
  }

  // Call once per render frame with real elapsed time.
  update(dt) {
    this._blade.getWorldPosition(this._worldPos);
    this.bladeCenter.copy(this._worldPos);

    // Blade normal = local +Z of the blade in world space
    this.bladeNormal.set(0, 0, 1).applyQuaternion(
      this._blade.getWorldQuaternion(new THREE.Quaternion())
    );

    if (this._initialized && dt > 0) {
      this.velocity
        .copy(this._worldPos)
        .sub(this._prevPos)
        .divideScalar(dt);
    }
    this._prevPos.copy(this._worldPos);
    this._initialized = true;
  }
}

function buildPaddleMesh() {
  const group = new THREE.Group();

  const woodMat = new THREE.MeshStandardMaterial({ color: 0xc89f6b, roughness: 0.8 });
  const rubberRed = new THREE.MeshStandardMaterial({ color: 0xcc2222, roughness: 0.7 });
  const rubberBlack = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.7 });

  // Handle along the controller grip axis
  const handle = new THREE.Mesh(
    new THREE.CylinderGeometry(PADDLE.HANDLE_RADIUS, PADDLE.HANDLE_RADIUS * 1.15, PADDLE.HANDLE_LENGTH, 12),
    woodMat
  );
  handle.rotation.x = Math.PI / 2;
  group.add(handle);

  // Blade head, positioned above the handle, facing sideways like a real grip
  const blade = new THREE.Group();
  blade.name = 'blade';

  const core = new THREE.Mesh(
    new THREE.CylinderGeometry(PADDLE.HEAD_RADIUS, PADDLE.HEAD_RADIUS, PADDLE.HEAD_THICKNESS, 32),
    woodMat
  );
  core.rotation.x = Math.PI / 2;
  blade.add(core);

  const faceGeo = new THREE.CylinderGeometry(PADDLE.HEAD_RADIUS, PADDLE.HEAD_RADIUS, 0.002, 32);
  const faceFront = new THREE.Mesh(faceGeo, rubberRed);
  faceFront.rotation.x = Math.PI / 2;
  faceFront.position.z = PADDLE.HEAD_THICKNESS / 2 + 0.001;
  blade.add(faceFront);

  const faceBack = new THREE.Mesh(faceGeo, rubberBlack);
  faceBack.rotation.x = Math.PI / 2;
  faceBack.position.z = -(PADDLE.HEAD_THICKNESS / 2 + 0.001);
  blade.add(faceBack);

  // Offset blade forward/up from the grip so it sits like a held paddle
  blade.position.set(0, 0.02, -(PADDLE.HANDLE_LENGTH / 2 + PADDLE.HEAD_RADIUS));
  blade.rotation.x = -Math.PI / 2;
  group.add(blade);

  return group;
}
