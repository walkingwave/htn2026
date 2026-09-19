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

const PAPER = '#f2efe6';
const MONO = 'ui-monospace, "SF Mono", Menlo, monospace';
const SANS = 'Inter, "Helvetica Neue", Helvetica, Arial, sans-serif';

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
    ctx.fillStyle = '#0a0a0b';
    ctx.fillRect(0, 0, W, H);

    // Red register bar down the left edge, echoing the start menu
    ctx.fillStyle = red;
    ctx.fillRect(0, 0, 14, H);

    ctx.strokeStyle = 'rgba(242,239,230,0.16)';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, W - 2, H - 2);

    const L = 52; // left margin, clear of the register bar

    // Header: mode name and armed state
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = PAPER;
    ctx.font = `700 40px ${SANS}`;
    ctx.fillText(machine.drill.name.toUpperCase(), L, 76);

    const armed = machine.enabled;
    ctx.font = `500 22px ${MONO}`;
    const stateLabel = armed ? 'ARMED' : 'PAUSED';
    const labelWidth = ctx.measureText(stateLabel).width;
    if (armed) {
      ctx.fillStyle = red;
      ctx.fillRect(W - 48 - labelWidth - 20, 50, labelWidth + 20, 32);
      ctx.fillStyle = PAPER;
    } else {
      ctx.strokeStyle = 'rgba(242,239,230,0.3)';
      ctx.lineWidth = 2;
      ctx.strokeRect(W - 48 - labelWidth - 20, 50, labelWidth + 20, 32);
      ctx.fillStyle = 'rgba(242,239,230,0.5)';
    }
    ctx.textAlign = 'right';
    ctx.fillText(stateLabel, W - 58, 74);
    ctx.textAlign = 'left';

    ctx.strokeStyle = 'rgba(242,239,230,0.16)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(L, 104);
    ctx.lineTo(W - 48, 104);
    ctx.stroke();

    // Primary stat: targets in target practice, otherwise the rally streak
    const targeting = machine.mode.type === 'target';
    ctx.fillStyle = PAPER;
    ctx.font = `700 150px ${MONO}`;
    ctx.fillText(String(targeting ? game.targetsHit : game.streak), L, 258);

    ctx.fillStyle = red;
    ctx.font = `500 26px ${MONO}`;
    ctx.fillText(targeting ? 'TARGETS' : 'STREAK', L + 4, 300);

    // Secondary stats
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
    let x = 420;
    for (const [label, value] of stats) {
      ctx.fillStyle = PAPER;
      ctx.font = `700 60px ${MONO}`;
      ctx.fillText(String(value), x, 226);
      ctx.fillStyle = 'rgba(242,239,230,0.42)';
      ctx.font = `500 21px ${MONO}`;
      ctx.fillText(label, x, 266);
      x += 152;
    }

    // Accuracy bar — square, drawn as a ruled track with a solid red fill
    const barY = 344;
    const barW = W - L - 48;
    ctx.strokeStyle = 'rgba(242,239,230,0.22)';
    ctx.lineWidth = 2;
    ctx.strokeRect(L, barY, barW, 22);
    ctx.fillStyle = red;
    ctx.fillRect(L, barY, (barW * game.accuracy) / 100, 22);

    ctx.fillStyle = 'rgba(242,239,230,0.62)';
    ctx.font = `500 24px ${MONO}`;
    ctx.fillText(`ON-TABLE ${String(game.accuracy).padStart(3, ' ')}%`, L, 414);

    ctx.fillStyle = 'rgba(242,239,230,0.4)';
    ctx.textAlign = 'right';
    ctx.fillText(
      `SERVED ${machine.servedCount} / ${game.lastEvent.toUpperCase()}`,
      W - 48,
      414
    );

    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(242,239,230,0.26)';
    ctx.font = `500 21px ${MONO}`;
    ctx.fillText('TRIGGER PAUSE   ·   GRIP NEXT MODE', L, 462);

    this.texture.needsUpdate = true;
  }
}
