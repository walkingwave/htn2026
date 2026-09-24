import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { MODES, simulateShot, solveLaunch } from '../src/ballMachine.js';
import { BALL, NET, PLAY_AREA, TABLE } from '../src/constants.js';

// The machine's whole job is putting a ball somewhere specific. These tests
// fly every solved launch to see whether it actually arrives, rather than
// trusting the solver converged.
//
// The geometry matters and is easy to get backwards: the machine stands at
// SERVER_Z (negative) and serves to a target on the player's half (positive),
// so every ball travels from -z toward +z. The first version of this file
// mirrored the table and reported a broken net guard that did not exist.
const MUZZLE = new THREE.Vector3(0, TABLE.HEIGHT + 0.26, PLAY_AREA.SERVER_Z + 0.12);
const aimAt = (x, z) => new THREE.Vector3(x, TABLE.HEIGHT + BALL.RADIUS, z);
const NEAR_Z = TABLE.LENGTH * 0.18;
const FAR_Z = TABLE.LENGTH * 0.40;

test('a solved launch lands near its target and clears the net', () => {
  const cases = [
    { label: 'topspin drive', spin: new THREE.Vector3(190, 0, 0), speed: 5.0 },
    { label: 'backspin push', spin: new THREE.Vector3(-150, 0, 0), speed: 4.0 },
    { label: 'flat block', spin: new THREE.Vector3(0, 0, 0), speed: 4.6 },
    { label: 'sidespin', spin: new THREE.Vector3(0, 170, 0), speed: 4.6 },
  ];

  for (const { label, spin, speed } of cases) {
    const target = aimAt(0.3, FAR_Z);
    const velocity = solveLaunch(MUZZLE, target, speed, spin);
    const shot = simulateShot(MUZZLE, velocity, target.y, spin);

    assert.equal(shot.landed, true, `${label} reaches the table`);
    assert.ok(
      shot.netClearance > 0,
      `${label} clears the net (was ${shot.netClearance.toFixed(3)} m)`
    );
    assert.ok(
      Math.hypot(shot.x - target.x, shot.z - target.z) < 0.05,
      `${label} lands within 5 cm of the target ` +
        `(x ${shot.x.toFixed(2)} vs ${target.x}, z ${shot.z.toFixed(2)} vs ${target.z})`
    );
  }
});

test('the solver aims across the table, not just down the middle', () => {
  const spin = new THREE.Vector3(120, 0, 0);
  for (const x of [-0.7, 0, 0.7]) {
    for (const z of [NEAR_Z, FAR_Z]) {
      const target = aimAt(x, z);
      const shot = simulateShot(MUZZLE, solveLaunch(MUZZLE, target, 4.8, spin), target.y, spin);
      assert.equal(shot.landed, true, `(${x}, ${z}) reaches the table`);
      assert.ok(shot.netClearance > 0, `(${x}, ${z}) clears the net`);
      assert.ok(
        Math.hypot(shot.x - x, shot.z - z) < 0.06,
        `(${x}, ${z}) lands close enough (got ${shot.x.toFixed(2)}, ${shot.z.toFixed(2)})`
      );
    }
  }
});

test('a slower machine still gets the ball over, just with more lift', () => {
  const spin = new THREE.Vector3(0, 0, 0);
  const target = aimAt(0, NEAR_Z);
  const fast = solveLaunch(MUZZLE, target, 6.0, spin);
  const slow = solveLaunch(MUZZLE, target, 3.5, spin);

  assert.ok(slow.y > fast.y, 'a slower ball is launched higher to reach the same place');
  for (const [label, velocity] of [['fast', fast], ['slow', slow]]) {
    const shot = simulateShot(MUZZLE, velocity, target.y, spin);
    assert.equal(shot.landed, true, `${label} reaches the table`);
    assert.ok(shot.netClearance > 0, `${label} clears the net`);
  }
});

// A launch that starts already at the target has no direction to point in.
// The machine never aims at its own muzzle, so this cannot happen in play, but
// the solver should not hand back NaN if it ever did.
test('a target level with the muzzle does not produce NaN', () => {
  const velocity = solveLaunch(MUZZLE, MUZZLE.clone(), 4.6, new THREE.Vector3());
  assert.ok(Number.isFinite(velocity.x), 'x is finite');
  assert.ok(Number.isFinite(velocity.y), 'y is finite');
  assert.ok(Number.isFinite(velocity.z), 'z is finite');
});

// This is the one that was genuinely broken. Sidespin pushes the ball across
// the table, and the solver scaled launch speed along a fixed line without
// ever re-aiming, so nothing could correct a lateral error. Before the fix
// this landed 77 cm wide of its target.
test('sidespin is corrected, not just scaled', () => {
  const target = aimAt(0.3, FAR_Z);
  const spin = new THREE.Vector3(0, 170, 0);
  const shot = simulateShot(MUZZLE, solveLaunch(MUZZLE, target, 4.6, spin), target.y, spin);
  const miss = Math.hypot(shot.x - target.x, shot.z - target.z);
  assert.ok(miss < 0.05, `sidespin lands within 5 cm (missed by ${miss.toFixed(3)} m)`);
});

// The net guard is the whole reason solveLaunch iterates on launch angle, so
// the crossing has to be detected in the direction the machine actually
// serves. It travels from -z toward +z.
test('a shot flat enough to hit the net is reported as such', () => {
  const smash = simulateShot(
    MUZZLE,
    new THREE.Vector3(0, 0, 14),
    TABLE.HEIGHT,
    new THREE.Vector3()
  );
  assert.ok(
    Number.isFinite(smash.netClearance),
    'the crossing is detected in the direction the machine actually serves'
  );
  assert.ok(
    smash.netClearance < NET.HEIGHT * 0.5,
    `a flat smash should be near or below the tape, got ${smash.netClearance}`
  );
});

test('a lofted shot clears the net by a real margin', () => {
  const lofted = simulateShot(
    MUZZLE,
    new THREE.Vector3(0, 3, 9),
    TABLE.HEIGHT,
    new THREE.Vector3()
  );
  assert.ok(lofted.netClearance > NET.HEIGHT, 'well over the tape');
});

test('every drill mode is a complete, playable description', () => {
  assert.ok(MODES.length >= 5);
  const names = new Set();

  for (const mode of MODES) {
    assert.ok(mode.name && !names.has(mode.name), `${mode.name} is unique`);
    names.add(mode.name);
    assert.ok(['drill', 'infinite', 'target', 'rally'].includes(mode.type), `${mode.name} has a known type`);
  }

  for (const mode of MODES.filter((m) => m.type === 'drill')) {
    assert.ok(['x', 'y'].includes(mode.axis), `${mode.name} has a spin axis`);
    assert.ok(Number.isFinite(mode.spin), `${mode.name} has a spin`);
    assert.ok(mode.speed > 0, `${mode.name} has a speed`);
    assert.ok(mode.interval > 0, `${mode.name} has an interval`);
  }

  const infinite = MODES.find((m) => m.type === 'infinite');
  assert.ok(infinite.roam);
  for (const key of ['speedRange', 'spinRange', 'intervalRange']) {
    const [lo, hi] = infinite[key];
    assert.ok(lo < hi, `infinite.${key} is an ordered range`);
  }
});

test('the machine exposes a ball size the physics already agrees with', () => {
  // solveLaunch simulates with BALL constants; if those were ever undefined
  // the simulation would silently return nonsense rather than throw.
  assert.ok(BALL.RADIUS > 0);
  assert.ok(NET.HEIGHT > 0);
});
