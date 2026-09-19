import * as THREE from 'three';
import { TABLE, COLORS } from './constants.js';

// Procedural canvas textures. Everything is generated at runtime so the app
// stays a single self-contained bundle with no image assets to load — which
// also keeps the Quest Browser's first paint fast over a LAN dev server.

const hex = (c) => `#${c.toString(16).padStart(6, '0')}`;

function canvas(w, h) {
  const el = document.createElement('canvas');
  el.width = w;
  el.height = h;
  return { el, ctx: el.getContext('2d') };
}

function toTexture(el, { repeat, anisotropy = 8 } = {}) {
  const tex = new THREE.CanvasTexture(el);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = anisotropy;
  if (repeat) {
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(repeat[0], repeat[1]);
  }
  return tex;
}

// Playing surface: base blue with the boundary, centre and end lines painted
// in. Drawing the lines into the texture avoids five extra coplanar meshes
// and the z-fighting that comes with them.
export function tableSurfaceTexture() {
  const pxPerM = 360;
  const w = Math.round(TABLE.WIDTH * pxPerM);
  const h = Math.round(TABLE.LENGTH * pxPerM);
  const { el, ctx } = canvas(w, h);

  // Near-flat colour. A strong gradient across a surface this large reads as
  // uneven lighting rather than as a material, and it fights the actual
  // lighting in the scene.
  ctx.fillStyle = hex(COLORS.TABLE_BLUE);
  ctx.fillRect(0, 0, w, h);

  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, 'rgba(0,0,0,0.12)');
  grad.addColorStop(0.5, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.12)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  // Faint speckle so the large flat area isn't a dead colour field up close
  ctx.globalAlpha = 0.035;
  for (let i = 0; i < 4000; i++) {
    ctx.fillStyle = i % 2 ? '#ffffff' : '#000000';
    ctx.fillRect(Math.random() * w, Math.random() * h, 2, 2);
  }
  ctx.globalAlpha = 1;

  const line = Math.round(TABLE.LINE_WIDTH * pxPerM);
  ctx.fillStyle = hex(COLORS.LINE);
  ctx.fillRect(0, 0, line, h); // side lines
  ctx.fillRect(w - line, 0, line, h);
  ctx.fillRect(0, 0, w, line); // end lines
  ctx.fillRect(0, h - line, w, line);

  const centre = Math.round(line / 2);
  ctx.fillRect(Math.round(w / 2 - centre / 2), 0, centre, h);

  return toTexture(el, { anisotropy: 16 });
}

// Net mesh: a fine grid drawn once and tiled, with transparent holes.
export function netTexture(repeatX, repeatY) {
  const size = 64;
  const { el, ctx } = canvas(size, size);
  ctx.clearRect(0, 0, size, size);
  ctx.strokeStyle = 'rgba(232,238,245,0.9)';
  ctx.lineWidth = 3.5;
  ctx.beginPath();
  ctx.moveTo(size / 2, 0);
  ctx.lineTo(size / 2, size);
  ctx.moveTo(0, size / 2);
  ctx.lineTo(size, size / 2);
  ctx.stroke();

  const tex = new THREE.CanvasTexture(el);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.anisotropy = 8;
  return tex;
}

// Ball: off-white with a seam and a brand dot. Without a marking the ball's
// spin is completely invisible, which hides the most important cue the
// trainer gives you.
export function ballTexture() {
  const w = 256;
  const h = 128;
  const { el, ctx } = canvas(w, h);

  ctx.fillStyle = hex(COLORS.BALL);
  ctx.fillRect(0, 0, w, h);

  // Shading band so the sphere doesn't read as a flat disc
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, 'rgba(0,0,0,0.10)');
  grad.addColorStop(0.5, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.10)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = 'rgba(0,0,0,0.22)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();

  ctx.fillStyle = 'rgba(200,60,60,0.85)';
  ctx.beginPath();
  ctx.arc(w * 0.28, h * 0.32, 11, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = 'rgba(40,60,90,0.7)';
  ctx.font = 'bold 22px system-ui, sans-serif';
  ctx.fillText('3★', w * 0.62, h * 0.4);

  return toTexture(el);
}

// Venue floor: sports-hall boards.
export function floorTexture() {
  const size = 512;
  const { el, ctx } = canvas(size, size);
  ctx.fillStyle = hex(COLORS.FLOOR);
  ctx.fillRect(0, 0, size, size);

  const plank = size / 8;
  for (let i = 0; i < 8; i++) {
    ctx.fillStyle = `rgba(255,220,180,${0.012 + (i % 3) * 0.008})`;
    ctx.fillRect(0, i * plank, size, plank - 2);
    ctx.fillStyle = 'rgba(0,0,0,0.38)';
    ctx.fillRect(0, i * plank + plank - 2, size, 2);
  }
  // Staggered board ends
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  for (let i = 0; i < 8; i++) {
    ctx.fillRect(((i * 197) % size), i * plank, 2, plank);
  }
  return toTexture(el, { repeat: [6, 6] });
}
