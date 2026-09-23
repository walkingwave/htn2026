import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

// Paddle geometry uses procedural canvas textures. This small DOM shim keeps
// the integration test browser-free while still constructing the real Paddle,
// Opponent, Ball, and PhysicsWorld classes.
globalThis.document = {
  createElement() {
    return {
      width: 1,
      height: 1,
      getContext() {
        return {
          fillRect() {}, clearRect() {}, strokeRect() {}, beginPath() {},
          moveTo() {}, lineTo() {}, stroke() {}, arc() {}, fill() {}, fillText() {},
          createLinearGradient() { return { addColorStop() {} }; },
        };
      },
    };
  },
};

const [{ Opponent }, { Ball }, { PhysicsWorld }, { TABLE }] = await Promise.all([
  import('../src/opponent.js'),
  import('../src/ball.js'),
  import('../src/physics.js'),
  import('../src/constants.js'),
]);

test('opponent paddle contacts an incoming ball through the real physics path', () => {
  const opponent = new Opponent('normal', { random: () => 0.5 });
  const ball = new Ball();
  ball.serve(
    new THREE.Vector3(0.05, TABLE.HEIGHT + 0.28, -1.0),
    new THREE.Vector3(0.1, -0.3, -4.1),
    new THREE.Vector3()
  );
  // In the game this flag is set by the player's preceding paddle contact.
  ball.touchedByPaddle = true;

  const physics = new PhysicsWorld();
  let hits = 0;
  physics.onBounce = (_ball, event) => {
    if (event === 'paddle') hits++;
  };

  opponent.setActive(true);
  for (let i = 0; i < 120 && hits === 0; i++) {
    opponent.update(1 / 90, [ball]);
    physics.step(1 / 90, [ball], [opponent.paddle]);
  }

  assert.equal(hits, 1);
  assert.ok(ball.velocity.z > 0, 'the returned ball must travel back toward the player');
  assert.equal(ball.lastHitBy, opponent.paddle);
});
