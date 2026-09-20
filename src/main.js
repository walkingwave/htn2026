import * as THREE from 'three';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
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
import { Game, SCOREBOARD_POSITION } from './game.js';
import { Scoreboard } from './hud.js';
import { TargetZone } from './target.js';
import { HandPaddleRig } from './handPaddle.js';
import { PaddleSourceRouter, PADDLE_SOURCE } from './paddleSource.js';
import { PaddleTracker, TRACKER_STATE } from './vision/paddleTracker.js';
import { Opponent } from './opponent.js';
import { Coach, SCENARIOS } from './coach.js';
import {
  createRoom,
  makeRoomCode,
  roomLinkFor,
  roomFromUrl,
  clearRoomFromUrl,
  isRealtimeAvailable,
} from './net.js';
import { VersusMatch } from './versus.js';
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
    // A versus match is served by the host over the network, so the ball
    // machine stays down for it.
    machine.enabled = settings.get('game') !== 'versus';
    game.reset();
    // The camera only opens once you are actually playing, not while the
    // setting sits there remembered from last time.
    if (usingWebcamBat()) startWebcamBat();
  },
  onExit: () => {
    machine.enabled = false;
    leaveVersus();
    clearBalls();
    stopWebcamBat();
  },
  isInputBlocked: () => vrMenu.open,
  onRecenter: () => recenter(),

  // Online versus. The lobby in the shell calls these; everything about how
  // the match actually runs lives in enterVersus / leaveVersus below. Both
  // are hoisted function declarations, so naming them here is safe.
  onVersusCreate: async () => {
    const code = makeRoomCode();
    const room = await enterVersus('host', code);
    // Prefer a LAN address the other device can actually open — `localhost`
    // means nothing to a headset across the room.
    const origin = room?.lanUrls?.[0] || window.location.origin;
    // `room.role` rather than 'host': over the LAN relay the server decides by
    // arrival, so hosting a code someone else already opened makes you the
    // guest. Telling the player otherwise would be a lie about which end of
    // the table they are on.
    return { role: room.role, code, link: roomLinkFor(code, origin), kind: room.kind };
  },
  onVersusJoin: async (code) => {
    const room = await enterVersus('guest', code.trim().toUpperCase());
    return { role: room.role, code, kind: room.kind };
  },
  onVersusLeave: () => leaveVersus(),
  // What the run was worth, read at the moment you quit. Versus is scored on
  // what you took off a real opponent; the other two on the trainer's stats.
  onRunSummary: () => ({
    hits: game.hits,
    misses: game.misses,
    returns: game.returns,
    bestStreak: game.bestStreak,
    longestRally: game.longestRally,
    targetsHit: game.targetsHit,
    accuracy: game.accuracy,
    lessonBest: game.lessonBest,
    lessonAttempts: game.lessonAttempts,
    pointsWon: netMode === 'guest' ? match.scoreGuest : match.scoreHost,
    matchWon: Boolean(netMode) && match.winner === netMode,
  }),
  // A link with ?room=CODE means someone invited you: the lobby opens on the
  // join step with the code already filled in.
  invitedRoom: roomFromUrl(),
  realtimeAvailable: isRealtimeAvailable(),
});

xr.detectSupport().then((support) => ui.applyXRSupport(support));

// --- Physics ----------------------------------------------------------------
const physics = new PhysicsWorld();
physics.onBounce = (ball, event, paddle) => {
  sfx.contact(event, ball.velocity.length());

  // Online versus scores itself. The host resolves floor bounces into points;
  // the guest never simulates the match ball at all, so it has no contacts of
  // its own to interpret.
  if (netMode) {
    if (netMode === 'host') handleVersusHostBounce(ball, event);
    return;
  }

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

// --- Desktop bat ------------------------------------------------------------
// A headset gives you a bat because there is a tracked hand to hang it on. On
// a screen there is nothing to hang it on, so the pointer drives a rig parented
// under playerRig: mouse X/Y place the blade in a small volume over the near
// half of the table, the wheel (or a click, or F) moves it in depth.
//
// The pose is written straight from the event with no smoothing of our own, and
// depth is eased toward a target rather than snapped, so Paddle.update() derives
// a real swing velocity from the motion between frames — exactly as it does
// from a grip. A thrust therefore carries momentum into the ball instead of
// teleporting through it.
//
// This is what lets someone at a laptop play a match against someone in a
// headset; it also means the desktop preview can rally rather than just watch.
const desktopRig = new THREE.Group();
playerRig.add(desktopRig);
const desktopPaddle = new Paddle();
desktopPaddle.attachTo(desktopRig);
desktopPaddle.enabled = false; // switched on below whenever we're not in XR
desktopPaddle.mesh.visible = false;
paddles.push(desktopPaddle);

const DESKTOP_REST_Z = -0.72; // blade's resting depth, a little in front of you
const DESKTOP_THRUST_Z = -1.18; // how far forward a swing reaches
const DESKTOP_THRUST_TIME = 0.14; // seconds held forward before it returns

let desktopDepthTarget = DESKTOP_REST_Z;
let desktopThrust = 0;

// Where the player is asking the *blade* to be, in rig space. Kept separate
// from the rig's own position because the blade sits up and back from the
// paddle's origin, on the end of a handle: put the rig under the cursor and
// the blade ends up ten-odd centimetres away, which against an 85 mm blade is
// the difference between playing the ball and missing everything. The rig
// position is derived from this each frame — never nudged, or the offset
// would be subtracted again on every mouse move and the bat would walk off
// down the table.
const desktopAim = new THREE.Vector3(0, 0.95, DESKTOP_REST_Z);
const _bladeOffset = new THREE.Vector3();

function placeDesktopBat(clientX, clientY) {
  if (renderer.xr.isPresenting) return; // controllers own the bats in a session
  const x = THREE.MathUtils.clamp(clientX / window.innerWidth, 0, 1);
  const y = THREE.MathUtils.clamp(clientY / window.innerHeight, 0, 1);
  desktopAim.x = (x - 0.5) * 1.25;
  // Never below the surface, never above about head height.
  desktopAim.y = Math.max(TABLE.HEIGHT + 0.03, 0.95 + (0.5 - y) * 0.7);
  desktopYaw = (x - 0.5) * 0.5;
  poseDesktopBat();
}

// A bat's face is perpendicular to the forearm, so the blade points along the
// rig's +X, not down its -Z: a quarter turn is what squares it to the table.
// (Half a turn leaves it edge-on, which passes straight through the ball and
// is very hard to see.) Horizontal position adds a little steer on top, the
// way turning your wrist aims a real return.
let desktopYaw = 0;

function poseDesktopBat() {
  desktopRig.rotation.set(0, Math.PI / 2 + desktopYaw, 0);
  desktopRig.quaternion.setFromEuler(desktopRig.rotation);
  _bladeOffset
    .copy(desktopPaddle.mesh.getObjectByName('blade').position)
    .applyQuaternion(desktopRig.quaternion);
  desktopRig.position.copy(desktopAim).sub(_bladeOffset);
}

function swingDesktopBat() {
  if (renderer.xr.isPresenting) return;
  desktopThrust = DESKTOP_THRUST_TIME;
}

// --- Webcam bat -------------------------------------------------------------
// The flat-screen counterpart to hand tracking: a webcam watches your actual
// paddle and drives the on-screen one, so a laptop player swings a real bat
// rather than pushing a mouse. The tracker finds the rubber by colour and
// reads pose off the blob's ellipse — see vision/paddleTracker.js.
//
// It feeds the same rig the pointer drives, so everything downstream (swing
// velocity, spin, versus packets) is identical either way; only where the pose
// comes from changes.
let camTracker = null;
const _camQuat = new THREE.Quaternion();
const _camBase = new THREE.Quaternion();
const _camPos = new THREE.Vector3();

function usingWebcamBat() {
  return settings.get('paddleSource') === PADDLE_SOURCE.CAMERA;
}

function startWebcamBat() {
  if (camTracker) return;
  camTracker = new PaddleTracker();
  camTracker.onState = (state, error) => {
    // The preview carries the running commentary; toasts are for the moments
    // that change what the player should do.
    if (state === TRACKER_STATE.ERROR) {
      ui.setCamStatus(error ?? 'Camera unavailable');
      ui.toast(error ?? 'Camera unavailable');
    } else if (state === TRACKER_STATE.CALIBRATING) {
      ui.setCamStatus('Hold the bat in the box · click');
      ui.toast('Hold your bat up, face on — then click to calibrate');
    } else if (state === TRACKER_STATE.TRACKING) {
      ui.setCamStatus('Tracking · V to recalibrate');
    } else if (state === TRACKER_STATE.LOST) {
      ui.setCamStatus('Lost it — hold the bat up');
    }
  };
  ui.showCamPreview(camTracker);
  camTracker.start().catch((err) => {
    ui.toast(err?.message ?? 'Camera failed');
    stopWebcamBat();
  });
}

function stopWebcamBat() {
  camTracker?.stop();
  camTracker = null;
  ui.showCamPreview(null);
}

// Pose the rig from the tracker. Camera space is +X right, +Y up, −Z away
// from the viewer, with the origin at the lens; the desktop camera sits at eye
// height on the rig, so the shift is a single offset. Depth and height are
// clamped to the volume the bat can usefully be in, because a lost frame or a
// red shirt in the background would otherwise throw it across the room.
function poseWebcamBat() {
  _camPos.copy(camTracker.position);
  _camPos.y = THREE.MathUtils.clamp(_camPos.y + 1.62, TABLE.HEIGHT + 0.03, 1.6);
  _camPos.x = THREE.MathUtils.clamp(_camPos.x, -0.8, 0.8);
  _camPos.z = THREE.MathUtils.clamp(_camPos.z, -1.35, -0.2);

  // The tracker reports how the real bat is tilted; the quarter turn that
  // squares a blade to the table is ours to add.
  _camBase.setFromAxisAngle(UP, Math.PI / 2);
  _camQuat.copy(camTracker.quaternion).multiply(_camBase);
  desktopRig.quaternion.copy(_camQuat);
  _bladeOffset
    .copy(desktopPaddle.mesh.getObjectByName('blade').position)
    .applyQuaternion(_camQuat);
  desktopRig.position.copy(_camPos).sub(_bladeOffset);
}

placeDesktopBat(window.innerWidth / 2, window.innerHeight * 0.55);

window.addEventListener('pointermove', (e) => placeDesktopBat(e.clientX, e.clientY), {
  passive: true,
});
window.addEventListener('pointerdown', (e) => {
  if (!ui.menu.hidden) return; // the menu owns its own clicks
  // The webcam tracker has to be shown the bat's colour once. Any click while
  // it is waiting is that gesture, so there is no separate key to learn.
  if (camTracker?.state === TRACKER_STATE.CALIBRATING) {
    if (!camTracker.calibrateColour()) ui.toast('Nothing bright enough — try better light');
    return;
  }
  placeDesktopBat(e.clientX, e.clientY);
  swingDesktopBat();
});
window.addEventListener(
  'wheel',
  (e) => {
    if (renderer.xr.isPresenting || !ui.menu.hidden) return;
    desktopDepthTarget = THREE.MathUtils.clamp(
      desktopDepthTarget - Math.sign(e.deltaY) * 0.08,
      -1.3,
      -0.2
    );
  },
  { passive: true }
);

// Keyboard alternative, for playing without a mouse. UI owns the single
// keydown listener for commands; these are movement, so they live here.
const DESKTOP_KEYS = { ArrowLeft: 0, ArrowRight: 0, ArrowUp: 0, ArrowDown: 0, KeyF: 0 };
window.addEventListener('keydown', (e) => {
  if (!ui.menu.hidden) return;

  // Re-learn the bat's colour without leaving the game. Lighting changes as
  // you move around a room, and a key beats going back to the menu for it.
  if (e.code === 'KeyV' && camTracker) {
    if (camTracker.calibrateColour()) ui.toast('Bat colour re-learned');
    else ui.toast('Hold the bat in the middle of the frame');
    return;
  }
  // Which way an ambiguous tilt is read, for the rare case it latches on to
  // the wrong sign — a paddle leaning away looks identical to one leaning
  // toward the camera, so this cannot be resolved from the image alone.
  if (e.code === 'KeyB' && camTracker) {
    camTracker.flipTilt();
    ui.toast('Bat tilt flipped');
    return;
  }

  if (!(e.code in DESKTOP_KEYS)) return;
  DESKTOP_KEYS[e.code] = 1;
  if (e.code === 'KeyF') swingDesktopBat();
});
window.addEventListener('keyup', (e) => {
  if (e.code in DESKTOP_KEYS) DESKTOP_KEYS[e.code] = 0;
});

function updateDesktopBat(dt) {
  const inXR = renderer.xr.isPresenting;
  desktopPaddle.enabled = !inXR;
  desktopPaddle.mesh.visible = !inXR;

  // Outside a session the controller bats are attached to grips that sit at
  // the rig origin — on the floor, at the player's feet. They report that pose
  // perfectly well, so physics treats them as live bats and they swat balls
  // nobody can see. Stand them down until a session actually poses them.
  for (const paddle of paddles) {
    if (paddle === desktopPaddle) continue;
    paddle.enabled = inXR && (paddle.handHolds ?? true);
    paddle.mesh.visible = paddle.enabled;
  }

  if (inXR) return;

  // A webcam bat, once it has locked on, owns the rig outright: the pose is
  // the real bat's. Until it locks on — or if it loses the bat — the pointer
  // stays in charge, so you are never left with nothing to play with.
  if (usingWebcamBat() && camTracker?.state === TRACKER_STATE.TRACKING) {
    poseWebcamBat();
    return;
  }

  // Held arrow keys slide the blade at a steady rate; the mouse overrides on
  // its next move, which is what you'd expect from whichever you touched last.
  const speed = 1.1; // m/s
  const dx = (DESKTOP_KEYS.ArrowRight - DESKTOP_KEYS.ArrowLeft) * speed * dt;
  const dy = (DESKTOP_KEYS.ArrowUp - DESKTOP_KEYS.ArrowDown) * speed * dt;
  if (dx || dy) {
    desktopAim.x = THREE.MathUtils.clamp(desktopAim.x + dx, -0.7, 0.7);
    desktopAim.y = THREE.MathUtils.clamp(desktopAim.y + dy, TABLE.HEIGHT + 0.03, 1.45);
    desktopYaw = (desktopAim.x / 1.25) * 0.5;
  }

  if (desktopThrust > 0) desktopThrust -= dt;
  const target = desktopThrust > 0 ? DESKTOP_THRUST_Z : desktopDepthTarget;
  // Eased rather than snapped, so Paddle.update() samples a sustained velocity
  // and a thrust carries momentum into the ball.
  desktopAim.z += (target - desktopAim.z) * Math.min(1, dt * 12);
  poseDesktopBat();
}

// ---------------------------------------------------------------------------
// Online versus (1v1)
//
// One side is authoritative. The host simulates the ball with the same physics
// the trainer uses and streams its position; the guest renders that and streams
// only its own bat. That asymmetry is what keeps the two views agreeing: there
// is exactly one simulation, so there is nothing to reconcile.
//
// Each player swings locally with no round trip, which is the part that has to
// feel immediate. The cost is that the host's bat is authoritative over
// contact, so a guest's return is resolved against a bat pose that is up to one
// network tick old — acceptable at 30 Hz over a LAN, and far better than
// waiting on an ack before the ball moves.
//
// While netMode is null every line below is dormant and the trainer behaves
// exactly as it did before.
// ---------------------------------------------------------------------------
let netMode = null; // null | 'host' | 'guest'
let room = null; // active room handle
const match = new VersusMatch();
let versusBall = null; // the rally ball (host authoritative)
let versusServeTimer = 0; // countdown before the host's next serve
let netSendAccum = 0; // throttle for outbound state
let guestBallActive = false;

const NET_TICK = 1 / 30; // 30 Hz, which is plenty for a ball and one bat
const VERSUS_SERVE_SECONDS = 3;

const guestBallTarget = new THREE.Vector3();
const _versusQuat = new THREE.Quaternion();
const _versusFwd = new THREE.Vector3(0, 0, 1);

// The opponent's bat, driven entirely by network packets. It is handed to
// physics like any other paddle, so their shots come out of the same contact
// model as yours — real spin, real restitution.
const remotePaddle = new Paddle();
scene.add(remotePaddle.mesh);
remotePaddle.enabled = false;
remotePaddle.networked = true;
remotePaddle.mesh.visible = false; // nothing to show until a packet arrives

// Which bat this player is actually swinging — the one whose pose gets sent.
//
// Outside a session that is the pointer-driven bat. The controller bats are
// still "tracking" on a desktop, because they faithfully report the pose of a
// grip that is sitting at the rig origin, so picking the first tracked paddle
// would stream a bat parked at the player's feet.
function getLocalVersusPaddle() {
  if (!renderer.xr.isPresenting) return desktopPaddle;
  return (
    paddles.find(
      (paddle) => paddle !== desktopPaddle && paddle.enabled && paddle.tracking
    ) ?? paddles[0]
  );
}

function bladePacket(paddle = getLocalVersusPaddle()) {
  return {
    c: [paddle.bladeCenter.x, paddle.bladeCenter.y, paddle.bladeCenter.z],
    n: [paddle.bladeNormal.x, paddle.bladeNormal.y, paddle.bladeNormal.z],
    v: [paddle.velocity.x, paddle.velocity.y, paddle.velocity.z],
    // Whether the sender's bat is actually being tracked. Someone watching
    // from a desktop browser has a paddle object but no pose for it, and
    // without this flag it would arrive as a phantom bat parked at the origin
    // — which is on the table, swatting balls its owner can't see.
    t: paddle.tracking,
  };
}

function applyRemotePaddle(pkt) {
  if (!pkt) return;
  const tracked = pkt.t !== false;
  remotePaddle.enabled = tracked;
  // This paddle never runs Paddle.update(), so mark it tracked here —
  // otherwise the swept contact test skips it and the opponent could never
  // return a ball.
  remotePaddle.tracking = tracked;
  if (!tracked) {
    remotePaddle.mesh.visible = false;
    return;
  }
  remotePaddle.bladeCenter.set(pkt.c[0], pkt.c[1], pkt.c[2]);
  remotePaddle.bladeNormal.set(pkt.n[0], pkt.n[1], pkt.n[2]).normalize();
  remotePaddle.velocity.set(pkt.v[0], pkt.v[1], pkt.v[2]);
  remotePaddle.mesh.visible = true;
  remotePaddle.mesh.position.copy(remotePaddle.bladeCenter);
  remotePaddle.mesh.quaternion.copy(
    _versusQuat.setFromUnitVectors(_versusFwd, remotePaddle.bladeNormal)
  );
}

function startVersusServe() {
  versusServeTimer = VERSUS_SERVE_SECONDS;
  ui.showCountdown(VERSUS_SERVE_SECONDS);
}

// Put the ball up in front of whoever is serving, for them to hit — rather
// than firing it across the table on their behalf. A real serve starts with a
// toss, and the point should begin with a stroke the player actually made.
//
// The host runs this for both sides. When the guest is serving, the toss is
// placed against the bat pose their client is streaming, so the ball appears
// in front of *their* bat, wherever they are holding it.
const SERVE_TOSS_UP = 2.1; // m/s — about a 22 cm toss, roughly the real thing
const SERVE_TOSS_AHEAD = 0.11; // metres in front of the blade, within reach
const SERVE_TOSS_RISE = 0.1; // and above it, so it falls back past the face

function serveVersusBall() {
  const ball = balls.find((b) => !b.active);
  if (!ball) return;

  // Which way is "across the table" for the server: the host plays from +Z.
  const toNet = match.server === 'host' ? -1 : 1;
  const serverIsLocal = match.server === netMode;
  const bat = serverIsLocal ? getLocalVersusPaddle() : remotePaddle;

  const spawn = new THREE.Vector3();
  if (bat?.tracking) {
    spawn.copy(bat.bladeCenter);
    spawn.z += toNet * SERVE_TOSS_AHEAD;
    spawn.y += SERVE_TOSS_RISE;
  } else {
    // No bat pose yet — a guest who hasn't moved, or a player with no tracked
    // input. Toss it over their end of the table so the point can still start.
    spawn.set(0, TABLE.HEIGHT + 0.3, -toNet * (TABLE.LENGTH / 2 - 0.35));
  }
  // Never below the surface, whatever the bat was doing.
  spawn.y = Math.max(spawn.y, TABLE.HEIGHT + 0.12);

  ball.serve(spawn, new THREE.Vector3(0, SERVE_TOSS_UP, 0));
  ball.floorCounted = false; // our own flag; Ball.serve() doesn't know about it
  ball.awaitingServeStrike = true; // a toss nobody hits is not a lost point
  versusBall = ball;
  broadcastHostState();
}

function broadcastHostState() {
  if (!room) return;
  const ball =
    versusBall && versusBall.active
      ? {
          active: true,
          p: [
            versusBall.mesh.position.x,
            versusBall.mesh.position.y,
            versusBall.mesh.position.z,
          ],
        }
      : { active: false, p: [0, 0, 0] };
  room.send('state', {
    match: match.snapshot(),
    ball,
    paddle: bladePacket(),
  });
}

function handleVersusHostBounce(ball, event) {
  // The toss is live once it has been struck; until then it is not part of the
  // point at all.
  if (event === 'paddle' && ball === versusBall) ball.awaitingServeStrike = false;

  // A toss the server swung at and missed — or simply let drop — costs them
  // nothing but the re-serve. Scoring it would mean losing points to a fumbled
  // ball toss, which is not what anyone is playing for. Any contact that isn't
  // the bat ends it: a toss that lands, on the table or the floor, was not a
  // serve. (The table case matters — a ball that comes to rest up there never
  // reaches the floor, and the point would hang there forever.)
  if (ball === versusBall && !ball.floorCounted && ball.awaitingServeStrike) {
    ball.floorCounted = true;
    ball.deactivate();
    versusBall = null;
    broadcastHostState();
    startVersusServe();
    return;
  }

  if (event !== 'floor' || ball !== versusBall || ball.floorCounted) return;

  ball.floorCounted = true;
  // A ball that reaches the floor on the host's half (z>0) is one the host
  // failed to return, so the guest scores — and the other way around.
  const scorer = ball.mesh.position.z > 0 ? 'guest' : 'host';
  ball.deactivate();
  versusBall = null;
  const winner = match.scorePoint(scorer);
  ui.updateVersusScore(match.snapshot(), 'host');
  game.revision++; // repaint the in-world board
  broadcastHostState();
  if (winner) ui.showVersusWin(winner === 'host', match.snapshot());
  else startVersusServe();
}

function runVersusHost(dt) {
  if (!match.winner && versusServeTimer > 0) {
    const previous = Math.ceil(versusServeTimer);
    versusServeTimer -= dt;
    if (versusServeTimer <= 0) {
      versusServeTimer = 0;
      ui.hideCountdown();
      serveVersusBall();
    } else if (Math.ceil(versusServeTimer) !== previous) {
      ui.showCountdown(Math.ceil(versusServeTimer));
    }
  }

  versusPaddles.length = 0;
  versusPaddles.push(...paddles, remotePaddle);
  physics.step(dt, balls, versusPaddles);

  // A ball that stops on the table never reaches the floor, so the point would
  // otherwise hang there with a dead ball sitting on the surface and neither
  // player able to do anything about it. Resting is just as final as landing:
  // resolve it the same way, on the half it came to rest on.
  if (versusBall?.active && versusBall.restingOn && !versusBall.floorCounted) {
    handleVersusHostBounce(versusBall, 'floor');
  }

  for (const ball of balls) {
    if (!ball.active) continue;
    ball.updateVisualSpin(dt);
    if (ball.mesh.position.length() > 14) ball.deactivate();
  }

  netSendAccum += dt;
  if (netSendAccum >= NET_TICK) {
    netSendAccum = 0;
    broadcastHostState();
  }
}

function applyHostState(state) {
  if (!state) return;
  match.apply(state.match);
  ui.updateVersusScore(match.snapshot(), 'guest');
  game.revision++;
  applyRemotePaddle(state.paddle);

  if (state.ball?.active) {
    guestBallActive = true;
    guestBallTarget.set(state.ball.p[0], state.ball.p[1], state.ball.p[2]);
    if (!versusBall) versusBall = balls[0];
    // The guest renders the ball but never simulates it: keeping it inactive
    // keeps physics away from it, and the mesh is driven from packets.
    versusBall.active = false;
    versusBall.mesh.visible = true;
  } else {
    guestBallActive = false;
    if (versusBall) {
      versusBall.deactivate();
      versusBall = null;
    }
  }

  if (match.winner) ui.showVersusWin(match.winner === 'guest', match.snapshot());
}

function runVersusGuest(dt) {
  netSendAccum += dt;
  if (netSendAccum >= NET_TICK) {
    netSendAccum = 0;
    room?.send('paddle', bladePacket());
  }
  // Smoothed toward the last packet rather than snapped to it, so a late or
  // dropped one reads as the ball carrying on instead of stuttering.
  if (guestBallActive && versusBall) {
    versusBall.mesh.position.lerp(guestBallTarget, Math.min(1, dt * 16));
    versusBall.updateVisualSpin(dt);
  }
}

// Put this player on one end of the table. Called once the room has said which
// side we are, which is not necessarily the one the player asked for.
function takeVersusSide(role) {
  netMode = role;

  // The guest plays from the far end. Turning the rig 180° also mirrors the
  // pointer mapping, so left and right stay the way round they should be with
  // no extra transforms anywhere else.
  const guest = role === 'guest';
  playerRig.position.set(0, 0, guest ? -PLAY_AREA.PLAYER_Z : PLAY_AREA.PLAYER_Z);
  playerRig.rotation.y = guest ? Math.PI : 0;

  // The board hangs beyond the far end, which for the guest is behind their
  // head. Move it to the other end and turn it round so both players read the
  // score off a board in front of them.
  scoreboard.mesh.position.z = guest ? -SCOREBOARD_POSITION.z : SCOREBOARD_POSITION.z;
  scoreboard.mesh.rotation.y = guest ? Math.PI : 0;
}

async function enterVersus(role, code) {
  machine.enabled = false;
  coach.setActive(false);
  opponent.setActive(false);
  clearBalls();
  game.reset();

  versusBall = null;
  guestBallActive = false;
  versusServeTimer = 0;
  netSendAccum = 0;
  match.reset();
  // Nothing serves in a match, and the launcher stands at the far end —
  // which is exactly where the guest is standing, so it would otherwise be
  // parked in their face.
  machine.mesh.visible = false;
  opponent.mesh.visible = false;

  netMode = role; // provisional, so the trainer stands down while we connect
  room = createRoom({ code, role });

  // Both messages are wired up before the side is known, because over the LAN
  // relay it isn't ours to decide: the server hands out host and guest by who
  // arrives first, so this client can come back as the opposite of what the
  // player pressed. Each handler checks the side it ended up on.
  room.on('paddle', (pkt) => {
    if (netMode === 'host') applyRemotePaddle(pkt);
  });
  room.on('state', (state) => {
    if (netMode === 'guest') applyHostState(state);
  });

  room.onOpponent((present) => {
    ui.setVersusOpponent(present);
    // The first moment both players are in the room, the host puts a ball up.
    if (
      present &&
      netMode === 'host' &&
      !match.winner &&
      !versusBall &&
      versusServeTimer <= 0
    ) {
      startVersusServe();
    }
  });

  await room.connect();
  takeVersusSide(room.role); // the side the room actually gave us
  game.revision++;
  return room;
}

function leaveVersus() {
  if (!netMode && !room) return;
  room?.close();
  room = null;
  netMode = null;
  remotePaddle.enabled = false;
  remotePaddle.tracking = false;
  remotePaddle.mesh.visible = false;
  versusBall = null;
  guestBallActive = false;
  versusServeTimer = 0;
  netSendAccum = 0;
  clearBalls();
  ui.hideCountdown();
  playerRig.position.set(0, 0, PLAY_AREA.PLAYER_Z);
  playerRig.rotation.y = 0;
  scoreboard.mesh.position.z = SCOREBOARD_POSITION.z;
  scoreboard.mesh.rotation.y = 0;
  applyHandedness(); // restores bat visibility the versus branch took over
  machine.mesh.visible = true;
  opponent.mesh.visible = true;
  clearRoomFromUrl();
  game.revision++;
}

// The board reads the match straight off these, so it can show a score
// without knowing anything about the network.
scoreboard.versus = { match, get role() { return netMode; } };

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
    // The desktop bat rides the pointer, not a hand, so handedness has nothing
    // to say about it. updateDesktopBat owns whether it is live.
    if (paddle === desktopPaddle) return;
    const handedness = inputSources[i]?.handedness;
    // Before a controller reports its handedness, assume index 0 is the
    // right hand rather than leaving the player with no paddle at all.
    const hand = handedness ?? (i === 0 ? 'right' : 'left');
    const holdsPaddle = preferred === 'both' || hand === preferred;

    // Recorded as well as applied, because updateDesktopBat re-derives
    // `enabled` every frame and needs to know what handedness decided.
    paddle.handHolds = holdsPaddle;
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
  if (key === 'paddleSource') {
    // Hold the camera open only while it is the chosen input. Nobody wants a
    // webcam light on because they tried a menu option once.
    if (usingWebcamBat()) startWebcamBat();
    else stopWebcamBat();
  }
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

// --- Desktop camera ---------------------------------------------------------
// The camera rides with the bat instead of being flown around independently.
//
// A free orbit camera is fine for looking at a scene and hopeless for playing
// in one: judging where a ball is in depth depends on knowing where you are,
// and if the viewpoint drifts you are re-learning that every rally. Anchoring
// it to the bat means the bat is always in the same part of the frame, the
// ball grows straight toward you, and the only thing you have to read is the
// ball's flight.
//
// It follows at a fraction of the bat's travel, not one to one. Matching the
// bat exactly makes the world swing about whenever you move, which is both
// unreadable and slightly sickening; trailing it keeps the horizon steady
// while still turning the view toward the side you are playing from.
const CAM_FOLLOW_X = 0.35; // how much of the bat's sideways travel to take
const CAM_FOLLOW_Y = 0.25;
const CAM_BEHIND = 0.85; // metres behind the blade
const CAM_HEIGHT = 1.5; // eye height above the floor, near enough standing
const CAM_EASE = 6; // per second; enough to feel attached, not glued

const _camAim = new THREE.Vector3();
const _camLook = new THREE.Vector3();

function updateDesktopCamera(dt) {
  if (renderer.xr.isPresenting) return; // the headset owns the camera

  // Everything here is in rig space, so the guest's flipped rig turns the
  // view around with it and nothing else has to know.
  _camAim.set(
    desktopAim.x * CAM_FOLLOW_X,
    CAM_HEIGHT + (desktopAim.y - 0.95) * CAM_FOLLOW_Y,
    desktopAim.z + CAM_BEHIND
  );
  camera.position.lerp(_camAim, Math.min(1, dt * CAM_EASE));

  // Look down the table, biased toward the side the bat is on, so moving wide
  // opens up the angle you are actually playing into.
  _camLook.set(desktopAim.x * 0.45, TABLE.HEIGHT + 0.12, -TABLE.LENGTH * 0.42);
  playerRig.localToWorld(_camLook);
  camera.lookAt(_camLook);
}

// --- Main loop --------------------------------------------------------------
const clock = new THREE.Clock();
let servedSeen = 0;
const activePaddles = [];
const versusPaddles = [];
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

  // Pose the desktop bat before the paddles sample themselves, so the swing
  // velocity is measured against the pose it actually has this frame.
  updateDesktopBat(dt);
  updateDesktopCamera(dt);

  for (const paddle of paddles) paddle.update(dt);

  // A networked match replaces the trainer wholesale: no machine, no rally
  // opponent, no coach, and only one side steps physics. Bail out here rather
  // than threading `netMode` through every stage below.
  if (netMode) {
    pollMenuButton(dt);
    vrMenu.update(dt, controllers);
    for (const controller of controllers) {
      if (controller.userData.ray) controller.userData.ray.visible = vrMenu.open;
    }
    targetRing.visible = false;
    targetZone.visible = false;

    // A browser with no headset has bats that are attached to nothing, parked
    // at the rig origin. Facing down the table they sit behind the camera and
    // nobody notices; the guest's rig is turned around, which swings them into
    // view as two objects floating in front of your face. Hide what isn't
    // actually being tracked.
    for (const paddle of paddles) {
      paddle.mesh.visible = paddle.enabled && paddle.tracking;
    }

    if (netMode === 'host') runVersusHost(dt);
    else runVersusGuest(dt);

    scoreboard.update();
    ui.update();
    renderer.render(scene, camera);
    return;
  }

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
    match, remotePaddle, desktopPaddle,
    get camTracker() { return camTracker; },
    get netMode() { return netMode; },
    get room() { return room; },
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
