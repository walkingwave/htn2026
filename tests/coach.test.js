import assert from 'node:assert/strict';
import test from 'node:test';

import { COACH_STATE, SCENARIOS, adviseFrom, gradeNote } from '../src/coach.js';
import { PLAY_AREA, TABLE } from '../src/constants.js';

const attempt = (over = {}) => ({
  path: 90, sync: 90, face: 90, timing: 90, duration: 0.3, total: 90, ...over,
});

test('every scenario is complete and internally consistent', () => {
  assert.ok(SCENARIOS.length >= 5);
  const ids = new Set();

  for (const scenario of SCENARIOS) {
    assert.ok(scenario.id && !ids.has(scenario.id), `${scenario.id} is unique`);
    ids.add(scenario.id);
    assert.ok(scenario.name && scenario.brief, `${scenario.id} is described to the player`);
    assert.ok(['held', 'fed'].includes(scenario.kind), `${scenario.id} has a known kind`);

    // Every stroke has to be somewhere the player can actually reach.
    assert.ok(scenario.contactZ === undefined || Number.isFinite(scenario.contactZ));
    const contact = scenario.contact;
    if (scenario.kind === 'held') {
      assert.equal(contact.length, 3, `${scenario.id} has a 3D contact point`);
      assert.ok(contact[0] > -1 && contact[0] < 1, `${scenario.id} contact is across the table`);
      assert.ok(contact[1] > TABLE.HEIGHT - 0.2, `${scenario.id} contact is above the table`);
      assert.ok(contact[2] < PLAY_AREA.PLAYER_Z, `${scenario.id} contact is in front of the player`);
    } else {
      assert.ok(scenario.feed?.origin && scenario.feed?.bounce, `${scenario.id} has a feed`);
    }

    assert.ok(scenario.land, `${scenario.id} says where to land`);
    assert.ok(
      scenario.land.z < 0,
      `${scenario.id} lands on the far side, not the player's own half`
    );
    assert.ok(scenario.pace > 0, `${scenario.id} has a pace`);
    assert.equal(typeof scenario.stroke?.rise, 'number', `${scenario.id} has a stroke shape`);
  }
});

test('one sloppy attempt is not treated as a habit', () => {
  const scenario = SCENARIOS[0];
  assert.equal(adviseFrom([], scenario, 0.3), 'Trace the ribbon from the ring');
  assert.equal(adviseFrom([attempt({ total: 10 })], scenario, 0.3), 'Trace the ribbon from the ring');
});

test('a strong, even swing is told to move on', () => {
  const advice = adviseFrom([attempt(), attempt(), attempt()], SCENARIOS[0], 0.3);
  assert.match(advice, /Dialled in|Solid all round/);
});

test('a drifting line is named as a line problem, not a shape one', () => {
  // Path and sync fall together — the code deliberately judges them as one
  // fault so the advice can talk about a wandering swing.
  const history = [
    attempt({ path: 40, sync: 42, face: 90, timing: 90 }),
    attempt({ path: 44, sync: 39, face: 88, timing: 91 }),
  ];
  const advice = adviseFrom(history, SCENARIOS[0], 0.3);
  assert.match(advice, /line/i);
});

test('a swing that is on the line but out of step is told about pace', () => {
  const history = [
    attempt({ path: 82, sync: 50, face: 90, timing: 90 }),
    attempt({ path: 79, sync: 54, face: 88, timing: 92 }),
  ];
  const advice = adviseFrom(history, SCENARIOS[0], 0.3);
  assert.match(advice, /pace of the marker/);
});

test('face advice follows the direction the stroke actually rises', () => {
  const weakFace = [attempt({ face: 30, timing: 95 }), attempt({ face: 35, timing: 92 })];

  const rising = SCENARIOS.find((s) => s.stroke.rise > 0);
  const falling = SCENARIOS.find((s) => s.stroke.rise < 0);

  assert.match(adviseFrom(weakFace, rising, 0.3), /Close the face/);
  assert.match(adviseFrom(weakFace, falling, 0.3), /more open/);
});

test('timing advice distinguishes rushing from dawdling', () => {
  const expected = 0.3;
  const slow = [attempt({ timing: 30, duration: 0.8 }), attempt({ timing: 35, duration: 0.9 })];
  const fast = [attempt({ timing: 30, duration: 0.1 }), attempt({ timing: 35, duration: 0.12 })];

  assert.match(adviseFrom(slow, SCENARIOS[0], expected), /Too slow/);
  assert.match(adviseFrom(fast, SCENARIOS[0], expected), /rushing/);
});

test('a fault that is not decisively worse reads as broadly solid', () => {
  // face and timing within six points of each other: neither is the story.
  const history = [
    attempt({ path: 95, sync: 95, face: 72, timing: 75, total: 80 }),
    attempt({ path: 94, sync: 93, face: 70, timing: 76, total: 78 }),
  ];
  assert.match(adviseFrom(history, SCENARIOS[0], 0.3), /Solid all round at 79%/);
});

test('grades are ordered and cover the whole range', () => {
  assert.equal(gradeNote(100), 'Textbook');
  assert.equal(gradeNote(90), 'Textbook');
  assert.equal(gradeNote(89), 'Good shape');
  assert.equal(gradeNote(75), 'Good shape');
  assert.equal(gradeNote(74), 'Getting there');
  assert.equal(gradeNote(55), 'Getting there');
  assert.equal(gradeNote(54), 'Off the line');
  assert.equal(gradeNote(35), 'Off the line');
  assert.equal(gradeNote(34), 'Try again');
  assert.equal(gradeNote(0), 'Try again');
});

test('the coach state machine names every phase it can be in', () => {
  assert.deepEqual(Object.values(COACH_STATE).sort(), [
    'countdown', 'idle', 'ready', 'scored', 'tracing',
  ]);
});
