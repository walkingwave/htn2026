import * as THREE from 'three';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import './styles.css';
import { createTable } from './table.js';
import { createXRButtons } from './xrButtons.js';
import { Paddle } from './paddle.js';
import { Ball } from './ball.js';
import { PhysicsWorld } from './physics.js';
import { BallMachine } from './ballMachine.js';
import { PLAY_AREA, TABLE } from './constants.js';
import { DIFFICULTIES, TrainerSession } from './session.js';
import { createTrainerUI } from './ui.js';
import { startHandTracking } from './handTracking.js';

const BALL_POOL_SIZE = 8;
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setSize(window.innerWidth, window.innerHeight); renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.xr.enabled = true; renderer.xr.setReferenceSpaceType('local-floor'); document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene(); const VR_BACKGROUND = new THREE.Color(0x101018); scene.background = VR_BACKGROUND;
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 50);
const playerRig = new THREE.Group(); playerRig.position.set(0, 0, PLAY_AREA.PLAYER_Z); playerRig.add(camera); scene.add(playerRig); camera.position.set(0, 1.6, 0);
scene.add(new THREE.HemisphereLight(0xbbccff, 0x334422, 0.9)); const keyLight = new THREE.DirectionalLight(0xfff1d0, 1.5); keyLight.position.set(3, 6, 2); scene.add(keyLight);
const table = createTable(); scene.add(table); const vrEnvironment = table.getObjectByName('vr-environment');
function applyMode(mode) { const isAR = mode === 'immersive-ar'; scene.background = isAR ? null : VR_BACKGROUND; if (vrEnvironment) vrEnvironment.visible = !isAR; }
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
  const group = new THREE.Group(); const skin = new THREE.MeshStandardMaterial({ color: 0xe0a078, roughness: .8 }); const sleeve = new THREE.MeshStandardMaterial({ color: 0xef5b45, roughness: .7 });
  for (const side of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(.055, .075, .36, 12), sleeve); arm.rotation.z = side * .45; arm.position.set(side * .24, -.08, .01); group.add(arm);
    const hand = new THREE.Mesh(new THREE.SphereGeometry(.09, 16, 12), skin); hand.position.set(side * .18, .1, -.02); group.add(hand);
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
const flyPaddle = new THREE.Mesh(new THREE.CapsuleGeometry(.07, .23, 6, 12), new THREE.MeshStandardMaterial({ color: 0x6b62c7, roughness: .5 })); flyPaddle.position.set(0, 1.0, -.98); flyPaddle.rotation.z = .2; scene.add(flyPaddle);

const balls = Array.from({ length: BALL_POOL_SIZE }, () => new Ball()); balls.forEach((ball) => scene.add(ball.mesh));
const machine = new BallMachine(balls); scene.add(machine.mesh); const session = new TrainerSession(); const physics = new PhysicsWorld();
let training = false; let paused = false; let cvStop = null; let cvActive = false;
const paddles = []; const controllerModelFactory = new XRControllerModelFactory();
for (const index of [0, 1]) { const grip = renderer.xr.getControllerGrip(index); grip.add(controllerModelFactory.createControllerModel(grip)); playerRig.add(grip); const paddle = new Paddle(); paddle.attachTo(grip); paddles.push(paddle); const controller = renderer.xr.getController(index); controller.addEventListener('selectstart', () => { machine.enabled = !machine.enabled; }); playerRig.add(controller); }
const cvRig = new THREE.Group(); cvRig.visible = true; cvRig.add(buildHands()); playerRig.add(cvRig); const cvPaddle = new Paddle(); cvPaddle.attachTo(cvRig); paddles.push(cvPaddle);

function setPointerPose(clientX, clientY) { if (cvActive || renderer.xr.isPresenting) return; const x = clientX / window.innerWidth; const y = clientY / window.innerHeight; cvRig.position.set((x - .5) * 1.4, 1.65 + (.5 - y) * 1.1, .35); cvRig.rotation.set(0, 0, -(x - .5) * .6); }
renderer.domElement.addEventListener('pointermove', (event) => setPointerPose(event.clientX, event.clientY));
renderer.domElement.addEventListener('pointerdown', (event) => setPointerPose(event.clientX, event.clientY));

const ui = createTrainerUI({
  onStart(difficulty, drill) { const profile = DIFFICULTIES[difficulty]; session.reset(difficulty, drill); session.start(); training = true; paused = false; updateTargetMarker(session.getCurrentTargetMove()); machine.interval = profile.interval; machine.speed = profile.speed; machine.enabled = true; machine._timer = .5; ui.update(session.summary(), 'TRAINING'); },
  onPause() { paused = !paused; machine.enabled = training && !paused; ui.feedback(paused ? 'Training paused.' : 'Rally live.', paused ? '' : 'success'); },
  onReset() { training = false; paused = false; machine.enabled = false; updateTargetMarker(null); balls.forEach((ball) => ball.deactivate()); session.reset(ui.getDifficulty(), ui.getDrill()); ui.update(session.summary(), 'READY'); },
  onMachineToggle() { machine.enabled = !machine.enabled; return machine.enabled; },
  onEnableCV() { if (cvStop) { cvStop(); cvStop = null; cvActive = false; cvRig.visible = true; return; } cvActive = true; startHandTracking((pose) => { cvRig.visible = true; cvRig.position.set((pose.x - .5) * 1.4, 1.65 + (.5 - pose.y) * 1.1, .35); cvRig.rotation.set(0, 0, -pose.angle); }, (message) => ui.feedback(message, 'success')).then((stop) => { cvStop = stop; }).catch((error) => { cvActive = false; ui.feedback(error.message, 'error'); }); },
});

machine.onServe = () => { session.serve(); ui.update(session.summary(), 'SERVE'); };
physics.onBounce = (ball, event) => {
  if (!training || paused) return;
  const result = session.record(event, { position: ball.mesh.position });
  if (event === 'paddle') ui.feedback(session.drill === 'fly' ? 'Fly read — early preparation.' : 'Nice return', 'success');
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
      updateTargetMarker(null);
      ui.feedback('Full target sequence complete!', 'success');
      ui.showSummary(session.finish());
      return;
    }
    ui.feedback(`Move complete — ${result.nextMove.shortLabel} is next.`, 'success');
  }
  if (event === 'table') ui.update(session.summary(), 'RALLY');
  if (event === 'net') ui.feedback('Net error — close the racket angle.', 'error');
  if (event === 'floor') { ui.feedback('Rally ended — reset your feet.', 'error'); setTimeout(() => ball.deactivate(), 700); if (session.misses >= 5) { training = false; machine.enabled = false; updateTargetMarker(null); ui.showSummary(session.finish()); } }
  ui.update(session.summary(), 'TRAINING');
};

const orbit = new OrbitControls(camera, renderer.domElement); orbit.target.set(0, TABLE.HEIGHT, 0); orbit.update();
renderer.xr.addEventListener('sessionstart', () => { orbit.enabled = false; cvRig.visible = false; }); renderer.xr.addEventListener('sessionend', () => { orbit.enabled = true; cvRig.visible = true; });
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => { const dt = clock.getDelta(); if (!paused) { paddles.forEach((paddle) => paddle.update(dt)); if (training) machine.update(dt); physics.step(dt, balls, paddles); session.update(); if (training) ui.update(session.summary(), 'TRAINING'); } balls.forEach((ball) => { if (ball.active && ball.mesh.position.length() > 12) ball.deactivate(); }); const t = clock.elapsedTime; flyOpponent.position.x = Math.sin(t * 1.2) * .28; flyOpponent.position.y = 1.55 + Math.sin(t * 2.1) * .05; flyPaddle.position.x = Math.sin(t * .9) * .35; flyPaddle.position.y = 1.0 + Math.sin(t * 1.8) * .18; renderer.render(scene, camera); });
window.addEventListener('resize', () => { camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix(); renderer.setSize(window.innerWidth, window.innerHeight); });
