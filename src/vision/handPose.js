import * as THREE from 'three';
import { TABLE } from '../constants.js';

const PALM = [0, 5, 9, 13, 17];
const NEUTRAL = new THREE.Vector3(0, 1.08, -0.72);
const pointValid = (point) => point && [point.x, point.y, point.z].every(Number.isFinite);

// Palm joints stay stable when fingers curl. Fingertips are intentionally not
// used to position or orient the bat.
export class HandPaddlePose {
  constructor() {
    this.position = NEUTRAL.clone();
    this.quaternion = new THREE.Quaternion();
    this.tracking = false;
    this.timestamp = null;
    this._neutral = null;
    this._latest = null;
    this._hand = null;
    this._normalSign = 1;
  }

  markLost() {
    this.tracking = false;
    this.timestamp = null;
  }

  recenter() {
    if (!this.tracking || !this._latest) return false;
    this._neutral = { ...this._latest };
    this.position.copy(NEUTRAL);
    this.timestamp = null;
    return true;
  }

  update({ landmarks, worldLandmarks, aspect, handedness, timestamp }) {
    if (!Number.isFinite(timestamp) || !Number.isFinite(aspect) || aspect <= 0
      || !PALM.every((index) => pointValid(landmarks?.[index]) && pointValid(worldLandmarks?.[index]))) {
      this.markLost();
      return false;
    }
    const x = 1 - PALM.reduce((sum, index) => sum + landmarks[index].x, 0) / PALM.length;
    const y = PALM.reduce((sum, index) => sum + landmarks[index].y, 0) / PALM.length;
    let imageSize = 0;
    let worldSize = 0;
    for (const [a, b] of [[0, 9], [5, 17]]) {
      imageSize += (landmarks[a].x - landmarks[b].x) ** 2 + ((landmarks[a].y - landmarks[b].y) / aspect) ** 2;
      worldSize += (worldLandmarks[a].x - worldLandmarks[b].x) ** 2 + (worldLandmarks[a].y - worldLandmarks[b].y) ** 2;
    }
    if (imageSize < 1e-6 || worldSize < 1e-6) { this.markLost(); return false; }
    // Correct projected size for palm tilt before estimating relative depth.
    const size = Math.sqrt(imageSize / worldSize);
    const direction = (a, b) => new THREE.Vector3(
      -(worldLandmarks[a].x - worldLandmarks[b].x),
      -(worldLandmarks[a].y - worldLandmarks[b].y),
      worldLandmarks[a].z - worldLandmarks[b].z,
    );
    const up = direction(9, 0).normalize();
    const across = direction(5, 17).normalize();
    const normal = across.cross(up);
    if (normal.lengthSq() < 0.05) { this.markLost(); return false; }
    normal.normalize();
    const handChanged = this._hand !== handedness;
    if (!this._neutral || handChanged) {
      this._neutral = { x: 0.5, y: 0.5, size };
      this._normalSign = normal.z < 0 ? -1 : 1;
      this._hand = handedness;
    }
    normal.multiplyScalar(this._normalSign);
    const right = up.clone().cross(normal).normalize();
    up.crossVectors(normal, right).normalize();
    const targetQuaternion = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, normal));
    const targetPosition = new THREE.Vector3(
      THREE.MathUtils.clamp((x - this._neutral.x) * 1.6, -0.85, 0.85),
      THREE.MathUtils.clamp(NEUTRAL.y + (this._neutral.y - y) * 1.3, TABLE.HEIGHT + 0.025, 1.65),
      THREE.MathUtils.clamp(NEUTRAL.z - Math.log(size / this._neutral.size) * 0.7, -1.3, -0.3),
    );
    const reacquired = !this.tracking || this.timestamp === null || timestamp - this.timestamp > 250 || handChanged;
    if (reacquired) {
      this.position.copy(targetPosition);
      this.quaternion.copy(targetQuaternion);
    } else {
      const dt = THREE.MathUtils.clamp((timestamp - this.timestamp) / 1000, 1 / 120, 0.1);
      const speed = this.position.distanceTo(targetPosition) / dt;
      this.position.lerp(targetPosition, 1 - Math.exp(-dt * (25 + Math.min(speed, 4) * 15)));
      const angle = this.quaternion.angleTo(targetQuaternion);
      this.quaternion.slerp(targetQuaternion, 1 - Math.exp(-dt * (18 + angle * 30)));
    }
    this._latest = { x, y, size };
    this.timestamp = timestamp;
    this.tracking = true;
    return { reacquired };
  }
}
