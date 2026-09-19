import * as THREE from 'three';
import { COLORS } from './constants.js';
import { SCOREBOARD_POSITION } from './game.js';

// In-world scoreboard. A DOM overlay is invisible once you're in an immersive
// session, so the stats have to live in the scene as geometry.
//
// The canvas is only redrawn when a displayed value actually changes —
// repainting and re-uploading a 1024px texture every frame would cost more
// than the rest of the scene combined on a Quest.

const W = 1024;
const H = 512;

const hex = (c) => `#${c.toString(16).padStart(6, '0')}`;

// Same three inks and single monospace face as the flat shell (ui.css) and the
// in-VR menu, so the board reads as part of the same retro terminal.
const PAPER = '#f2efe6';
const DIM = 'rgba(242,239,230,0.45)';
const FAINT = 'rgba(242,239,230,0.22)';
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

const L = 56; // left margin, clear of the register bar
const R = 56; // right margin

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
    this.texture.anisotropy = 8;

    const panel = new THREE.Mesh(
      new THREE.PlaneGeometry(1.4, 0.7),
      new THREE.MeshBasicMaterial({
        map: this.texture,
        transparent: true,
        toneMapped: false,
      })
    );

    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(1.46, 0.76, 0.02),
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

    // CRT scanlines — the one piece of texture the flat shell can't do in CSS
    ctx.fillStyle = 'rgba(0,0,0,0.30)';
    for (let y = 0; y < H; y += 4) ctx.fillRect(0, y, W, 2);

    // Red register bar down the left edge, echoing the start menu
    ctx.fillStyle = red;
    ctx.fillRect(0, 0, 10, H);

    // Corner brackets instead of a full frame: the menu has no boxes
    this._brackets();

    // Header: caret + mode name, same row shape as a menu item
    const title = machine.drill.name.toUpperCase();
    ctx.font = `700 36px ${MONO}`;
    ctx.fillStyle = red;
    ctx.fillText('▸', L, 78);
    ctx.fillStyle = PAPER;
    tracked(ctx, title, L + 42, 78, 5.8);

    // Armed state is a line of text, not a badge
    const armed = machine.enabled;
    ctx.font = `500 24px ${MONO}`;
    ctx.fillStyle = armed ? red : DIM;
    tracked(ctx, armed ? 'ARMED' : 'PAUSED', W - R, 76, 5, 'right');

    this._rule(104);

    // Primary stat: targets in target practice, otherwise the rally streak
    const targeting = machine.mode.type === 'target';
    ctx.fillStyle = PAPER;
    ctx.font = `700 150px ${MONO}`;
    const big = String(targeting ? game.targetsHit : game.streak);
    ctx.fillText(big, L, 252);

    ctx.fillStyle = red;
    ctx.font = `500 24px ${MONO}`;
    tracked(ctx, targeting ? 'TARGETS' : 'STREAK', L + 4, 296, 4.6);

    // Secondary stats, laid out as a tracked column list
    const stats = targeting
      ? [
          ['RETURNS', game.returns],
          ['HITS', game.hits],
          ['MISSES', game.misses],
          ['STREAK', game.streak],
        ]
      : [
          ['RETURNS', game.returns],
          ['HITS', game.hits],
          ['MISSES', game.misses],
          ['BEST', game.bestStreak],
        ];
    let x = 430;
    for (const [label, value] of stats) {
      ctx.fillStyle = PAPER;
      ctx.font = `700 58px ${MONO}`;
      ctx.fillText(String(value), x, 222);
      ctx.fillStyle = DIM;
      ctx.font = `500 19px ${MONO}`;
      tracked(ctx, label, x, 264, 3.2);
      x += 150;
    }

    this._rule(322);

    // Accuracy as a block meter — the retro stand-in for a progress bar
    const CELLS = 28;
    const filled = Math.round((CELLS * game.accuracy) / 100);
    ctx.font = `500 30px ${MONO}`;
    const cellW = ctx.measureText('█').width + 3;
    for (let i = 0; i < CELLS; i++) {
      ctx.fillStyle = i < filled ? red : FAINT;
      ctx.fillText('█', L + i * cellW, 382);
    }

    ctx.fillStyle = PAPER;
    ctx.font = `500 23px ${MONO}`;
    tracked(
      ctx,
      `${String(game.accuracy).padStart(3, ' ')}% ON-TABLE`,
      W - R,
      380,
      3.4,
      'right'
    );

    // Status line: last event on the left, serve count on the right
    ctx.fillStyle = DIM;
    ctx.font = `500 20px ${MONO}`;
    tracked(ctx, game.lastEvent.toUpperCase(), L, 428, 3.2);
    tracked(ctx, `SERVED ${machine.servedCount}`, W - R, 428, 3.2, 'right');

    // Key hints, styled like the flat shell's bottom bar: bold key, dim action
    this._keys(
      [
        ['TRIGGER', 'PAUSE'],
        ['GRIP', 'NEXT MODE'],
        ['A/B', 'MENU'],
      ],
      466
    );

    this.texture.needsUpdate = true;
  }

  _rule(y) {
    const { ctx } = this;
    ctx.strokeStyle = FAINT;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(L, y);
    ctx.lineTo(W - R, y);
    ctx.stroke();
  }

  _brackets() {
    const { ctx } = this;
    const m = 20; // inset from the panel edge
    const len = 46;
    ctx.strokeStyle = FAINT;
    ctx.lineWidth = 3;
    for (const [cx, cy, sx, sy] of [
      [m, m, 1, 1],
      [W - m, m, -1, 1],
      [m, H - m, 1, -1],
      [W - m, H - m, -1, -1],
    ]) {
      ctx.beginPath();
      ctx.moveTo(cx + sx * len, cy);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx, cy + sy * len);
      ctx.stroke();
    }
  }

  _keys(pairs, y) {
    const { ctx } = this;
    let x = L;
    pairs.forEach(([key, action], i) => {
      if (i > 0) {
        ctx.fillStyle = FAINT;
        ctx.font = `500 19px ${MONO}`;
        ctx.fillText('·', x, y);
        x += 26;
      }
      ctx.fillStyle = PAPER;
      ctx.font = `700 19px ${MONO}`;
      tracked(ctx, key, x, y, 3);
      x += trackedWidth(ctx, key, 3) + 12;

      ctx.fillStyle = DIM;
      ctx.font = `500 19px ${MONO}`;
      tracked(ctx, action, x, y, 3);
      x += trackedWidth(ctx, action, 3) + 26;
    });
  }
}
