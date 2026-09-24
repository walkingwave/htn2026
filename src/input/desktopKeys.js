// Keyboard alternative, for playing without a mouse.
//
// UI owns the single keydown listener for *commands* (pause, skip mode, mute);
// these are movement keys sampled every frame by the bat, so they live here and
// stay out of UI's way. One listener for both would fire every shortcut twice.

export const DESKTOP_KEYS = {
  ArrowLeft: 0,
  ArrowRight: 0,
  ArrowUp: 0,
  ArrowDown: 0,
  KeyF: 0,
};

/**
 * Bind the desktop bat's key handling.
 *
 * @param {object} handlers
 * @param {() => boolean} [handlers.isBlocked]  true while something owns the
 *   keyboard (the menu); both keydown and keyup are then ignored.
 * @param {(e: KeyboardEvent) => boolean} [handlers.onCommand]  handles the
 *   bat's own shortcuts (re-learn colour, flip tilt, tuning panel) and returns
 *   true when it consumed the event.
 * @param {() => void} [handlers.onSwing]  called on the swing key.
 * @returns {() => void} an unbind function.
 */
export function bindDesktopKeys({ isBlocked, onCommand, onSwing } = {}) {
  const blocked = isBlocked ?? (() => false);

  const onKeyDown = (event) => {
    if (blocked()) return;
    if (onCommand?.(event)) return;
    if (!(event.code in DESKTOP_KEYS)) return;
    DESKTOP_KEYS[event.code] = 1;
    if (event.code === 'KeyF') onSwing?.();
  };

  const onKeyUp = (event) => {
    if (event.code in DESKTOP_KEYS) DESKTOP_KEYS[event.code] = 0;
  };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  return () => {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    for (const code of Object.keys(DESKTOP_KEYS)) DESKTOP_KEYS[code] = 0;
  };
}
