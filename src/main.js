import * as THREE from 'three';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import './styles.css';
import { buildEnvironment, setEnvironmentPalette } from './environment.js';
import { createTable } from './table.js';
import { createXRButtons } from './xrButtons.js';
import { Paddle } from './paddle.js';
import { Ball } from './ball.js';
import { PhysicsWorld } from './physics.js';
import { BallMachine } from './ballMachine.js';
import { PLAY_AREA, TABLE } from './constants.js';
import { DIFFICULTIES, RANKED_LIVES, TrainerSession } from './session.js';
import { createRoom, makeRoomCode, roomLinkFor, roomFromUrl, clearRoomFromUrl, isRealtimeAvailable } from './net.js';
import { VersusMatch, VERSUS_TARGET } from './versus.js';
import { createTrainerUI } from './ui.js';
import { startHandTracking } from './handTracking.js';

const APP_ROUTES = new Set(['/', '/training', '/live-game', '/tournament']);
const currentPath = APP_ROUTES.has(window.location.pathname) ? window.location.pathname : '/';

// Vite can re-evaluate this module during HMR. Remove prior app generations
// so old canvases, HUDs, and paddles cannot remain layered over the new scene.
if (typeof window !== 'undefined') {
  window.__flyballRenderers?.forEach((oldRenderer) => oldRenderer.setAnimationLoop(null));
  window.__flyballRenderers = [];
  document.querySelectorAll('canvas, .trainer-ui, [data-flyball-xr]').forEach((node) => node.remove());
}

const BALL_POOL_SIZE = 8;
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setSize(window.innerWidth, window.innerHeight); renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.xr.enabled = true; renderer.xr.setReferenceSpaceType('local-floor'); renderer.domElement.dataset.flyballRenderer = 'true'; document.body.appendChild(renderer.domElement);
window.__flyballRenderers ??= [];
window.__flyballRenderers.push(renderer);
const scene = new THREE.Scene();
const VR_BACKGROUND = new THREE.Color(0x101018);
const LANDSCAPES = { classic: 0x101018, sunset: 0x3b1f2b, neon: 0x071d2c, disco: 0x0b0716 };
let landscapeBackground = VR_BACKGROUND;
scene.background = landscapeBackground;
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 50);
const playerRig = new THREE.Group(); playerRig.position.set(0, 0, PLAY_AREA.PLAYER_Z); playerRig.add(camera); scene.add(playerRig); camera.position.set(0, 1.6, 0);
scene.add(new THREE.HemisphereLight(0xbbccff, 0x334422, 0.9)); const keyLight = new THREE.DirectionalLight(0xfff1d0, 1.5); keyLight.position.set(3, 6, 2); scene.add(keyLight);
const table = createTable(); scene.add(table);
const landscapeEnvironment = buildEnvironment(VR_BACKGROUND.getHex());
scene.add(landscapeEnvironment.group);
landscapeEnvironment.gear && scene.add(landscapeEnvironment.gear);
const vrEnvironment = table.getObjectByName('vr-environment');
function applyLandscape(name = 'classic') {
  const palette = LANDSCAPES[name] ?? LANDSCAPES.classic;
  landscapeBackground = new THREE.Color(palette);
  if (!renderer.xr.isPresenting) scene.background = landscapeBackground;
  setEnvironmentPalette(name, landscapeEnvironment);
}
function applyMode(mode) { const isAR = mode === 'immersive-ar'; scene.background = isAR ? null : landscapeBackground; if (vrEnvironment) vrEnvironment.visible = !isAR; }
createXRButtons(renderer, { onModeChange: applyMode }); renderer.xr.addEventListener('sessionend', () => applyMode(null));

const targetMarker = new THREE.Mesh(new THREE.CircleGeometry(1, 32), new THREE.MeshBasicMaterial({ color: 0xffc857, transparent: true, opacity: .72, side: THREE.DoubleSide }));
targetMarker.rotation.x = -Math.PI / 2; targetMarker.visible = false; scene.add(targetMarker);
const targetRing = new THREE.Mesh(new THREE.RingGeometry(.9, 1, 32), new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true, opacity: .95 }));
targetRing.rotation.x = -Math.PI / 2; targetRing.visible = false; scene.add(targetRing);

function updateTargetMarker(move) {
  const visible = Boolean(move);
  targetMarker.visible = visible;
  targetRing.visible = visible;
  if (!visible) return;
  targetMarker.position.set(move.x, TABLE.HEIGHT + .006, move.z);
  targetRing.position.set(move.x, TABLE.HEIGHT + .01, move.z);
  targetMarker.scale.setScalar(move.radius);
  targetRing.scale.setScalar(move.radius);
}

function buildHands() {
  const group = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({ color: 0xe0a078, roughness: .82 });
  const sleeve = new THREE.MeshStandardMaterial({ color: 0xef5b45, roughness: .72 });
  for (const side of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(.022, .032, .22, 12), sleeve);
    arm.rotation.z = side * .35;
    arm.position.set(side * .14, -.13, .045);
    group.add(arm);
    const hand = new THREE.Mesh(new THREE.SphereGeometry(.034, 16, 12), skin);
    hand.scale.set(.9, 1.15, .75);
    hand.position.set(side * .1, -.005, .03);
    group.add(hand);
  }
  return group;
}
function buildFlyOpponent() {
  const group = new THREE.Group(); const body = new THREE.Mesh(new THREE.SphereGeometry(.13, 16, 10), new THREE.MeshStandardMaterial({ color: 0x27333c })); body.scale.set(1.5, .8, 1); group.add(body);
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0xef5b45 }); for (const side of [-1, 1]) { const eye = new THREE.Mesh(new THREE.SphereGeometry(.045, 10, 8), eyeMat); eye.position.set(side * .08, .04, .11); group.add(eye); }
  const wingMat = new THREE.MeshBasicMaterial({ color: 0xcfe9ef, transparent: true, opacity: .35, side: THREE.DoubleSide }); for (const side of [-1, 1]) { const wing = new THREE.Mesh(new THREE.PlaneGeometry(.28, .16), wingMat); wing.position.set(side * .18, .08, 0); wing.rotation.z = side * .35; group.add(wing); }
  group.position.set(0, 1.55, -1.75); return group;
}
const flyOpponent = buildFlyOpponent(); scene.add(flyOpponent);
const flyAnchor = new THREE.Group();
flyAnchor.position.set(0, TABLE.HEIGHT + .18, -.965);
scene.add(flyAnchor);
const flyPaddle = new Paddle({ owner: 'fly', vertical: true, color: 0x6b62c7 });
flyPaddle.attachTo(flyAnchor);

const balls = Array.from({ length: BALL_POOL_SIZE }, () => new Ball()); balls.forEach((ball) => scene.add(ball.mesh));
const machine = new BallMachine(balls); scene.add(machine.mesh); const session = new TrainerSession(); const physics = new PhysicsWorld();
let training = false; let paused = false; let cvStop = null; let cvActive = false;
// Serving is gated behind a visible 3-2-1 countdown at the start of a run and
// after every dropped ball. While serveCountdown > 0 the ball machine holds.
let serveCountdown = 0;
const SERVE_COUNTDOWN_SECONDS = 3;
function beginServeCountdown(seconds = SERVE_COUNTDOWN_SECONDS) {
  serveCountdown = seconds;
  ui.showCountdown(Math.ceil(seconds));
}
const paddles = []; const controllerModelFactory = new XRControllerModelFactory();
for (const index of [0, 1]) { const grip = renderer.xr.getControllerGrip(index); grip.add(controllerModelFactory.createControllerModel(grip)); playerRig.add(grip); const paddle = new Paddle(); paddle.attachTo(grip); paddles.push(paddle); const controller = renderer.xr.getController(index); controller.addEventListener('selectstart', () => { machine.enabled = !machine.enabled; }); playerRig.add(controller); }
const cvRig = new THREE.Group();
cvRig.visible = true;
const cvHands = buildHands();
cvHands.scale.setScalar(.72);
cvRig.add(cvHands);
playerRig.add(cvRig);
const cvPaddle = new Paddle({ owner: 'player', vertical: true });
cvPaddle.attachTo(cvRig);
paddles.push(cvPaddle);
paddles.push(flyPaddle);

// Opponent paddle for online versus. Driven entirely by network messages
// (blade center/normal/velocity), so it skips the local input update path.
const remoteAnchor = new THREE.Group();
scene.add(remoteAnchor);
const remotePaddle = new Paddle({ owner: 'remote', vertical: true, color: 0x6b62c7 });
remotePaddle.attachTo(remoteAnchor);
remotePaddle.enabled = false;
remotePaddle.networked = true;
paddles.push(remotePaddle);

function setPointerPose(clientX, clientY) {
  if (cvActive || renderer.xr.isPresenting) return;
  const x = THREE.MathUtils.clamp(clientX / window.innerWidth, 0, 1);
  const y = THREE.MathUtils.clamp(clientY / window.innerHeight, 0, 1);
  // Update the rig directly from the pointer event: no tween, no render-frame
  // queue, so the paddle stays under the cursor even while the UI is open.
  cvRig.position.set((x - .5) * 1.25, .95 + (.5 - y) * .7, -.72);
  cvRig.rotation.set(0, 0, -(x - .5) * .6);
}
window.addEventListener('pointermove', (event) => setPointerPose(event.clientX, event.clientY), { passive: true });
window.addEventListener('pointerrawupdate', (event) => setPointerPose(event.clientX, event.clientY), { passive: true });
window.addEventListener('pointerdown', (event) => setPointerPose(event.clientX, event.clientY), { passive: true });

const ui = createTrainerUI({
  onStart(difficulty, drill, mode, landscape) { const profile = DIFFICULTIES[difficulty]; applyLandscape(landscape ?? 'classic'); session.reset(difficulty, drill); session.mode = mode ?? session.mode ?? 'casual'; session.landscape = landscape; session.start(); training = true; paused = false; document.body.classList.add('paddle-pointer-mode'); table.rotation.y = 0; flyPaddle.enabled = drill === 'fly'; updateTargetMarker(session.getCurrentTargetMove()); machine.interval = profile.interval; machine.speed = profile.speed; machine.enabled = true; machine._timer = .5; ui.setLives(session.mode === 'ranked' ? RANKED_LIVES : 0); beginServeCountdown(); ui.update(session.summary(), 'TRAINING'); },
  onLandscapeChange(name) { applyLandscape(name ?? 'classic'); },
  onDrillChange(nextDrill) { const difficulty = ui.getDifficulty(); const profile = DIFFICULTIES[difficulty]; balls.forEach((ball) => ball.deactivate()); session.reset(difficulty, nextDrill); if (training) { session.start(); machine.interval = profile.interval; machine.speed = profile.speed; machine.enabled = true; machine._timer = .5; beginServeCountdown(); } flyPaddle.enabled = training && nextDrill === 'fly'; updateTargetMarker(session.getCurrentTargetMove()); ui.setLives(training && session.mode === 'ranked' ? RANKED_LIVES : 0); ui.update(session.summary(), training ? 'TRAINING' : 'READY'); },
  onPause() { paused = !paused; machine.enabled = training && !paused; ui.feedback(paused ? 'Training paused.' : 'Rally live.', paused ? '' : 'success'); },
  onReset() { training = false; paused = false; serveCountdown = 0; ui.hideCountdown(); document.body.classList.remove('paddle-pointer-mode'); machine.enabled = false; flyPaddle.enabled = false; updateTargetMarker(null); balls.forEach((ball) => ball.deactivate()); session.reset(ui.getDifficulty(), ui.getDrill()); ui.setLives(0); ui.update(session.summary(), 'READY'); },
  onMachineToggle() { machine.enabled = !machine.enabled; return machine.enabled; },
  onEnableCV() { if (cvStop) { cvStop(); cvStop = null; cvActive = false; cvRig.visible = true; return; } cvActive = true; startHandTracking((pose) => { cvRig.visible = true; cvRig.position.set((pose.x - .5) * 1.25, .95 + (.5 - pose.y) * .7, -.72); cvRig.rotation.set(0, 0, -pose.angle); }, (message) => ui.feedback(message, 'success')).then((stop) => { cvStop = stop; }).catch((error) => { cvActive = false; ui.feedback(error.message, 'error'); }); },
  async onVersusCreate() { const code = makeRoomCode(); await enterVersus('host', code); return { code, link: roomLinkFor(code), kind: isRealtimeAvailable() ? 'supabase' : 'local' }; },
  onVersusLeave() { leaveVersus(); },
});

// ---------------------------------------------------------------------------
// Online versus (1v1). Host is authoritative for the ball + scoring; both sides
// control their own paddle locally and sync it as blade center/normal/velocity.
// ---------------------------------------------------------------------------
let netMode = null;        // null | 'host' | 'guest'
let room = null;           // active net room handle
const match = new VersusMatch();
let versusBall = null;     // current rally ball (host authoritative)
let versusServeTimer = 0;  // countdown before the next serve (host)
let netSendAccum = 0;      // throttle for outbound network state
let guestBallActive = false;
const NET_TICK = 1 / 30;
const _q = new THREE.Quaternion();
const _fwd = new THREE.Vector3(0, 0, 1);
const guestBallTarget = new THREE.Vector3();

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
  remotePaddle.bladeCenter.set(pkt.c[0], pkt.c[1], pkt.c[2]);
  remotePaddle.bladeNormal.set(pkt.n[0], pkt.n[1], pkt.n[2]).normalize();
  remotePaddle.velocity.set(pkt.v[0], pkt.v[1], pkt.v[2]);
  remotePaddle.mesh.position.copy(remotePaddle.bladeCenter);
  remotePaddle.mesh.quaternion.copy(_q.setFromUnitVectors(_fwd, remotePaddle.bladeNormal));
}

function serveVersusBall() {
  const ball = balls.find((b) => !b.active);
  if (!ball) return;
  const dir = match.server === 'host' ? -1 : 1; // host serves toward -Z, guest toward +Z
  ball.serve(
    new THREE.Vector3((Math.random() * 2 - 1) * 0.3, TABLE.HEIGHT + 0.35, -dir * 0.8),
    new THREE.Vector3((Math.random() * 2 - 1) * 0.6, 1.4, dir * 3.4),
  );
  versusBall = ball;
  broadcastHostState();
}

function broadcastHostState() {
  if (!room) return;
  const ball = versusBall && versusBall.active
    ? { active: true, p: [versusBall.mesh.position.x, versusBall.mesh.position.y, versusBall.mesh.position.z] }
    : { active: false };
  room.send('state', { match: match.snapshot(), ball, paddle: bladePacket(cvPaddle) });
}

function handleVersusHostBounce(ball, event) {
  if (event !== 'floor' || ball !== versusBall || ball.floorCounted) return;
  ball.floorCounted = true;
  // Landing on the host's half (z>0) means the guest scored, and vice versa.
  const scorer = ball.mesh.position.z > 0 ? 'guest' : 'host';
  ball.deactivate();
  versusBall = null;
  const winner = match.scorePoint(scorer);
  ui.updateVersusScore(match.snapshot(), 'host');
  broadcastHostState();
  if (winner) ui.showVersusWin(winner === 'host', match.snapshot());
  else { versusServeTimer = SERVE_COUNTDOWN_SECONDS; ui.showCountdown(SERVE_COUNTDOWN_SECONDS); }
}

function runVersusHost(dt) {
  if (match.winner) return;
  if (versusServeTimer > 0) {
    const prev = Math.ceil(versusServeTimer);
    versusServeTimer -= dt;
    if (versusServeTimer <= 0) { versusServeTimer = 0; ui.hideCountdown(); serveVersusBall(); }
    else if (Math.ceil(versusServeTimer) !== prev) ui.showCountdown(Math.ceil(versusServeTimer));
  }
  physics.step(dt, balls, paddles);
  netSendAccum += dt;
  if (netSendAccum >= NET_TICK) { netSendAccum = 0; broadcastHostState(); }
}

function applyHostState(state) {
  if (!state) return;
  match.apply(state.match);
  ui.updateVersusScore(match.snapshot(), 'guest');
  applyRemotePaddle(state.paddle);
  if (state.ball?.active) {
    guestBallActive = true;
    guestBallTarget.set(state.ball.p[0], state.ball.p[1], state.ball.p[2]);
    if (!versusBall) { versusBall = balls[0]; }
    versusBall.active = true; versusBall.mesh.visible = true;
  } else {
    guestBallActive = false;
    if (versusBall) { versusBall.deactivate(); versusBall = null; }
  }
  if (match.winner) ui.showVersusWin(match.winner === 'guest', match.snapshot());
}

function runVersusGuest(dt) {
  netSendAccum += dt;
  if (netSendAccum >= NET_TICK) { netSendAccum = 0; room?.send('paddle', bladePacket(cvPaddle)); }
  if (guestBallActive && versusBall) versusBall.mesh.position.lerp(guestBallTarget, Math.min(1, dt * 16));
}

async function enterVersus(role, code) {
  training = false; paused = false; serveCountdown = 0; ui.hideCountdown();
  machine.enabled = false; flyPaddle.enabled = false; updateTargetMarker(null);
  balls.forEach((b) => b.deactivate()); versusBall = null; guestBallActive = false; ui.setLives(0);
  document.body.classList.add('paddle-pointer-mode');
  match.reset();
  netMode = role;
  remotePaddle.enabled = true;
  // The guest plays from the far end; the 180° turn also mirrors the pointer
  // mapping so left/right feel natural without extra transforms.
  if (role === 'guest') { playerRig.position.set(0, 0, -PLAY_AREA.PLAYER_Z); playerRig.rotation.y = Math.PI; }
  else { playerRig.position.set(0, 0, PLAY_AREA.PLAYER_Z); playerRig.rotation.y = 0; }
  room = createRoom({ code, role });
  if (role === 'host') room.on('paddle', (pkt) => applyRemotePaddle(pkt));
  else room.on('state', (state) => applyHostState(state));
  room.onOpponent((present) => {
    ui.setVersusOpponent(present);
    if (present && role === 'host' && !match.winner && !versusBall && versusServeTimer <= 0) {
      versusServeTimer = SERVE_COUNTDOWN_SECONDS;
      ui.showCountdown(SERVE_COUNTDOWN_SECONDS);
    }
  });
  await room.connect();
}

function leaveVersus() {
  if (room) { room.close(); room = null; }
  netMode = null;
  remotePaddle.enabled = false;
  versusBall = null; guestBallActive = false; versusServeTimer = 0;
  balls.forEach((b) => b.deactivate());
  ui.hideCountdown();
  playerRig.position.set(0, 0, PLAY_AREA.PLAYER_Z); playerRig.rotation.y = 0;
  clearRoomFromUrl();
}

machine.onServe = () => { session.serve(); ui.update(session.summary(), 'SERVE'); };
physics.onBounce = (ball, event, details = {}) => {
  if (netMode === 'host') { handleVersusHostBounce(ball, event); return; }
  if (netMode === 'guest') return; // guest renders host-authoritative state only
  if (!training || paused) return;
  // A ball settling on the floor fires many bounce events; only the first
  // counts as a drop. Ignore the rest until the ball is re-served.
  if (event === 'floor' && ball.floorCounted) return;
  const result = session.record(event, { ...details, position: ball.mesh.position.clone() });
  if (event === 'paddle') ui.feedback(details.owner === 'fly' ? 'Fly return — move early.' : session.drill === 'fly' ? 'Nice placement — make the fly move.' : 'Nice return', 'success');
  if (event === 'table' && result.targetHit) {
    ui.feedback(`${result.move.shortLabel}: clean target · ${result.moveSuccesses}/5`, 'success');
  }
  if (event === 'table' && result.targetMiss) {
    ui.feedback(`Missed ${result.move.shortLabel} — ${result.moveSuccesses}/5. ${result.move.cue}`, 'error');
  }
  if (event === 'table' && result.moveAdvanced) {
    updateTargetMarker(result.nextMove);
    if (result.drillComplete) {
      training = false;
      machine.enabled = false;
      flyPaddle.enabled = false;
      updateTargetMarker(null);
      ui.feedback('Full target sequence complete!', 'success');
      ui.showSummary(session.finish());
      return;
    }
    ui.feedback(`Move complete — ${result.nextMove.shortLabel} is next.`, 'success');
  }
  if (event === 'table') ui.update(session.summary(), 'RALLY');
  if (event === 'net') ui.feedback('Net error — close the racket angle.', 'error');
  if (event === 'floor') {
    ball.floorCounted = true;
    const flyMiss = session.drill === 'fly' && ball.mesh.position.z < 0;
    const rankedRunOver = session.mode === 'ranked' && result.playerMiss && session.misses >= RANKED_LIVES;
    // The dropped ball vanishes right away so it can't rebound or double-count.
    ball.deactivate();
    if (rankedRunOver) {
      training = false;
      paused = false;
      serveCountdown = 0;
      ui.hideCountdown();
      machine.enabled = false;
      flyPaddle.enabled = false;
      updateTargetMarker(null);
      ui.loseLife();
      ui.feedback('Final ball down — ranked run over.', 'error');
      ui.showSummary(session.finish());
      return;
    }
    if (result.playerMiss) {
      if (session.mode === 'ranked') {
        ui.loseLife();
        const livesLeft = Math.max(0, RANKED_LIVES - session.misses);
        ui.feedback(`Ball down — ${livesLeft} ${livesLeft === 1 ? 'ball' : 'balls'} left.`, 'error');
      } else {
        ui.feedback('Rally ended — reset your feet.', 'error');
      }
      // Clear any other balls in play and count down to the next serve.
      balls.forEach((other) => { if (other !== ball) other.deactivate(); });
      beginServeCountdown();
    } else if (flyMiss) {
      ui.feedback('The fly missed — keep the pressure on.', 'success');
    }
  }
  ui.update(session.summary(), 'TRAINING');
};

const orbit = new OrbitControls(camera, renderer.domElement);
// Desktop mouse input belongs to the paddle, not the camera. Keeping the
// camera fixed removes the competing drag/damping path that made the paddle
// feel delayed. XR still owns the camera during immersive sessions.
orbit.enabled = false;
orbit.enableDamping = false;
orbit.target.set(0, TABLE.HEIGHT, 0);
orbit.update();
renderer.xr.addEventListener('sessionstart', () => { orbit.enabled = false; cvRig.visible = false; });
renderer.xr.addEventListener('sessionend', () => { orbit.enabled = false; cvRig.visible = true; });
const clock = new THREE.Clock();
function updateFlyAI() {
  const incoming = balls.find((ball) => ball.active && ball.velocity.z < 0 && ball.mesh.position.z < -.15);
  if (!incoming) {
    flyAnchor.position.x += (Math.sin(clock.elapsedTime * .9) * .25 - flyAnchor.position.x) * .08;
    return;
  }
  const targetZ = flyAnchor.position.z - .185;
  const travel = Math.max(.08, (targetZ - incoming.mesh.position.z) / incoming.velocity.z);
  const predictedX = THREE.MathUtils.clamp(incoming.mesh.position.x + incoming.velocity.x * travel, -TABLE.WIDTH / 2 + .08, TABLE.WIDTH / 2 - .08);
  const predictedY = THREE.MathUtils.clamp(incoming.mesh.position.y + incoming.velocity.y * travel, TABLE.HEIGHT + .08, TABLE.HEIGHT + .38);
  flyAnchor.position.x += (predictedX - flyAnchor.position.x) * .18;
  flyAnchor.position.y += (predictedY - flyAnchor.position.y) * .18;
}
renderer.setAnimationLoop(() => { const dt = clock.getDelta(); if (ui.isModeSelecting?.()) table.rotation.y += dt * .22; else if (!renderer.xr.isPresenting) table.rotation.y = THREE.MathUtils.damp(table.rotation.y, 0, 8, dt); if (!paused) { paddles.forEach((paddle) => { if (!paddle.networked) paddle.update(dt); }); if (netMode === 'host') { runVersusHost(dt); } else if (netMode === 'guest') { runVersusGuest(dt); } else { if (training) { if (serveCountdown > 0) { const prev = Math.ceil(serveCountdown); serveCountdown -= dt; if (serveCountdown <= 0) { serveCountdown = 0; ui.hideCountdown(); machine._timer = Math.min(machine._timer, .15); } else if (Math.ceil(serveCountdown) !== prev) { ui.showCountdown(Math.ceil(serveCountdown)); } } else { machine.update(dt); } } updateFlyAI(); physics.step(dt, balls, paddles); session.update(); if (training) ui.update(session.summary(), 'TRAINING'); } } balls.forEach((ball) => { if (ball.active && ball.mesh.position.length() > 12) ball.deactivate(); }); const t = clock.elapsedTime; flyOpponent.position.x = flyAnchor.position.x; flyOpponent.position.y = 1.55 + Math.sin(t * 2.1) * .05; renderer.render(scene, camera); });
window.addEventListener('resize', () => { camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix(); renderer.setSize(window.innerWidth, window.innerHeight); });

// If the page was opened from a shared game link, join it as the guest.
const autoJoinCode = roomFromUrl();
if (autoJoinCode) {
  ui.openVersus('guest', { code: autoJoinCode, link: roomLinkFor(autoJoinCode), kind: isRealtimeAvailable() ? 'supabase' : 'local' });
  enterVersus('guest', autoJoinCode).catch((error) => ui.feedback(error.message, 'error'));
} else if (currentPath === '/training') {
  ui.openTraining(new URLSearchParams(window.location.search).get('drill'));
} else if (currentPath === '/live-game') {
  ui.startLiveGame();
} else if (currentPath === '/tournament') {
  ui.openTournament();
}
