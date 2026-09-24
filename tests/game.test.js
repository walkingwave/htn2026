import assert from 'node:assert/strict';
import test from 'node:test';

import { Game } from '../src/game.js';
import { PLAY_AREA } from '../src/constants.js';

// A ball is just the flags the scoring machine reads. Building it here rather
// than importing Ball keeps the test on the scoring rules and not on meshes.
function fakeBall(z = 0) {
  return {
    active: true,
    countedHit: false,
    countedReturn: false,
    countedMiss: false,
    touchedByPaddle: false,
    awaitingOutcome: false,
    mesh: { position: { z } },
  };
}

test('a hit only opens the question; the bounce resolves it', () => {
  const game = new Game();
  const ball = fakeBall();

  game.onContact(ball, 'paddle');
  assert.equal(game.hits, 1);
  assert.equal(game.returns, 0, 'touching it is not returning it');

  ball.mesh.position.z = -0.5; // landed over the net
  game.onContact(ball, 'table');
  assert.equal(game.returns, 1);
  assert.equal(game.streak, 1);
  assert.equal(game.bestStreak, 1);
});

test('the same ball cannot be counted twice', () => {
  const game = new Game();
  const ball = fakeBall();
  game.onContact(ball, 'paddle');
  game.onContact(ball, 'paddle');
  assert.equal(game.hits, 1);

  ball.mesh.position.z = -0.5;
  game.onContact(ball, 'table');
  game.onContact(ball, 'table');
  assert.equal(game.returns, 1);
});

test('a ball that never crosses breaks the streak without becoming a miss', () => {
  const game = new Game();
  game.streak = 5;
  game.bestStreak = 5;

  const ball = fakeBall();
  game.onContact(ball, 'paddle');
  ball.mesh.position.z = 0.5; // came down on your own half
  game.onContact(ball, 'table');

  assert.equal(game.streak, 0);
  assert.equal(game.misses, 0, 'you made contact, so this is not a miss');
  assert.equal(game.returns, 0);
  assert.equal(game.bestStreak, 5, 'the best streak survives a broken one');
});

test('a struck ball reaching the floor is off the table, not a miss', () => {
  const game = new Game();
  game.streak = 3;
  const ball = fakeBall();
  game.onContact(ball, 'paddle');
  game.onContact(ball, 'floor');

  assert.equal(game.misses, 0);
  assert.equal(game.streak, 0);
});

test('an untouched ball on the floor is a miss', () => {
  const game = new Game();
  game.streak = 3;
  const ball = fakeBall();
  game.onContact(ball, 'floor');

  assert.equal(game.misses, 1);
  assert.equal(game.streak, 0);

  // And only once, however many floor events arrive.
  game.onContact(ball, 'floor');
  assert.equal(game.misses, 1);
});

test('the per-frame sweep catches balls that sail past unhit', () => {
  const game = new Game();
  const flying = fakeBall(PLAY_AREA.PLAYER_Z + 1);
  const still = fakeBall(0);
  const inactive = fakeBall(PLAY_AREA.PLAYER_Z + 1);
  inactive.active = false;

  game.update([flying, still, inactive]);
  assert.equal(game.misses, 1, 'only the active ball past the player counts');

  game.update([flying]);
  assert.equal(game.misses, 1, 'and only once');
});

test('accuracy measures returns against everything that was played', () => {
  const game = new Game();
  assert.equal(game.accuracy, 0, 'no attempts is zero, not NaN');

  const good = fakeBall();
  game.onContact(good, 'paddle');
  good.mesh.position.z = -0.5;
  game.onContact(good, 'table');

  const missed = fakeBall();
  game.onContact(missed, 'floor');

  assert.equal(game.hits, 1);
  assert.equal(game.returns, 1);
  assert.equal(game.misses, 1);
  assert.equal(game.accuracy, 50);
});

test('the rally counter keeps the longest exchange', () => {
  const game = new Game();
  game.onRallyExchange();
  game.onRallyExchange();
  game.onRallyExchange();
  assert.equal(game.rally, 3);
  assert.equal(game.longestRally, 3);

  game.endRally('point');
  assert.equal(game.rally, 0);
  assert.equal(game.longestRally, 3);

  game.onRallyExchange();
  assert.equal(game.longestRally, 3, 'a shorter rally does not lower the record');
});

test('coaching scores keep the best attempt and count the rest', () => {
  const game = new Game();
  game.onLessonScore({ total: 62, note: 'Flat' });
  game.onLessonScore({ total: 88, note: 'Good' });
  game.onLessonScore({ total: 40, note: 'Early' });

  assert.equal(game.lessonBest, 88);
  assert.equal(game.lessonAttempts, 3);
  assert.equal(game.lessonScore, 40, 'the latest score is the current one');
});

test('reset clears the run and announces it', () => {
  const game = new Game();
  const ball = fakeBall();
  game.onServe();
  game.onContact(ball, 'paddle');
  ball.mesh.position.z = -0.5;
  game.onContact(ball, 'table');
  game.onTargetHit();
  game.onLessonScore({ total: 90, note: 'Good' });
  const revision = game.revision;

  game.reset();

  assert.equal(game.served, 0);
  assert.equal(game.hits, 0);
  assert.equal(game.returns, 0);
  assert.equal(game.misses, 0);
  assert.equal(game.streak, 0);
  assert.equal(game.bestStreak, 0);
  assert.equal(game.targetsHit, 0);
  assert.equal(game.longestRally, 0);
  assert.equal(game.lessonBest, 0);
  assert.equal(game.lessonAttempts, 0);
  assert.ok(game.revision > revision, 'the board has to know to repaint');
});
