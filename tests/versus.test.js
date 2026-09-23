import assert from 'node:assert/strict';
import test from 'node:test';
import { VersusMatch } from '../src/versus.js';

test('versus ignores invalid scorers', () => {
  const match = new VersusMatch();

  assert.equal(match.scorePoint('spectator'), null);
  assert.deepEqual(match.snapshot(), {
    scoreHost: 0,
    scoreGuest: 0,
    server: 'host',
    winner: null,
    target: 11,
  });
});

test('versus rejects malformed or impossible remote snapshots', () => {
  const match = new VersusMatch();
  const original = match.snapshot();

  assert.equal(match.apply({ ...original, server: 'spectator' }), false);
  assert.equal(match.apply({ ...original, scoreHost: -1 }), false);
  assert.equal(match.apply({ ...original, scoreHost: 11, scoreGuest: 0 }), false);
  assert.deepEqual(match.snapshot(), original);

  assert.equal(match.apply({
    scoreHost: 10,
    scoreGuest: 9,
    server: 'guest',
    winner: null,
    target: 11,
  }), true);
  assert.equal(match.scoreHost, 10);
  assert.equal(match.winner, null);
});
