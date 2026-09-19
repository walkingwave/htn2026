import * as THREE from 'three';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

import { createTable } from './table.js';
import { createXRButtons } from './xrButtons.js';
import { Paddle } from './paddle.js';
import { Ball } from './ball.js';
import { PhysicsWorld } from './physics.js';
import { BallMachine } from './ballMachine.js';
import { Game } from './game.js';
import { Scoreboard } from './hud.js';
import { TargetZone } from './target.js';
import { PLAY_AREA, TABLE, COLORS, BALL } from './constants.js';

const BALL_POOL_SIZE = 10;
const DEAD_BALL_LINGER = 1.5; // seconds a dead ball stays visible before recycling

// --- Renderer / scene -------------------------------------------------------
// alpha:true so the framebuffer is transparent in AR — the Quest compositor
// shows camera passthrough wherever nothing is drawn.
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const VR_BACKGROUND = new THREE.Color(0x0a0d14);
scene.background = VR_BACKGROUND;

// A baked room probe gives every material sensible reflections, which is most
// of the difference between "untextured boxes" and "objects in a space".
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

const camera = new THREE.PerspectiveCamera(
  70,
  window.innerWidth / window.innerHeight,
  0.01,
  60
);

// Player rig: move this group to reposition the player in the world.
// In XR the camera is controlled by the headset relative to this rig.
const playerRig = new THREE.Group();
playerRig.position.set(0, 0, PLAY_AREA.PLAYER_Z);
playerRig.add(camera);
scene.add(playerRig);

// Desktop fallback camera position (headset overrides this in XR)
camera.position.set(0, 1.62, 0);

// --- Lighting ---------------------------------------------------------------
scene.add(new THREE.HemisphereLight(0xc8d6f0, 0x1d1712, 0.32));

const keyLight = new THREE.DirectionalLight(0xffffff, 1.5);
keyLight.position.set(2.5, 5, 1.5);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(1024, 1024);
keyLight.shadow.camera.near = 0.5;
keyLight.shadow.camera.far = 14;
keyLight.shadow.camera.left = -3;
keyLight.shadow.camera.right = 3;
keyLight.shadow.camera.top = 4;
keyLight.shadow.camera.bottom = -4;
keyLight.shadow.bias = -0.0012;
scene.add(keyLight);
scene.add(keyLight.target);

// Overhead venue light, the sort that hangs above a match table. Kept soft
// and wide — a tight, bright cone blows the playing surface out to white and
// destroys the depth cues you need to read the ball against it.
const venueLight = new THREE.SpotLight(0xffffff, 9, 11, Math.PI / 3.2, 0.9, 1.4);
venueLight.position.set(0, 3.6, 0);
venueLight.target.position.set(0, TABLE.HEIGHT, 0);
scene.add(venueLight);
scene.add(venueLight.target);

// --- World ------------------------------------------------------------------
const table = createTable();
scene.add(table);
const vrEnvironment = table.getObjectByName('vr-environment');

const balls = Array.from({ length: BALL_POOL_SIZE }, () => new Ball());
for (const b of balls) scene.add(b.mesh);

const machine = new BallMachine(balls);
scene.add(machine.mesh);

const game = new Game();
const scoreboard = new Scoreboard(game, machine);
scene.add(scoreboard.mesh);

// Ring showing where the next ball is aimed — the trainer's single most
// useful cue, since it tells you where to move before the ball arrives.
const targetRing = new THREE.Mesh(
  new THREE.RingGeometry(BALL.RADIUS * 3, BALL.RADIUS * 4.2, 32),
  new THREE.MeshBasicMaterial({
    color: COLORS.ACCENT,
    transparent: true,
    opacity: 0.55,
    side: THREE.DoubleSide,
    depthWrite: false,
  })
);
targetRing.rotation.x = -Math.PI / 2;
scene.add(targetRing);

// Target-practice pad on the far half
const targetZone = new TargetZone();
scene.add(targetZone.mesh);

// AR: transparent background, no virtual floor, dimmer fill so the real room
// carries the lighting. VR: full venue.
function applyMode(mode) {
  const isAR = mode === 'immersive-ar';
  scene.background = isAR ? null : VR_BACKGROUND;
  if (vrEnvironment) vrEnvironment.visible = !isAR;
  venueLight.visible = !isAR;
  keyLight.intensity = isAR ? 0.9 : 1.5;
}

createXRButtons(renderer, { onModeChange: applyMode });
renderer.xr.addEventListener('sessionend', () => applyMode(null));

// --- Physics ----------------------------------------------------------------
const physics = new PhysicsWorld();
physics.onBounce = (ball, event) => {
  game.onContact(ball, event);

  if (event === 'paddle') {
    pulse(ball);
    return;
  }

  // A return that lands inside the pad scores and moves the target on.
  if (
    event === 'table' &&
    machine.isTargetMode &&
    ball.touchedByPaddle &&
    !ball.scoredTarget &&
    ball.mesh.position.z < 0 &&
    targetZone.contains(ball.mesh.position.x, ball.mesh.position.z)
  ) {
    ball.scoredTarget = true;
    targetZone.registerHit();
    game.onTargetHit();
  }

  // Floor contact means the rally is over for this ball; start a countdown
  // that returns it to the pool. Timed in simulation seconds rather than via
  // setTimeout so it can't drift when the browser throttles the frame loop.
  if (event === 'floor' && ball.retireIn === null) {
    ball.retireIn = DEAD_BALL_LINGER;
  }
};

// --- Controllers + paddles --------------------------------------------------
const controllerModelFactory = new XRControllerModelFactory();
const paddles = [];
const inputSources = [];

for (const i of [0, 1]) {
  const grip = renderer.xr.getControllerGrip(i);
  grip.add(controllerModelFactory.createControllerModel(grip));
  playerRig.add(grip);

  const paddle = new Paddle();
  paddle.attachTo(grip);
  paddles.push(paddle);

  const controller = renderer.xr.getController(i);
  controller.addEventListener('connected', (e) => {
    inputSources[i] = e.data;
  });
  controller.addEventListener('disconnected', () => {
    inputSources[i] = null;
  });
  // Trigger arms/pauses the machine, grip cycles drills
  controller.addEventListener('selectstart', () => {
    machine.enabled = !machine.enabled;
    game.revision++;
  });
  controller.addEventListener('squeezestart', () => {
    machine.nextDrill();
    game.revision++;
  });
  playerRig.add(controller);
}

// Short haptic tap on contact, on whichever hand actually struck the ball.
function pulse(ball) {
  let nearest = -1;
  let best = Infinity;
  paddles.forEach((paddle, i) => {
    const d = paddle.bladeCenter.distanceToSquared(ball.mesh.position);
    if (d < best) {
      best = d;
      nearest = i;
    }
  });
  const actuator = inputSources[nearest]?.gamepad?.hapticActuators?.[0];
  actuator?.pulse?.(0.7, 40);
}

// --- Desktop fallback: orbit controls for dev without a headset -------------
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.target.set(0, TABLE.HEIGHT, 0);
orbit.update();
renderer.xr.addEventListener('sessionstart', () => (orbit.enabled = false));
renderer.xr.addEventListener('sessionend', () => (orbit.enabled = true));

const status = document.getElementById('status');
let statusRevision = -1;
function updateStatus() {
  if (!status || game.revision === statusRevision) return;
  statusRevision = game.revision;
  status.textContent =
    `${machine.drill.name} · streak ${game.streak} · ` +
    `returns ${game.returns}/${game.hits + game.misses} (${game.accuracy}%)`;
}

// --- Main loop --------------------------------------------------------------
const clock = new THREE.Clock();
let servedSeen = 0;

function tick(dt) {
  for (const paddle of paddles) paddle.update(dt);

  machine.update(dt);
  if (machine.servedCount !== servedSeen) {
    servedSeen = machine.servedCount;
    game.onServe();
  }

  physics.step(dt, balls, paddles);
  game.update(balls);

  // The aim ring shows where the machine is about to land a ball; in target
  // mode there's no incoming shot to telegraph, so the pad takes over.
  const targeting = machine.isTargetMode;
  targetRing.visible = !targeting;
  targetZone.visible = targeting;
  if (targeting) {
    targetZone.update(dt);
  } else {
    targetRing.position.set(machine.aim.x, TABLE.HEIGHT + 0.002, machine.aim.z);
  }

  for (const ball of balls) {
    if (!ball.active) continue;
    ball.updateVisualSpin(dt);

    // Any ball that has come to rest is out of play, wherever it settled.
    // Keying retirement off the floor alone strands balls that stop on the
    // table — which silently drains the pool until the machine can't serve.
    if (ball.restingOn && ball.retireIn === null) {
      ball.retireIn = DEAD_BALL_LINGER;
    }

    if (ball.mesh.position.length() > 14) {
      retire(ball);
    } else if (ball.retireIn !== null) {
      ball.retireIn -= dt;
      if (ball.retireIn <= 0) retire(ball);
    }
  }

  scoreboard.update();
  updateStatus();
  renderer.render(scene, camera);
}

// Per-ball scoring flags reset in Ball.serve(), so returning to the pool is
// just a deactivate.
function retire(ball) {
  ball.deactivate();
}

renderer.setAnimationLoop(() => tick(clock.getDelta()));

// Dev-only handle for driving the simulation from the console or an
// automated check. `requestAnimationFrame` is frozen in a backgrounded tab,
// so stepping `tick` by hand is the only way to measure trajectories
// reliably. Vite strips this branch from production builds.
if (import.meta.env.DEV) {
  window.__probe = { balls, machine, physics, game, paddles, targetZone, scene, tick };
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// Keyboard shortcuts make desktop iteration much faster than reaching for a
// headset every time.
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    machine.enabled = !machine.enabled;
    game.revision++;
  } else if (e.code === 'KeyD') {
    machine.nextDrill();
    game.revision++;
  } else if (e.code === 'KeyR') {
    game.reset();
  } else if (e.code === 'KeyS') {
    machine.serve();
  }
});
