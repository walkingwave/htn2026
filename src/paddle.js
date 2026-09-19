import * as THREE from 'three';
import { PADDLE } from './constants.js';

// A paddle that attaches to an input or AI anchor and tracks its own velocity.
// Vertical paddles are used by desktop/CV and the fly; XR keeps its controller
// grip orientation so existing headset input remains compatible.
export class Paddle {
  constructor({ owner = 'player', vertical = false, color = 0xcc2222 } = {}) {
    this.owner = owner;
    this.enabled = true;
    this.mesh = buildPaddleMesh(color, vertical);
    this.velocity = new THREE.Vector3();
    this._prevPos = new THREE.Vector3();
    this._worldPos = new THREE.Vector3();
    this._worldQuaternion = new THREE.Quaternion();
    this._initialized = false;
    this.bladeCenter = new THREE.Vector3();
    this.bladeNormal = new THREE.Vector3();
    this._blade = this.mesh.getObjectByName('blade');
  }

  attachTo(anchor) {
    anchor.add(this.mesh);
  }

  update(dt) {
    this._blade.getWorldPosition(this._worldPos);
    this.bladeCenter.copy(this._worldPos);
    this._blade.getWorldQuaternion(this._worldQuaternion);
    this.bladeNormal.set(0, 0, 1).applyQuaternion(this._worldQuaternion).normalize();
    if (this._initialized && dt > 0) {
      this.velocity.copy(this._worldPos).sub(this._prevPos).divideScalar(dt);
    }
    this._prevPos.copy(this._worldPos);
    this._initialized = true;
  }
}

function buildPaddleMesh(color, vertical) {
  const group = new THREE.Group();
  const woodMat = new THREE.MeshStandardMaterial({ color: 0xc89f6b, roughness: 0.8 });
  const rubberFront = new THREE.MeshStandardMaterial({ color, roughness: 0.7 });
  const rubberBack = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.7 });

  const handle = new THREE.Mesh(
    new THREE.CylinderGeometry(PADDLE.HANDLE_RADIUS, PADDLE.HANDLE_RADIUS * 1.15, PADDLE.HANDLE_LENGTH, 12),
    woodMat
  );
  handle.rotation.x = Math.PI / 2;
  group.add(handle);

  const blade = new THREE.Group();
  blade.name = 'blade';
  const core = new THREE.Mesh(
    new THREE.CylinderGeometry(PADDLE.HEAD_RADIUS, PADDLE.HEAD_RADIUS, PADDLE.HEAD_THICKNESS, 32),
    woodMat
  );
  core.rotation.x = Math.PI / 2;
  blade.add(core);

  const faceGeo = new THREE.CylinderGeometry(PADDLE.HEAD_RADIUS, PADDLE.HEAD_RADIUS, 0.002, 32);
  const faceFront = new THREE.Mesh(faceGeo, rubberFront);
  faceFront.rotation.x = Math.PI / 2;
  faceFront.position.z = PADDLE.HEAD_THICKNESS / 2 + 0.001;
  blade.add(faceFront);
  const faceBack = new THREE.Mesh(faceGeo, rubberBack);
  faceBack.rotation.x = Math.PI / 2;
  faceBack.position.z = -(PADDLE.HEAD_THICKNESS / 2 + 0.001);
  blade.add(faceBack);

  blade.position.set(0, 0.02, -(PADDLE.HANDLE_LENGTH / 2 + PADDLE.HEAD_RADIUS));
  // XR controller grips supply their own orientation. Desktop/CV/AI need a
  // vertical blade whose normal points along the table's z axis.
  blade.rotation.x = vertical ? 0 : -Math.PI / 2;
  group.add(blade);
  return group;
}
