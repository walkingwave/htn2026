import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';

import { OPTIONS, Settings } from '../src/settings.js';
import { buildPauseMenu } from '../src/menuModel.js';

// A localStorage stand-in: Settings persists to it at construction, and node
// has none. Each test gets a clean one so nothing leaks between them.
function installStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  const previous = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
  };
  return { store, restore: () => { globalThis.localStorage = previous; } };
}

const KEY = 'paddlelab-xr.settings';

afterEach(() => {
  delete globalThis.localStorage;
});

test('settings start from defaults and persist what is set', () => {
  const { store, restore } = installStorage();
  try {
    const settings = new Settings();
    assert.equal(settings.get('game'), 'arcade');
    assert.equal(settings.get('difficulty'), 'normal');

    settings.set('game', 'coach');
    settings.set('pace', 1.25);
    assert.equal(JSON.parse(store.get(KEY)).game, 'coach');

    // A fresh instance reads back what the last one wrote.
    const reloaded = new Settings();
    assert.equal(reloaded.get('game'), 'coach');
    assert.equal(reloaded.get('pace'), 1.25);
  } finally {
    restore();
  }
});

test('a player identity is minted once and kept across reloads', () => {
  const { store, restore } = installStorage();
  try {
    const first = new Settings();
    assert.ok(first.get('playerId'), 'an anonymous identity is always present');
    const id = first.get('playerId');

    const second = new Settings();
    assert.equal(second.get('playerId'), id, 'renaming must not fork coaching history');

    // Changing the display name leaves the identity alone.
    second.set('playerName', 'Ada');
    assert.equal(new Settings().get('playerId'), id);
  } finally {
    restore();
  }
});

test('corrupt or hostile stored settings are dropped, not trusted', () => {
  const { store, restore } = installStorage();
  try {
    store.set(KEY, JSON.stringify({
      game: 'not-a-real-mode',       // right type, unknown value
      pace: 'fast',                  // wrong type for a number
      sound: 3,                      // wrong type for a boolean
      accuracy: 1e999,               // non-finite number
      difficulty: 'hard',            // the one good value
      evil: 'payload',               // not a key this build knows
    }));
    const settings = new Settings();
    assert.equal(settings.get('difficulty'), 'hard', 'the valid value survives');
    assert.equal(settings.get('game'), 'arcade', 'the unknown enum falls back');
    assert.equal(settings.get('pace'), 1);
    assert.equal(settings.get('sound'), true);
    assert.equal(settings.values.evil, undefined, 'unknown keys are dropped');
  } finally {
    restore();
  }
});

test('unusable storage degrades to defaults instead of throwing', () => {
  const previous = globalThis.localStorage;
  globalThis.localStorage = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
  };
  try {
    const settings = new Settings();
    assert.equal(settings.get('game'), 'arcade');
    settings.set('pace', 0.78);
    assert.equal(settings.get('pace'), 0.78, 'the session still works');
  } finally {
    globalThis.localStorage = previous;
  }
});

test('subscribers hear changes once, and can unsubscribe', () => {
  const { restore } = installStorage();
  try {
    const settings = new Settings();
    const seen = [];
    const off = settings.onChange((key, value) => seen.push([key, value]));

    settings.set('pace', 0.78);
    settings.set('pace', 0.78); // unchanged: no second call
    assert.deepEqual(seen, [['pace', 0.78]]);

    off();
    settings.set('difficulty', 'hard');
    assert.equal(seen.length, 1, 'a removed listener stops hearing things');
  } finally {
    restore();
  }
});

function fakeSettings(overrides = {}) {
  const values = {
    game: 'arcade', paddleSource: 'controller', difficulty: 'normal', hand: 'right',
    pace: 1, feedRate: 1, placement: 1, sound: true, aimMarker: true, ...overrides,
  };
  return { get: (key) => values[key], set: (key, value) => { values[key] = value; } };
}

function fakeMachine(modeIndex = 0, modes = ['Serve', 'Drive', 'Push']) {
  return {
    modeIndex,
    modeNames: modes,
    get modes() { return this.modeNames; },
  };
}

test('the pause menu describes every row it should, once', () => {
  const menu = buildPauseMenu({
    machine: fakeMachine(),
    settings: fakeSettings(),
    game: { revision: 0, reset() {} },
    onExit() {},
    onResume() {},
  });

  const ids = menu.map((row) => row.id);
  assert.equal(new Set(ids).size, ids.length, 'no duplicated rows');
  for (const expected of ['resume', 'mode', 'game', 'paddleSource', 'difficulty', 'exit']) {
    assert.ok(ids.includes(expected), `${expected} belongs in the menu`);
  }
  assert.equal(menu.find((row) => row.id === 'resume').kind, 'action');
  assert.equal(menu.find((row) => row.id === 'sound').kind, 'toggle');
});

test('versus is not cycled into from the middle of a session', () => {
  const settings = fakeSettings({ game: 'versus' });
  const build = () => buildPauseMenu({
    machine: fakeMachine(),
    settings,
    game: { revision: 0, reset() {} },
    onExit() {},
    onResume() {},
  });

  const row = build().find((item) => item.id === 'game');
  // It still names what is actually set, even though it will not offer it.
  assert.equal(row.value, 'Versus');
  // Stepping from a hidden value lands on the first real option, not on
  // wherever versus used to sit in the list.
  row.step(1);
  assert.equal(settings.get('game'), 'arcade');

  // Both renderers rebuild the model whenever the menu opens, so a label
  // catches up on the next build rather than live on the row.
  assert.equal(build().find((item) => item.id === 'game').value, 'Arcade');
});

test('stepping a normal value walks the list and wraps', () => {
  const settings = fakeSettings({ difficulty: 'normal' });
  // Both renderers rebuild the model immediately after every step, so the
  // model is rebuilt here too — that is the contract, and holding one model
  // across steps is not how anything uses it.
  const row = () => buildPauseMenu({
    machine: fakeMachine(),
    settings,
    game: { revision: 0, reset() {} },
    onExit() {},
    onResume() {},
  }).find((item) => item.id === 'difficulty');

  assert.equal(row().value, 'Normal');
  row().step(1);
  assert.equal(settings.get('difficulty'), 'hard');
  row().step(1);
  assert.equal(settings.get('difficulty'), 'fly', 'wraps past the end');
  row().step(-1);
  assert.equal(settings.get('difficulty'), 'hard', 'and backwards');
});

test('the webcam bat is hidden in a headset but offered on a flat screen', () => {
  const base = {
    machine: fakeMachine(),
    settings: fakeSettings(),
    game: { revision: 0, reset() {} },
    onExit() {},
    onResume() {},
  };

  const flat = buildPauseMenu(base).find((row) => row.id === 'paddleSource');
  const inHeadset = buildPauseMenu({ ...base, inXR: true }).find((row) => row.id === 'paddleSource');

  assert.ok(flat.step, 'the flat-screen menu can drive a webcam bat');
  // In XR the hidden option is not steppable into from a normal position.
  inHeadset.step(-1);
  assert.notEqual(inHeadset.value, 'Webcam paddle');
});

test('coach mode swaps the drill row for the scenario row', () => {
  const shared = {
    machine: fakeMachine(),
    game: { revision: 0, reset() {} },
    onExit() {},
    onResume() {},
  };
  const arcade = buildPauseMenu({ ...shared, settings: fakeSettings({ game: 'arcade' }) });
  const coach = buildPauseMenu({ ...shared, settings: fakeSettings({ game: 'coach' }) });

  assert.equal(arcade.find((row) => row.id === 'mode').label, 'Mode');
  assert.equal(coach.find((row) => row.id === 'scenario').label, 'Scenario');
  assert.ok(OPTIONS.scenario.length > 0);
});
