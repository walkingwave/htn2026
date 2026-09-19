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

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
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
      new THREE.MeshStandardMaterial({ color: 0x0b0d12, roughness: 0.6 })
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

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(10,13,20,0.92)';
    roundRect(ctx, 0, 0, W, H, 34);
    ctx.fill();

    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 3;
    roundRect(ctx, 6, 6, W - 12, H - 12, 30);
    ctx.stroke();

    // Header: drill name and armed state
    ctx.fillStyle = hex(COLORS.ACCENT);
    ctx.font = 'bold 44px system-ui, sans-serif';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(machine.drill.name.toUpperCase(), 48, 82);

    ctx.fillStyle = machine.enabled ? hex(COLORS.ACCENT) : '#8a3a3a';
    ctx.beginPath();
    ctx.arc(W - 70, 66, 15, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = '26px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(machine.enabled ? 'ARMED' : 'PAUSED', W - 100, 76);
    ctx.textAlign = 'left';

    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(48, 108);
    ctx.lineTo(W - 48, 108);
    ctx.stroke();

    // Primary stat: targets in target practice, otherwise the rally streak
    const targeting = machine.mode.type === 'target';
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 150px system-ui, sans-serif';
    ctx.fillText(String(targeting ? game.targetsHit : game.streak), 48, 262);

    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '30px system-ui, sans-serif';
    ctx.fillText(targeting ? 'TARGETS' : 'STREAK', 52, 306);

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
    let x = 430;
    for (const [label, value] of stats) {
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 62px system-ui, sans-serif';
      ctx.fillText(String(value), x, 230);
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.font = '24px system-ui, sans-serif';
      ctx.fillText(label, x, 272);
      x += 150;
    }

    // Accuracy bar
    const barY = 350;
    const barW = W - 96;
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    roundRect(ctx, 48, barY, barW, 26, 13);
    ctx.fill();

    ctx.fillStyle = hex(COLORS.ACCENT);
    roundRect(ctx, 48, barY, Math.max(26, (barW * game.accuracy) / 100), 26, 13);
    ctx.fill();

    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.font = '28px system-ui, sans-serif';
    ctx.fillText(`ON-TABLE RETURNS  ${game.accuracy}%`, 48, 418);

    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.font = '26px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`SERVED ${machine.servedCount}  ·  ${game.lastEvent}`, W - 48, 418);

    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    ctx.font = '24px system-ui, sans-serif';
    ctx.fillText('TRIGGER  pause  ·  GRIP  next drill', 48, 468);

    this.texture.needsUpdate = true;
  }
}
