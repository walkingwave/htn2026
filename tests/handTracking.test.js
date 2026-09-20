import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { startHandTracking } from '../src/handTracking.js';
import { HandPaddlePose } from '../src/vision/handPose.js';
import { Paddle } from '../src/paddle.js';

const close = (actual, expected, tolerance = 1e-7) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function handFrame({ x = 0.5, y = 0.5, scale = 2, pitch = 0, handedness = 'Right', timestamp = 1000 } = {}) {
  const aspect = 4 / 3;
  const worldLandmarks = Array.from({ length: 21 }, () => new THREE.Vector3());
  worldLandmarks[0].set(0, 0.04, 0);
  worldLandmarks[5].set(-0.025, -0.01, 0);
  worldLandmarks[9].set(0, -0.025, 0);
  worldLandmarks[13].set(0.013, -0.012, 0);
  worldLandmarks[17].set(0.029, 0.002, 0);
  for (const point of worldLandmarks) {
    if (handedness === 'Left') point.x *= -1;
    point.applyAxisAngle(new THREE.Vector3(1, 0, 0), pitch);
  }
  const centre = [0, 5, 9, 13, 17].reduce((sum, i) => sum.add(worldLandmarks[i]), new THREE.Vector3()).divideScalar(5);
  const landmarks = worldLandmarks.map((point) => ({
    x: x + (point.x - centre.x) * scale,
    y: y + (point.y - centre.y) * scale * aspect,
    z: point.z * scale,
  }));
  return { landmarks, worldLandmarks, aspect, handedness, timestamp };
}

test('either hand centres above the table, mirrors lateral movement, and follows upward movement', () => {
  for (const handedness of ['Right', 'Left']) {
    const pose = new HandPaddlePose();
    pose.update(handFrame({ handedness }));
    close(pose.position.x, 0);
    close(pose.position.y, 1.08);
    close(pose.position.z, -0.72);
    close(pose.quaternion.angleTo(new THREE.Quaternion()), 0);
    pose.update(handFrame({ handedness, x: 0.3, y: 0.3, timestamp: 1100 }));
    assert.ok(pose.position.x > 0.2);
    assert.ok(pose.position.y > 1.25);
  }
});

test('palm tilt changes the blade angle without pretending the hand moved in depth', () => {
  const pose = new HandPaddlePose();
  pose.update(handFrame());
  for (let i = 1; i <= 15; i++) pose.update(handFrame({ pitch: 0.6, timestamp: 1000 + i * 1000 / 30 }));
  close(pose.position.z, -0.72);
  const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(pose.quaternion);
  assert.ok(normal.y > 0.5);
  assert.ok(normal.z > 0.8 && normal.z < 0.9);
  pose.update(handFrame({ pitch: 0.6, scale: 2.5, timestamp: 1600 }));
  assert.ok(pose.position.z < -0.8, 'moving toward the webcam should extend the paddle toward the net');
});

test('finger movement does not wobble the paddle, and recenter/loss preserve sensible poses', () => {
  const pose = new HandPaddlePose();
  pose.update(handFrame());
  const frame = handFrame({ timestamp: 1033 });
  frame.landmarks[8] = { x: 0.01, y: 0.99, z: -0.5 };
  pose.update(frame);
  close(pose.position.x, 0);
  close(pose.position.y, 1.08);
  close(pose.quaternion.angleTo(new THREE.Quaternion()), 0);
  pose.update(handFrame({ x: 0.25, y: 0.3, scale: 3, timestamp: 1100 }));
  assert.equal(pose.recenter(), true);
  pose.update(handFrame({ x: 0.25, y: 0.3, scale: 3, timestamp: 1133 }));
  close(pose.position.length(), new THREE.Vector3(0, 1.08, -0.72).length());
  pose.markLost();
  assert.equal(pose.recenter(), false);
  assert.equal(pose.update(handFrame({ timestamp: 1500 })).reacquired, true);
  const invalid = handFrame({ timestamp: 1533 });
  invalid.worldLandmarks[9].x = NaN;
  assert.equal(pose.update(invalid), false);
  assert.equal(pose.tracking, false);
});

function cameraEnvironment(t) {
  const cameraRequest = deferred();
  const callbacks = new Map();
  let nextFrame = 0;
  let stopped = 0;
  let closed = 0;
  let detections = 0;
  let result = {};
  const track = { stop() { stopped++; }, addEventListener() {} };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const video = {
    style: {}, readyState: 2, currentTime: 0, videoWidth: 640, videoHeight: 480,
    setAttribute() {}, async play() {}, pause() {}, remove() {}, srcObject: null,
  };
  const canvas = { getContext: () => ({ fillRect() {} }) };
  const model = {
    detectForVideo() { detections++; return result; },
    close() { closed++; },
  };
  const globals = {
    navigator: { mediaDevices: { getUserMedia: () => cameraRequest.promise } },
    document: { createElement: (tag) => tag === 'video' ? video : canvas, body: { appendChild() {} } },
    requestAnimationFrame: (callback) => { callbacks.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame: (id) => callbacks.delete(id),
  };
  for (const [key, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, key, original);
      else delete globalThis[key];
    });
  }
  return {
    video, model, stream, cameraRequest, callbacks,
    get stopped() { return stopped; }, get closed() { return closed; }, get detections() { return detections; },
    setResult(value) { result = value; },
    tick(time) {
      const [id, callback] = callbacks.entries().next().value;
      callbacks.delete(id);
      callback(time);
    },
  };
}

test('exiting during camera permission releases a late stream without loading the model', async (t) => {
  const camera = cameraEnvironment(t);
  const controller = new AbortController();
  let loads = 0;
  const start = startHandTracking(() => {}, () => {}, {
    signal: controller.signal, createLandmarker: async () => { loads++; return camera.model; },
  });
  controller.abort();
  camera.cameraRequest.resolve(camera.stream);
  await start;
  assert.equal(camera.stopped, 1);
  assert.equal(loads, 0);
  assert.equal(camera.callbacks.size, 0);
});

test('exiting during model loading closes the camera immediately and disposes a late model', async (t) => {
  const camera = cameraEnvironment(t);
  const loading = deferred();
  const modelStarted = deferred();
  const controller = new AbortController();
  const start = startHandTracking(() => {}, () => {}, {
    signal: controller.signal,
    createLandmarker: () => { modelStarted.resolve(); return loading.promise; },
  });
  camera.cameraRequest.resolve(camera.stream);
  await modelStarted.promise;
  controller.abort();
  assert.equal(camera.stopped, 1);
  assert.equal(camera.video.srcObject, null);
  loading.resolve(camera.model);
  await start;
  assert.equal(camera.closed, 1);
  assert.equal(camera.callbacks.size, 0);
});

test('startup and inference failures release camera resources', async (t) => {
  const camera = cameraEnvironment(t);
  const startup = startHandTracking(() => {}, () => {}, { createLandmarker: async () => { throw new Error('Model unavailable'); } });
  camera.cameraRequest.resolve(camera.stream);
  await assert.rejects(startup, /Model unavailable/);
  assert.equal(camera.stopped, 1);
  let error;
  camera.model.detectForVideo = () => { throw new Error('Inference failed'); };
  await startHandTracking(() => {}, () => {}, { createLandmarker: async () => camera.model, onError: (value) => { error = value; } });
  camera.tick(1000);
  assert.match(error.message, /Inference failed/);
  assert.equal(camera.stopped, 2);
  assert.equal(camera.closed, 1);
  assert.equal(camera.callbacks.size, 0);
});

test('only fresh video frames trigger inference and missing/stalled hands stop tracking', async (t) => {
  const camera = cameraEnvironment(t);
  const poses = [];
  const sample = handFrame();
  camera.setResult({ landmarks: [sample.landmarks], worldLandmarks: [sample.worldLandmarks] });
  const start = startHandTracking((pose) => poses.push(pose), () => {}, { createLandmarker: async () => camera.model });
  camera.cameraRequest.resolve(camera.stream);
  const stop = await start;
  t.after(stop);
  camera.tick(1000);
  camera.tick(1017);
  camera.tick(1034);
  assert.equal(camera.detections, 1);
  camera.video.currentTime = 1 / 30;
  camera.setResult({});
  camera.tick(1067);
  assert.equal(poses.at(-1), null);
  camera.video.currentTime = 2 / 30;
  camera.setResult({ landmarks: [sample.landmarks], worldLandmarks: [sample.worldLandmarks] });
  camera.tick(1100);
  camera.tick(1400);
  assert.equal(poses.at(-1), null);
  stop();
  assert.equal(camera.closed, 1);
  assert.equal(camera.callbacks.size, 0);
});

test('hand mode aligns the collision face and uses camera timestamps for swing velocity', (t) => {
  cameraEnvironment(t);
  const rig = new THREE.Group();
  const paddle = new Paddle({ vertical: true });
  paddle.attachTo(rig);
  const original = paddle.mesh.getObjectByName('blade').position.clone();
  paddle.setPalmTrackingMode(true);
  paddle.updateFromCamera(1000);
  rig.position.set(0.1, 1.1, -0.7);
  rig.rotation.x = 0.2;
  paddle.resetTracking();
  paddle.updateFromCamera(1033);
  assert.ok(paddle.bladeCenter.equals(rig.position));
  assert.ok(paddle.bladeNormal.distanceTo(new THREE.Vector3(0, 0, 1).applyQuaternion(rig.quaternion)) < 1e-9);
  rig.position.x += 0.1;
  paddle.updateFromCamera(1033 + 1000 / 30);
  close(paddle.velocity.x, 3);
  paddle.updateFromCamera(1033 + 1000 / 30);
  close(paddle.velocity.x, 3);
  paddle.resetTracking();
  rig.position.x += 1;
  paddle.updateFromCamera(1200);
  assert.equal(paddle.velocity.length(), 0);
  assert.equal(paddle.tracking, false);
  paddle.setPalmTrackingMode(false);
  assert.ok(paddle.mesh.getObjectByName('blade').position.equals(original));
});
