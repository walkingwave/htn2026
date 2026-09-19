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

export function buildPauseMenu({ machine, settings, game, onExit, onResume }) {
  const cycle = (key) => {
    const choices = OPTIONS[key];
    const index = Math.max(
      0,
      choices.findIndex((c) => c.value === settings.get(key))
    );
    return {
      id: key,
      kind: 'cycle',
      value: choices[index].label,
      step: (delta) => {
        const next = (index + delta + choices.length) % choices.length;
        settings.set(key, choices[next].value);
      },
    };
  };

  const modeIndex = machine.modeIndex;

  return [
    { id: 'resume', kind: 'action', label: 'Resume', activate: onResume },
    {
      id: 'mode',
      kind: 'cycle',
      label: 'Mode',
      value: MODES[modeIndex].name,
      step: (delta) => {
        machine.modeIndex =
          (modeIndex + delta + MODES.length) % MODES.length;
        game.revision++;
      },
    },
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
      id: 'reset',
      kind: 'action',
      label: 'Reset score',
      activate: () => game.reset(),
    },
    { id: 'exit', kind: 'action', label: 'Quit to menu', activate: onExit },
  ];
}
