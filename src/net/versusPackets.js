import * as THREE from 'three';

// Five tries at 0.6s, 1.2s, 2.4s, 4s, 4s covers a Wi-Fi blip, a laptop display
// sleep, or a relay restart. Past that the player is told plainly rather than
// left watching a countdown that will never finish.
export const VERSUS_RECONNECT_LIMIT = 5;

// Exponential backoff capped at 4s, so a one-frame drop is invisible but a
// dead relay is not hammered.
export function versusReconnectDelay(attempt) {
  return Math.min(600 * 2 ** (attempt - 1), 4000);
}

// The remote bat is posed entirely by these packets, so they stay deliberately
// small: two vectors, a velocity, and one flag.
export function encodeBladePacket(paddle) {
  return {
    c: [paddle.bladeCenter.x, paddle.bladeCenter.y, paddle.bladeCenter.z],
    n: [paddle.bladeNormal.x, paddle.bladeNormal.y, paddle.bladeNormal.z],
    v: [paddle.velocity.x, paddle.velocity.y, paddle.velocity.z],
    // Whether the sender's bat is actually being tracked. Someone watching
    // from a desktop browser has a paddle object but no pose for it, and
    // without this flag it would arrive as a phantom bat parked at the origin
    // — which is on the table, swatting balls its owner can't see.
    t: paddle.tracking,
  };
}

const _quat = new THREE.Quaternion();
const _forward = new THREE.Vector3(0, 0, 1);

// Write a received blade packet onto a paddle object. Returns false when the
// packet is missing or its owner is not tracking, so callers can treat those
// cases as "no pose" without repeating the checks.
export function applyRemotePaddle(paddle, pkt) {
  if (!pkt) return false;
  const tracked = pkt.t !== false;
  paddle.enabled = tracked;
  // This paddle never runs Paddle.update(), so mark it tracked here —
  // otherwise the swept contact test skips it and the opponent could never
  // return a ball.
  paddle.tracking = tracked;
  if (!tracked) {
    paddle.mesh.visible = false;
    return false;
  }
  paddle.bladeCenter.set(pkt.c[0], pkt.c[1], pkt.c[2]);
  paddle.bladeNormal.set(pkt.n[0], pkt.n[1], pkt.n[2]).normalize();
  paddle.velocity.set(pkt.v[0], pkt.v[1], pkt.v[2]);
  paddle.mesh.visible = true;
  paddle.mesh.position.copy(paddle.bladeCenter);
  paddle.mesh.quaternion.copy(
    _quat.setFromUnitVectors(_forward, paddle.bladeNormal)
  );
  return true;
}
