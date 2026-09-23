import assert from 'node:assert/strict';
import test from 'node:test';
import { FlyBrain } from '../src/flybrain.js';

test('FlyBrain tactical fallback stays inside return-action bounds', () => {
  const brain = new FlyBrain();
  const tactic = brain.chooseTactic({
    ball: { x: 0.7, vx: -1.5 },
    confidence: 0.8,
    rally: 5,
    risk: 0.65,
  });

  assert.ok(tactic.targetX >= -0.55 && tactic.targetX <= 0.55);
  assert.ok(tactic.targetZ >= 0.22 && tactic.targetZ <= 0.42);
  assert.ok(tactic.pace >= 4.2 && tactic.pace <= 5.0);
  assert.ok(tactic.risk >= 0.08 && tactic.risk <= 0.8);
});

test('FlyBrain keeps a temporal intercept stable while motion reverses', () => {
  const brain = new FlyBrain();
  brain._init({
    numNodes: 1,
    csr: { offsets: [0, 1], source: [0], weightQ: [0], weightScale: 1 },
    retinaNodes: [0],
    retinaPrefX: [0],
    descendingNodes: [0],
    readout: {
      // Feature order: descending, bias, x, vx, z, vz.
      W: [[0, 0, 1, 0, 0, 0], [0, 0, 0, 0, 0, 0]],
      ballNorm: { x: 0.7625, vx: 5, z: 1.37, vz: 5 },
    },
    reservoir: { leak: 0.25, gain: 1, sigma: 0.18, amp: 1.2 },
    planeZ: -1.47,
    planeYMin: 0.81,
    planeYMax: 1.21,
    layout: [[0, 0]],
  });
  brain.ready = true;

  const first = brain.step({ x: 0.55, y: 1.0, z: -0.7, vx: 0, vy: 0, vz: -4 });
  const second = brain.step({ x: -0.55, y: 1.0, z: -0.9, vx: -1, vy: 0, vz: -4 });

  assert.equal(brain.stepCount, 2);
  assert.equal(brain.lastBall.x, -0.55);
  assert.ok(first.targetX > 0);
  assert.ok(second.targetX < first.targetX, 'the smoothed readout should follow a lane reversal');
  assert.ok(second.confidence >= 0 && second.confidence <= 1);
});

test('FlyBrain accepts an exported linear policy without owning contact physics', () => {
  const brain = new FlyBrain();
  brain.policy = {
    W: [
      [0, 0, 0, 0, 0, 0.9],
      [0, 0, 0, 0, 0, 0.5],
      [0, 0, 0, 0, 0, 4.7],
      [0, 0, 0, 0, 0, 0.7],
    ],
  };

  const tactic = brain.chooseTactic({
    ball: { x: 0, vx: 0 },
    confidence: 0.5,
    rally: 0,
    risk: 0.5,
  });

  assert.deepEqual(tactic, {
    targetX: 0.62,
    targetZ: 0.5,
    pace: 4.7,
    risk: 0.7,
  });
});
