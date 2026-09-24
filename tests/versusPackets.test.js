import assert from 'node:assert/strict';
import test from 'node:test';

import * as THREE from 'three';

import {
  VERSUS_RECONNECT_LIMIT,
  applyRemotePaddle,
  encodeBladePacket,
  versusReconnectDelay,
} from '../src/net/versusPackets.js';

// A stand-in for the physics paddle: the packet helpers only ever touch the
// blade vectors, the tracking flag, and the mesh transform.
function fakePaddle() {
  return {
    tracking: true,
    enabled: false,
    bladeCenter: new THREE.Vector3(1, 2, 3),
    bladeNormal: new THREE.Vector3(0, 0, 1),
    velocity: new THREE.Vector3(4, 5, 6),
    mesh: {
      visible: false,
      position: new THREE.Vector3(),
      quaternion: new THREE.Quaternion(),
    },
  };
}

test('a blade packet survives the round trip', () => {
  const sent = fakePaddle();
  const packet = encodeBladePacket(sent);

  // Arrays, not objects — the payload is JSON on the wire.
  assert.deepEqual(packet.c, [1, 2, 3]);
  assert.deepEqual(packet.n, [0, 0, 1]);
  assert.deepEqual(packet.v, [4, 5, 6]);
  assert.equal(packet.t, true);

  const received = fakePaddle();
  assert.equal(applyRemotePaddle(received, packet), true);
  assert.equal(received.enabled, true);
  assert.equal(received.tracking, true);
  assert.equal(received.mesh.visible, true);
  assert.deepEqual(received.bladeCenter.toArray(), [1, 2, 3]);
  assert.deepEqual(received.velocity.toArray(), [4, 5, 6]);
  assert.deepEqual(
    received.mesh.position.toArray(),
    received.bladeCenter.toArray()
  );
});

test('an untracked bat never reaches the table as a phantom paddle', () => {
  const packet = encodeBladePacket({ ...fakePaddle(), tracking: false });
  assert.equal(packet.t, false);

  const received = fakePaddle();
  assert.equal(applyRemotePaddle(received, packet), false);
  assert.equal(received.enabled, false);
  assert.equal(received.tracking, false);
  assert.equal(received.mesh.visible, false);
});

test('a packet without the tracking flag is assumed to be a real pose', () => {
  // The flag is how a desktop watcher says "I have no bat", but a sender that
  // predates it never marks itself untracked — so an absent flag means tracked.
  const packet = { c: [0, 0, 0], n: [0, 0, 1], v: [0, 0, 0] };
  const received = fakePaddle();
  assert.equal(applyRemotePaddle(received, packet), true);
  assert.equal(received.enabled, true);
  assert.equal(received.mesh.visible, true);
  // Nothing at all is still nothing.
  assert.equal(applyRemotePaddle(received, null), false);
});

test('reconnect backoff is fast at first and capped', () => {
  assert.equal(versusReconnectDelay(1), 600);
  assert.equal(versusReconnectDelay(2), 1200);
  assert.equal(versusReconnectDelay(3), 2400);
  assert.equal(versusReconnectDelay(4), 4000);
  // The limit is what the UI reports, so it has to match the schedule length.
  assert.equal(versusReconnectDelay(VERSUS_RECONNECT_LIMIT), 4000);
  assert.equal(versusReconnectDelay(20), 4000, 'never unbounded');
});
