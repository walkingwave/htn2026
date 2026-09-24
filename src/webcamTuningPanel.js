// The live tuning panel for the webcam paddle, opened with T.
//
// All of it is tuning, none of it is game state, and it is the only part of the
// desktop input path that builds DOM — so it lives on its own. Values are
// persisted by the caller, which owns the tuning object.

export const TUNING_ROWS = [
  ['gainX', 'Reach · sideways', 1, 4, 0.1],
  ['gainY', 'Reach · vertical', 0.8, 3, 0.1],
  ['stiffness', 'Response (snappy ↔ smooth)', 6, 30, 1],
  ['maxSpeed', 'Max paddle speed', 2, 10, 0.5],
  ['swingSpeed', 'Swing flick threshold', 0.15, 0.8, 0.05],
  ['assistRange', 'Assist · catch radius', 0.08, 0.4, 0.02],
  ['assistPull', 'Assist · strength', 0.08, 0.4, 0.02],
  ['assistSlew', 'Assist · speed', 0.5, 3, 0.1],
  ['assistHorizon', 'Assist · look-ahead', 0.08, 0.3, 0.01],
  ['lead', 'Latency lead', 0, 0.15, 0.01],
  ['camEase', 'Camera follow', 1, 8, 0.5],
];

/**
 * A lazily-built panel the player can show and hide.
 *
 * @param {object} options
 * @param {Record<string, number>} options.tuning    live values, mutated in place
 * @param {Record<string, number>} options.defaults  values the reset button restores
 * @param {() => void} options.save                  called after every change
 */
export function createTuningPanel({ tuning, defaults, save }) {
  let el = null;

  const build = () => {
    const panel = document.createElement('div');
    panel.id = 'webcam-tuning';
    panel.setAttribute('role', 'group');
    panel.setAttribute('aria-label', 'Webcam paddle tuning');
    // Capped and scrollable so the panel cannot push its own controls off the
    // bottom of a short window — it is the only way back to a working paddle.
    panel.style.cssText =
      'position:fixed;right:12px;top:12px;z-index:40;background:rgba(11,11,12,0.95);' +
      'border-left:6px solid #e2231a;padding:14px 16px;width:min(280px,calc(100vw - 48px));' +
      'max-height:calc(100vh - 24px);overflow-y:auto;' +
      'font:12px ui-monospace,monospace;color:#f2efe6;';
    panel.innerHTML =
      '<div style="color:#e2231a;font-weight:700;margin-bottom:8px">PADDLE TUNING</div>' +
      '<div data-rows></div>' +
      '<button type="button" data-reset style="margin-top:8px;background:none;border:1px solid #555;' +
      'color:#f2efe6;font:inherit;padding:3px 10px;cursor:pointer">Reset defaults</button>' +
      '<div style="color:rgba(242,239,230,0.4);margin-top:6px">T to close · saved automatically</div>';
    document.body.appendChild(panel);

    const rows = panel.querySelector('[data-rows]');
    const renderRows = () => {
      rows.innerHTML = '';
      for (const [key, label, min, max, step] of TUNING_ROWS) {
        const row = document.createElement('label');
        row.style.cssText = 'display:block;margin:6px 0';
        const value = document.createElement('span');
        value.style.cssText = 'float:right;color:#e2231a';
        value.textContent = tuning[key];
        const input = document.createElement('input');
        input.type = 'range';
        input.min = min;
        input.max = max;
        input.step = step;
        input.value = tuning[key];
        // The wrapping <label> names the slider for pointer users; the explicit
        // attribute is what a screen reader announces while dragging.
        input.setAttribute('aria-label', label);
        input.style.cssText = 'width:100%;accent-color:#e2231a';
        input.oninput = () => {
          tuning[key] = Number(input.value);
          value.textContent = input.value;
          save();
        };
        row.append(label + ' ', value, input);
        rows.appendChild(row);
      }
    };
    renderRows();

    panel.querySelector('[data-reset]').onclick = () => {
      Object.assign(tuning, defaults);
      save();
      renderRows();
    };
    return panel;
  };

  return {
    toggle() {
      if (!el) {
        el = build();
        el.querySelector('input')?.focus();
        return;
      }
      el.hidden = !el.hidden;
      if (!el.hidden) el.querySelector('input')?.focus();
    },
    get element() {
      return el;
    },
  };
}
