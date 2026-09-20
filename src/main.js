import * as THREE from 'three';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

import { createTable } from './table.js';
import { XRManager } from './xr.js';
import { UI } from './ui.js';
import { Settings } from './settings.js';
import { Sfx } from './audio.js';
import { VRMenu } from './vrMenu.js';
import { Paddle } from './paddle.js';
import { Ball } from './ball.js';
import { PhysicsWorld } from './physics.js';
import { BallMachine } from './ballMachine.js';
import { Game } from './game.js';
import { Scoreboard } from './hud.js';
import { TargetZone } from './target.js';
import { HandPaddleRig } from './handPaddle.js';
import { PaddleSourceRouter, PADDLE_SOURCE } from './paddleSource.js';
import { Opponent } from './opponent.js';
import { Coach, SCENARIOS } from './coach.js';
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
const VR_BACKGROUND = new THREE.Color(0x0a0a0b);
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

const settings = new Settings();
const sfx = new Sfx(settings);

const balls = Array.from({ length: BALL_POOL_SIZE }, () => new Ball());
for (const b of balls) scene.add(b.mesh);

const machine = new BallMachine(balls, settings);
machine.enabled = false; // stays idle behind the start menu until a mode is picked
scene.add(machine.mesh);

// Puts the table in front of you, wherever you happen to be standing and
// whichever way you are facing.
//
// The floor-level origin a headset hands back is wherever the guardian was
// drawn, which is rarely where you want to stand to play. Rather than ask
// the player to walk to the right spot, move the world: rotate the rig so
// the head faces down the table, then slide it so the head lands at the
// player's end.
const UP = new THREE.Vector3(0, 1, 0);
const _headLocal = new THREE.Vector3();
const _headEuler = new THREE.Euler(0, 0, 0, 'YXZ');

function recenter() {
  // Head pose relative to the rig is exactly what the headset reports
  _headEuler.setFromQuaternion(camera.quaternion, 'YXZ');
  playerRig.rotation.y = -_headEuler.y;

  _headLocal.copy(camera.position).applyAxisAngle(UP, playerRig.rotation.y);
  playerRig.position.set(
    -_headLocal.x,
    0,
    PLAY_AREA.PLAYER_Z - _headLocal.z
  );
  playerRig.updateMatrixWorld(true);
  ui.toast('Table recentred');
}

// Sweep every ball back into the pool. Without this, balls still in flight
// when you quit stay airborne behind the menu and are still hanging there
// when the next session starts.
function clearBalls() {
  for (const ball of balls) ball.deactivate();
}

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

// Rally opponent. Its bat is an ordinary Paddle handed to the physics
// alongside yours, so its returns come out of the same contact model —
// real spin, real restitution, and a net cord behaves like a net cord.
const opponent = new Opponent();
scene.add(opponent.mesh);
machine.server = opponent; // in rally mode the opponent puts the ball in play

// Coach mode: a lesson is a path the bat should travel, shown as a ribbon
// and scored on how closely you trace it.
const coach = new Coach({
  sfx,
  onScore: (score) => {
    game.onLessonScore(score);
    ui.toast(`${score.total}% · ${coach.advice}`);
  },
});
scene.add(coach.group);
scoreboard.coach = coach; // the board shows the lesson's guidance line

// Picking a scenario off the in-world board is the same action as picking
// it in the menu, so the setting follows along.
coach.onScenarioPicked = (scenario) => {
  settings.set('scenario', scenario.id);
  ui.toast(scenario.name);
  game.revision++;
};

// The bottom bar names the running scenario without needing the coach
Object.defineProperty(machine, 'coachName', {
  get: () => coach.scenario.name,
});

// AR: transparent background, no virtual floor, dimmer fill so the real room
// carries the lighting. VR: full venue.
function applyMode(mode) {
  const isAR = mode === 'immersive-ar';
  scene.background = isAR ? null : VR_BACKGROUND;
  if (vrEnvironment) vrEnvironment.visible = !isAR;
  venueLight.visible = !isAR;
  keyLight.intensity = isAR ? 0.9 : 1.5;
}

const xr = new XRManager(renderer);
xr.onModeChange = (mode) => {
  applyMode(mode);
  // A session can end without warning — headset removed, system menu, battery.
  // Close the in-world pause menu so it isn't still hanging there, open and
  // holding input, the next time a session starts.
  if (!mode) vrMenu.toggle(false);
};

const ui = new UI({
  xr,
  machine,
  game,
  settings,
  sfx,
  // `mode` is an XR session mode, or null for the on-screen preview. The
  // desktop build being developed separately hooks in here.
  onStart: () => {
    clearBalls();
    machine.enabled = true;
    game.reset();
  },
  onExit: () => {
    machine.enabled = false;
    clearBalls();
  },
  isInputBlocked: () => vrMenu.open,
  onRecenter: () => recenter(),
});

xr.detectSupport().then((support) => ui.applyXRSupport(support));

// --- Physics ----------------------------------------------------------------
const physics = new PhysicsWorld();
physics.onBounce = (ball, event, paddle) => {
  sfx.contact(event, ball.velocity.length());

  // The coach's live drills report where your return actually went, so it
  // needs to see what happens to the ball it served.
  coach.onBallEvent(ball, event, paddle);

  // The opponent's returns arrive through the same contact path as yours,
  // so they have to be told apart: one is an exchange in the rally, the
  // other is a hit on your scorecard.
  if (event === 'paddle' && paddle?.isOpponent) {
    game.onRallyExchange();
    opponent.onHit();
    return;
  }

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
    sfx.targetHit();
  }

  // Floor contact means the rally is over for this ball; start a countdown
  // that returns it to the pool. Timed in simulation seconds rather than via
  // setTimeout so it can't drift when the browser throttles the frame loop.
  if (event === 'floor' && ball.retireIn === null) {
    ball.retireIn = DEAD_BALL_LINGER;
    // A ball on the floor ends the rally, whoever put it there.
    if (machine.isRallyMode) {
      game.endRally(ball.touchedByPaddle ? 'Rally over' : 'Missed');
    }
  }
};

// --- Controllers + paddles --------------------------------------------------
const controllerModelFactory = new XRControllerModelFactory();
const paddles = [];
const controllers = [];
const inputSources = [];

// Ray drawn from each controller, shown only while the VR menu is up
const rayGeometry = new THREE.BufferGeometry().setFromPoints([
  new THREE.Vector3(0, 0, 0),
  new THREE.Vector3(0, 0, -1),
]);

const controllerModels = [];
const handRigs = [];
const paddleSources = [];

for (const i of [0, 1]) {
  // Grip space is the controller's physical pose, so a mesh parented here
  // inherits the tracked position and orientation every frame — the paddle
  // is the controller, one to one, with no smoothing or lag of our own.
  const grip = renderer.xr.getControllerGrip(i);
  const model = controllerModelFactory.createControllerModel(grip);
  grip.add(model);
  controllerModels.push(model);
  playerRig.add(grip);

  const paddle = new Paddle();
  paddle.attachTo(grip);
  paddles.push(paddle);

  // Hand tracking, so the bat can follow your actual hand holding a real
  // paddle instead of a controller. The hand space is a sibling of the grip;
  // the router below decides which one the mesh hangs off each frame.
  const hand = renderer.xr.getHand(i);
  playerRig.add(hand);
  const handRig = new HandPaddleRig(hand, i === 0 ? 'right' : 'left');
  playerRig.add(handRig.group);
  handRigs.push(handRig);

  // Parent for poses fed in from outside the page — a camera-based tracker
  // running elsewhere. Nothing writes to it until such a feed connects.
  const externalRoot = new THREE.Group();
  playerRig.add(externalRoot);

  paddleSources.push(
    new PaddleSourceRouter({
      paddle,
      controllerGrip: grip,
      handRig,
      externalRoot,
    })
  );

  const controller = renderer.xr.getController(i);
  controller.addEventListener('connected', (e) => {
    inputSources[i] = e.data;
    applyHandedness();
  });
  controller.addEventListener('disconnected', () => {
    inputSources[i] = null;
    applyHandedness();
  });

  // Trigger: picks menu entries while the menu is up, otherwise arms or
  // pauses the machine.
  controller.addEventListener('selectstart', () => {
    if (vrMenu.open) {
      vrMenu.activate();
    } else {
      machine.enabled = !machine.enabled;
      game.revision++;
    }
  });
  controller.addEventListener('squeezestart', () => {
    if (vrMenu.open) return;
    machine.nextDrill();
    game.revision++;
  });

  const ray = new THREE.Line(
    rayGeometry,
    new THREE.LineBasicMaterial({ color: COLORS.ACCENT, transparent: true, opacity: 0.6 })
  );
  ray.scale.z = 3;
  ray.visible = false;
  controller.add(ray);
  controller.userData.ray = ray;

  controllers.push(controller);
  playerRig.add(controller);
}

// In-headset pause menu. The DOM shell is invisible in an immersive session,
// so this is the only way to reach settings with the headset on.
const vrMenu = new VRMenu({
  camera,
  machine,
  game,
  settings,
  sfx,
  onRecenter: () => recenter(),
  onExit: () => {
    xr.end();
    machine.enabled = false;
    ui.showMenu();
  },
});
// Added to the scene, not the player rig: the panel is positioned from the
// camera's *world* pose, so parenting it under the rig would offset it by the
// rig's own position.
scene.add(vrMenu.group);

// A/X on either controller opens and closes it. There's no WebXR event for
// face buttons, so the gamepad has to be polled with edge detection.
const MENU_BUTTONS = [4, 5]; // A/X and B/Y
let menuButtonWasDown = false;

function pollMenuButton(dt) {
  const down = inputSources.some((source) =>
    MENU_BUTTONS.some((b) => source?.gamepad?.buttons?.[b]?.pressed)
  );
  if (down && !menuButtonWasDown) vrMenu.toggle();
  menuButtonWasDown = down;

  if (!vrMenu.open) return;

  // Thumbstick drives the menu too, so reaching a setting never depends on
  // getting a ray onto the panel. Take whichever stick is pushed furthest.
  let x = 0;
  let y = 0;
  for (const source of inputSources) {
    const axes = source?.gamepad?.axes;
    if (!axes) continue;
    // Quest reports the stick on axes 2 and 3; some runtimes use 0 and 1.
    const sx = Math.abs(axes[2] ?? 0) > Math.abs(axes[0] ?? 0) ? axes[2] : axes[0];
    const sy = Math.abs(axes[3] ?? 0) > Math.abs(axes[1] ?? 0) ? axes[3] : axes[1];
    if (Math.abs(sx ?? 0) > Math.abs(x)) x = sx ?? 0;
    if (Math.abs(sy ?? 0) > Math.abs(y)) y = sy ?? 0;
  }
  vrMenu.handleStick(x, y, dt);
}

// You hold one bat, not two. The off hand keeps its controller model so you
// can still see where it is, but carries no paddle — otherwise it swats balls
// out of the air by accident.
function applyHandedness() {
  const preferred = settings.get('hand');
  paddles.forEach((paddle, i) => {
    const handedness = inputSources[i]?.handedness;
    // Before a controller reports its handedness, assume index 0 is the
    // right hand rather than leaving the player with no paddle at all.
    const hand = handedness ?? (i === 0 ? 'right' : 'left');
    const holdsPaddle = preferred === 'both' || hand === preferred;

    paddle.enabled = holdsPaddle;
    paddle.mesh.visible = holdsPaddle;
    if (controllerModels[i]) controllerModels[i].visible = !holdsPaddle;
  });
}

function applyScenario() {
  const index = SCENARIOS.findIndex((s) => s.id === settings.get('scenario'));
  // Clear first: the previous scenario's ball is held at *its* contact
  // point, which is somewhere else entirely, so switching left it hanging
  // over the table while a second one appeared at the new spot.
  clearBalls();
  coach.setScenario(index < 0 ? 0 : index);
}

// Coach is a separate game, so the machine and the rally opponent stand
// down for it rather than it being one more drill in the rotation.
function applyGame() {
  const coaching = settings.get('game') === 'coach';
  machine.coachActive = coaching;
  // Clear on every switch, not just into Coach. A held ball never falls and
  // never recycles, so leaving one behind parked it in mid-air over the
  // arcade table for good and cost a slot in the pool.
  clearBalls();
  game.reset();
  coach.reset();
  game.revision++;
}

settings.onChange((key) => {
  if (key === 'hand') applyHandedness();
  if (key === 'difficulty') opponent.setSkill(settings.get('difficulty'));
  if (key === 'scenario') applyScenario();
  if (key === 'game') applyGame();
});

applyHandedness();
opponent.setSkill(settings.get('difficulty'));
applyScenario();
applyGame();

// Guidance buzz while tracing a lesson, on whichever hand holds the bat.
function hapticGuide(strength) {
  const index = paddles.findIndex((p) => p.enabled);
  const actuator =
    inputSources[index < 0 ? 0 : index]?.gamepad?.hapticActuators?.[0];
  actuator?.pulse?.(Math.min(strength, 1) * 0.55, 45);
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

// --- Main loop --------------------------------------------------------------
const clock = new THREE.Clock();
let servedSeen = 0;
const activePaddles = [];
const ZERO = new THREE.Vector3();
let lastCoachLine = '';

function tick(dt) {
  // Choose what drives each bat before reading its pose, so the velocity
  // Paddle derives is measured against the parent it is actually on.
  const wanted = settings.get('paddleSource') ?? PADDLE_SOURCE.CONTROLLER;
  for (const source of paddleSources) {
    source.setMode(wanted);
    source.update(dt);
  }
  // A controller model is shown only for a hand that is idle: not holding
  // the bat, and not being tracked as a hand. Seeing a floating controller
  // beside your real hand is worse than seeing nothing.
  paddleSources.forEach((source, i) => {
    const model = controllerModels[i];
    if (!model) return;
    model.visible =
      !paddles[i].enabled && source.activeSource !== PADDLE_SOURCE.HAND;
  });

  for (const paddle of paddles) paddle.update(dt);

  // The opponent only exists in rally mode. It moves before the physics
  // step so the bat's derived velocity matches the motion this frame.
  opponent.setActive(machine.isRallyMode && !vrMenu.open);
  opponent.update(dt, balls);

  coach.setActive(machine.isCoachMode && !vrMenu.open);
  const guide = coach.update(
    dt,
    paddles.find((p) => p.enabled) ?? paddles[0],
    // Park a ball, held still, where the stroke should meet it.
    (position, spin) => {
      const ball = balls.find((b) => !b.active);
      if (!ball) return;
      ball.serve(position, ZERO, spin);
      ball.frozen = true;
    },
    () => balls.find((b) => b.active && b.frozen) ?? null,
    // Serve a live ball for the reaction drills, returned so the coach can
    // follow what happens to it.
    (position, velocity, spin) => {
      const ball = balls.find((b) => !b.active);
      if (!ball) return null;
      ball.serve(position, velocity, spin);
      return ball;
    }
  );

  if (guide > 0.08) hapticGuide(guide);

  pollMenuButton(dt);
  vrMenu.update(dt, controllers);
  for (const controller of controllers) {
    if (controller.userData.ray) controller.userData.ray.visible = vrMenu.open;
  }

  // The menu is a pause screen: hold the machine while it's up, but keep
  // stepping physics so balls already in the air settle instead of freezing
  // mid-flight.
  const wasEnabled = machine.enabled;
  if (vrMenu.open) machine.enabled = false;

  machine.update(dt);
  if (machine.servedCount !== servedSeen) {
    servedSeen = machine.servedCount;
    game.onServe();
  }

  if (vrMenu.open) machine.enabled = wasEnabled; // restore; the pause is momentary

  // The opponent's bat joins the paddle list only while it is rallying, so
  // it cannot swat balls in the other modes.
  activePaddles.length = 0;
  activePaddles.push(...paddles);
  if (opponent.active) activePaddles.push(opponent.paddle);

  physics.step(dt, balls, activePaddles);
  game.update(balls);

  // The aim ring shows where the machine is about to land a ball; in target
  // mode there's no incoming shot to telegraph, so the pad takes over.
  const targeting = machine.isTargetMode;
  targetRing.visible = !targeting && settings.get('aimMarker');
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

  // The coach's line changes without the score changing — arming, tracing,
  // switching lesson — so the board needs to know to repaint.
  if (machine.isCoachMode) {
    const line = coach.instruction;
    if (line !== lastCoachLine) {
      lastCoachLine = line;
      game.revision++;
    }
  }

  scoreboard.update();
  ui.update();
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
  window.__probe = {
    balls, machine, physics, game, paddles, targetZone,
    settings, ui, vrMenu, opponent, coach, scene, camera, tick,
  };
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// Keyboard shortcuts live entirely in UI, which owns the single keydown
// listener. A second listener here meant every key fired twice: Space
// toggled the machine and immediately toggled it back, and D skipped two
// modes at once.
