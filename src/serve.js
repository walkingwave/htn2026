import * as THREE from 'three';

// Shared physical serve toss for every input source. The ball starts just
// behind the server's paddle and travels toward the net, crossing the paddle
// plane after a short, predictable rise. That gives mouse, webcam, phone,
// hand, and XR players the same contact window without auto-hitting.
export const SERVE_TOSS_UP = 1.35;
export const SERVE_TOSS_FORWARD = 0.55;
export const SERVE_TOSS_BEHIND = 0.13;
export const SERVE_TOSS_HEIGHT = 0.025;

export function createServeToss({ center, toNet }) {
  const direction = new THREE.Vector3(0, 0, toNet < 0 ? -1 : 1);
  const position = new THREE.Vector3().copy(center);
  // "Behind" is opposite the direction of play, so the ball crosses the
  // actual blade plane instead of beginning on the net side of it.
  position.addScaledVector(direction, -SERVE_TOSS_BEHIND);
  position.y += SERVE_TOSS_HEIGHT;

  const velocity = new THREE.Vector3(0, SERVE_TOSS_UP, 0);
  velocity.addScaledVector(direction, SERVE_TOSS_FORWARD);
  return { position, velocity };
}
