import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {
  chooseReturnPlan,
  isLegalReturn,
  OPPONENT_SKILL,
} from '../src/opponent.js';
import { BALL, TABLE } from '../src/constants.js';

function seeded(seed = 7) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function incoming(spin = new THREE.Vector3()) {
  return {
    origin: new THREE.Vector3(0, TABLE.HEIGHT + 0.24, -(TABLE.LENGTH / 2) - 0.1),
    incoming: new THREE.Vector3(0.15, -0.35, -4.1),
    spin,
  };
}

test('opponent candidate selection returns a legal shot for common spin states', () => {
  for (const spin of [
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(150, 0, 0),
    new THREE.Vector3(-140, 0, 0),
    new THREE.Vector3(0, 110, 0),
  ]) {
    const plan = chooseReturnPlan({
      ...incoming(spin),
      skill: OPPONENT_SKILL.normal,
      random: seeded(42),
    });

    assert.equal(plan.legal, true);
    assert.equal(isLegalReturn(plan.shot, OPPONENT_SKILL.normal.netMargin), true);
    assert.ok(plan.shot.netClearance >= OPPONENT_SKILL.normal.netMargin);
    assert.ok(Math.abs(plan.shot.x) <= TABLE.WIDTH / 2 - BALL.RADIUS);
    assert.ok(plan.shot.z >= BALL.RADIUS && plan.shot.z <= TABLE.LENGTH / 2 - BALL.RADIUS);
  }
});

test('return selection is deterministic with an injected random source', () => {
  const args = { ...incoming(), skill: OPPONENT_SKILL.hard };
  const first = chooseReturnPlan({ ...args, random: seeded(99) });
  const second = chooseReturnPlan({ ...args, random: seeded(99) });

  assert.deepEqual(first.target.toArray(), second.target.toArray());
  assert.deepEqual(first.velocity.toArray(), second.velocity.toArray());
  assert.equal(first.legal, second.legal);
});

test('easy and hard bots use different tactical risk profiles while staying legal', () => {
  const easy = chooseReturnPlan({
    ...incoming(),
    skill: OPPONENT_SKILL.easy,
    random: seeded(3),
  });
  const hard = chooseReturnPlan({
    ...incoming(),
    skill: OPPONENT_SKILL.hard,
    random: seeded(3),
  });

  assert.equal(easy.legal, true);
  assert.equal(hard.legal, true);
  assert.ok(hard.velocity.length() >= easy.velocity.length() * 0.85);
  assert.notDeepEqual(easy.target.toArray(), hard.target.toArray());
});

test('candidate selection falls back to a bounded plan for an awkward incoming ball', () => {
  const plan = chooseReturnPlan({
    origin: new THREE.Vector3(TABLE.WIDTH, 0.3, -1.0),
    incoming: new THREE.Vector3(3, -5, -1),
    spin: new THREE.Vector3(0, 300, 0),
    skill: OPPONENT_SKILL.easy,
    random: seeded(1),
  });

  assert.ok(Number.isFinite(plan.velocity.x));
  assert.ok(Number.isFinite(plan.velocity.y));
  assert.ok(Number.isFinite(plan.velocity.z));
  assert.ok(plan.velocity.length() < 20);
});
