import * as THREE from 'three';
import { COLORS } from './constants.js';
import { buildPauseMenu } from './menuModel.js';

// The same retro menu as the flat shell, rendered in world space so it exists
// inside the headset — DOM overlays are simply not visible in an immersive
// session.
//
// Two ways in, because both hands and head are tracked:
//   • point a controller and pull the trigger
//   • or just look at a row and hold your gaze — the dwell ring fills and
//     activates, so the menu is fully usable with head tracking alone
//
// The panel is placed in front of wherever you're facing when it opens and
// then stays put, rather than chasing your head every frame, which is both
// nauseating and impossible to point at.

const W = 1024;
const H = 768;
const PANEL_WIDTH = 0.95;
const PANEL_HEIGHT = (PANEL_WIDTH * H) / W;

const ROW_TOP = 176;
const ROW_BOTTOM = 700; // rows must finish above the footer
const ROW_H_MAX = 52;

// Row height adapts to how many entries there are. Twice now a new setting
// has pushed the last rows off the bottom of the panel, so the layout
// derives from the list rather than being a constant to remember to update.
function rowHeight(count) {
  if (count <= 0) return ROW_H_MAX;
  return Math.min(ROW_H_MAX, (ROW_BOTTOM - ROW_TOP) / count);
}
const DWELL_TIME = 1.4; // seconds of sustained gaze to activate
const DWELL_STEPS = 20; // visible increments of the dwell bar; see update()

const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
const PAPER = '#f2efe6';
const DIM = 'rgba(242,239,230,0.45)';
const ACCENT = `#${COLORS.ACCENT.toString(16).padStart(6, '0')}`;

const _raycaster = new THREE.Raycaster();
const _origin = new THREE.Vector3();
const _direction = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _camDir = new THREE.Vector3();
const _matrix = new THREE.Matrix4();

export class VRMenu {
  constructor({ camera, machine, game, settings, sfx, onExit }) {
    Object.assign(this, { camera, machine, game, settings, sfx, onExit });

    this.open = false;
    this.items = [];
    this.hovered = -1;
    this.usingGaze = false;

    this._dwell = 0;
    this._dwellStep = -1;
    this._dwellSpent = false;
    this._dirty = true;

    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d');

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 8;

    this.panel = new THREE.Mesh(
      new THREE.PlaneGeometry(PANEL_WIDTH, PANEL_HEIGHT),
      new THREE.MeshBasicMaterial({
        map: this.texture,
        transparent: true,
        toneMapped: false,
      })
    );

    this.group = new THREE.Group();
    this.group.add(this.panel);
    this.group.visible = false;

    // Reticle that rides the intersection point
    this.reticle = new THREE.Mesh(
      new THREE.CircleGeometry(0.006, 16),
      new THREE.MeshBasicMaterial({ color: COLORS.ACCENT, toneMapped: false })
    );
    this.reticle.visible = false;
    this.group.add(this.reticle);
  }

  // --- Visibility -------------------------------------------------------

  toggle(force) {
    const next = force ?? !this.open;
    if (next === this.open) return;
    this.open = next;
    this.group.visible = next;
    this._dwell = 0;
    this._dwellStep = -1;
    this._dwellSpent = false;
    this.hovered = -1;

    if (next) {
      this.items = this._buildItems();
      this._place();
      this._dirty = true;
    }
    this.sfx.ui(next);
  }

  // Drops the panel centred on wherever the player is looking when it opens.
  //
  // Pitch is clamped rather than flattened: flattening puts the panel out of
  // view whenever you open it while looking down at the table, but following
  // the gaze exactly would stick it on the floor.
  _place() {
    this.camera.getWorldPosition(_camPos);
    this.camera.getWorldDirection(_camDir);

    _camDir.y = THREE.MathUtils.clamp(_camDir.y, -0.45, 0.45);
    if (_camDir.lengthSq() < 1e-6) _camDir.set(0, 0, -1);
    _camDir.normalize();

    this.group.position.copy(_camPos).addScaledVector(_camDir, 1.15);
    this.group.lookAt(_camPos);

    // World matrices are otherwise only refreshed during render, so the first
    // raycast after opening would test against the panel's previous pose.
    this.group.updateMatrixWorld(true);
  }

  _buildItems() {
    return buildPauseMenu({
      machine: this.machine,
      game: this.game,
      settings: this.settings,
      onResume: () => this.toggle(false),
      onExit: () => {
        this.toggle(false);
        this.onExit?.();
      },
    });
  }

  // --- Interaction ------------------------------------------------------

  // `controllers` are three's XR controller objects; any with a live pose
  // takes priority over gaze.
  update(dt, controllers) {
    if (!this.open) return;

    const { hit, gaze } = this._pick(controllers);
    this.usingGaze = gaze;

    let index = -1;
    if (hit) {
      index = this._indexAt(hit.uv);
      this.reticle.visible = true;
      this.reticle.position.copy(this.panel.worldToLocal(hit.point.clone()));
      this.reticle.position.z += 0.002;
      this._hitU = hit.uv.x;
    } else {
      this.reticle.visible = false;
    }

    if (index !== this.hovered) {
      this.hovered = index;
      this._dwell = 0;
      this._dwellStep = -1;
      this._dwellSpent = false; // new row, so a fresh dwell is allowed
      this._dirty = true;
      if (index >= 0) this.sfx.ui();
    }

    // Gaze dwell: looking is the only input, so hold to commit. One
    // activation per visit — without the latch a resting gaze re-fires every
    // DWELL_TIME and spins a cycle row through its values forever.
    if (this.usingGaze && this.hovered >= 0 && !this._dwellSpent) {
      this._dwell += dt;

      // Only repaint when the progress bar would visibly move. Flagging
      // dirty every frame means a full 1024×768 canvas repaint and texture
      // upload at headset framerate — measured at 42/s — for an indicator
      // that only has a couple of dozen distinguishable states.
      const step = Math.floor((this._dwell / DWELL_TIME) * DWELL_STEPS);
      if (step !== this._dwellStep) {
        this._dwellStep = step;
        this._dirty = true;
      }

      if (this._dwell >= DWELL_TIME) {
        this._dwell = 0;
        this._dwellStep = -1;
        this._dwellSpent = true;
        this.activate();
      }
    }

    if (this._dirty) this.draw();
  }

  // Try every tracked controller and take whichever is actually pointing at
  // the panel, rather than assuming a hand. Committing to the first
  // controller in the list meant that if you pointed with your other hand,
  // the ray came from the one hanging at your side and nothing ever
  // highlighted — the menu looked broken.
  _pick(controllers) {
    let fallback = null;

    for (const controller of controllers) {
      if (!controller?.visible) continue;
      _matrix.identity().extractRotation(controller.matrixWorld);
      _origin.setFromMatrixPosition(controller.matrixWorld);
      _direction.set(0, 0, -1).applyMatrix4(_matrix).normalize();

      _raycaster.set(_origin, _direction);
      const hit = _raycaster.intersectObject(this.panel, false)[0];
      if (hit) return { hit, gaze: false };
      fallback = { hit: null, gaze: false };
    }

    // No controller on target: fall back to the head, so the menu still
    // works by looking at it.
    this.camera.getWorldPosition(_origin);
    this.camera.getWorldDirection(_direction);
    _raycaster.set(_origin, _direction);
    const gazeHit = _raycaster.intersectObject(this.panel, false)[0];
    if (gazeHit) return { hit: gazeHit, gaze: true };

    return fallback ?? { hit: null, gaze: true };
  }

  _indexAt(uv) {
    if (!uv) return -1;
    const y = (1 - uv.y) * H;
    if (y < ROW_TOP) return -1;
    const i = Math.floor((y - ROW_TOP) / rowHeight(this.items.length));
    return i >= 0 && i < this.items.length ? i : -1;
  }

  // Trigger press, or a completed dwell.
  activate() {
    if (this.hovered < 0) return;
    const item = this.items[this.hovered];

    if (item.kind === 'action') {
      item.activate?.();
    } else {
      // Pointing at the left chevron steps backwards; anywhere else forwards.
      const backwards = this._hitU > 0.6 && this._hitU < 0.72;
      item.step(backwards ? -1 : 1);
      this.items = this._buildItems(); // values changed; re-read labels
    }

    this.sfx.ui();
    this._dirty = true;
    if (this.open) this.draw();
  }

  // --- Drawing ----------------------------------------------------------

  draw() {
    const { ctx, game, machine } = this;
    this._dirty = false;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(11,11,12,0.95)';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(242,239,230,0.18)';
    ctx.lineWidth = 3;
    ctx.strokeRect(2, 2, W - 4, H - 4);

    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = ACCENT;
    ctx.font = `700 34px ${MONO}`;
    ctx.fillText('PAUSED', 60, 92);

    ctx.fillStyle = DIM;
    ctx.font = `500 22px ${MONO}`;
    ctx.fillText(
      machine.isTargetMode
        ? `${game.targetsHit} TARGETS`
        : `STREAK ${game.streak}  ·  ${game.returns} ON TABLE`,
      60,
      136
    );

    ctx.strokeStyle = 'rgba(242,239,230,0.16)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(60, ROW_TOP - 26);
    ctx.lineTo(W - 60, ROW_TOP - 26);
    ctx.stroke();

    const rowH = rowHeight(this.items.length);
    const fontSize = Math.min(25, Math.round(rowH * 0.5));
    this.items.forEach((item, i) => {
      const y = ROW_TOP + i * rowH;
      const selected = i === this.hovered;

      if (selected) {
        ctx.fillStyle = 'rgba(226,35,26,0.18)';
        ctx.fillRect(40, y, W - 80, rowH - 4);
      }

      const baseline = y + rowH * 0.66;
      ctx.fillStyle = selected ? ACCENT : PAPER;
      ctx.font = `${selected ? 700 : 500} ${fontSize}px ${MONO}`;
      ctx.fillText(selected ? '▸' : ' ', 56, baseline);
      ctx.fillText(item.label.toUpperCase(), 96, baseline);

      if (item.kind !== 'action') {
        ctx.fillStyle = selected ? PAPER : DIM;
        ctx.textAlign = 'right';
        ctx.fillText('‹', W - 260, baseline);
        ctx.fillText(String(item.value).toUpperCase(), W - 110, baseline);
        ctx.fillText('›', W - 70, baseline);
        ctx.textAlign = 'left';
      }
    });

    // Dwell progress, only meaningful when the head is the pointer
    ctx.fillStyle = DIM;
    ctx.font = `500 20px ${MONO}`;
    ctx.fillText(
      this.usingGaze ? 'LOOK AND HOLD TO SELECT' : 'POINT AND PULL TRIGGER',
      60,
      H - 42
    );

    if (this.usingGaze && this.hovered >= 0 && this._dwell > 0) {
      const pct = Math.min(1, this._dwell / DWELL_TIME);
      ctx.fillStyle = 'rgba(242,239,230,0.14)';
      ctx.fillRect(W - 300, H - 58, 240, 10);
      ctx.fillStyle = ACCENT;
      ctx.fillRect(W - 300, H - 58, 240 * pct, 10);
    }

    this.texture.needsUpdate = true;
  }
}
