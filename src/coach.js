import * as THREE from 'three';
import { TABLE, PLAY_AREA, COLORS } from './constants.js';

// Coach mode: a stroke is taught as a path the bat should travel.
//
// One curve drives everything, which is what keeps the mode honest — the
// ribbon you see, the score you get and the buzz in your hand are all
// readings of the same thing rather than three approximations of it:
//
//   • the ribbon is the curve, widened along the blade angle it wants
//   • the ghost runs the curve at the speed the stroke should take
//   • the score is how far your blade strayed from it, how well the face
//     matched, and whether you swung at the right pace
//   • the haptics are the live distance to it
//
// Lessons are authored in a frame just in front of the player rather than
// in world space, so they follow the table when it is recentred.

const ORIGIN = new THREE.Vector3(0, 0, PLAY_AREA.PLAYER_Z - 0.35);

// `p` is the blade position, `n` the face normal, both in the lesson frame
// (+x right, +y up, −z toward the net). `t` is seconds from the start of
// the stroke, which sets the pace the ghost runs at.
export const LESSONS = [
  {
    id: 'serve',
    name: 'Serve',
    brief: 'Brush up the back of the ball, low over the net',
    feedsBall: true,
    contactAt: 0.42, // fraction along the path where bat meets ball
    keys: [
      { p: [0.30, 1.16, 0.20], n: [-0.25, 0.1, -0.96], t: 0 },
      { p: [0.24, 1.00, 0.10], n: [-0.3, 0.05, -0.95], t: 0.22 },
      { p: [0.12, 0.92, -0.02], n: [-0.35, 0.18, -0.92], t: 0.4 },
      { p: [-0.04, 0.98, -0.16], n: [-0.3, 0.3, -0.9], t: 0.58 },
      { p: [-0.22, 1.12, -0.3], n: [-0.2, 0.42, -0.88], t: 0.8 },
    ],
  },
  {
    id: 'drive',
    name: 'Forehand drive',
    brief: 'Forward through the ball, finishing high',
    feedsBall: true,
    contactAt: 0.45,
    keys: [
      { p: [0.38, 0.92, 0.26], n: [-0.45, 0.0, -0.89], t: 0 },
      { p: [0.26, 0.94, 0.08], n: [-0.4, 0.06, -0.91], t: 0.2 },
      { p: [0.08, 0.99, -0.10], n: [-0.32, 0.16, -0.93], t: 0.38 },
      { p: [-0.12, 1.08, -0.26], n: [-0.24, 0.3, -0.92], t: 0.56 },
      { p: [-0.30, 1.20, -0.36], n: [-0.18, 0.4, -0.9], t: 0.75 },
    ],
  },
  {
    id: 'push',
    name: 'Backspin push',
    brief: 'Open face, slice down and forward under the ball',
    feedsBall: true,
    contactAt: 0.5,
    keys: [
      { p: [0.30, 1.10, 0.18], n: [-0.3, 0.45, -0.84], t: 0 },
      { p: [0.20, 1.00, 0.06], n: [-0.28, 0.5, -0.82], t: 0.22 },
      { p: [0.06, 0.92, -0.06], n: [-0.25, 0.55, -0.8], t: 0.42 },
      { p: [-0.08, 0.88, -0.18], n: [-0.22, 0.58, -0.78], t: 0.62 },
      { p: [-0.22, 0.90, -0.28], n: [-0.2, 0.6, -0.77], t: 0.82 },
    ],
  },
];

const RIBBON_WIDTH = 0.13;
const RIBBON_SAMPLES = 90;

// Above this the blade is too far off the path to be tracing it at all, so
// the sample is counted as a miss rather than dragging the average down by
// an unbounded amount.
const MAX_DEVIATION = 0.28; // metres

// How far behind or ahead of the demonstrated pace still counts as tracing
// the stroke at all.
const MAX_SYNC = 0.4; // metres

const _v = new THREE.Vector3();
const _closest = new THREE.Vector3();
const _tangent = new THREE.Vector3();
const _side = new THREE.Vector3();

export const COACH_STATE = {
  IDLE: 'idle',
  READY: 'ready',
  TRACING: 'tracing',
  SCORED: 'scored',
};

export class Coach {
  constructor({ sfx, onScore } = {}) {
    this.sfx = sfx;
    this.onScore = onScore;

    this.lessonIndex = 0;
    this.state = COACH_STATE.IDLE;
    this.active = false;

    this.lastScore = null;
    this.bestScore = 0;
    this.attempts = 0;
    this.history = [];
    this.advice = 'Trace the ribbon from the ring';
    this.lessonChanged = 0; // bumped so the HUD knows to repaint
    this.deviation = 0; // live distance from the path, for haptics

    this.group = new THREE.Group();
    this.group.visible = false;

    this._samples = [];
    this._elapsed = 0;
    this._ghostT = 0;
    this._armCooldown = 0;

    this._buildGhost();
    this.setLesson(0);
  }

  get lesson() {
    return LESSONS[this.lessonIndex];
  }

  setLesson(index) {
    this.lessonIndex = ((index % LESSONS.length) + LESSONS.length) % LESSONS.length;
    this._buildPath();
    // A new stroke is a new skill: carrying advice across would describe a
    // habit the player does not have in this one.
    this.history = [];
    this.advice = 'Trace the ribbon from the ring';
    this.lessonChanged++;
    this.reset();
  }

  nextLesson() {
    this.setLesson(this.lessonIndex + 1);
    return this.lesson;
  }

  setActive(active) {
    if (active === this.active) return;
    this.active = active;
    this.group.visible = active;
    this.reset();
  }

  reset() {
    this.state = this.active ? COACH_STATE.READY : COACH_STATE.IDLE;
    this._samples.length = 0;
    this._elapsed = 0;
    this._ghostT = 0;
    this.deviation = 0;
  }

  // --- Path and ribbon ----------------------------------------------------

  _buildPath() {
    const lesson = this.lesson;
    const points = lesson.keys.map((k) =>
      new THREE.Vector3(...k.p).add(ORIGIN)
    );
    this.curve = new THREE.CatmullRomCurve3(points, false, 'catmullrom', 0.4);
    this.normals = lesson.keys.map((k) => new THREE.Vector3(...k.n).normalize());
    this.duration = lesson.keys[lesson.keys.length - 1].t;

    // Cache a dense polyline: every deviation query walks it, and doing that
    // against the curve directly would re-evaluate the spline hundreds of
    // times per frame.
    this._polyline = this.curve.getSpacedPoints(RIBBON_SAMPLES);

    this.group.clear();
    this.group.add(this._buildCore());
    this.group.add(this._buildRibbon());
    this.group.add(this._buildStartMarker());
    this.group.add(this.ghost);
  }

  // The ribbon is widened along the face direction the stroke wants, so its
  // twist shows you the blade angle as well as the route.
  _buildRibbon() {
    const positions = [];
    const uvs = [];
    const indices = [];

    for (let i = 0; i <= RIBBON_SAMPLES; i++) {
      const t = i / RIBBON_SAMPLES;
      const point = this.curve.getPointAt(t);
      this.curve.getTangentAt(t, _tangent);
      const normal = this._normalAt(t);

      // Ribbon lies across the tangent, in the plane of the blade face
      _side.crossVectors(_tangent, normal).normalize().multiplyScalar(RIBBON_WIDTH / 2);

      positions.push(
        point.x - _side.x, point.y - _side.y, point.z - _side.z,
        point.x + _side.x, point.y + _side.y, point.z + _side.z
      );
      uvs.push(t, 0, t, 1);

      if (i < RIBBON_SAMPLES) {
        const a = i * 2;
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();

    return new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({
        map: ribbonTexture(),
        transparent: true,
        opacity: 0.55,
        side: THREE.DoubleSide,
        depthWrite: false,
        toneMapped: false,
      })
    );
  }

  // A solid line through the middle of the ribbon. The ribbon itself twists
  // to show the blade angle, which means it turns edge-on to you for parts
  // of the stroke and all but disappears; the core keeps the route readable
  // from wherever you are standing.
  _buildCore() {
    return new THREE.Mesh(
      new THREE.TubeGeometry(this.curve, RIBBON_SAMPLES, 0.006, 8, false),
      new THREE.MeshBasicMaterial({ color: COLORS.ACCENT, toneMapped: false })
    );
  }

  _buildStartMarker() {
    const start = this.curve.getPointAt(0);
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.055, 0.007, 8, 24),
      new THREE.MeshBasicMaterial({ color: COLORS.LINE, toneMapped: false })
    );
    ring.position.copy(start);
    this.curve.getTangentAt(0, _tangent);
    ring.lookAt(start.clone().add(_tangent));
    return ring;
  }

  _buildGhost() {
    this.ghost = new THREE.Mesh(
      new THREE.SphereGeometry(0.028, 16, 12),
      new THREE.MeshBasicMaterial({ color: COLORS.LINE, toneMapped: false })
    );
  }

  // Blade normal along the path, interpolated between the authored keys.
  _normalAt(t) {
    const n = this.normals.length - 1;
    const scaled = t * n;
    const i = Math.min(Math.floor(scaled), n - 1);
    return _v
      .copy(this.normals[i])
      .lerp(this.normals[i + 1], scaled - i)
      .normalize();
  }

  // Shortest distance from a point to the path, plus where along it that was.
  _closestOnPath(point) {
    let best = Infinity;
    let bestT = 0;
    for (let i = 0; i < this._polyline.length; i++) {
      const d = point.distanceToSquared(this._polyline[i]);
      if (d < best) {
        best = d;
        bestT = i / (this._polyline.length - 1);
      }
    }
    return { distance: Math.sqrt(best), t: bestT };
  }

  // --- Running the lesson -------------------------------------------------

  // `paddle` is the player's bat. Returns the haptic strength to apply.
  update(dt, paddle) {
    if (!this.active || !paddle?.tracking) return 0;

    const blade = paddle.bladeCenter;
    const near = this._closestOnPath(blade);
    this.deviation = near.distance;

    if (this._armCooldown > 0) this._armCooldown -= dt;

    switch (this.state) {
      case COACH_STATE.READY:
      case COACH_STATE.SCORED: {
        this._ghostPreview(dt);
        // Starting the stroke is simply arriving at the start of the path.
        const atStart = blade.distanceTo(this.curve.getPointAt(0)) < 0.1;
        if (atStart && this._armCooldown <= 0) {
          this.state = COACH_STATE.TRACING;
          this._samples.length = 0;
          this._elapsed = 0;
          this._ghostT = 0;
          this.sfx?.ui(true);
        }
        break;
      }

      case COACH_STATE.TRACING: {
        this._elapsed += dt;
        this._ghostT = Math.min(this._elapsed / this.duration, 1);
        this.ghost.position.copy(this.curve.getPointAt(this._ghostT));

        // Two different questions, so two measurements. Distance to the
        // nearest point asks "is the shape right", but it cannot see error
        // *along* the path — on a stroke that sweeps sideways, a swing
        // shifted bodily along its own line sits perfectly on the curve and
        // scored full marks. Distance to the ghost asks "were you there at
        // the right moment", which catches exactly that.
        this._samples.push({
          t: near.t,
          deviation: near.distance,
          sync: blade.distanceTo(this.ghost.position),
          facing: paddle.bladeNormal.dot(this._normalAt(near.t)),
          speed: paddle.velocity.length(),
          elapsed: this._elapsed,
        });

        // The stroke ends when you reach the far end of the path, or when
        // you have clearly stopped tracing it.
        const finished = near.t > 0.94 && this._elapsed > this.duration * 0.4;
        const abandoned =
          this._elapsed > this.duration * 2.5 || near.distance > MAX_DEVIATION * 2;
        if (finished || abandoned) this._finish(finished);
        break;
      }
    }

    // Haptics: strength rises with how far off the path you are, so the buzz
    // is a nudge back toward it rather than a binary right/wrong.
    if (this.state === COACH_STATE.TRACING) {
      return THREE.MathUtils.clamp(this.deviation / MAX_DEVIATION, 0, 1);
    }
    return 0;
  }

  // Idle: run the ghost round the path on a loop to demonstrate the pace.
  _ghostPreview(dt) {
    this._ghostT = (this._ghostT + dt / (this.duration + 0.6)) % 1;
    this.ghost.position.copy(this.curve.getPointAt(this._ghostT));
  }

  _finish(completed) {
    const samples = this._samples;
    this.attempts++;
    this._armCooldown = 0.9; // don't immediately re-arm on the follow-through

    if (!completed || samples.length < 6) {
      this.lastScore = { total: 0, path: 0, sync: 0, face: 0, timing: 0, note: 'Incomplete' };
      this.state = COACH_STATE.SCORED;
      this.onScore?.(this.lastScore);
      return;
    }

    // Path: mean deviation, as a fraction of the distance at which you are
    // no longer meaningfully on the line.
    let devSum = 0;
    let syncSum = 0;
    let faceSum = 0;
    for (const s of samples) {
      devSum += Math.min(s.deviation, MAX_DEVIATION);
      syncSum += Math.min(s.sync, MAX_SYNC);
      faceSum += THREE.MathUtils.clamp(s.facing, 0, 1);
    }
    const path = 1 - devSum / samples.length / MAX_DEVIATION;
    const sync = 1 - syncSum / samples.length / MAX_SYNC;
    const face = faceSum / samples.length;

    // Duration: did the whole stroke take about as long as it should.
    const took = samples[samples.length - 1].elapsed;
    const timing = 1 - Math.min(Math.abs(took - this.duration) / this.duration, 1);

    const total = Math.round(
      (path * 0.34 + sync * 0.33 + face * 0.22 + timing * 0.11) * 100
    );

    this.lastScore = {
      total: THREE.MathUtils.clamp(total, 0, 100),
      path: Math.round(path * 100),
      sync: Math.round(sync * 100),
      face: Math.round(face * 100),
      timing: Math.round(timing * 100),
      note: gradeNote(total),
    };
    this.bestScore = Math.max(this.bestScore, this.lastScore.total);
    this.history.push({ ...this.lastScore, duration: took });
    if (this.history.length > HISTORY * 2) this.history.shift();
    this.advice = adviseFrom(this.history, this.lesson, this.duration);
    this.state = COACH_STATE.SCORED;
    this.sfx?.targetHit?.();
    this.onScore?.(this.lastScore);
  }

  // One short line telling the player what to do next. The mode is a lesson,
  // so it should always be obvious what the next action is.
  get instruction() {
    switch (this.state) {
      case COACH_STATE.TRACING:
        return 'Follow the marker';
      case COACH_STATE.SCORED:
        return this.advice;
      case COACH_STATE.READY:
        return 'Put your bat in the ring to start';
      default:
        return this.lesson.brief;
    }
  }

  // Where the ball should be to meet this stroke, for lessons that feed one.
  contactPoint() {
    return this.curve.getPointAt(this.lesson.contactAt);
  }
}

// Advice comes from the pattern across your recent attempts, not from the
// last one. A single sloppy swing says nothing; the same weakness showing up
// three times running is a habit worth naming — and naming the specific
// fault ("you're rushing it") is what makes this a lesson rather than a
// score.
const HISTORY = 6;

// `expected` is the stroke's intended duration. It lives on the Coach, not
// on the lesson, and reading `lesson.duration` here silently yielded
// undefined — every comparison against it was false, so a slow swing was
// told it was rushing.
function adviseFrom(history, lesson, expected) {
  if (history.length < 2) return 'Trace the ribbon from the ring';

  const recent = history.slice(-HISTORY);
  const mean = (key) =>
    recent.reduce((sum, s) => sum + s[key], 0) / recent.length;

  const path = mean('path');
  const sync = mean('sync');
  const face = mean('face');
  const timing = mean('timing');

  // Path and sync are not independent: swinging off the line also puts you
  // out of step with the marker, so both drop together and neither looks
  // decisive on its own. Judging them as one "line" fault is what lets the
  // advice name a wandering swing instead of shrugging and calling it solid.
  const line = Math.min(path, sync);
  const areas = [
    { key: 'line', value: line },
    { key: 'face', value: face },
    { key: 'timing', value: timing },
  ].sort((a, b) => a.value - b.value);

  const worst = areas[0];
  if (worst.value > 88) return 'Dialled in — try it faster';

  // Only call out a fault that is clearly the weak one, otherwise the advice
  // flip-flops between attempts and teaches nothing.
  if (areas[1].value - worst.value < 6) {
    return `Solid all round at ${Math.round(mean('total'))}% — keep going`;
  }

  switch (worst.key) {
    case 'line':
      // Within the line fault, which half is worse: the shape or the pace.
      return sync < path - 8
        ? 'Match the pace of the marker, not just the shape'
        : 'Stay on the line — your swing is drifting off it';
    case 'face':
      return lesson.id === 'push'
        ? 'Keep the face more open through the ball'
        : 'Close the face — it is opening through contact';
    case 'timing':
      return mean('duration') > expected
        ? 'Too slow — commit to the stroke'
        : 'Slow down, you are rushing the stroke';
    default:
      return 'Trace the ribbon from the ring';
  }
}

function gradeNote(total) {
  if (total >= 90) return 'Textbook';
  if (total >= 75) return 'Good shape';
  if (total >= 55) return 'Getting there';
  if (total >= 35) return 'Off the line';
  return 'Try again';
}

// Gradient along the ribbon so which way to swing is obvious, with chevrons
// pointing down the path. A plain coloured strip reads as decoration; the
// arrows make it an instruction.
let cachedRibbon = null;
function ribbonTexture() {
  if (cachedRibbon) return cachedRibbon;

  const w = 512;
  const h = 64;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');

  const grad = ctx.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, 'rgba(226,35,26,0.15)');
  grad.addColorStop(0.5, 'rgba(226,35,26,0.55)');
  grad.addColorStop(1, 'rgba(242,239,230,0.85)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = 'rgba(242,239,230,0.8)';
  ctx.lineWidth = 4;
  for (let x = 24; x < w; x += 64) {
    ctx.beginPath();
    ctx.moveTo(x, 14);
    ctx.lineTo(x + 22, h / 2);
    ctx.lineTo(x, h - 14);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  cachedRibbon = tex;
  return tex;
}
