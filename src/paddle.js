import * as THREE from 'three';
import { PADDLE } from './constants.js';

// A paddle that attaches to an input or AI anchor and tracks its own velocity.
// Vertical paddles are used by desktop/CV and the fly; XR keeps its controller
// grip orientation so existing headset input remains compatible.
export class Paddle {
  constructor({ owner = 'player', vertical = false, color = 0xe53935 } = {}) {
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

function createBladeShape() {
  const shape = new THREE.Shape();
  // A slightly tapered, rounded ITTF-style blade: broad at the shoulder,
  // rounded across the top, and narrower where it meets the handle.
  shape.moveTo(-0.042, -0.044);
  shape.lineTo(-0.068, 0.018);
  shape.quadraticCurveTo(-0.078, 0.054, -0.066, 0.092);
  shape.quadraticCurveTo(-0.041, 0.128, 0, 0.135);
  shape.quadraticCurveTo(0.041, 0.128, 0.066, 0.092);
  shape.quadraticCurveTo(0.078, 0.054, 0.068, 0.018);
  shape.lineTo(0.042, -0.044);
  shape.quadraticCurveTo(0.022, -0.057, 0, -0.058);
  shape.quadraticCurveTo(-0.022, -0.057, -0.042, -0.044);
  return shape;
}

function createFaceMesh(shape, material, z) {
  const face = new THREE.Mesh(new THREE.ShapeGeometry(shape), material);
  face.position.z = z;
  return face;
}

function buildPaddleMesh(color, vertical) {
  const group = new THREE.Group();
  const woodMat = new THREE.MeshStandardMaterial({ color: 0xc8945b, roughness: 0.72 });
  const edgeMat = new THREE.MeshStandardMaterial({ color: 0x5b3423, roughness: 0.82 });
  const rubberFront = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, depthTest: false, toneMapped: false });
  const rubberBack = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(0.68), side: THREE.DoubleSide, depthTest: false, toneMapped: false });
  const shape = createBladeShape();

  const handle = new THREE.Mesh(
    new THREE.CylinderGeometry(PADDLE.HANDLE_RADIUS * 0.9, PADDLE.HANDLE_RADIUS * 1.2, PADDLE.HANDLE_LENGTH, 12),
    woodMat
  );
  handle.name = 'handle';
  handle.position.y = -PADDLE.HANDLE_LENGTH / 2 - 0.012;
  group.add(handle);

  const neck = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.035, 0.018), edgeMat);
  neck.name = 'neck';
  neck.position.y = 0.004;
  group.add(neck);

  const blade = new THREE.Group();
  blade.name = 'blade';
  blade.position.y = 0.062;
  blade.rotation.x = vertical ? 0 : -Math.PI / 2;

  const core = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, {
    depth: PADDLE.HEAD_THICKNESS,
    bevelEnabled: true,
    bevelThickness: 0.003,
    bevelSize: 0.003,
    bevelSegments: 2,
    curveSegments: 8,
  }), rubberFront);
  core.position.z = -PADDLE.HEAD_THICKNESS / 2;
  core.name = 'wood-core';
  core.renderOrder = 0;
  blade.add(core);

  const frontFace = createFaceMesh(shape, rubberFront, 0.028);
  const backFace = createFaceMesh(shape, rubberBack, -0.028);
  frontFace.renderOrder = 2;
  backFace.renderOrder = 2;
  blade.add(frontFace, backFace);

  // A thin contrasting edge tape makes the blade readable from the side.
  const edge = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(shape.getPoints(32).map((point) => new THREE.Vector3(point.x, point.y, 0.03))), new THREE.LineBasicMaterial({ color: 0xf1c27d }));
  blade.add(edge);
  group.add(blade);
  return group;
}
