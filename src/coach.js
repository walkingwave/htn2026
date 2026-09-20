import * as THREE from 'three';
import { TABLE, BALL, PLAY_AREA, COLORS } from './constants.js';
import { solveLaunchTo, solveContact, advanceToPlane } from './ballistics.js';

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
//
// Two kinds of scenario:
//   held — the ball waits, frozen at the contact point, and the strike
//          releases it; the lesson is purely the shape of the stroke.
//   fed  — the ball is served at you and you swing with the marker; the
//          lesson adds the timing.

// How long the bat travels before and after the strike.
const BACKSWING_TIME = 0.26;
const FOLLOW_TIME = 0.22;

// A real stroke accelerates into the ball and eases off after it — it does
// not travel at one speed. That matters for more than looks: length is the
// integral of speed over time, so treating the swing as constant-speed at
// the contact speed made each limb over a metre long, which is several
// times a real stroke and impossible to trace.
//
// Modelled as a ramp up to the contact speed and a partial ramp down:
//
//   before:  v(t) = v·t/B          distance = ½·v·B
//   after:   v(t) = v·(1 − 0.8·s/F) distance = 0.6·v·F
//
// The times below only *size* the stroke. The real ones are derived from
// the finished curve, because the arc through the control points is longer
// than the straight limbs used to place them, and the bat walks the arc.
const FOLLOW_DECAY = 0.8; // how far the bat slows by the end of the finish
const BACK_FRACTION = 0.5; // ∫ of the ramp up, as a fraction of v·B
const FOLLOW_FRACTION = 1 - FOLLOW_DECAY / 2; // ∫ of the ramp down, over v·F

// Pause between the bat entering the ring and a fed ball being launched,
// long enough to get set and short enough not to feel like waiting.
const FEED_DELAY = 0.8;

const DEG = Math.PI / 180;

// Each scenario's `stroke.rise` is the angle of the swing above horizontal.
// This is what makes the path read as the named stroke: a topspin drive
// travels low-to-high, a push high-to-low, and neither travels along the
// bat's face normal — the gap between swing direction and face is the brush
// that puts spin on the ball.
export const SCENARIOS = [
  {
    id: 'serve',
    name: 'Serve',
    brief: 'Brush up the back of the ball and land it deep crosscourt',
    kind: 'held',
    contact: [0.16, TABLE.HEIGHT + 0.2, PLAY_AREA.PLAYER_Z - 0.34],
    spin: [0, 0, 0],
    land: { x: -0.42, z: -1.0 },
    pace: 4.0,
    stroke: { rise: 20 },
  },
  {
    id: 'drive',
    name: 'Topspin drive',
    brief: 'Close the face, swing low to high, drive it deep',
    kind: 'held',
    contact: [0.3, TABLE.HEIGHT + 0.26, PLAY_AREA.PLAYER_Z - 0.5],
    spin: [150, 0, 0],
    land: { x: -0.3, z: -0.95 },
    pace: 4.3,
    stroke: { rise: 32 },
  },
  {
    id: 'push',
    name: 'Backspin push',
    brief: 'Open the face, swing high to low, keep it low over the net',
    // Backspin is kept moderate. The stroke solve only models the impulse
    // along the face, so the tangential drag a spinning ball adds is
    // unaccounted for — and it scales with the spin. At championship
    // backspin the solved push died in the net every time; this is heavy
    // enough to demand an open face and light enough that the taught stroke
    // actually clears.
    contact: [-0.26, TABLE.HEIGHT + 0.24, PLAY_AREA.PLAYER_Z - 0.5],
    spin: [-70, 0, 0],
    kind: 'held',
    land: { x: 0.25, z: -0.8 },
    pace: 3.4,
    stroke: { rise: -12 },
  },
  {
    id: 'return',
    name: 'Return a serve',
    brief: 'A backspin serve comes at you — push it back deep',
    kind: 'fed',
    feed: {
      origin: [-0.25, TABLE.HEIGHT + 0.3, -(TABLE.LENGTH / 2) - 0.25],
      bounce: { x: 0.12, z: 0.8 },
      pace: 3.4,
      spin: [-40, 0, 0],
    },
    contactZ: PLAY_AREA.PLAYER_Z - 0.55,
    land: { x: -0.28, z: -0.85 },
    pace: 3.6,
    stroke: { rise: -8 },
  },
  {
    id: 'block',
    name: 'Block a drive',
    brief: 'A fast topspin drive — meet it early with a short block',
    kind: 'fed',
    feed: {
      origin: [0.3, TABLE.HEIGHT + 0.29, -(TABLE.LENGTH / 2) - 0.25],
      bounce: { x: -0.1, z: 0.65 },
      pace: 4.6,
      spin: [120, 0, 0],
    },
    contactZ: PLAY_AREA.PLAYER_Z - 0.5,
    land: { x: 0.2, z: -0.9 },
    pace: 3.8,
    // A block barely changes the ball's velocity, so its solved bat speed is
    // small — and path length is speed times time. At the default times the
    // path collapsed to 14 cm, smaller than the arming ring. The stretched
    // size keeps it a compact stroke that is still long enough to trace.
    stroke: { rise: 6, size: 1.5 },
  },
];

// The guide is a single tube — a string through space — rather than a flat
// ribbon. The ribbon twisted as the face angle changed along the stroke and
// read as a warped sheet; a string has no facing to get wrong.
const TUBE_RADIUS = 0.014;
const TUBE_RADIAL = 10;
const RIBBON_SAMPLES = 90; // tube segments and progress-paint resolution

const MAX_DEVIATION = 0.28; // metres; beyond this you are not on the line
const MAX_SYNC = 0.4; // metres behind or ahead of the demonstrated pace

const HISTORY = 6;

const TRACED = new THREE.Color(0x3ddc84); // green, for the part you have done
const UNTRACED = new THREE.Color(0xe2231a);

// Scenario board geometry. The canvas is drawn at 1024 px per metre, so the
// bat hit-test can be done in pixel space with the same numbers the drawing
// uses — the old version kept a second set of metre-space constants that had
// to be re-derived every time a row moved.
const BOARD_W = 512;
const BOARD_H = 512;
const PX_PER_M = 1024;
const ROWS_TOP = 76; // px; top edge of the first scenario row
const ROW_PITCH = 52;

const _tangent = new THREE.Vector3();
const _local = new THREE.Vector3();
const _curvePoint = new THREE.Vector3();

export const COACH_STATE = {
  IDLE: 'idle',
  READY: 'ready',
  COUNTDOWN: 'countdown', // fed only: bat is set, ball about to launch
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
    this._feedBall = null; // the ball this attempt served, for outcome tracking
    this._struck = false;
    this.result = ''; // where the last fed return actually went

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

  get isFed() {
    return this.scenario.kind === 'fed';
  }

  setScenario(index) {
    const n = SCENARIOS.length;
    this.scenarioIndex = ((index % n) + n) % n;
    this._solveStroke();
    // A new stroke is a new skill; advice about the last one would describe
    // a habit the player does not have in this one.
    this.history = [];
    this.advice = 'Put your bat in the ring to start';
    this.result = '';
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
    this._feedBall = null;
    this._struck = false;
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

    if (scenario.kind === 'fed') {
      // Fly the feed forward to the plane where the stroke meets it, so the
      // contact the path is built around is the contact that will happen.
      const feed = scenario.feed;
      const origin = new THREE.Vector3(...feed.origin);
      const feedSpin = new THREE.Vector3(...feed.spin);
      const bounce = new THREE.Vector3(
        feed.bounce.x,
        TABLE.HEIGHT + BALL.RADIUS,
        feed.bounce.z
      );
      const feedVel = solveLaunchTo(origin, bounce, feed.pace, feedSpin, 0.1);
      const arrival = advanceToPlane(
        origin,
        feedVel,
        feedSpin,
        scenario.contactZ,
        TABLE.HEIGHT + 0.05
      );
      // The scenarios are tuned so this solves; if an edit breaks one, fall
      // back to a held ball at head-of-table height rather than crashing.
      if (arrival) {
        contactPoint = arrival.position;
        inVel = arrival.velocity;
        this.ballSpin = arrival.spin;
        this.feedOrigin = origin;
        this.feedVelocity = feedVel;
        this.feedSpin = feedSpin;
        this.flightTime = arrival.time;
      } else {
        contactPoint = new THREE.Vector3(0, TABLE.HEIGHT + 0.25, scenario.contactZ);
        inVel = new THREE.Vector3(0, 0, 0);
        this.ballSpin = feedSpin.clone();
        this.feedOrigin = null;
      }
    } else {
      // The ball waits, held still, at the point the stroke should meet it.
      //
      // Timing a moving feed to a player's swing is a problem with no good
      // answer — the feed cannot know when you will go, and a swing that
      // arrives early or late teaches nothing about the stroke. Holding the
      // ball removes the question: the contact happens where the lesson says
      // it does, whenever you get there, and what is being graded is the
      // shape of the swing. The fed scenarios then add the timing back, one
      // skill at a time.
      contactPoint = new THREE.Vector3(
        scenario.contact[0],
        scenario.contact[1],
        scenario.contact[2]
      );
      inVel = new THREE.Vector3(0, 0, 0);
      this.ballSpin = new THREE.Vector3(...(scenario.spin ?? [0, 0, 0]));
      this.feedOrigin = null;
    }

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
    this.contactNormal = normal.clone().multiplyScalar(Math.sign(speed) || 1);
    this.contactSpeed = Math.abs(speed);
    this.outVel = outVel.clone();

    // The swing travels along the stroke's own direction, not the face
    // normal. Horizontally it goes where the shot goes; vertically it rises
    // or falls at the stroke's authored angle — low-to-high for topspin,
    // high-to-low for a push. Built along the normal instead, every path
    // read as a shove: face angle and swing direction are different things,
    // and the gap between them is the brush.
    const up = new THREE.Vector3(0, 1, 0);
    const rise = (scenario.stroke?.rise ?? 15) * DEG;
    const dir = new THREE.Vector3(outVel.x, 0, outVel.z);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
    dir.normalize().multiplyScalar(Math.cos(rise));
    dir.y = Math.sin(rise);

    // Only the component of the bat's speed along the face normal drives
    // the contact, so a brushing stroke must travel faster than a square
    // one to deliver the same shot — which is exactly what players do.
    const along = Math.max(Math.abs(dir.dot(this.contactNormal)), 0.35);
    this.contactSpeed /= along;

    const size = scenario.stroke?.size ?? 1;
    const back = this.contactSpeed * BACKSWING_TIME * size * BACK_FRACTION;
    const through = this.contactSpeed * FOLLOW_TIME * size * FOLLOW_FRACTION;

    // In-plane "up" for shaping the arc: the part of world-up perpendicular
    // to the swing, so the curve bows the same way whether the stroke rises
    // or falls.
    const perp = up.clone().addScaledVector(dir, -up.dot(dir)).normalize();
    const across = new THREE.Vector3().crossVectors(dir, up).normalize();
    if (across.lengthSq() < 1e-6) across.set(1, 0, 0);

    const start = contactPoint
      .clone()
      .addScaledVector(dir, -back)
      .addScaledVector(perp, -back * 0.18)
      .addScaledVector(across, back * 0.1);
    const mid = contactPoint
      .clone()
      .addScaledVector(dir, -back * 0.45)
      .addScaledVector(perp, -back * 0.07);
    const after = contactPoint
      .clone()
      .addScaledVector(dir, through * 0.5)
      .addScaledVector(perp, through * 0.1);
    const end = contactPoint
      .clone()
      .addScaledVector(dir, through)
      .addScaledVector(perp, through * 0.28)
      .addScaledVector(across, -through * 0.22);

    this.curve = new THREE.CatmullRomCurve3(
      [start, mid, contactPoint.clone(), after, end],
      false,
      'catmullrom',
      0.35
    );

    // Contact is the middle of five control points, so it sits at t = 0.5 in
    // curve space — half of the 200 sampled segments.
    const lengths = this.curve.getLengths(200);
    const arcTotal = lengths[200] || 1e-6;
    const arcBack = lengths[100];
    const arcThrough = Math.max(arcTotal - arcBack, 1e-6);

    // The straight-limb estimate above sized the curve; the real brush angle
    // is the curve's tangent where it meets the ball, so refine the speed
    // against that. Without this every scenario landed short.
    const tangent = this.curve.getTangentAt(arcBack / arcTotal, _tangent);
    const tangentAlong = Math.abs(tangent.dot(this.contactNormal));
    this.contactSpeed = (Math.abs(speed) / Math.max(tangentAlong, 0.35));

    // Invert the profile to get the times the arc actually needs, so peak
    // speed lands exactly on the contact speed the shot was solved for.
    this.arcBack = arcBack;
    this.arcThrough = arcThrough;
    this.arcTotal = arcTotal;
    this.backTime = (2 * arcBack) / Math.max(this.contactSpeed, 1e-3);
    this.followTime =
      arcThrough / Math.max(this.contactSpeed * FOLLOW_FRACTION, 1e-3);
    this.duration = this.backTime + this.followTime;
    // Where contact falls along the path by distance, which is what
    // getPointAt is parameterised by.
    this.contactAt = arcBack / arcTotal;
    this._polyline = this.curve.getSpacedPoints(RIBBON_SAMPLES);

    this.group.clear();
    this.group.add(this._buildCore());
    this.ribbon = this._buildRibbon();
    this.group.add(this.ribbon);
    this.group.add(this._buildStartMarker());
    this.group.add(this._buildChevrons());
    this.group.add(this._buildLandingMarker(target));
    this.group.add(this.ghost);
    if (this._board) this.group.add(this._board); // survives a path rebuild
    this._drawBoard();
    this._paintProgress(0);
  }

  // --- Guide string ---------------------------------------------------------

  // The stroke drawn as one tube, coloured per ring so the string turns
  // green behind the bat as it is traced. TubeGeometry lays its vertices
  // out ring by ring along the curve — (radial + 1) vertices per ring,
  // (segments + 1) rings — which is what lets a per-ring paint work.
  _buildRibbon() {
    const geo = new THREE.TubeGeometry(
      this.curve,
      RIBBON_SAMPLES,
      TUBE_RADIUS,
      TUBE_RADIAL,
      false
    );
    const count = geo.getAttribute('position').count;
    geo.setAttribute(
      'color',
      new THREE.Float32BufferAttribute(new Float32Array(count * 3).fill(1), 3)
    );
    return new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
        toneMapped: false,
      })
    );
  }

  // Colours the string green up to how far you have traced, so the line
  // fills in behind the bat as the stroke is completed.
  _paintProgress(progress) {
    const attr = this.ribbon?.geometry.getAttribute('color');
    if (!attr) return;
    const ringSize = TUBE_RADIAL + 1;
    for (let i = 0; i <= RIBBON_SAMPLES; i++) {
      const c = i / RIBBON_SAMPLES <= progress ? TRACED : UNTRACED;
      for (let r = 0; r < ringSize; r++) {
        attr.setXYZ(i * ringSize + r, c.r, c.g, c.b);
      }
    }
    attr.needsUpdate = true;
  }

  // Faint halo around the string so it stays findable when it runs edge-on
  // to the eye or against a bright passthrough background.
  _buildCore() {
    return new THREE.Mesh(
      new THREE.TubeGeometry(this.curve, RIBBON_SAMPLES, TUBE_RADIUS * 2.4, 8, false),
      new THREE.MeshBasicMaterial({
        color: 0xf2efe6,
        transparent: true,
        opacity: 0.12,
        depthWrite: false,
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

  // Small arrows along the ribbon so the direction of travel is readable at
  // a glance — without them players traced the line backwards.
  _buildChevrons() {
    const group = new THREE.Group();
    const material = new THREE.MeshBasicMaterial({
      color: 0xf2efe6,
      transparent: true,
      opacity: 0.85,
      toneMapped: false,
    });
    for (const u of [0.16, 0.42, 0.72]) {
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(0.022, 0.06, 10),
        material
      );
      // Cones point +Y; rotate the geometry so lookAt's +Z convention works.
      cone.geometry.rotateX(Math.PI / 2);
      const point = this.curve.getPointAt(u);
      this.curve.getTangentAt(u, _tangent);
      cone.position.copy(point);
      cone.lookAt(point.clone().add(_tangent));
      group.add(cone);
    }
    return group;
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
  // one action that needs the pause menu was backwards. The bottom half
  // shows the score, so glancing left answers both "what am I doing" and
  // "how did that go".
  _buildScenarioBoard() {
    const canvas = document.createElement('canvas');
    canvas.width = BOARD_W;
    canvas.height = BOARD_H;
    const ctx = canvas.getContext('2d');
    this._boardCtx = ctx;
    this._boardTexture = new THREE.CanvasTexture(canvas);
    this._boardTexture.colorSpace = THREE.SRGBColorSpace;
    this._boardTexture.anisotropy = 8;

    const panel = new THREE.Mesh(
      new THREE.PlaneGeometry(BOARD_W / PX_PER_M, BOARD_H / PX_PER_M),
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
    board.position.set(-0.68, TABLE.HEIGHT + 0.48, PLAY_AREA.PLAYER_Z - 0.5);
    board.rotation.y = 0.5;
    this._board = board;
    this._drawBoard();
    return board;
  }

  _drawBoard() {
    const ctx = this._boardCtx;
    if (!ctx) return;
    const W = BOARD_W;
    const H = BOARD_H;
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
      const y = ROWS_TOP + 32 + i * ROW_PITCH;
      const current = i === this.scenarioIndex;
      if (current) {
        ctx.fillStyle = 'rgba(226,35,26,0.2)';
        ctx.fillRect(22, y - 32, W - 50, 44);
      }
      ctx.fillStyle = current ? '#e2231a' : 'rgba(242,239,230,0.55)';
      ctx.font = `${current ? 700 : 500} 24px ui-monospace, monospace`;
      ctx.fillText(current ? '▸' : ' ', 34, y);
      ctx.fillText(scenario.name.toUpperCase(), 72, y);
      if (scenario.kind === 'fed') {
        // Mark the reaction drills so the two kinds are tellable apart
        // before you pick one.
        ctx.fillStyle = 'rgba(242,239,230,0.35)';
        ctx.font = '500 18px ui-monospace, monospace';
        ctx.fillText('LIVE', W - 90, y);
      }
    });

    const statusTop = ROWS_TOP + 32 + SCENARIOS.length * ROW_PITCH + 4;
    ctx.strokeStyle = 'rgba(242,239,230,0.18)';
    ctx.beginPath();
    ctx.moveTo(34, statusTop);
    ctx.lineTo(W - 28, statusTop);
    ctx.stroke();

    // Score summary: the number you just earned and the one to beat.
    ctx.fillStyle = '#f2efe6';
    ctx.font = '700 52px ui-monospace, monospace';
    const last = this.lastScore ? `${this.lastScore.total}%` : '--';
    ctx.fillText(last, 34, statusTop + 66);
    ctx.fillStyle = 'rgba(242,239,230,0.5)';
    ctx.font = '500 20px ui-monospace, monospace';
    ctx.fillText(`BEST ${this.bestScore}%`, 200, statusTop + 50);
    ctx.fillText(`TRIES ${this.attempts}`, 200, statusTop + 76);

    // Where the last live return went — the fed drills are about the result
    // as much as the shape.
    if (this.result) {
      ctx.fillStyle = this.result === 'ON THE TABLE' ? '#3ddc84' : '#e2231a';
      ctx.font = '700 22px ui-monospace, monospace';
      ctx.fillText(this.result, 34, statusTop + 106);
    }

    ctx.fillStyle = 'rgba(242,239,230,0.4)';
    ctx.font = '500 18px ui-monospace, monospace';
    ctx.fillText('TAP A ROW WITH YOUR BAT TO SWITCH', 34, H - 24);

    this._boardTexture.needsUpdate = true;
  }

  // Touching a row with the bat switches drill, so the common action needs
  // no menu at all.
  _checkBoardTap(blade) {
    if (!this._board) return;
    // Reused rather than cloned: this runs every frame the lesson is idle.
    const local = this._board.worldToLocal(_local.copy(blade));
    const halfW = BOARD_W / PX_PER_M / 2;
    const halfH = BOARD_H / PX_PER_M / 2;
    const onPanel =
      Math.abs(local.x) < halfW - 0.02 &&
      Math.abs(local.y) < halfH - 0.02 &&
      Math.abs(local.z) < 0.1;

    if (!onPanel) {
      this._boardTouch = false;
      return;
    }
    if (this._boardTouch) return; // one switch per touch, not one per frame
    this._boardTouch = true;

    // Panel-local metres back to the canvas pixels the rows were drawn at.
    const py = BOARD_H / 2 - local.y * PX_PER_M;
    const index = Math.floor((py - ROWS_TOP) / ROW_PITCH);
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

  // How far along the path the stroke should have travelled by `t`, as a
  // fraction of its length. This is what makes the demonstration accelerate
  // into the ball instead of gliding at one speed.
  _profileU(t) {
    const v = this.contactSpeed;
    const total = this.arcTotal;
    if (!total || total < 1e-6) return 0;
    if (t <= 0) return 0;

    if (t <= this.backTime) {
      const d = (v * t * t) / (2 * Math.max(this.backTime, 1e-6));
      return Math.min(d / total, 1);
    }
    const s = Math.min(t - this.backTime, this.followTime);
    const d =
      this.arcBack +
      v * (s - (FOLLOW_DECAY * s * s) / (2 * Math.max(this.followTime, 1e-6)));
    return Math.min(d / total, 1);
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

  // The physics tells us what actually happened to the fed ball, so the
  // drill can report the result and not just the shape.
  onBallEvent(ball, event, paddle) {
    if (!this.active || !this._feedBall || ball !== this._feedBall) return;
    if (event === 'paddle' && !paddle?.isOpponent) {
      this._struck = true;
      return;
    }
    if (!this._struck) return;
    if (event === 'table' && ball.mesh.position.z < 0) {
      this.result = 'ON THE TABLE';
      this._feedBall = null;
    } else if (event === 'floor' || (event === 'table' && ball.mesh.position.z >= 0)) {
      this.result = 'OFF THE TABLE';
      this._feedBall = null;
    }
    this._drawBoard();
  }

  // --- Running a scenario -------------------------------------------------

  // Returns the haptic strength to apply this frame. `placeBall` parks a
  // frozen ball at the contact point; `feedBall` serves a live one.
  update(dt, paddle, placeBall, heldBall, feedBall) {
    if (!this.active || !paddle?.tracking) return 0;

    const blade = paddle.bladeCenter;
    const near = this._closestOnPath(blade);
    this.deviation = near.distance;

    if (this._armCooldown > 0) this._armCooldown -= dt;
    if (this.state !== COACH_STATE.TRACING) this._checkBoardTap(blade);

    // Keep a ball waiting whenever we are not mid-stroke — held drills only;
    // a fed drill's ball arrives by being served at you.
    if (
      !this.isFed &&
      this.state !== COACH_STATE.TRACING &&
      !heldBall?.()
    ) {
      this._placeHeldBall(placeBall);
    }

    switch (this.state) {
      case COACH_STATE.READY:
      case COACH_STATE.SCORED: {
        // Idle demonstration loops the same accelerating profile, with a
        // pause at the end so the stroke reads as a stroke.
        this._demoT = ((this._demoT ?? 0) + dt) % (this.duration + 0.8);
        this._ghostT = this._profileU(Math.min(this._demoT, this.duration));
        this.curve.getPointAt(this._ghostT, this.ghost.position);

        const atStart =
          blade.distanceTo(this.curve.getPointAt(0, _curvePoint)) < 0.11;
        if (atStart && this._armCooldown <= 0) {
          this._samples.length = 0;
          this._ghostT = 0;
          this.progress = 0;
          this._paintedStep = -1;
          this._paintProgress(0);
          this._struck = false;

          if (this.isFed && this.feedOrigin && feedBall) {
            // Set: the ball launches after a beat, and the swing starts
            // when the marker moves — which is timed so the stroke meets
            // the ball at the solved contact.
            this.state = COACH_STATE.COUNTDOWN;
            this._countdown = FEED_DELAY;
          } else {
            this.state = COACH_STATE.TRACING;
            this._elapsed = 0;
          }
          this.sfx?.ui(true);
        }
        break;
      }

      case COACH_STATE.COUNTDOWN: {
        // Ghost waits at the start of the path with the player.
        this.curve.getPointAt(0, this.ghost.position);
        this._countdown -= dt;
        if (this._countdown <= 0) {
          this._feedBall =
            feedBall?.(
              this.feedOrigin.clone(),
              this.feedVelocity.clone(),
              this.feedSpin.clone()
            ) ?? null;
          this.result = '';
          // Clock runs negative through the ball's flight so the swing
          // (t = 0) begins exactly backTime before the ball arrives.
          this._elapsed = -Math.max(this.flightTime - this.backTime, 0);
          this.state = COACH_STATE.TRACING;
          this.sfx?.ui(true);
        }
        break;
      }

      case COACH_STATE.TRACING: {
        this._elapsed += dt;
        this._ghostT = this._profileU(this._elapsed);
        this.curve.getPointAt(this._ghostT, this.ghost.position);

        // While a fed ball is still inbound the player just holds the start;
        // grading their stillness would punish doing the right thing.
        if (this._elapsed < 0) break;

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
          this._elapsed > this.duration * 2.5 ||
          near.distance > MAX_DEVIATION * 2;
        if (finished || abandoned) this._finish(finished);
        break;
      }
    }

    if (this.state === COACH_STATE.TRACING && this._elapsed >= 0) {
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
      this._drawBoard();
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
    this._drawBoard();
    this.sfx?.targetHit?.();
    this.onScore?.(this.lastScore);
  }

  // One short line telling the player what to do next.
  get instruction() {
    switch (this.state) {
      case COACH_STATE.COUNTDOWN:
        return 'Get set — ball coming';
      case COACH_STATE.TRACING:
        return this._elapsed < 0
          ? 'Ball incoming — swing when the marker moves'
          : 'Follow the marker';
      case COACH_STATE.SCORED:
        return this.advice;
      case COACH_STATE.READY:
        return this.isFed
          ? 'Bat in the ring when you are ready'
          : 'Put your bat in the ring to start';
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
      return scenario.stroke?.rise < 0
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
