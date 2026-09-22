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
  // `hand` tracks the hand holding your own real bat inside a session.
  // `camera` is the flat-screen equivalent: a webcam watches the real bat and
  // drives the on-screen one, so a laptop player swings a physical paddle.
  paddleSource: [
    { label: 'Controller', value: 'controller' },
    { label: 'Real paddle', value: 'hand' },
    { label: 'Webcam paddle', value: 'camera' },
    { label: 'Hand tracking', value: 'camera-hand' },
    { label: 'Phone paddle', value: 'phone' },
  ],
  // Arcade is the drills and rally; Coach teaches strokes one at a time;
  // Versus is a networked match against another player.
  game: [
    { label: 'Arcade', value: 'arcade' },
    { label: 'Coach', value: 'coach' },
    { label: 'Versus', value: 'versus' },
    { label: 'Tournament', value: 'tournament' },
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
    // Paddle placement driven by a fruit fly's connectome (see flybrain.js)
    { label: 'Fly brain', value: 'fly' },
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
  game: 'arcade', // 'arcade' | 'coach' | 'versus' | 'tournament'
  sound: true,
  aimMarker: true,
  playerName: 'Player', // shown on the leaderboard
  // Stable anonymous browser identity for profile history. This is deliberately
  // separate from the editable display name, so renaming yourself does not
  // split your coaching trends into multiple players.
  playerId: '',
};

const STORAGE_KEY = 'paddlelab-xr.settings';
// The name before the rebrand. Read once, so nobody loses the settings they
// had; never written, so the old key dies with the next save.
const LEGACY_STORAGE_KEY = 'pingpong-trainer-settings';

export class Settings {
  constructor() {
    this.values = { ...DEFAULTS, ...load() };
    if (!this.values.playerId) {
      this.values.playerId = makePlayerId();
      save(this.values);
    }
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
    const raw = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY)
    );
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};

    // Settings are user-controlled browser data. Keep corrupt or stale values
    // from poisoning physics/UI on the next boot, while preserving only keys
    // that the current build actually understands.
    const safe = {};
    for (const [key, value] of Object.entries(raw)) {
      if (!(key in DEFAULTS)) continue;
      if (typeof value !== typeof DEFAULTS[key]) continue;
      if (typeof value === 'string' && value.length > 64) continue;
      if (typeof value === 'number' && !Number.isFinite(value)) continue;
      safe[key] = value;
    }
    return safe;
  } catch {
    return {}; // private browsing, corrupt entry — defaults are fine
  }
}

function makePlayerId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `player-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

function save(values) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(values));
  } catch {
    // Not worth surfacing; settings just won't persist.
  }
}
