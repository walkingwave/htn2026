// Player-facing settings. Small observable store so the UI and the game read
// from one place — the bottom bar writes, the ball machine reads.
//
// Values are multipliers rather than absolutes so they compose with whatever
// the active mode already specifies, instead of overriding its character.

export const OPTIONS = {
  pace: [
    { label: 'Slow', value: 0.78 },
    { label: 'Normal', value: 1 },
    { label: 'Fast', value: 1.25 },
  ],
  feedRate: [
    { label: 'Relaxed', value: 1.35 },
    { label: 'Normal', value: 1 },
    { label: 'Rapid', value: 0.68 },
  ],
  placement: [
    { label: 'Centred', value: 0.35 },
    { label: 'Normal', value: 1 },
    { label: 'Wide', value: 1.5 },
  ],
  hand: [
    { label: 'Right', value: 'right' },
    { label: 'Left', value: 'left' },
    { label: 'Both', value: 'both' },
  ],
  // What drives the bat. `hand` lets you hold your own real paddle and have
  // the headset track your hand instead of a controller.
  paddleSource: [
    { label: 'Controller', value: 'controller' },
    { label: 'Real paddle', value: 'hand' },
  ],
  // Arcade is the drills and rally; Coach teaches strokes one at a time;
  // Versus is a networked match against another player.
  game: [
    { label: 'Arcade', value: 'arcade' },
    { label: 'Coach', value: 'coach' },
    { label: 'Versus', value: 'versus' },
  ],
  // Which situation Coach drills.
  scenario: [
    { label: 'Serve', value: 'serve' },
    { label: 'Drive', value: 'drive' },
    { label: 'Push', value: 'push' },
    { label: 'Return', value: 'return' },
    { label: 'Block', value: 'block' },
  ],
  // How hard the rally opponent is to beat.
  difficulty: [
    { label: 'Easy', value: 'easy' },
    { label: 'Normal', value: 'normal' },
    { label: 'Hard', value: 'hard' },
  ],
};

const DEFAULTS = {
  pace: 1,
  feedRate: 1,
  placement: 1,
  hand: 'right',
  paddleSource: 'controller',
  difficulty: 'normal',
  scenario: 'serve',
  game: 'arcade', // 'arcade' | 'coach' | 'versus'
  sound: true,
  aimMarker: true,
};

const STORAGE_KEY = 'pingpong-trainer-settings';

export class Settings {
  constructor() {
    this.values = { ...DEFAULTS, ...load() };
    this._listeners = new Set();
  }

  get(key) {
    return this.values[key];
  }

  set(key, value) {
    if (this.values[key] === value) return;
    this.values[key] = value;
    save(this.values);
    for (const fn of this._listeners) fn(key, value);
  }

  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }
}

function load() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? {};
  } catch {
    return {}; // private browsing, corrupt entry — defaults are fine
  }
}

function save(values) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(values));
  } catch {
    // Not worth surfacing; settings just won't persist.
  }
}
