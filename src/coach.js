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

const CONTACT_PLANE_Z = PLAY_AREA.PLAYER_Z - 0.45;

// How long the bat travels before and after the strike. Real strokes are
// longer, but a short path is easier to trace accurately and the contact is
// the part being taught.
const BACKSWING_TIME = 0.34;
const FOLLOW_TIME = 0.3;

export const SCENARIOS = [
  {
    id: 'serve',
    name: 'Serve',
    brief: 'Ball drops in the same spot each time — brush it deep crosscourt',
    // A serve has no incoming ball: it is tossed and struck as it falls.
    toss: { x: 0.18, height: 1.35 },
    land: { x: -0.42, z: -1.0 },
    pace: 4.4,
  },
  {
    id: 'drive',
    name: 'Drive a topspin ball',
    brief: 'Same ball, same angle, every time — drive it deep',
    feed: {
      from: [-0.35, TABLE.HEIGHT + 0.26, -(TABLE.LENGTH / 2 + 0.2)],
      aimAt: [0.2, 0.85],
      speed: 4.6,
      spin: [150, 0, 0],
    },
    land: { x: -0.3, z: -1.05 },
    pace: 5.0,
  },
  {
    id: 'push',
    name: 'Push a backspin ball',
    brief: 'Heavy backspin arrives the same way each time — push it low',
    feed: {
      from: [0.3, TABLE.HEIGHT + 0.26, -(TABLE.LENGTH / 2 + 0.2)],
      aimAt: [-0.15, 0.7],
      speed: 3.9,
      spin: [-170, 0, 0],
    },
    land: { x: 0.25, z: -0.5 },
    pace: 3.4,
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
    this._ballDue = null;
    this._leadIn = 0;

    this._buildGhost();
    this.setScenario(0);
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
    this.deviation = 0;
    this._ballDue = null;
    this._leadIn = 0;
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

    if (scenario.toss) {
      // A serve: the ball is dropped from a fixed spot and struck on the way
      // down, so by contact its velocity is just what gravity has given it.
      contactPoint = new THREE.Vector3(
        scenario.toss.x,
        TABLE.HEIGHT + 0.22,
        PLAY_AREA.PLAYER_Z - 0.3
      );
      const fall = Math.max(scenario.toss.height - contactPoint.y, 0.05);
      inVel = new THREE.Vector3(0, -Math.sqrt(2 * 9.81 * fall), 0);
      this.feedState = null;
    } else {
      // A fed ball: fly the feed forward to the plane where it is met.
      const from = new THREE.Vector3(...scenario.feed.from);
      const aim = new THREE.Vector3(
        scenario.feed.aimAt[0],
        TABLE.HEIGHT + BALL.RADIUS,
        scenario.feed.aimAt[1]
      );
      const spin = new THREE.Vector3(...scenario.feed.spin);
      const feedVel = solveLaunchTo(from, aim, scenario.feed.speed, spin);

      const met = advanceToPlane(from, feedVel, spin, CONTACT_PLANE_Z, 0.55);
      this.feedState = { from, velocity: feedVel, spin, flight: met?.time ?? 1 };

      contactPoint = met
        ? met.position.clone()
        : new THREE.Vector3(0, 1.0, CONTACT_PLANE_Z);
      inVel = met ? met.velocity.clone() : new THREE.Vector3(0, -1, 3);
    }

    // What the ball must do next, and therefore what the bat must do.
    const outVel = solveLaunchTo(contactPoint, target, scenario.pace, null, 0.16);
    const { normal, speed } = solveContact(inVel, outVel);

    this.contactPoint = contactPoint;
    this.contactNormal = normal.clone();
    this.contactSpeed = Math.abs(speed);
    this.outVel = outVel.clone();

    // Lay the path along the swing: back along the face normal before
    // contact, on through it after.
    const dir = normal.clone().multiplyScalar(Math.sign(speed) || 1);
    const back = this.contactSpeed * BACKSWING_TIME * 0.62;
    const through = this.contactSpeed * FOLLOW_TIME * 0.85;

    const start = contactPoint.clone().addScaledVector(dir, -back);
    const mid = contactPoint.clone().addScaledVector(dir, -back * 0.38);
    const after = contactPoint.clone().addScaledVector(dir, through * 0.45);
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
  update(dt, paddle, serveBall, liveBall) {
    this._liveBall = liveBall;
    if (!this.active || !paddle?.tracking) return 0;

    const blade = paddle.bladeCenter;
    const near = this._closestOnPath(blade);
    this.deviation = near.distance;

    if (this._armCooldown > 0) this._armCooldown -= dt;
    if (this._ballDue !== null) {
      this._ballDue -= dt;
      if (this._ballDue <= 0) {
        this._ballDue = null;
        this._releaseBall(serveBall);
      }
    }

    switch (this.state) {
      case COACH_STATE.READY:
      case COACH_STATE.SCORED: {
        this._ghostT = (this._ghostT + dt / (this.duration + 0.7)) % 1;
        this.ghost.position.copy(this.curve.getPointAt(this._ghostT));

        const atStart = blade.distanceTo(this.curve.getPointAt(0)) < 0.11;
        if (atStart && this._armCooldown <= 0) {
          this.state = COACH_STATE.TRACING;
          this._samples.length = 0;
          this._elapsed = 0;
          this._ghostT = 0;
          this.progress = 0;
          this._paintProgress(0);

          // The ball has to be in the air before the stroke starts whenever
          // its flight is longer than the backswing — a fed ball takes some
          // 0.6 s to arrive and the bat reaches contact in 0.34 s, so
          // releasing it with the swing meant the bat was long past by the
          // time it got there. Release immediately, then hold the stroke at
          // the ring for the difference so contact still coincides.
          const flight = this.feedState?.flight ?? this._tossFlight();
          const toContact = this.contactAt * this.duration;
          this._leadIn = Math.max(flight - toContact, 0);
          this._ballDue = Math.max(toContact - flight, 0);
          this.sfx?.ui(true);
        }
        break;
      }

      case COACH_STATE.TRACING: {
        // Waiting at the ring for the ball to come to us. Rather than trust
        // a precomputed flight time — which drifts from the real one, since
        // the live ball bounces through the full physics — watch the actual
        // ball and start the stroke when it is exactly a backswing away.
        // Self-correcting, so the bat and ball meet whatever the feed does.
        if (this._leadIn > 0) {
          this._leadIn -= dt;
          this.ghost.position.copy(this.curve.getPointAt(0));

          const live = this._liveBall?.();
          if (live) {
            const met = advanceToPlane(
              live.mesh.position,
              live.velocity,
              live.spin,
              this.contactPoint.z,
              0.2
            );
            if (met && met.time <= this.contactAt * this.duration) {
              this._leadIn = 0; // it is a backswing away: go now
            }
          }
          break;
        }

        this._elapsed += dt;
        this._ghostT = Math.min(this._elapsed / this.duration, 1);
        this.ghost.position.copy(this.curve.getPointAt(this._ghostT));

        // Progress only moves forward: the trail should fill in as the
        // stroke completes, not flicker back when the bat wobbles.
        this.progress = Math.max(this.progress, near.t);
        this._paintProgress(this.progress);

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

  // How long the tossed ball takes to fall from release to contact.
  _tossFlight() {
    const scenario = this.scenario;
    if (!scenario.toss) return 0.35;
    const fall = Math.max(scenario.toss.height - this.contactPoint.y, 0.05);
    return Math.sqrt((2 * fall) / 9.81);
  }

  // Puts the scenario's ball in play. Identical every attempt, which is the
  // point — you are practising one situation, not reacting to a new one.
  _releaseBall(serveBall) {
    if (!serveBall) return;
    const scenario = this.scenario;

    if (scenario.toss) {
      serveBall(
        new THREE.Vector3(
          scenario.toss.x,
          scenario.toss.height,
          PLAY_AREA.PLAYER_Z - 0.3
        ),
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0, 0)
      );
    } else if (this.feedState) {
      serveBall(
        this.feedState.from.clone(),
        this.feedState.velocity.clone(),
        this.feedState.spin.clone()
      );
    }
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
