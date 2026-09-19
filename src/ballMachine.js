import * as THREE from 'three';
import { TABLE, NET, BALL, COLORS, PHYSICS, PLAY_AREA } from './constants.js';

// Robot ball machine at the far end of the table. This is the "trainer" part
// of the app: it aims at a chosen spot on the player's half and launches with
// a drill-specific spin.
//
// Spin convention, for a ball travelling toward the player (+Z):
//   ω = +X  topspin   — Magnus pushes the flight down, the bounce kicks on
//   ω = −X  backspin  — the ball floats, then checks up off the bounce
//   ω = ±Y  sidespin  — curves left or right and skids sideways on landing

// `drill`    fixed spin and pace, machine parked centre — learn one stroke
// `infinite` machine roams the baseline and randomises everything
// `target`   machine steps aside and feeds the ball up in front of you, to be
//            driven at a target pad on the far half
export const MODES = [
  { name: 'Topspin drive', type: 'drill', spin: 190, axis: 'x', speed: 5.0, interval: 2.2 },
  { name: 'Backspin push', type: 'drill', spin: -150, axis: 'x', speed: 4.0, interval: 2.6 },
  { name: 'Flat block', type: 'drill', spin: 0, axis: 'x', speed: 4.6, interval: 2.0 },
  { name: 'Sidespin mix', type: 'drill', spin: 170, axis: 'y', speed: 4.6, interval: 2.4 },
  {
    name: 'Infinite',
    type: 'infinite',
    roam: true,
    speedRange: [3.8, 5.8],
    spinRange: [-230, 230],
    intervalRange: [1.3, 2.4],
    spread: 0.62,
  },
  { name: 'Target practice', type: 'target', interval: 3.0, feedHeight: 0.55 },
];

const MUZZLE_HEIGHT = TABLE.HEIGHT + 0.26;
const BASELINE_TRAVEL = TABLE.WIDTH / 2 + 0.25; // how far the machine roams

const _target = new THREE.Vector3();
const _flat = new THREE.Vector3();

const rand = (lo, hi) => lo + Math.random() * (hi - lo);

export class BallMachine {
  constructor(balls, settings) {
    this.balls = balls; // pooled Ball instances
    this.settings = settings;
    this.enabled = true;
    this.spread = 0.5; // lateral spread of the target point (m)
    this.modeIndex = 0;
    this.servedCount = 0;

    this._timer = 1.2; // small delay before the first serve
    this._flash = 0; // indicator lamp decay
    this._wheelSpin = 0;
    this._roamTarget = 0; // x the machine is currently sliding toward
    this._roamTimer = 0;

    this.mesh = buildMachineMesh();
    this.mesh.position.set(0, 0, PLAY_AREA.SERVER_Z);
    this._head = this.mesh.getObjectByName('head');
    this._wheels = [
      this.mesh.getObjectByName('wheel-l'),
      this.mesh.getObjectByName('wheel-r'),
    ];
    this._lamp = this.mesh.getObjectByName('lamp');

    this.aim = new THREE.Vector3(0, TABLE.HEIGHT, TABLE.LENGTH / 4);
  }

  get mode() {
    return MODES[this.modeIndex];
  }

  // Kept as `drill` for the HUD's benefit — it only ever wants the name.
  get drill() {
    return this.mode;
  }

  nextDrill() {
    this.modeIndex = (this.modeIndex + 1) % MODES.length;
    this._timer = Math.min(this._timer, 1.0);
    return this.mode;
  }

  get isTargetMode() {
    return this.mode.type === 'target';
  }

  update(dt) {
    this._updateRoaming(dt);

    // Head tracks wherever the next ball is going
    if (this._head) {
      _flat.copy(this.aim);
      this._head.lookAt(_flat);
    }

    // Wheels idle-spin while armed and spike right after a shot
    const wheelRate = this.enabled && !this.isTargetMode ? 14 + this._flash * 60 : 0;
    this._wheelSpin += wheelRate * dt;
    for (const w of this._wheels) if (w) w.rotation.y = this._wheelSpin;

    if (this._flash > 0) {
      this._flash = Math.max(0, this._flash - dt * 3);
    }
    if (this._lamp) {
      this._lamp.material.emissiveIntensity = this.enabled
        ? 0.4 + this._flash * 2.5
        : 0.05;
      this._lamp.material.emissive.setHex(
        this.enabled ? COLORS.ACCENT : 0x802020
      );
    }

    if (!this.enabled) return;

    this._timer -= dt;
    if (this._timer <= 0) {
      this._timer = this._nextInterval();
      this.serve();
    }
  }

  // Settings are multipliers on whatever the mode specifies, so changing
  // them adjusts the challenge without flattening each mode's character.
  _setting(key, fallback = 1) {
    return this.settings?.get(key) ?? fallback;
  }

  _nextInterval() {
    const mode = this.mode;
    const base = mode.intervalRange ? rand(...mode.intervalRange) : mode.interval;
    return base * this._setting('feedRate');
  }

  // In infinite mode the machine slides along the baseline, so shots arrive
  // from a different angle each time instead of always down the same line.
  // In target mode it parks off to the side, out of the firing line.
  _updateRoaming(dt) {
    const mode = this.mode;
    let desiredX = 0;
    let desiredZ = PLAY_AREA.SERVER_Z;

    if (mode.roam) {
      this._roamTimer -= dt;
      if (this._roamTimer <= 0) {
        this._roamTimer = rand(1.5, 3.5);
        this._roamTarget = rand(-BASELINE_TRAVEL, BASELINE_TRAVEL);
      }
      desiredX = this._roamTarget;
    } else if (this.isTargetMode) {
      desiredX = BASELINE_TRAVEL + 0.45;
      desiredZ = PLAY_AREA.SERVER_Z - 0.1;
    }

    // Damped move so it glides rather than teleporting
    const k = Math.min(1, dt * 1.6);
    this.mesh.position.x += (desiredX - this.mesh.position.x) * k;
    this.mesh.position.z += (desiredZ - this.mesh.position.z) * k;
  }

  serve() {
    const ball = this.balls.find((b) => !b.active);
    if (!ball) return; // pool exhausted; a ball will free up shortly

    if (this.isTargetMode) {
      this._feedToPlayer(ball);
    } else {
      this._launch(ball);
    }

    this.servedCount++;
    this._flash = 1;
  }

  _launch(ball) {
    const mode = this.mode;

    // Aim at a point on the player's half, short of the end line. The spread
    // has to be clamped to the table: a wide mode multiplied by the Wide
    // placement setting otherwise targets past the side line, and a ball
    // aimed off the table is unhittable and scores as a miss through no
    // fault of the player.
    const maxSpread = TABLE.WIDTH / 2 - BALL.RADIUS - 0.04;
    const spread = Math.min(
      (mode.spread ?? this.spread) * this._setting('placement'),
      maxSpread
    );

    _target.set(
      (Math.random() * 2 - 1) * spread,
      TABLE.HEIGHT + BALL.RADIUS,
      TABLE.LENGTH * 0.18 + Math.random() * TABLE.LENGTH * 0.22
    );
    this.aim.copy(_target);

    const origin = new THREE.Vector3(
      this.mesh.position.x,
      MUZZLE_HEIGHT,
      this.mesh.position.z + 0.12
    );

    // Infinite mode rolls fresh spin and pace for every ball, including the
    // spin axis, so you can't settle into one stroke.
    let spinAmount;
    let axis;
    let speed;
    if (mode.type === 'infinite') {
      spinAmount = rand(...mode.spinRange);
      axis = Math.random() < 0.35 ? 'y' : 'x';
      speed = rand(...mode.speedRange);
    } else {
      spinAmount = mode.spin;
      axis = mode.axis;
      speed = mode.speed;
    }

    const spin = new THREE.Vector3();
    if (axis === 'y') {
      spin.set(0, spinAmount, 0);
    } else {
      spin.set(spinAmount, 0, 0);
    }

    const velocity = solveLaunch(origin, _target, speed * this._setting('pace'), spin);
    ball.serve(origin, velocity, spin);
  }

  // Target mode: lob the ball gently upward just in front of the player so
  // they can take a full swing at it. A near-vertical toss gives a wide
  // timing window, which is what makes this a placement drill rather than a
  // reaction one.
  _feedToPlayer(ball) {
    const mode = this.mode;
    const origin = new THREE.Vector3(
      rand(-0.28, 0.28),
      TABLE.HEIGHT + 0.06,
      PLAY_AREA.PLAYER_Z - 0.62
    );

    // Toss height sets the hang time: v = sqrt(2·g·h)
    const up = Math.sqrt(2 * 9.81 * mode.feedHeight);
    const velocity = new THREE.Vector3(rand(-0.06, 0.06), up, rand(-0.12, 0.02));

    this.aim.copy(origin);
    ball.serve(origin, velocity, new THREE.Vector3(0, 0, 0));
    ball.isFeed = true;
  }
}

// --- Launch solver ----------------------------------------------------------
// A closed-form ballistic solve is wrong here: drag takes metres off the
// range, and Magnus bends the flight hard enough that a topspin shot aimed
// analytically dives straight into the net. So aim by simulating the same
// forces the physics step applies, then correct and repeat.
//
// Two coupled corrections run together — horizontal speed scales toward the
// target range, and launch elevation rises until the ball clears the net with
// margin. A handful of iterations is plenty, and it only runs once per serve.

const SOLVER_ITERATIONS = 8;
const NET_MARGIN = 0.055; // metres of air over the tape

const _simPos = new THREE.Vector3();
const _simVel = new THREE.Vector3();
const _simSpin = new THREE.Vector3();
const _simAcc = new THREE.Vector3();
const _cross = new THREE.Vector3();

// Flies a trial shot and reports where it lands and how close it came to the
// net tape. Mirrors the integration in PhysicsWorld.
function simulateShot(origin, velocity, spin, targetY) {
  _simPos.copy(origin);
  _simVel.copy(velocity);
  _simSpin.copy(spin);

  const h = 1 / 240;
  let netClearance = Infinity;

  for (let i = 0; i < 240 * 3; i++) {
    const prevY = _simPos.y;
    const prevZ = _simPos.z;

    const speed = _simVel.length();
    _simAcc.set(0, PHYSICS.GRAVITY, 0);
    if (speed > 1e-4) {
      _simAcc.addScaledVector(_simVel, -PHYSICS.DRAG * speed);
      _cross.copy(_simSpin).cross(_simVel).multiplyScalar(PHYSICS.MAGNUS);
      _simAcc.add(_cross);
    }
    _simVel.addScaledVector(_simAcc, h);
    _simPos.addScaledVector(_simVel, h);
    _simSpin.multiplyScalar(Math.pow(BALL.SPIN_DECAY, h));

    if (prevZ < 0 && _simPos.z >= 0) {
      const t = Math.abs(prevZ) / Math.max(Math.abs(prevZ - _simPos.z), 1e-6);
      const y = prevY + (_simPos.y - prevY) * t;
      netClearance = y - (TABLE.HEIGHT + NET.HEIGHT);
    }

    if (_simVel.y < 0 && _simPos.y <= targetY) {
      return { landed: true, x: _simPos.x, z: _simPos.z, netClearance };
    }
  }
  return { landed: false, x: _simPos.x, z: _simPos.z, netClearance };
}

function solveLaunch(origin, target, speed, spin) {
  const dx = target.x - origin.x;
  const dz = target.z - origin.z;
  const dy = target.y - origin.y;
  const range = Math.hypot(dx, dz);
  const ux = dx / range;
  const uz = dz / range;

  // Opening guess: plain ballistics, but with gravity bumped by the Magnus
  // term topspin contributes, so the first trial is already in the region.
  const T = range / speed;
  const gEff = 9.81 + PHYSICS.MAGNUS * spin.x * speed;
  let horizontalSpeed = speed;
  let vy = (dy + 0.5 * gEff * T * T) / T;

  const velocity = new THREE.Vector3();

  for (let i = 0; i < SOLVER_ITERATIONS; i++) {
    velocity.set(ux * horizontalSpeed, vy, uz * horizontalSpeed);
    const shot = simulateShot(origin, velocity, spin, target.y);

    if (shot.netClearance < NET_MARGIN) {
      // Too flat — lift the launch until it clears the tape.
      vy += (NET_MARGIN - shot.netClearance) * 2.4 + 0.05;
      continue;
    }

    const flown = Math.hypot(shot.x - origin.x, shot.z - origin.z);
    if (!shot.landed || flown < 1e-3) break;

    const ratio = range / flown;
    if (Math.abs(ratio - 1) < 0.01) break;
    horizontalSpeed *= THREE.MathUtils.clamp(ratio, 0.75, 1.35);
  }

  return velocity.set(ux * horizontalSpeed, vy, uz * horizontalSpeed);
}

function buildMachineMesh() {
  const group = new THREE.Group();

  const shell = new THREE.MeshStandardMaterial({
    color: 0x2a2f38,
    roughness: 0.45,
    metalness: 0.35,
  });
  const dark = new THREE.MeshStandardMaterial({
    color: 0x14171c,
    roughness: 0.7,
  });
  const accent = new THREE.MeshStandardMaterial({
    color: COLORS.ACCENT,
    roughness: 0.4,
    metalness: 0.2,
  });

  // Tripod base
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(0.2, 0.26, 0.035, 20),
    dark
  );
  base.position.y = 0.018;
  base.castShadow = true;
  group.add(base);

  const column = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.065, TABLE.HEIGHT + 0.1, 16),
    shell
  );
  column.position.y = (TABLE.HEIGHT + 0.1) / 2;
  column.castShadow = true;
  group.add(column);

  // Body
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.32, 0.3), shell);
  body.position.y = MUZZLE_HEIGHT;
  body.castShadow = true;
  group.add(body);

  // Chamfer plate across the front so it isn't a plain cube
  const facePlate = new THREE.Mesh(new THREE.BoxGeometry(0.33, 0.22, 0.02), dark);
  facePlate.position.set(0, MUZZLE_HEIGHT - 0.02, 0.152);
  group.add(facePlate);

  const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.39, 0.024, 0.014), accent);
  stripe.position.set(0, MUZZLE_HEIGHT + 0.1, 0.152);
  group.add(stripe);

  // Status lamp
  const lamp = new THREE.Mesh(
    new THREE.SphereGeometry(0.016, 14, 10),
    new THREE.MeshStandardMaterial({
      color: 0x0a0a0a,
      emissive: new THREE.Color(COLORS.ACCENT),
      emissiveIntensity: 0.5,
      roughness: 0.3,
    })
  );
  lamp.name = 'lamp';
  lamp.position.set(0.14, MUZZLE_HEIGHT + 0.1, 0.152);
  group.add(lamp);

  // Hopper of spare balls on top
  const hopper = new THREE.Mesh(
    new THREE.CylinderGeometry(0.15, 0.1, 0.18, 20, 1, true),
    new THREE.MeshStandardMaterial({
      color: 0x9aa4b2,
      transparent: true,
      opacity: 0.32,
      roughness: 0.25,
      side: THREE.DoubleSide,
    })
  );
  hopper.position.y = MUZZLE_HEIGHT + 0.25;
  group.add(hopper);

  const hopperLip = new THREE.Mesh(
    new THREE.TorusGeometry(0.15, 0.007, 8, 24),
    shell
  );
  hopperLip.rotation.x = Math.PI / 2;
  hopperLip.position.y = MUZZLE_HEIGHT + 0.34;
  group.add(hopperLip);

  const spareGeo = new THREE.SphereGeometry(BALL.RADIUS, 12, 8);
  const spareMat = new THREE.MeshStandardMaterial({
    color: COLORS.BALL,
    roughness: 0.5,
  });
  // Deterministic scatter so the hopper looks packed but never re-shuffles
  for (let i = 0; i < 14; i++) {
    const s = new THREE.Mesh(spareGeo, spareMat);
    const a = i * 2.399; // golden-angle spiral
    const rad = 0.03 + (i % 4) * 0.028;
    s.position.set(
      Math.cos(a) * rad,
      MUZZLE_HEIGHT + 0.19 + (i % 5) * 0.02,
      Math.sin(a) * rad
    );
    group.add(s);
  }

  // Aiming head with the launch wheels
  const head = new THREE.Group();
  head.name = 'head';
  head.position.set(0, MUZZLE_HEIGHT - 0.02, 0.17);
  group.add(head);

  const barrel = new THREE.Mesh(
    new THREE.CylinderGeometry(0.045, 0.055, 0.14, 18, 1, true),
    dark
  );
  // lookAt() aims an object's −Z axis, so lay the barrel along −Z
  barrel.rotation.x = Math.PI / 2;
  barrel.position.z = -0.07;
  head.add(barrel);

  const muzzle = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.007, 8, 20), accent);
  muzzle.position.z = -0.14;
  head.add(muzzle);

  const wheelGeo = new THREE.CylinderGeometry(0.05, 0.05, 0.018, 18);
  const wheelMat = new THREE.MeshStandardMaterial({
    color: 0x3c4450,
    roughness: 0.5,
    metalness: 0.4,
  });
  for (const [name, sx] of [
    ['wheel-l', -1],
    ['wheel-r', 1],
  ]) {
    // The wheel spins on its own axis, so it sits inside a holder that does
    // the tilting. Putting both rotations on one object would make it wobble
    // about the parent's axis instead of turning in place.
    const holder = new THREE.Group();
    holder.rotation.z = Math.PI / 2;
    holder.position.set(sx * 0.055, 0, -0.03);

    const wheel = new THREE.Mesh(wheelGeo, wheelMat);
    wheel.name = name;
    holder.add(wheel);
    head.add(holder);
  }

  return group;
}
