import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {
  SERVE_TOSS_BEHIND,
  SERVE_TOSS_FORWARD,
  SERVE_TOSS_HEIGHT,
  createServeToss,
} from '../src/serve.js';

test('serve toss starts behind either server and travels toward the net', () => {
  for (const toNet of [-1, 1]) {
    const center = new THREE.Vector3(0.12, 0.94, toNet < 0 ? 1.05 : -1.05);
    const { position, velocity } = createServeToss({ center, toNet });
    const direction = new THREE.Vector3(0, 0, toNet);

    assert.equal(position.y, center.y + SERVE_TOSS_HEIGHT);
    assert.ok(position.clone().sub(center).dot(direction) < 0);
    assert.ok(velocity.dot(direction) > 0);
    assert.equal(velocity.y, 1.35);
  }
});

test('serve toss crosses the paddle plane during a readable low arc', () => {
  const center = new THREE.Vector3(0, 0.94, 1.05);
  const { position, velocity } = createServeToss({ center, toNet: -1 });
  const distance = SERVE_TOSS_BEHIND;
  const crossingTime = distance / SERVE_TOSS_FORWARD;
  const crossingY = position.y + velocity.y * crossingTime - 0.5 * 9.81 * crossingTime ** 2;

  assert.ok(crossingTime > 0.15 && crossingTime < 0.35);
  assert.ok(crossingY > center.y - 0.12 && crossingY < center.y + 0.12);
});
