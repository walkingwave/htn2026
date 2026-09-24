import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { PADDLE_SOURCE, PaddleSourceRouter } from '../src/paddleSource.js';

// The router only ever asks its parents to `add` the paddle mesh and reads
// `mesh.parent` back, so a real Object3D is the cheapest faithful stand-in —
// and it keeps the re-parenting assertions honest.
function makeRig({ handTracked = true } = {}) {
  const controllerGrip = new THREE.Group();
  const handRig = {
    group: new THREE.Group(),
    update: () => handTracked,
  };
  const externalRoot = new THREE.Group();
  const paddle = { mesh: new THREE.Group() };
  const router = new PaddleSourceRouter({ paddle, controllerGrip, handRig, externalRoot });
  return { router, paddle, controllerGrip, handRig, externalRoot };
}

test('the paddle starts on the controller', () => {
  const { router, paddle, controllerGrip } = makeRig();
  assert.equal(paddle.mesh.parent, controllerGrip);
  assert.equal(router.mode, PADDLE_SOURCE.CONTROLLER);
  assert.equal(router.update(0.016), PADDLE_SOURCE.CONTROLLER);
  assert.equal(router.healthy, true);
});

test('selecting hand tracking moves the blade onto the hand rig', () => {
  const { router, paddle, handRig } = makeRig();
  router.setMode(PADDLE_SOURCE.HAND);
  router.update(0.016);

  assert.equal(paddle.mesh.parent, handRig.group);
  assert.equal(router.activeSource, PADDLE_SOURCE.HAND);
  assert.equal(router.healthy, true);
});

test('hand tracking that blinks out hands the bat back to the controller', () => {
  const rig = makeRig();
  rig.router.setMode(PADDLE_SOURCE.HAND);
  rig.router.update(0.016);
  assert.equal(rig.paddle.mesh.parent, rig.handRig.group);

  // The hand left the headset's view.
  rig.handRig.update = () => false;
  rig.router.update(0.016);

  assert.equal(rig.paddle.mesh.parent, rig.controllerGrip);
  assert.equal(rig.router.activeSource, PADDLE_SOURCE.CONTROLLER);
  assert.equal(rig.router.healthy, false, 'the UI has to be able to report this');
});

test('a fresh external pose drives the blade, and a stale one falls back', () => {
  const { router, paddle, externalRoot, controllerGrip } = makeRig();
  router.setMode(PADDLE_SOURCE.EXTERNAL);
  router.setExternalPose(
    new THREE.Vector3(1, 2, 3),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 1, 0))
  );

  router.update(0.016);
  assert.equal(paddle.mesh.parent, externalRoot);
  assert.deepEqual(externalRoot.position.toArray(), [1, 2, 3]);
  assert.equal(router.healthy, true);

  // The feed goes quiet. Half a second later the bat is back on the
  // controller rather than frozen mid-air at its last known pose.
  router.update(0.3);
  assert.equal(router.healthy, true, 'still inside the window');
  router.update(0.2);
  assert.equal(paddle.mesh.parent, controllerGrip);
  assert.equal(router.healthy, false);
});

test('a new pose inside the window revives the external feed', () => {
  const { router } = makeRig();
  router.setMode(PADDLE_SOURCE.EXTERNAL);
  router.setExternalPose(new THREE.Vector3(), null);
  router.update(0.5);
  assert.equal(router.activeSource, PADDLE_SOURCE.CONTROLLER);

  router.setExternalPose(new THREE.Vector3(0, 1, 0), null);
  router.update(0.016);
  assert.equal(router.activeSource, PADDLE_SOURCE.EXTERNAL);
});

test('an external pose with no rotation keeps the current facing', () => {
  const { router, externalRoot } = makeRig();
  const facing = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0.7, 0));
  externalRoot.quaternion.copy(facing);

  router.setExternalPose(new THREE.Vector3(0, 0, 1), null);
  assert.equal(externalRoot.quaternion.angleTo(facing), 0);
});

test('phone and camera both resolve to the controller parent', () => {
  for (const mode of [PADDLE_SOURCE.PHONE, PADDLE_SOURCE.CAMERA]) {
    const { router, paddle, controllerGrip } = makeRig();
    router.setMode(mode);
    assert.equal(router.update(0.016), mode);
    // The router treats these as the tracked grip; main.js drives the rig.
    assert.equal(paddle.mesh.parent, controllerGrip);
  }
});

test('switching back and forth re-parents without stacking children', () => {
  const { router, paddle, controllerGrip, handRig, externalRoot } = makeRig();

  for (const mode of [PADDLE_SOURCE.HAND, PADDLE_SOURCE.EXTERNAL, PADDLE_SOURCE.CONTROLLER]) {
    router.setMode(mode);
    if (mode === PADDLE_SOURCE.EXTERNAL) {
      router.setExternalPose(new THREE.Vector3(), null);
    }
    router.update(0.016);
    // Object3D.add removes from the previous parent, but a router that
    // re-added without detaching would leave the mesh listed twice.
    assert.equal(paddle.mesh.parent.children.filter((c) => c === paddle.mesh).length, 1);
  }

  assert.equal(paddle.mesh.parent, controllerGrip);
  assert.equal(handRig.group.children.includes(paddle.mesh), false);
  assert.equal(externalRoot.children.includes(paddle.mesh), false);
});

test('a mode with no rig behind it still lands somewhere real', () => {
  const rig = makeRig();
  rig.router.setMode(PADDLE_SOURCE.EXTERNAL);
  // No external feed has ever arrived, so the very first update is already
  // past the freshness window.
  assert.equal(rig.router.update(1), PADDLE_SOURCE.CONTROLLER);
  assert.equal(rig.paddle.mesh.parent, rig.controllerGrip);
});
