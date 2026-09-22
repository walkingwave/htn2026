import * as THREE from 'three';

// A serve toss starts just beyond the paddle toward the net and drifts back
// through the face. This makes the contact window readable without auto-hitting
// for the player: the paddle still supplies the return speed, angle, and spin.
export const SERVE_TOSS_UP = 1.65;
export const SERVE_TOSS_FORWARD = 0.7;
export const SERVE_TOSS_OFFSET = 0.075;

export function createServeToss({ center, toNet, tracked = true }) {
  const direction = new THREE.Vector3(0, 0, toNet < 0 ? -1 : 1);
  const position = new THREE.Vector3().copy(center);
  const velocity = new THREE.Vector3(0, SERVE_TOSS_UP, 0);

  if (tracked) {
    position.addScaledVector(direction, SERVE_TOSS_OFFSET);
    velocity.addScaledVector(direction, SERVE_TOSS_FORWARD);
  }

  return { position, velocity };
}
