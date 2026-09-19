import * as THREE from 'three';
import { PADDLE } from './constants.js';

// A paddle that attaches to an input or AI anchor and tracks its own velocity.
// Vertical paddles are used by desktop/CV and the fly; XR keeps its controller
// grip orientation so existing headset input remains compatible.
export class Paddle {
  constructor({ owner = 'player', vertical = false, color = 0xff3030 } = {}) {
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
  const rubberFront = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, depthTest: false, depthWrite: false, toneMapped: false, transparent: false, opacity: 1 });
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

  // Use a solid elliptical cylinder instead of a concave triangulated face.
  // It stays opaque and readable at every camera angle.
  const edge = new THREE.Mesh(
    new THREE.CylinderGeometry(0.082, 0.082, 0.018, 32),
    edgeMat
  );
  edge.rotation.x = Math.PI / 2;
  edge.scale.y = 1.18;
  edge.position.z = 0;
  blade.add(edge);

  const face = new THREE.Mesh(
    new THREE.CylinderGeometry(0.077, 0.077, 0.021, 32),
    rubberFront
  );
  face.rotation.x = Math.PI / 2;
  face.scale.y = 1.18;
  face.position.z = 0.035;
  face.renderOrder = 2;
  blade.add(face);
  group.add(blade);
  return group;
}
