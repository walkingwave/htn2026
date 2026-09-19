import * as THREE from 'three';
import { COLORS } from './constants.js';
import { SCOREBOARD_POSITION } from './game.js';

// In-world scoreboard. A DOM overlay is invisible once you're in an immersive
// session, so the stats have to live in the scene as geometry.
//
// Everything here is sized for the one viewing condition that matters: the
// player standing at the near end, roughly 4.3 m away. The panel subtends
// about 30° of view, and a Quest resolves ~20 pixels per degree, so a canvas
// pixel is worth well under half a display pixel. Anything under ~50 canvas px
// is mush at that distance — which is why this board carries five numbers in
// very large type rather than a dense stat block.
//
// The canvas is only redrawn when a displayed value actually changes —
// repainting and re-uploading a texture this size every frame would cost more
// than the rest of the scene combined on a Quest.

const W = 2048;
const H = 1024;

const PANEL_W = 2.0; // metres
const PANEL_H = PANEL_W * (H / W);

const hex = (c) => `#${c.toString(16).padStart(6, '0')}`;

// Same three inks and single monospace face as the flat shell (ui.css) and the
// in-VR menu, so the board reads as part of the same retro terminal. The dim
// tones are lifted well above the CSS values: 45% grey on black is a readable
// caption on a monitor and an invisible one across a room in a headset.
const PAPER = '#f2efe6';
const DIM = 'rgba(242,239,230,0.72)';
const FAINT = 'rgba(242,239,230,0.34)';
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

const L = 96; // left margin, clear of the register bar
const R = 96; // right margin

// Canvas has no letter-spacing everywhere we run (ctx.letterSpacing is
// Chromium-only), and the wide tracking is the whole look of the flat menu —
// so lay the glyphs out by hand. Only runs when a value changes, never per
// frame, so the per-character cost is irrelevant.
function trackedWidth(ctx, text, spacing) {
  let w = 0;
  for (const ch of text) w += ctx.measureText(ch).width + spacing;
  return text.length ? w - spacing : 0;
}

// Draws `text` with `spacing` px between glyphs. `align` is 'left' or 'right';
// for 'right', `x` is the right edge. Returns the left edge used.
function tracked(ctx, text, x, y, spacing, align = 'left') {
  let cx = align === 'right' ? x - trackedWidth(ctx, text, spacing) : x;
  const left = cx;
  for (const ch of text) {
    ctx.fillText(ch, cx, y);
    cx += ctx.measureText(ch).width + spacing;
  }
  return left;
}

export class Scoreboard {
  constructor(game, machine) {
    this.game = game;
    this.machine = machine;
    this._lastRevision = -1;
    this._lastServed = -1;

    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d');

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 16; // the panel is viewed at a slant from below
    this.texture.generateMipmaps = true;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;

    const panel = new THREE.Mesh(
      new THREE.PlaneGeometry(PANEL_W, PANEL_H),
      new THREE.MeshBasicMaterial({
        map: this.texture,
        transparent: true,
        toneMapped: false,
      })
    );

    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(PANEL_W + 0.06, PANEL_H + 0.06, 0.02),
      new THREE.MeshStandardMaterial({ color: 0x0a0a0b, roughness: 0.7 })
    );
    frame.position.z = -0.015;

    this.mesh = new THREE.Group();
    this.mesh.add(frame);
    this.mesh.add(panel);
    this.mesh.position.set(
      SCOREBOARD_POSITION.x,
      SCOREBOARD_POSITION.y,
      SCOREBOARD_POSITION.z
    );
    this.mesh.rotation.x = 0.12; // tip the face up toward the player

    this.draw();
  }

  update() {
    if (
      this.game.revision === this._lastRevision &&
      this.machine.servedCount === this._lastServed
    ) {
      return;
    }
    this._lastRevision = this.game.revision;
    this._lastServed = this.machine.servedCount;
    this.draw();
  }

  draw() {
    const { ctx, game, machine } = this;
    const red = hex(COLORS.ACCENT);

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0b0b0c';
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    // Red register bar down the left edge, echoing the start menu
    ctx.fillStyle = red;
    ctx.fillRect(0, 0, 18, H);

    this._brackets();

    // --- Header: mode name, and whether the machine is firing -------------
    const title = machine.drill.name.toUpperCase();
    ctx.font = `700 84px ${MONO}`;
    ctx.fillStyle = red;
    ctx.fillText('▸', L, 136);
    ctx.fillStyle = PAPER;
    tracked(ctx, title, L + 92, 136, 12);

    // State is the thing you glance up for mid-rally, so it gets the same
    // weight as the title rather than caption size.
    const armed = machine.enabled;
    ctx.font = `700 60px ${MONO}`;
    ctx.fillStyle = armed ? red : DIM;
    tracked(ctx, armed ? 'ARMED' : 'PAUSED', W - R, 132, 10, 'right');

    this._rule(186);

    // --- Primary stat -----------------------------------------------------
    // Targets in target practice, otherwise the rally streak. Big enough to
    // read peripherally, without turning to look straight at the board.
    const kind = machine.mode.type;
    const primary =
      kind === 'target'
        ? { value: game.targetsHit, label: 'TARGETS' }
        : kind === 'rally'
          ? { value: game.rally, label: 'RALLY' }
          : kind === 'coach'
            ? { value: game.lessonScore, label: 'MATCH %' }
            : { value: game.streak, label: 'STREAK' };

    ctx.fillStyle = PAPER;
    ctx.font = `700 300px ${MONO}`;
    ctx.fillText(String(primary.value), L, 520);

    ctx.fillStyle = red;
    ctx.font = `700 54px ${MONO}`;
    tracked(ctx, primary.label, L + 8, 600, 10);

    // --- Secondary stats --------------------------------------------------
    // Three, not four: a fourth column costs every number ~25% of its width
    // and buys a figure nobody reads mid-drill.
    const stats =
      kind === 'coach'
        ? [
            ['BEST', game.lessonBest],
            ['TRIES', game.lessonAttempts],
            ['', ''],
          ]
        : kind === 'target'
        ? [
            ['HITS', game.hits],
            ['MISSES', game.misses],
            ['STREAK', game.streak],
          ]
        : kind === 'rally'
          ? [
              ['BEST', game.longestRally],
              ['HITS', game.hits],
              ['MISSES', game.misses],
            ]
          : [
              ['RETURNS', game.returns],
              ['MISSES', game.misses],
              ['BEST', game.bestStreak],
            ];

    const colW = 320;
    let x = W - R - colW * stats.length + 40;
    for (const [label, value] of stats) {
      ctx.fillStyle = PAPER;
      ctx.font = `700 132px ${MONO}`;
      ctx.fillText(String(value), x, 440);
      ctx.fillStyle = DIM;
      ctx.font = `500 40px ${MONO}`;
      tracked(ctx, label, x, 502, 6);
      x += colW;
    }

    this._rule(660);

    // --- Accuracy meter ---------------------------------------------------
    // Blocks rather than a bar: a 20 px-tall bar vanishes at this distance,
    // and discrete cells stay legible even when the edge blurs.
    const CELLS = 20;
    const filled = Math.round((CELLS * game.accuracy) / 100);
    const METER_W = 1180; // runs to just short of the percentage readout
    const GAP = 10;
    const cellW = (METER_W - GAP * (CELLS - 1)) / CELLS;
    for (let i = 0; i < CELLS; i++) {
      ctx.fillStyle = i < filled ? red : 'rgba(242,239,230,0.16)';
      ctx.fillRect(L + i * (cellW + GAP), 736, cellW, 58);
    }

    ctx.fillStyle = PAPER;
    ctx.font = `700 62px ${MONO}`;
    tracked(
      ctx,
      `${String(game.accuracy).padStart(3, ' ')}% ON-TABLE`,
      W - R,
      786,
      8,
      'right'
    );

    // --- Last event -------------------------------------------------------
    // The one line that changes on every ball, so it reads as a status light:
    // red for a fault, paper for a good return.
    // In a lesson this line carries the coaching instead — what to do now,
    // or what the last few attempts say you should work on. That is the
    // whole point of the mode, so it gets the status slot rather than a
    // ball-by-ball event nobody is watching for.
    const coaching = machine.mode.type === 'coach' && this.coach;
    const event = (coaching ? this.coach.instruction : game.lastEvent).toUpperCase();
    const fault = !coaching && event.startsWith('MISS');
    ctx.fillStyle = fault ? red : DIM;
    // The advice runs longer than an event word, so it is set smaller and
    // tighter to stay on one line at this width.
    ctx.font = `700 ${coaching ? 40 : 56}px ${MONO}`;
    tracked(ctx, event, L, 912, coaching ? 4 : 9);

    if (!coaching) {
      ctx.fillStyle = FAINT;
      ctx.font = `500 44px ${MONO}`;
      tracked(ctx, `SERVED ${machine.servedCount}`, W - R, 912, 7, 'right');
    }

    this.texture.needsUpdate = true;
  }

  _rule(y) {
    const { ctx } = this;
    ctx.strokeStyle = FAINT;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(L, y);
    ctx.lineTo(W - R, y);
    ctx.stroke();
  }

  _brackets() {
    const { ctx } = this;
    const m = 34; // inset from the panel edge
    const lm = 52; // left corners clear the red register bar
    const len = 84;
    ctx.strokeStyle = FAINT;
    ctx.lineWidth = 6;
    for (const [cx, cy, sx, sy] of [
      [lm, m, 1, 1],
      [W - m, m, -1, 1],
      [lm, H - m, 1, -1],
      [W - m, H - m, -1, -1],
    ]) {
      ctx.beginPath();
      ctx.moveTo(cx + sx * len, cy);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx, cy + sy * len);
      ctx.stroke();
    }
  }
}
