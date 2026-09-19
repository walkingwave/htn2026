import * as THREE from 'three';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { createTable } from './table.js';
import { createXRButtons } from './xrButtons.js';
import { Paddle } from './paddle.js';
import { Ball } from './ball.js';
import { PhysicsWorld } from './physics.js';
import { BallMachine } from './ballMachine.js';
import { PLAY_AREA, TABLE } from './constants.js';

const BALL_POOL_SIZE = 8;

// --- Renderer / scene ---
// alpha:true so the framebuffer is transparent in AR — the Quest compositor
// shows camera passthrough wherever nothing is drawn.
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const VR_BACKGROUND = new THREE.Color(0x101018);
scene.background = VR_BACKGROUND;

const camera = new THREE.PerspectiveCamera(
  70,
  window.innerWidth / window.innerHeight,
  0.01,
  50
);

// Player rig: move this group to reposition the player in the world.
// In XR the camera is controlled by the headset relative to this rig.
const playerRig = new THREE.Group();
playerRig.position.set(0, 0, PLAY_AREA.PLAYER_Z);
playerRig.add(camera);
scene.add(playerRig);

// Desktop fallback camera position (headset overrides this in XR)
camera.position.set(0, 1.6, 0);

// --- Lighting ---
scene.add(new THREE.HemisphereLight(0xbbccff, 0x334422, 0.9));
const keyLight = new THREE.DirectionalLight(0xffffff, 1.4);
keyLight.position.set(3, 6, 2);
scene.add(keyLight);

// --- World ---
const table = createTable();
scene.add(table);
const vrEnvironment = table.getObjectByName('vr-environment');

// AR: transparent background + real floor via passthrough. VR: dark room.
function applyMode(mode) {
  const isAR = mode === 'immersive-ar';
  scene.background = isAR ? null : VR_BACKGROUND;
  if (vrEnvironment) vrEnvironment.visible = !isAR;
}

createXRButtons(renderer, { onModeChange: applyMode });
renderer.xr.addEventListener('sessionend', () => applyMode(null));

const balls = Array.from({ length: BALL_POOL_SIZE }, () => new Ball());
for (const b of balls) scene.add(b.mesh);

const machine = new BallMachine(balls);
scene.add(machine.mesh);

const physics = new PhysicsWorld();
physics.onBounce = (ball, event) => {
  // Hook for scoring / sound / haptics. For now: floor = ball is dead.
  if (event === 'floor') {
    setTimeout(() => ball.deactivate(), 1500);
  }
};

// --- Controllers + paddles ---
const controllerModelFactory = new XRControllerModelFactory();
const paddles = [];

for (const i of [0, 1]) {
  const grip = renderer.xr.getControllerGrip(i);
  grip.add(controllerModelFactory.createControllerModel(grip));
  playerRig.add(grip);

  const paddle = new Paddle();
  paddle.attachTo(grip);
  paddles.push(paddle);

  // Trigger squeeze pauses/resumes the ball machine (simple debug control)
  const controller = renderer.xr.getController(i);
  controller.addEventListener('selectstart', () => {
    machine.enabled = !machine.enabled;
  });
  playerRig.add(controller);
}

// --- Desktop fallback: orbit controls for dev without a headset ---
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.target.set(0, TABLE.HEIGHT, 0);
orbit.update();
renderer.xr.addEventListener('sessionstart', () => (orbit.enabled = false));
renderer.xr.addEventListener('sessionend', () => (orbit.enabled = true));

// --- Main loop ---
const clock = new THREE.Clock();

renderer.setAnimationLoop(() => {
  const dt = clock.getDelta();

  for (const paddle of paddles) paddle.update(dt);
  machine.update(dt);
  physics.step(dt, balls, paddles);

  // Deactivate balls that flew far away
  for (const ball of balls) {
    if (ball.active && ball.mesh.position.length() > 12) ball.deactivate();
  }

  renderer.render(scene, camera);
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
