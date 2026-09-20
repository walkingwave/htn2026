import { OPTIONS } from './settings.js';
import { MODES } from './ballMachine.js';

// One description of the in-game menu, rendered twice: as DOM for the flat
// screen and as a canvas panel in world space for the headset. Keeping the
// model here means the two can't drift apart as options are added.
//
// `kind` tells a renderer how to draw a row:
//   action — a plain selectable line
//   cycle  — a value with ‹ › affordances, stepped by `step(delta)`
//   toggle — an on/off value, flipped by `step()`

export function buildPauseMenu({
  machine,
  settings,
  game,
  onExit,
  onResume,
  onRecenter,
  inXR = false,
}) {
  // Not every option in a list belongs in this menu.
  //
  // Versus is set up in the start menu, where the lobby lives; cycling to it
  // mid-session left the table empty and the player in a game with nobody in
  // it. The webcam bat is a flat-screen input — in a headset there is a
  // tracked hand to use instead, and picking it only opened a camera that
  // cannot see the bat.
  const hidden = {
    game: ['versus'],
    paddleSource: inXR ? ['camera'] : [],
  };

  const cycle = (key) => {
    const choices = OPTIONS[key].filter((c) => !(hidden[key] ?? []).includes(c.value));
    const current = settings.get(key);
    const index = choices.findIndex((c) => c.value === current);
    const off = index < 0; // the value in force is one this menu hides

    return {
      id: key,
      kind: 'cycle',
      // Name what is actually set, even when it is an option this menu will
      // not offer. Falling through to choices[0] made the pause menu report
      // "Arcade" in the middle of a Versus match.
      value: off
        ? (OPTIONS[key].find((c) => c.value === current)?.label ?? '—')
        : choices[index].label,
      step: (delta) => {
        if (!choices.length) return;
        // From a hidden value, a step lands on the first real option rather
        // than somewhere that depends on where the hidden one used to sit.
        const from = off ? (delta > 0 ? -1 : 0) : index;
        const next = (from + delta + choices.length) % choices.length;
        settings.set(key, choices[next].value);
      },
    };
  };

  const modeIndex = machine.modeIndex;

  // Coach and Arcade want different second rows: one picks a situation to
  // drill, the other picks which drill is running.
  const coaching = settings.get('game') === 'coach';
  const modeRow = coaching
    ? { ...cycle('scenario'), label: 'Scenario' }
    : {
        id: 'mode',
        kind: 'cycle',
        label: 'Mode',
        value: MODES[modeIndex].name,
        step: (delta) => {
          machine.modeIndex = (modeIndex + delta + MODES.length) % MODES.length;
          game.revision++;
        },
      };

  return [
    { id: 'resume', kind: 'action', label: 'Resume', activate: onResume },
    modeRow,
    { ...cycle('game'), label: 'Game' },
    { ...cycle('paddleSource'), label: 'Paddle input' },
    { ...cycle('difficulty'), label: 'Opponent' },

    { ...cycle('hand'), label: 'Paddle hand' },
    { ...cycle('pace'), label: 'Ball pace' },
    { ...cycle('feedRate'), label: 'Feed rate' },
    { ...cycle('placement'), label: 'Placement' },
    {
      id: 'sound',
      kind: 'toggle',
      label: 'Sound',
      value: settings.get('sound') ? 'On' : 'Off',
      step: () => settings.set('sound', !settings.get('sound')),
    },
    {
      id: 'aimMarker',
      kind: 'toggle',
      label: 'Aim marker',
      value: settings.get('aimMarker') ? 'On' : 'Off',
      step: () => settings.set('aimMarker', !settings.get('aimMarker')),
    },
    {
      id: 'recenter',
      kind: 'action',
      label: 'Recentre table',
      activate: () => onRecenter?.(),
    },
    {
      id: 'reset',
      kind: 'action',
      label: 'Reset score',
      activate: () => game.reset(),
    },
    { id: 'exit', kind: 'action', label: 'Quit to menu', activate: onExit },
  ];
}
