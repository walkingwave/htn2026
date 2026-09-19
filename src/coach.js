import * as THREE from 'three';
import { TABLE, BALL, PLAY_AREA, COLORS } from './constants.js';
import { solveLaunchTo, solveContact } from './ballistics.js';

// Coach mode: a scenario is a fixed situation, and the stroke that answers
// it is worked out rather than drawn by hand.
//
// That distinction is the whole design. An authored swing path looks
// plausible and teaches nothing, because nothing checks that following it
// actually puts the ball on the table — the first version's example stroke
// would have sent the ball off the end. Here each scenario states the
// situation (where the ball comes from, where it should end up) and the
// path is solved from the same ballistics the game runs on:
//
//   1. fly the fed ball forward to the plane where you would meet it
//   2. solve the launch from that point to the chosen landing spot
//   3. invert the contact for the bat's face angle and speed
//   4. lay a backswing and follow-through either side of that contact
//
// So the ribbon is a promise: trace it at the right pace and the ball lands
// where the scenario says it will.

// How long the bat travels before and after the strike. Real strokes are
// longer, but a short path is easier to trace accurately and the contact is
// the part being taught.
const BACKSWING_TIME = 0.34;
const FOLLOW_TIME = 0.3;

export const SCENARIOS = [
  {
    id: 'serve',
    name: 'Serve',
    brief: 'Brush up the back of the ball and land it deep crosscourt',
    contact: [0.16, TABLE.HEIGHT + 0.2, PLAY_AREA.PLAYER_Z - 0.34],
    spin: [0, 0, 0],
    land: { x: -0.42, z: -1.0 },
    pace: 4.4,
  },
  {
    id: 'drive',
    name: 'Drive a topspin ball',
    brief: 'Topspin on the ball — close the face and drive it deep',
    contact: [0.3, TABLE.HEIGHT + 0.26, PLAY_AREA.PLAYER_Z - 0.5],
    spin: [150, 0, 0],
    land: { x: -0.3, z: -0.95 },
    pace: 4.3,
  },
  {
    id: 'push',
    name: 'Push a backspin ball',
    brief: 'Heavy backspin — open the face and push it low over the net',
    // Backspin is kept moderate. The stroke solve only models the impulse
    // along the face, so the tangential drag a spinning ball adds is
    // unaccounted for — and it scales with the spin. At championship
    // backspin the solved push died in the net every time; this is heavy
    // enough to demand an open face and light enough that the taught stroke
    // actually clears.
    contact: [-0.26, TABLE.HEIGHT + 0.24, PLAY_AREA.PLAYER_Z - 0.5],
    spin: [-70, 0, 0],
    land: { x: 0.25, z: -0.8 },
    pace: 4.6,
  },
];

const RIBBON_WIDTH = 0.13;
const RIBBON_SAMPLES = 90;

const MAX_DEVIATION = 0.28; // metres; beyond this you are not on the line
const MAX_SYNC = 0.4; // metres behind or ahead of the demonstrated pace

const HISTORY = 6;

const TRACED = new THREE.Color(0x3ddc84); // green, for the part you have done
const UNTRACED = new THREE.Color(0xe2231a);

const _tangent = new THREE.Vector3();
const _side = new THREE.Vector3();
const _local = new THREE.Vector3();
const _curvePoint = new THREE.Vector3();

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

    this.scenarioIndex = 0;
    this.state = COACH_STATE.IDLE;
    this.active = false;

    this.lastScore = null;
    this.bestScore = 0;
    this.attempts = 0;
    this.history = [];
    this.advice = 'Put your bat in the ring to start';
    this.deviation = 0;
    this.progress = 0; // how far along the path you have traced

    this.group = new THREE.Group();
    this.group.visible = false;

    this._samples = [];
    this._elapsed = 0;
    this._ghostT = 0;
    this._armCooldown = 0;

    this._buildGhost();
    this.setScenario(0);
    this.group.add(this._buildScenarioBoard());
  }

  get scenario() {
    return SCENARIOS[this.scenarioIndex];
  }

  // Kept as `lesson` because the HUD and menu only want a name.
  get lesson() {
    return this.scenario;
  }

  setScenario(index) {
    const n = SCENARIOS.length;
    this.scenarioIndex = ((index % n) + n) % n;
    this._solveStroke();
    // A new stroke is a new skill; advice about the last one would describe
    // a habit the player does not have in this one.
    this.history = [];
    this.advice = 'Put your bat in the ring to start';
    this.reset();
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
    this.progress = 0;
    this._paintedStep = -1;
    this.deviation = 0;
    this._paintProgress(0);
  }

  // --- Deriving the stroke ------------------------------------------------

  // Works out where the ball will be, what has to happen to it, and
  // therefore where the bat must travel.
  _solveStroke() {
    const scenario = this.scenario;
    const target = new THREE.Vector3(
      scenario.land.x,
      TABLE.HEIGHT + BALL.RADIUS,
      scenario.land.z
    );

    let contactPoint;
    let inVel;

    // The ball waits, held still, at the point the stroke should meet it.
    //
    // Timing a moving feed to a player's swing is a problem with no good
    // answer — the feed cannot know when you will go, and a swing that
    // arrives early or late teaches nothing about the stroke. Holding the
    // ball removes the question: the contact happens where the lesson says
    // it does, whenever you get there, and what is being graded is the
    // shape of the swing.
    contactPoint = new THREE.Vector3(
      scenario.contact[0],
      scenario.contact[1],
      scenario.contact[2]
    );
    inVel = new THREE.Vector3(0, 0, 0);

    // It still carries the scenario's spin, so a backspin ball genuinely
    // needs an open face to lift — the spin is what the lesson is about,
    // and it survives the ball being stationary.
    this.ballSpin = new THREE.Vector3(...(scenario.spin ?? [0, 0, 0]));

    // What the ball must do next, and therefore what the bat must do.
    // The ball's spin carries through the contact and bends the flight, so
    // the outgoing solve has to know about it. Solved without, the topspin
    // drive was lifted straight past the end of the table.
    const outVel = solveLaunchTo(
      contactPoint,
      target,
      scenario.pace,
      this.ballSpin,
      0.16
    );
    const { normal, speed } = solveContact(inVel, outVel);

    this.contactPoint = contactPoint;
    this.contactNormal = normal.clone();
    this.contactSpeed = Math.abs(speed);
    this.outVel = outVel.clone();

    // Lay the path along the swing: back along the face normal before
    // contact, on through it after.
    // Path length has to equal speed x time, or tracing it at the
    // demonstrated pace delivers the wrong speed at contact. Shortening the
    // limbs "for feel" meant the bat arrived at about three quarters of the
    // solved speed, which the shots with margin survived and the delicate
    // push did not — it died in the net every time.
    const dir = normal.clone().multiplyScalar(Math.sign(speed) || 1);
    const back = this.contactSpeed * BACKSWING_TIME;
    const through = this.contactSpeed * FOLLOW_TIME;

    const start = contactPoint.clone().addScaledVector(dir, -back);
    const mid = contactPoint.clone().addScaledVector(dir, -back * 0.42);
    const after = contactPoint.clone().addScaledVector(dir, through * 0.5);
    const end = contactPoint.clone().addScaledVector(dir, through);

    // Real strokes rise through the ball rather than running dead straight,
    // and that lift is what the player should feel they are doing.
    start.y -= 0.06;
    mid.y -= 0.03;
    after.y += 0.05;
    end.y += 0.11;

    this.curve = new THREE.CatmullRomCurve3(
      [start, mid, contactPoint.clone(), after, end],
      false,
      'catmullrom',
      0.35
    );
    this.duration = BACKSWING_TIME + FOLLOW_TIME;
    this.contactAt = BACKSWING_TIME / this.duration;
    this._polyline = this.curve.getSpacedPoints(RIBBON_SAMPLES);

    this.group.clear();
    this.group.add(this._buildCore());
    this.ribbon = this._buildRibbon();
    this.group.add(this.ribbon);
    this.group.add(this._buildStartMarker());
    this.group.add(this._buildLandingMarker(target));
    this.group.add(this.ghost);
    if (this._board) this.group.add(this._board); // survives a path rebuild
    this._drawBoard();
    this._paintProgress(0);
  }

  // --- Ribbon -------------------------------------------------------------

  _buildRibbon() {
    const positions = [];
    const colors = [];
    const indices = [];

    for (let i = 0; i <= RIBBON_SAMPLES; i++) {
      const t = i / RIBBON_SAMPLES;
      const point = this.curve.getPointAt(t);
      this.curve.getTangentAt(t, _tangent);

      _side
        .crossVectors(_tangent, this.contactNormal)
        .normalize()
        .multiplyScalar(RIBBON_WIDTH / 2);

      positions.push(
        point.x - _side.x, point.y - _side.y, point.z - _side.z,
        point.x + _side.x, point.y + _side.y, point.z + _side.z
      );
      colors.push(1, 1, 1, 1, 1, 1);

      if (i < RIBBON_SAMPLES) {
        const a = i * 2;
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();

    return new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.7,
        side: THREE.DoubleSide,
        depthWrite: false,
        toneMapped: false,
      })
    );
  }

  // Colours the ribbon green up to how far you have traced, so the line
  // fills in behind the bat as the stroke is completed.
  _paintProgress(progress) {
    const attr = this.ribbon?.geometry.getAttribute('color');
    if (!attr) return;
    for (let i = 0; i <= RIBBON_SAMPLES; i++) {
      const c = i / RIBBON_SAMPLES <= progress ? TRACED : UNTRACED;
      attr.setXYZ(i * 2, c.r, c.g, c.b);
      attr.setXYZ(i * 2 + 1, c.r, c.g, c.b);
    }
    attr.needsUpdate = true;
  }

  _buildCore() {
    return new THREE.Mesh(
      new THREE.TubeGeometry(this.curve, RIBBON_SAMPLES, 0.005, 8, false),
      new THREE.MeshBasicMaterial({
        color: 0xf2efe6,
        transparent: true,
        opacity: 0.5,
        toneMapped: false,
      })
    );
  }

  _buildStartMarker() {
    const start = this.curve.getPointAt(0);
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.06, 0.008, 8, 24),
      new THREE.MeshBasicMaterial({ color: COLORS.LINE, toneMapped: false })
    );
    ring.position.copy(start);
    this.curve.getTangentAt(0, _tangent);
    ring.lookAt(start.clone().add(_tangent));
    return ring;
  }

  // Where the ball is meant to land, so the scenario states its own goal.
  _buildLandingMarker(target) {
    const pad = new THREE.Mesh(
      new THREE.RingGeometry(0.1, 0.13, 32),
      new THREE.MeshBasicMaterial({
        color: TRACED,
        transparent: true,
        opacity: 0.6,
        side: THREE.DoubleSide,
        depthWrite: false,
        toneMapped: false,
      })
    );
    pad.rotation.x = -Math.PI / 2;
    pad.position.set(target.x, TABLE.HEIGHT + 0.004, target.z);
    return pad;
  }

  // A board listing the scenarios, standing beside the lesson. Switching
  // drill is the thing you do most often in this mode, and making it the
  // one action that needs the pause menu was backwards.
  _buildScenarioBoard() {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 320;
    const ctx = canvas.getContext('2d');
    this._boardCtx = ctx;
    this._boardTexture = new THREE.CanvasTexture(canvas);
    this._boardTexture.colorSpace = THREE.SRGBColorSpace;
    this._boardTexture.anisotropy = 8;

    const panel = new THREE.Mesh(
      new THREE.PlaneGeometry(0.5, 0.3125),
      new THREE.MeshBasicMaterial({
        map: this._boardTexture,
        transparent: true,
        toneMapped: false,
      })
    );
    const board = new THREE.Group();
    board.add(panel);
    // Off to the player's left at chest height, angled inward, clear of the
    // stroke itself.
    board.position.set(-0.62, TABLE.HEIGHT + 0.42, PLAY_AREA.PLAYER_Z - 0.5);
    board.rotation.y = 0.5;
    this._board = board;
    this._drawBoard();
    return board;
  }

  _drawBoard() {
    const ctx = this._boardCtx;
    if (!ctx) return;
    const W = 512;
    const H = 320;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(11,11,12,0.94)';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#e2231a';
    ctx.fillRect(0, 0, 8, H);

    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#e2231a';
    ctx.font = '600 22px ui-monospace, monospace';
    ctx.fillText('SCENARIO', 34, 46);

    ctx.strokeStyle = 'rgba(242,239,230,0.18)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(34, 62);
    ctx.lineTo(W - 28, 62);
    ctx.stroke();

    SCENARIOS.forEach((scenario, i) => {
      const y = 108 + i * 52;
      const current = i === this.scenarioIndex;
      if (current) {
        ctx.fillStyle = 'rgba(226,35,26,0.2)';
        ctx.fillRect(22, y - 32, W - 50, 44);
      }
      ctx.fillStyle = current ? '#e2231a' : 'rgba(242,239,230,0.55)';
      ctx.font = `${current ? 700 : 500} 26px ui-monospace, monospace`;
      ctx.fillText(current ? '▸' : ' ', 34, y);
      ctx.fillText(scenario.name.toUpperCase(), 72, y);
    });

    ctx.fillStyle = 'rgba(242,239,230,0.4)';
    ctx.font = '500 18px ui-monospace, monospace';
    ctx.fillText('TAP WITH YOUR BAT TO SWITCH', 34, H - 28);

    this._boardTexture.needsUpdate = true;
  }

  // Touching a row with the bat switches drill, so the common action needs
  // no menu at all.
  _checkBoardTap(blade) {
    if (!this._board) return;
    // Reused rather than cloned: this runs every frame the lesson is idle.
    const local = this._board.worldToLocal(_local.copy(blade));
    const onPanel =
      Math.abs(local.x) < 0.28 && Math.abs(local.y) < 0.18 && Math.abs(local.z) < 0.1;

    if (!onPanel) {
      this._boardTouch = false;
      return;
    }
    if (this._boardTouch) return; // one switch per touch, not one per frame
    this._boardTouch = true;

    // Panel space runs +y up; rows run down the board from the top.
    const rowsTop = 0.082;
    const rowHeight = 0.052;
    const index = Math.floor((rowsTop - local.y) / rowHeight);
    if (index >= 0 && index < SCENARIOS.length && index !== this.scenarioIndex) {
      this.setScenario(index);
      this.onScenarioPicked?.(SCENARIOS[index]);
      this.sfx?.ui(true);
    }
  }

  _buildGhost() {
    this.ghost = new THREE.Mesh(
      new THREE.SphereGeometry(0.03, 16, 12),
      new THREE.MeshBasicMaterial({ color: COLORS.LINE, toneMapped: false })
    );
  }

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

  // --- Running a scenario -------------------------------------------------

  // Returns the haptic strength to apply this frame. `serveBall` puts the
  // scenario's ball in play.
  update(dt, paddle, placeBall, heldBall) {
    if (!this.active || !paddle?.tracking) return 0;

    const blade = paddle.bladeCenter;
    const near = this._closestOnPath(blade);
    this.deviation = near.distance;

    if (this._armCooldown > 0) this._armCooldown -= dt;
    if (this.state !== COACH_STATE.TRACING) this._checkBoardTap(blade);

    // Keep a ball waiting whenever we are not mid-stroke.
    if (this.state !== COACH_STATE.TRACING && !heldBall?.()) {
      this._placeHeldBall(placeBall);
    }

    switch (this.state) {
      case COACH_STATE.READY:
      case COACH_STATE.SCORED: {
        this._ghostT = (this._ghostT + dt / (this.duration + 0.7)) % 1;
        this.curve.getPointAt(this._ghostT, this.ghost.position);

        const atStart =
          blade.distanceTo(this.curve.getPointAt(0, _curvePoint)) < 0.11;
        if (atStart && this._armCooldown <= 0) {
          this.state = COACH_STATE.TRACING;
          this._samples.length = 0;
          this._elapsed = 0;
          this._ghostT = 0;
          this.progress = 0;
          this._paintedStep = -1;
          this._paintProgress(0);

          this.sfx?.ui(true);
        }
        break;
      }

      case COACH_STATE.TRACING: {
        this._elapsed += dt;
        this._ghostT = Math.min(this._elapsed / this.duration, 1);
        this.curve.getPointAt(this._ghostT, this.ghost.position);

        // Progress only moves forward: the trail should fill in as the
        // stroke completes, not flicker back when the bat wobbles.
        // Repaint only when the green edge actually moves a segment. The
        // colour attribute is re-uploaded to the GPU on every paint, and at
        // headset framerate that is a pointless upload most frames.
        this.progress = Math.max(this.progress, near.t);
        const step = Math.floor(this.progress * RIBBON_SAMPLES);
        if (step !== this._paintedStep) {
          this._paintedStep = step;
          this._paintProgress(this.progress);
        }

        this._samples.push({
          t: near.t,
          deviation: near.distance,
          sync: blade.distanceTo(this.ghost.position),
          facing: paddle.bladeNormal.dot(this.contactNormal),
          elapsed: this._elapsed,
        });

        const finished = near.t > 0.94 && this._elapsed > this.duration * 0.4;
        const abandoned =
          this._elapsed > this.duration * 2.5 || near.distance > MAX_DEVIATION * 2;
        if (finished || abandoned) this._finish(finished);
        break;
      }
    }

    if (this.state === COACH_STATE.TRACING) {
      return THREE.MathUtils.clamp(this.deviation / MAX_DEVIATION, 0, 1);
    }
    return 0;
  }

  // Parks a ball, held still, at the point the stroke meets it. Called
  // whenever there isn't one waiting, so a fresh ball appears after every
  // attempt without the player doing anything.
  _placeHeldBall(placeBall) {
    if (!placeBall) return;
    placeBall(this.contactPoint.clone(), this.ballSpin.clone());
  }

  _finish(completed) {
    const samples = this._samples;
    this.attempts++;
    this._armCooldown = 0.9;

    if (!completed || samples.length < 6) {
      this.lastScore = {
        total: 0, path: 0, sync: 0, face: 0, timing: 0, note: 'Incomplete',
      };
      this.state = COACH_STATE.SCORED;
      this.onScore?.(this.lastScore);
      return;
    }

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

    const took = samples[samples.length - 1].elapsed;
    const timing = 1 - Math.min(Math.abs(took - this.duration) / this.duration, 1);

    const total = THREE.MathUtils.clamp(
      Math.round((path * 0.34 + sync * 0.33 + face * 0.22 + timing * 0.11) * 100),
      0,
      100
    );

    this.lastScore = {
      total,
      path: Math.round(path * 100),
      sync: Math.round(sync * 100),
      face: Math.round(face * 100),
      timing: Math.round(timing * 100),
      note: gradeNote(total),
    };
    this.bestScore = Math.max(this.bestScore, total);
    this.history.push({ ...this.lastScore, duration: took });
    if (this.history.length > HISTORY * 2) this.history.shift();
    this.advice = adviseFrom(this.history, this.scenario, this.duration);

    this.state = COACH_STATE.SCORED;
    this.sfx?.targetHit?.();
    this.onScore?.(this.lastScore);
  }

  // One short line telling the player what to do next.
  get instruction() {
    switch (this.state) {
      case COACH_STATE.TRACING:
        return 'Follow the marker';
      case COACH_STATE.SCORED:
        return this.advice;
      case COACH_STATE.READY:
        return 'Put your bat in the ring to start';
      default:
        return this.scenario.brief;
    }
  }
}

// Advice comes from the pattern across recent attempts, not the last one. A
// single sloppy swing says nothing; the same weakness three times running is
// a habit worth naming.
function adviseFrom(history, scenario, expected) {
  if (history.length < 2) return 'Trace the ribbon from the ring';

  const recent = history.slice(-HISTORY);
  const mean = (key) => recent.reduce((sum, s) => sum + s[key], 0) / recent.length;

  const path = mean('path');
  const sync = mean('sync');
  const face = mean('face');
  const timing = mean('timing');

  // Path and sync are not independent: swinging off the line also puts you
  // out of step with the marker, so both drop together and neither looks
  // decisive alone. Judging them as one fault is what lets the advice name
  // a wandering swing instead of calling it solid.
  const areas = [
    { key: 'line', value: Math.min(path, sync) },
    { key: 'face', value: face },
    { key: 'timing', value: timing },
  ].sort((a, b) => a.value - b.value);

  const worst = areas[0];
  if (worst.value > 88) return 'Dialled in — try the next scenario';
  if (areas[1].value - worst.value < 6) {
    return `Solid all round at ${Math.round(mean('total'))}% — keep going`;
  }

  switch (worst.key) {
    case 'line':
      return sync < path - 8
        ? 'Match the pace of the marker, not just the shape'
        : 'Stay on the line — your swing is drifting off it';
    case 'face':
      return scenario.id === 'push'
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
