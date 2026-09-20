import * as THREE from 'three';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

import { createTable } from './table.js';
import { XRManager } from './xr.js';
import { UI } from './ui.js';
import { Settings, OPTIONS } from './settings.js';
import { Sfx } from './audio.js';
import { VRMenu } from './vrMenu.js';
import { Paddle } from './paddle.js';
import { Ball } from './ball.js';
import { PhysicsWorld } from './physics.js';
import { BallMachine, MODES } from './ballMachine.js';
import { Game } from './game.js';
import { Scoreboard } from './hud.js';
import { TargetZone } from './target.js';
import { PLAY_AREA, TABLE, COLORS, BALL } from './constants.js';
import {
  createRoom,
  makeRoomCode,
  roomLinkFor,
  roomFromUrl,
  clearRoomFromUrl,
  tourneyLinkFor,
  tourneyFromUrl,
  clearTourneyFromUrl,
  isRealtimeAvailable,
} from './net.js';
import { VersusMatch, VERSUS_TARGET } from './versus.js';
import { PaddleTracker, TRACKER_STATE } from './vision/paddleTracker.js';
import { FlyBrain } from './flybrain/flyBrain.js';
import { FlyBrainViz } from './flybrain/flyBrainViz.js';

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

const xr = new XRManager(renderer);
xr.onModeChange = applyMode;

// Background choices offered by the setup wizard. Mutating VR_BACKGROUND keeps
// applyMode() (which reuses it) in sync.
const BACKGROUNDS = { arena: 0x0a0a0b, sunset: 0x2a1420, neon: 0x06131f, void: 0x000000 };
function applyBackground(name) {
  VR_BACKGROUND.setHex(BACKGROUNDS[name] ?? BACKGROUNDS.arena);
  if (!renderer.xr.isPresenting) scene.background = VR_BACKGROUND;
}

// 3-2-1 gate: the machine stays idle until the countdown finishes.
let launchCountdown = 0;
function startLaunchCountdown() {
  launchCountdown = 3;
  ui.showCountdown(3);
}

// Single-player is point-based: exactly one ball is in play at a time. This
// holds the ball the current point is being played with; the per-frame loop
// watches it, and when the point resolves (miss / double bounce / dead feed /
// a return that settles) it runs the 3-2-1 before the machine feeds again.
let pointBall = null;
function endPoint() {
  if (netMode !== null) return; // versus/tournament run their own scoring
  if (machine.isTargetMode) return; // drills feed continuously — no per-point 3-2-1
  if (launchCountdown > 0) return; // a countdown is already queuing the next feed
  machine.enabled = false; // hold the machine through the countdown
  if (pointBall && pointBall.active) pointBall.deactivate();
  pointBall = null;
  startLaunchCountdown();
}

const ui = new UI({
  xr,
  machine,
  game,
  settings,
  sfx,
  // `choice` = { mode, input, background, xrMode } from the setup wizard.
  onStart: (choice = {}) => {
    const { mode = 'bot', input = 'mouse', background = 'arena', botSettings } = choice;
    applyBackground(background);
    // Beta endpoints still fall back to a local experience, with a clear note.
    if (mode === 'friend') ui.toast('Online play is in beta — playing the bot');
    else if (mode === 'tournament') ui.toast('Tournaments are in beta — playing the bot');
    else if (input === 'phone') ui.toast('Phone control is coming — using the mouse');
    // Webcam paddle is a real input now: start the tracker for it, stop it for
    // any other input so the pointer takes back over.
    if (input === 'paddle') startCamPaddle();
    else stopCamPaddle();

    // Play a Fly: the connectome-reservoir opponent. Play a (Standard) Bot and
    // the beta friend/tournament paths use the analytic AI. Both run on the
    // host loop with no ball machine.
    if (mode === 'fly') {
      startBotGame({ fly: true });
      return;
    }
    if (mode === 'bot' || mode === 'friend' || mode === 'tournament') {
      startBotGame({ fly: false });
      return;
    }

    // Drills: the ball machine feeds CONTINUOUSLY. The wizard's settings step
    // maps pace/feed/placement onto their Settings multipliers and the shot
    // type onto a machine mode, defaulting to target practice.
    machine.modeIndex = MODES.findIndex((m) => m.type === 'target');
    if (botSettings) {
      const applyOpt = (key) => {
        const opt = OPTIONS[key]?.find((o) => o.label === botSettings[key]);
        if (opt) settings.set(key, opt.value);
      };
      applyOpt('pace');
      applyOpt('feedRate');
      applyOpt('placement');
      const shotIndex = MODES.findIndex((m) => m.name === botSettings.modeName);
      if (shotIndex >= 0) machine.modeIndex = shotIndex;
    }
    game.reset();
    game.revision++;
    pointBall = null;
    balls.forEach((b) => b.deactivate());
    // No 3-2-1, no point-based hold: the machine keeps feeding until reset.
    ui.hideCountdown();
    machine.enabled = true;
  },
  onExit: () => {
    stopCamPaddle();
    machine.enabled = false;
    launchCountdown = 0;
    pointBall = null;
    ui.hideCountdown();
  },
  // Online versus lobby hooks. The lobby UI (built separately) calls these to
  // create/join/leave a networked 1v1; the game logic lives in enterVersus /
  // leaveVersus below. Both are hoisted function declarations, so referencing
  // them here before their definition is safe.
  onVersusCreate: async () => {
    const code = makeRoomCode();
    await enterVersus('host', code);
    return {
      role: 'host',
      code,
      link: roomLinkFor(code),
      kind: isRealtimeAvailable() ? 'supabase' : 'local',
    };
  },
  onVersusJoin: async (code) => {
    await enterVersus('guest', code);
  },
  onVersusLeave: () => {
    leaveVersus();
  },
  // Tournament lobby transport. main is a dumb pipe: it opens/joins a room and
  // forwards every message + presence event to the UI, which owns the roster
  // and bracket. Channel is namespaced ('T'+code) so it can't collide with a
  // 1v1 versus room of the same code.
  onTourneyCreate: async () => {
    const code = makeRoomCode();
    tourneyRoom = createRoom({ code: `T${code}`, role: 'host' });
    wireTourneyRoom(tourneyRoom);
    await tourneyRoom.connect();
    return { code, link: tourneyLinkFor(code), kind: isRealtimeAvailable() ? 'supabase' : 'local' };
  },
  onTourneyJoin: async (code) => {
    tourneyRoom = createRoom({ code: `T${code}`, role: `guest-${Math.random().toString(36).slice(2, 8)}` });
    wireTourneyRoom(tourneyRoom);
    await tourneyRoom.connect();
    return { code };
  },
  onTourneySend: (type, data) => tourneyRoom?.send(type, data),
  onTourneyLeave: () => {
    tourneyRoom?.close();
    tourneyRoom = null;
    clearTourneyFromUrl();
  },
});

xr.detectSupport().then((support) => ui.applyXRSupport(support));

// --- Physics ----------------------------------------------------------------
const physics = new PhysicsWorld();
physics.onBounce = (ball, event) => {
  // Online versus takes over scoring entirely. The host resolves floor
  // bounces into points (handleVersusHostBounce); the guest renders only
  // host-authoritative state, so it ignores its local physics contacts.
  if (netMode === 'host') {
    handleVersusHostBounce(ball, event);
    return;
  }
  if (netMode === 'guest') return;

  game.onContact(ball, event);
  sfx.contact(event, ball.velocity.length());

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

  // Double bounce: a second landing on the player's half with no return in
  // between loses the point (game.onContact has already logged the miss).
  // Recycle the ball at once so the per-frame watcher runs the 3-2-1.
  if (
    event === 'table' &&
    ball === pointBall &&
    !ball.touchedByPaddle &&
    ball.playerHalfBouncesSincePaddle >= 2
  ) {
    ball.deactivate();
    return;
  }

  // Floor contact means the rally is over for this ball; start a countdown
  // that returns it to the pool. Timed in simulation seconds rather than via
  // setTimeout so it can't drift when the browser throttles the frame loop.
  if (event === 'floor' && ball.retireIn === null) {
    // Dead feed: the machine launched a ball that never made a legal bounce on
    // the player's half (and the player never touched it). That's the
    // machine's fault, not a miss — recycle it silently and immediately, no
    // lingering, so the next point's 3-2-1 starts right away.
    if (ball === pointBall && !ball.touchedByPaddle && !ball.everBouncedPlayerHalf) {
      ball.deactivate();
    } else {
      ball.retireIn = DEAD_BALL_LINGER;
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

// --- Desktop mouse paddle ---------------------------------------------------
// XR gives a paddle only when a headset is attached to a grip. On desktop the
// player drives a vertical paddle over the near half of the table with the
// mouse. The rig is parented under playerRig (world Z = PLAYER_Z), so pointer
// coordinates map to a small volume in front of the player, above the table.
// The pose is written straight from the pointer event with no smoothing, so
// the blade stays under the cursor; Paddle.update() then derives swing
// velocity/spin from the rig's motion between frames, exactly like a grip.
const mousePaddleRig = new THREE.Group();
playerRig.add(mousePaddleRig);
const mousePaddle = new Paddle({ vertical: true });
mousePaddle.attachTo(mousePaddleRig);

// Webcam paddle (ported from main): an HSV colour tracker follows a real
// paddle and drives the mouse rig. Opt-in via the "A Ping Pong Paddle" menu
// choice; the pointer is suspended while it's active and takes back over
// whenever the tracker isn't actually TRACKING.
let camTracker = null;
let useCamPaddle = false;
function startCamPaddle() {
  if (useCamPaddle) return;
  useCamPaddle = true;
  camTracker = new PaddleTracker();
  camTracker.onState = (state, err) => {
    if (state === TRACKER_STATE.ERROR) ui.toast?.(err || 'Camera unavailable — using mouse');
    else if (state === TRACKER_STATE.TRACKING) ui.toast?.('Paddle cam live — move your bat');
    else if (state === TRACKER_STATE.CALIBRATING) ui.toast?.('Hold your paddle up to calibrate…');
  };
  camTracker.start().catch((e) => { ui.toast?.(e?.message || 'Camera failed — using mouse'); stopCamPaddle(); });
}
function stopCamPaddle() {
  useCamPaddle = false;
  camTracker?.stop();
  camTracker = null;
}
paddles.push(mousePaddle);

// ---------------------------------------------------------------------------
// Online versus (1v1). The host is authoritative for the ball and scoring;
// each side drives its own paddle locally and syncs it to the other as blade
// center/normal/velocity. When netMode is null everything below is dormant and
// the single-player trainer (bot/drills/countdown/mouse paddle) is unchanged.
// ---------------------------------------------------------------------------
let netMode = null; // null | 'host' | 'guest'
let room = null; // active net room handle
// Local bot match (tournament): reuses the host loop with no network room.
// When vsBot is true, runVersusHost drives an AI opponent paddle and the
// match winner is resolved through endBotMatch instead of the win overlay.
let vsBot = false;
let botOpponentName = '';
const match = new VersusMatch();
let versusBall = null; // current rally ball (host authoritative)
let versusServeTimer = 0; // countdown before the next serve (host)
let netSendAccum = 0; // throttle for outbound network state
let guestBallActive = false;
const NET_TICK = 1 / 30; // ~30 Hz network send rate
const VERSUS_SERVE_SECONDS = 3;
const guestBallTarget = new THREE.Vector3();
const _versusQuat = new THREE.Quaternion();
const _versusFwd = new THREE.Vector3(0, 0, 1);

// Opponent paddle: driven entirely by network packets, so it skips the local
// input update path (see the tick paddle loop) and is flagged `networked`.
const remoteAnchor = new THREE.Group();
scene.add(remoteAnchor);
const remotePaddle = new Paddle({ vertical: true });
remotePaddle.attachTo(remoteAnchor);
remotePaddle.enabled = false;
remotePaddle.networked = true;
paddles.push(remotePaddle);

function bladePacket(paddle) {
  return {
    c: [paddle.bladeCenter.x, paddle.bladeCenter.y, paddle.bladeCenter.z],
    n: [paddle.bladeNormal.x, paddle.bladeNormal.y, paddle.bladeNormal.z],
    v: [paddle.velocity.x, paddle.velocity.y, paddle.velocity.z],
  };
}

function applyRemotePaddle(pkt) {
  if (!pkt) return;
  remotePaddle.enabled = true;
  // The networked paddle never runs Paddle.update(), so mark it as tracking
  // here — otherwise the swept paddle test in physics skips it and the
  // opponent could never return a ball.
  remotePaddle.tracking = true;
  remotePaddle.bladeCenter.set(pkt.c[0], pkt.c[1], pkt.c[2]);
  remotePaddle.bladeNormal.set(pkt.n[0], pkt.n[1], pkt.n[2]).normalize();
  remotePaddle.velocity.set(pkt.v[0], pkt.v[1], pkt.v[2]);
  remotePaddle.mesh.position.copy(remotePaddle.bladeCenter);
  remotePaddle.mesh.quaternion.copy(
    _versusQuat.setFromUnitVectors(_versusFwd, remotePaddle.bladeNormal)
  );
}

function startVersusServe() {
  versusServeTimer = VERSUS_SERVE_SECONDS;
  ui.showCountdown(VERSUS_SERVE_SECONDS);
}

function serveVersusBall() {
  const ball = balls.find((b) => !b.active);
  if (!ball) return;
  // Server alternates ends: host serves toward -Z (the guest), guest toward +Z.
  const dir = match.server === 'host' ? -1 : 1;
  ball.serve(
    new THREE.Vector3((Math.random() * 2 - 1) * 0.3, TABLE.HEIGHT + 0.35, -dir * 0.8),
    new THREE.Vector3((Math.random() * 2 - 1) * 0.6, 1.4, dir * 3.4)
  );
  ball.floorCounted = false; // ad-hoc flag; Ball.serve() doesn't reset it
  versusBall = ball;
  broadcastHostState();
}

function broadcastHostState() {
  if (!room) return;
  const ball =
    versusBall && versusBall.active
      ? {
          active: true,
          p: [versusBall.mesh.position.x, versusBall.mesh.position.y, versusBall.mesh.position.z],
        }
      : { active: false, p: [0, 0, 0] };
  room.send('state', { match: match.snapshot(), ball, paddle: bladePacket(mousePaddle) });
}

function handleVersusHostBounce(ball, event) {
  if (event !== 'floor' || ball !== versusBall || ball.floorCounted) return;
  ball.floorCounted = true;
  // A ball landing on the host's half (z>0) means the host failed to return
  // it, so the guest scores — and vice versa.
  const scorer = ball.mesh.position.z > 0 ? 'guest' : 'host';
  ball.deactivate();
  versusBall = null;
  const winner = match.scorePoint(scorer);
  ui.updateVersusScore(match.snapshot(), 'host');
  broadcastHostState();
  if (winner) {
    if (vsBot) endBotMatch(winner);
    else ui.showVersusWin(winner === 'host', match.snapshot());
  } else startVersusServe();
}

function runVersusHost(dt) {
  if (!match.winner && versusServeTimer > 0) {
    const prev = Math.ceil(versusServeTimer);
    versusServeTimer -= dt;
    if (versusServeTimer <= 0) {
      versusServeTimer = 0;
      ui.hideCountdown();
      serveVersusBall();
    } else if (Math.ceil(versusServeTimer) !== prev) {
      ui.showCountdown(Math.ceil(versusServeTimer));
    }
  }
  // Local tournament match: an AI drives the opponent paddle. It must run
  // before physics.step so the swept collision sees this frame's pose/velocity.
  if (vsBot) updateBotPaddle(dt);
  physics.step(dt, balls, paddles);
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
  applyRemotePaddle(state.paddle);
  if (state.ball?.active) {
    guestBallActive = true;
    guestBallTarget.set(state.ball.p[0], state.ball.p[1], state.ball.p[2]);
    if (!versusBall) versusBall = balls[0];
    // The guest renders the ball but never simulates it: keep it inactive so
    // physics.step ignores it, and drive its mesh purely from network state.
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
    room?.send('paddle', bladePacket(mousePaddle));
  }
  if (guestBallActive && versusBall) {
    versusBall.mesh.position.lerp(guestBallTarget, Math.min(1, dt * 16));
    versusBall.updateVisualSpin(dt);
  }
}

async function enterVersus(role, code) {
  machine.enabled = false;
  launchCountdown = 0;
  ui.hideCountdown();
  game.reset?.();
  balls.forEach((b) => b.deactivate());
  versusBall = null;
  guestBallActive = false;
  versusServeTimer = 0;
  netSendAccum = 0;
  match.reset();
  netMode = role;
  remotePaddle.enabled = true;
  // The guest plays from the far (-Z) end; the 180° turn also mirrors the
  // pointer mapping so left/right feel natural with no extra transforms.
  if (role === 'guest') {
    playerRig.position.set(0, 0, -PLAY_AREA.PLAYER_Z);
    playerRig.rotation.y = Math.PI;
  } else {
    playerRig.position.set(0, 0, PLAY_AREA.PLAYER_Z);
    playerRig.rotation.y = 0;
  }
  room = createRoom({ code, role });
  if (role === 'host') room.on('paddle', (pkt) => applyRemotePaddle(pkt));
  else room.on('state', (state) => applyHostState(state));
  room.onOpponent((present) => {
    ui.setVersusOpponent(present);
    // First time both players are present, the host kicks off the serve.
    if (present && role === 'host' && !match.winner && !versusBall && versusServeTimer <= 0) {
      startVersusServe();
    }
  });
  await room.connect();
}

function leaveVersus() {
  room?.close();
  room = null;
  netMode = null;
  vsBot = false; // exit any local bot match cleanly
  useFlyBrain = false;
  flyBrainViz.hide();
  remotePaddle.enabled = false;
  remotePaddle.tracking = false;
  versusBall = null;
  guestBallActive = false;
  versusServeTimer = 0;
  netSendAccum = 0;
  balls.forEach((b) => b.deactivate());
  ui.hideCountdown();
  // Restore the opponent anchor to identity so networked versus (which poses
  // remotePaddle relative to this anchor) isn't offset by a prior bot match.
  remoteAnchor.rotation.set(0, 0, 0);
  remoteAnchor.position.set(0, 0, 0);
  playerRig.position.set(0, 0, PLAY_AREA.PLAYER_Z);
  playerRig.rotation.y = 0;
  clearRoomFromUrl();
}

// --- Tournament lobby net pipe ----------------------------------------------
// A single room per tournament; every inbound message + presence change is
// forwarded to the UI, which owns the roster and bracket state.
let tourneyRoom = null;
function wireTourneyRoom(roomHandle) {
  for (const type of ['join', 'roster', 'bracket']) {
    roomHandle.on(type, (data) => ui._onTourneyMessage?.(type, data));
  }
  roomHandle.onOpponent((present) => ui._onTourneyPresence?.(present));
}

// --- Local AI rally ("fly brain") -------------------------------------------
// A real 1v1 game to 11 (win by 2) against an AI opponent, built on the host
// loop with no network room. The AI paddle lives at the far (-Z) end, predicts
// where incoming balls will cross its plane, and returns them over the net —
// deliberately imperfect so the player can score.

// Reaction plane for the AI paddle — a little in front of the far baseline.
const BOT_HOME_Z = -(TABLE.LENGTH / 2 - 0.35);

// Connectome-reservoir controller + its visualization for "Play a Fly". The
// model is fetched once at startup; until it resolves (or if it's missing)
// FlyBrain.step() falls back to a near-perfect analytic intercept.
const flyBrain = new FlyBrain();
flyBrain.load().then((ok) => ok && console.info('[FlyBrain] connectome model loaded'));
const flyBrainViz = new FlyBrainViz(flyBrain);
flyBrainViz.mount();
flyBrainViz.hide();
let useFlyBrain = false;

function startBotGame({ fly = false } = {}) {
  vsBot = true;
  useFlyBrain = fly;
  botOpponentName = fly ? 'Fly' : 'Bot';

  machine.enabled = false;
  launchCountdown = 0;
  ui.hideCountdown();
  game.reset?.();
  balls.forEach((b) => b.deactivate());
  versusBall = null;
  guestBallActive = false;
  versusServeTimer = 0;
  netSendAccum = 0;
  match.reset();

  // Host loop with no room: broadcastHostState() is a no-op (guards !room).
  netMode = 'host';
  room = null;

  remotePaddle.enabled = true;
  remotePaddle.networked = true;

  // You play from the near (+Z) end, unrotated; the bot faces you from -Z with
  // its blade turned toward +Z so returns come back over the net.
  playerRig.position.set(0, 0, PLAY_AREA.PLAYER_Z);
  playerRig.rotation.y = 0;
  remoteAnchor.rotation.y = Math.PI; // blade faces +Z (back toward the player)
  remoteAnchor.position.set(0, TABLE.HEIGHT + 0.2, BOT_HOME_Z);

  // The Fly brings its connectome reservoir + activation viz; the standard bot
  // does not.
  if (fly) { flyBrain.reset(); flyBrainViz.show(); }
  else flyBrainViz.hide();

  // Scoreboard-only view (no lobby/room code), then serve directly — there's
  // no room to wait on, so we don't rely on room.onOpponent.
  ui.showBotMatch(botOpponentName);
  ui.updateVersusScore(match.snapshot(), 'host');
  startVersusServe();
}

// Cheap ballistic roll-forward (gravity + one table bounce) to find where an
// incoming ball crosses the fly's paddle plane. This is what the standard bot
// lacked: a naive linear guess ignores the bounce, so the paddle sat at the
// wrong height and whiffed.
function predictIntercept(ball) {
  const p = ball.mesh.position.clone();
  const v = ball.velocity.clone();
  const g = -9.81, dt = 1 / 120, surfaceY = TABLE.HEIGHT + BALL.RADIUS;
  let bounced = false;
  for (let i = 0; i < 600; i++) {
    v.y += g * dt;
    p.addScaledVector(v, dt);
    if (p.y <= surfaceY && v.y < 0 && Math.abs(p.x) < TABLE.WIDTH / 2 && p.z < 0 && !bounced) {
      p.y = surfaceY; v.y = -v.y * 0.9; bounced = true;
    }
    if (p.z <= BOT_HOME_Z) break;
  }
  return { x: p.x, y: p.y };
}

function updateBotPaddle(dt) {
  const ball = versusBall;
  let targetX = remoteAnchor.position.x;
  let targetY = remoteAnchor.position.y;

  const minX = -(TABLE.WIDTH / 2 - 0.12);
  const maxX = TABLE.WIDTH / 2 - 0.12;
  const minY = TABLE.HEIGHT + 0.05;
  const maxY = TABLE.HEIGHT + 0.45;

  if (useFlyBrain) {
    // Connectome reservoir. Step every frame (even with no ball) so activity
    // keeps flowing and the viz animates; it drives toward the ball whenever
    // one is incoming. The world frame matches how the readout was trained.
    const s = ball && ball.active
      ? {
          x: ball.mesh.position.x, y: ball.mesh.position.y,
          vx: ball.velocity.x, vy: ball.velocity.y,
          z: ball.mesh.position.z, vz: ball.velocity.z,
        }
      : { x: 0, y: TABLE.HEIGHT + 0.2, vx: 0, vy: 0, z: 0, vz: -3 };
    const out = flyBrain.step(s);
    targetX = out.targetX;
    if (out.targetY != null) targetY = out.targetY;

    // Near-unbeatable: track the predicted intercept almost exactly.
    const k = Math.min(1, dt * 18);
    targetX = THREE.MathUtils.clamp(targetX, minX, maxX);
    targetY = THREE.MathUtils.clamp(targetY, minY, maxY);
    remoteAnchor.position.x += (targetX - remoteAnchor.position.x) * k;
    remoteAnchor.position.y += (targetY - remoteAnchor.position.y) * k;
    remoteAnchor.position.z = BOT_HOME_Z;
    remoteAnchor.rotation.y = Math.PI;
    remotePaddle.update(dt);
    remotePaddle.bladeNormal.y += 0.28;
    remotePaddle.bladeNormal.normalize();
    return;
  }

  // Standard bot: predict the post-bounce intercept and track it briskly
  // enough to actually get there (the old gain of ~0.12/frame was too slow to
  // reach anything but a ball hit straight at it).
  const k = Math.min(1, dt * 12);
  if (ball && ball.active && ball.velocity.z < 0) {
    const hit = predictIntercept(ball);
    targetX = hit.x;
    targetY = hit.y;
  }
  targetX = THREE.MathUtils.clamp(targetX, minX, maxX);
  targetY = THREE.MathUtils.clamp(targetY, minY, maxY);
  remoteAnchor.position.x += (targetX - remoteAnchor.position.x) * k;
  remoteAnchor.position.y += (targetY - remoteAnchor.position.y) * k;
  remoteAnchor.position.z = BOT_HOME_Z;
  remoteAnchor.rotation.y = Math.PI;
  remotePaddle.update(dt);

  // Return bias: tilt the blade normal up so the reflected ball arcs over the
  // net instead of driving flat into it.
  remotePaddle.bladeNormal.y += 0.32;
  remotePaddle.bladeNormal.normalize();
}

function endBotMatch(winner) {
  // The rally ball is already retired by handleVersusHostBounce; freeze the
  // match on the win overlay. Full teardown (netMode/vsBot/rig/anchor) happens
  // when the player taps Back-to-menu -> leaveVersus().
  ui.hideCountdown();
  versusBall = null;
  guestBallActive = false;
  versusServeTimer = 0;
  balls.forEach((b) => b.deactivate());
  ui.showVersusWin(winner === 'host', match.snapshot());
}

// Depth of the mouse paddle along Z. Scrolling sets a TARGET; the render loop
// eases the rig toward it, so the motion carries real velocity (momentum) into
// the ball instead of teleporting.
let mouseDepthTarget = -0.72;
function setMousePaddlePose(clientX, clientY) {
  if (renderer.xr.isPresenting) return; // XR controllers own the paddles
  if (useCamPaddle) return; // the webcam tracker owns the rig while active
  const x = THREE.MathUtils.clamp(clientX / window.innerWidth, 0, 1);
  const y = THREE.MathUtils.clamp(clientY / window.innerHeight, 0, 1);
  // X spans a little more than the table width; Y rides just above the surface
  // up to head height; Z sits the blade a bit in front of the player over the
  // near half of the table. All relative to playerRig.
  mousePaddleRig.position.x = (x - 0.5) * 1.25;
  // Never let the blade drop below the table surface.
  mousePaddleRig.position.y = Math.max(TABLE.HEIGHT + 0.03, 0.95 + (0.5 - y) * 0.7);
  // Z (depth) is eased toward mouseDepthTarget in the render loop so a forward
  // scroll is a real thrust with momentum, not a one-frame teleport.
  // A gentle roll with horizontal position gives natural left/right steering.
  mousePaddleRig.rotation.set(0, 0, -(x - 0.5) * 0.6);
}
window.addEventListener('pointermove', (e) => setMousePaddlePose(e.clientX, e.clientY), { passive: true });
window.addEventListener('pointerdown', (e) => setMousePaddlePose(e.clientX, e.clientY), { passive: true });
// Scroll wheel moves the paddle back/forward in depth so you can step behind
// the bounce. (OrbitControls' own wheel-zoom is disabled below so it doesn't
// fight this.) Scroll down = back toward you; scroll up = forward toward net.
window.addEventListener('wheel', (e) => {
  if (renderer.xr.isPresenting || useCamPaddle) return;
  if (ui.menu && !ui.menu.hidden) return; // let the menu scroll normally
  e.preventDefault();
  // Set a target; the render loop eases the paddle toward it so a forward
  // scroll swings the bat with momentum instead of snapping instantly.
  mouseDepthTarget = THREE.MathUtils.clamp(mouseDepthTarget + Math.sign(e.deltaY) * 0.12, -1.3, -0.15);
}, { passive: false });

// The mouse paddle is a desktop-only stand-in for a tracked controller: hide
// and disable it in XR so it can't swat balls out of the air from a stale
// pose, and bring it back when the immersive session ends.
renderer.xr.addEventListener('sessionstart', () => {
  mousePaddle.enabled = false;
  mousePaddle.mesh.visible = false;
  renderer.domElement.style.cursor = '';
});
renderer.xr.addEventListener('sessionend', () => {
  mousePaddle.enabled = true;
  mousePaddle.mesh.visible = true;
});

// In-headset pause menu. The DOM shell is invisible in an immersive session,
// so this is the only way to reach settings with the headset on.
const vrMenu = new VRMenu({
  camera,
  machine,
  game,
  settings,
  sfx,
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

function pollMenuButton() {
  const down = inputSources.some((source) =>
    MENU_BUTTONS.some((b) => source?.gamepad?.buttons?.[b]?.pressed)
  );
  if (down && !menuButtonWasDown) vrMenu.toggle();
  menuButtonWasDown = down;
}

// You hold one bat, not two. The off hand keeps its controller model so you
// can still see where it is, but carries no paddle — otherwise it swats balls
// out of the air by accident.
function applyHandedness() {
  const preferred = settings.get('hand');
  paddles.forEach((paddle, i) => {
    // Handedness only governs the two XR grip paddles; the desktop mouse
    // paddle isn't held in a hand and must keep its own enabled/visible state.
    if (paddle === mousePaddle) return;
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

settings.onChange((key) => {
  if (key === 'hand') applyHandedness();
});
applyHandedness();

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
orbit.enableZoom = false; // the scroll wheel moves the paddle depth instead
orbit.update();

// On-screen desktop controls legend, shown while playing (hidden on the menu
// and in XR). Kept in sync with menu visibility in the render loop.
const controlsHint = document.createElement('div');
controlsHint.id = 'controls-hint';
controlsHint.innerHTML =
  '<span><b>Move</b> paddle</span>' +
  '<span><b>Scroll</b> depth</span>' +
  '<span><b>Z</b>/<b>X</b> zoom</span>' +
  '<span><b>Space</b> pause</span>' +
  '<span><b>S</b> serve</span>';
document.body.appendChild(controlsHint);
renderer.xr.addEventListener('sessionstart', () => (orbit.enabled = false));
renderer.xr.addEventListener('sessionend', () => (orbit.enabled = true));

// --- Main loop --------------------------------------------------------------
const clock = new THREE.Clock();
let servedSeen = 0;

function tick(dt) {
  // Webcam paddle: pose the rig from the tracker before paddles sample their
  // velocity, so the derived swing speed/spin is measured against this pose.
  if (useCamPaddle && camTracker && camTracker.state === TRACKER_STATE.TRACKING) {
    mousePaddleRig.position.copy(camTracker.position);
    mousePaddleRig.quaternion.copy(camTracker.quaternion);
  } else if (!renderer.xr.isPresenting) {
    // Ease the paddle depth toward the scroll target. Doing it here (rather
    // than snapping on the wheel event) means Paddle.update samples a smooth,
    // sustained Z velocity, so a forward scroll drives the ball with momentum.
    mousePaddleRig.position.z += (mouseDepthTarget - mousePaddleRig.position.z) * Math.min(1, dt * 10);
  }
  for (const paddle of paddles) {
    // Networked (opponent) paddles are posed from incoming packets, not from
    // local input, so they must not run the velocity-sampling update.
    if (paddle.networked) continue;
    paddle.update(dt);
  }

  pollMenuButton();
  vrMenu.update(dt, controllers);
  for (const controller of controllers) {
    if (controller.userData.ray) controller.userData.ray.visible = vrMenu.open;
  }

  if (netMode === 'host') {
    runVersusHost(dt);
  } else if (netMode === 'guest') {
    runVersusGuest(dt);
  } else {
    // --- Single-player trainer (bot / drills / countdown) -----------------
    // 3-2-1 before the first serve: hold the machine, tick the on-screen count.
    if (launchCountdown > 0) {
      const prev = Math.ceil(launchCountdown);
      launchCountdown -= dt;
      if (launchCountdown <= 0) {
        launchCountdown = 0;
        ui.hideCountdown();
        machine.enabled = true;
        machine._timer = Math.min(machine._timer, 0.2);
      } else if (Math.ceil(launchCountdown) !== prev) {
        ui.showCountdown(Math.ceil(launchCountdown));
      }
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
      // Drills feed continuously — no point-based hold. The ball machine keeps
      // launching until the player resets or leaves the mode.
    }

    if (vrMenu.open) machine.enabled = wasEnabled; // restore; the pause is momentary

    physics.step(dt, balls, paddles);
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

    // The point ends the moment its ball leaves play — a miss, a double
    // bounce, a dead feed recycled above, or a return that has settled.
    // Run the 3-2-1 (endPoint guards against firing during a countdown),
    // then the machine feeds the next single ball when it hits zero.
    if (pointBall && !pointBall.active && launchCountdown <= 0) {
      endPoint();
    }
  }

  scoreboard.update();
  ui.update();
  if (useFlyBrain) flyBrainViz.render();
  controlsHint.style.display = (!renderer.xr.isPresenting && ui.menu && ui.menu.hidden) ? 'flex' : 'none';

  // Hide the OS cursor while the desktop player is training so it doesn't sit
  // on top of the paddle, but restore it over the start menu so the buttons
  // stay clickable. XR owns the cursor state through its session listeners.
  if (!renderer.xr.isPresenting) {
    renderer.domElement.style.cursor = ui.menu.hidden ? 'none' : '';
  }

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
    settings, ui, vrMenu, scene, camera, tick,
  };
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// Keyboard shortcuts make desktop iteration much faster than reaching for a
// headset every time.
window.addEventListener('keydown', (e) => {
  if (!ui.menu.hidden) return; // menu is up; let the buttons own the input

  if (e.code === 'Space') {
    e.preventDefault(); // stop the browser scrolling / re-firing a focused button
    machine.enabled = !machine.enabled;
    game.revision++;
    ui.toast(machine.enabled ? 'Machine armed' : 'Paused');
  } else if (e.code === 'KeyD') {
    ui.toast(machine.nextDrill().name);
    game.revision++;
  } else if (e.code === 'KeyR') {
    game.reset();
    ui.toast('Score reset');
  } else if (e.code === 'KeyS') {
    machine.serve();
  } else if (e.code === 'KeyZ') {
    // Zoom in (narrower field of view).
    camera.fov = Math.max(40, camera.fov - 4);
    camera.updateProjectionMatrix();
  } else if (e.code === 'KeyX') {
    // Zoom out (wider field of view).
    camera.fov = Math.min(85, camera.fov + 4);
    camera.updateProjectionMatrix();
  }
});

// If this page was opened from a shared room link (?room=CODE), drop straight
// into the versus lobby as the guest and connect.
const autoJoinCode = roomFromUrl();
if (autoJoinCode) {
  ui.openVersusLobby({
    role: 'guest',
    code: autoJoinCode,
    link: roomLinkFor(autoJoinCode),
    kind: isRealtimeAvailable() ? 'supabase' : 'local',
  });
  enterVersus('guest', autoJoinCode).catch((err) => ui.toast?.(err?.message ?? 'Could not join room'));
}

// A shared tournament link (?t=CODE) drops the visitor straight into the
// tournament lobby's join screen (Kahoot-style: enter a name, then you're in).
const autoTourneyCode = tourneyFromUrl();
if (autoTourneyCode) {
  ui.openTournamentJoin?.(autoTourneyCode);
}
