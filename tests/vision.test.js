import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {
  PredictivePositionFilter,
  PredictiveRotationFilter,
} from '../src/vision/markerPaddleTracker.js';
import {
  decodeMessage,
  encodeMessage,
  isClientMessage,
} from '../src/multiplayerProtocol.js';

test('position predictor leads a moving paddle without exceeding its safety bound', () => {
  const filter = new PredictivePositionFilter({ maxSpeed: 2, maxAcceleration: 10 });
  filter.filter(new THREE.Vector3(0, 0, 0), 0, 0.08);
  const first = filter.filter(new THREE.Vector3(0.05, 0, 0), 33, 0.08, 1);
  const second = filter.filter(new THREE.Vector3(0.1, 0, 0), 66, 0.08, 1);

  assert.ok(first.x > 0.05, 'the first prediction should lead the measurement');
  assert.ok(second.x > 0.1, 'the second prediction should continue leading motion');
  assert.ok(second.x < 0.35, 'prediction must remain bounded over a short lead');
});

test('position predictor reduces its lead for uncertain measurements', () => {
  const filter = new PredictivePositionFilter();
  filter.filter(new THREE.Vector3(0, 0, 0), 0, 0.1);
  const confident = filter.filter(new THREE.Vector3(0.2, 0, 0), 50, 0.1, 1);
  filter.reset();
  filter.filter(new THREE.Vector3(0, 0, 0), 0, 0.1);
  const uncertain = filter.filter(new THREE.Vector3(0.2, 0, 0), 50, 0.1, 0.25);

  assert.ok(confident.x > uncertain.x);
});

test('rotation predictor leads a bounded wrist rotation', () => {
  const filter = new PredictiveRotationFilter({ maxAngularSpeed: 10 });
  const identity = new THREE.Quaternion();
  filter.filter(identity, 0, 0.08);
  const current = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 1, 0),
    0.2
  );
  const predicted = filter.filter(current, 50, 0.08, 1);

  assert.ok(predicted.angleTo(current) < 0.3);
  assert.ok(predicted.angleTo(identity) > current.angleTo(identity));
});

test('pose and phone packets are accepted by the shared multiplayer protocol', () => {
  const pose = decodeMessage(encodeMessage('pose', {
    position: [0.1, 0.9, -0.7],
    quaternion: [0, 0, 0, 1],
    confidence: 0.9,
  }));
  const phone = decodeMessage(encodeMessage('phone-pose', { x: 0.2, y: -0.1, flick: true }));

  assert.equal(pose.type, 'pose');
  assert.equal(isClientMessage(pose), true);
  assert.equal(phone.type, 'phone-pose');
  assert.equal(isClientMessage(phone), true);
});
