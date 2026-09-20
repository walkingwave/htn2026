import test from 'node:test';
import assert from 'node:assert/strict';
import { Tournament } from '../src/tournament.js';

test('tournament advances the local player through the playable bracket', () => {
  const tournament = new Tournament();
  for (let i = 0; i < 11; i++) tournament.scorePoint(0);

  assert.equal(tournament.currentMatchId, '1-0');
  assert.equal(tournament.currentMatch.player1.name, 'You');
  assert.equal(tournament.currentMatch.player2.name, 'Blake');
  assert.equal(tournament.matches[0].winner, 0);
});

test('deuce requires a two-point lead and a loss ends the local tournament', () => {
  const tournament = new Tournament();
  for (let i = 0; i < 10; i++) {
    tournament.scorePoint(0);
    tournament.scorePoint(1);
  }
  assert.equal(tournament.currentMatch.winner, null);
  tournament.scorePoint(0);
  tournament.scorePoint(1);
  tournament.scorePoint(1);
  tournament.scorePoint(0);
  tournament.scorePoint(1);
  assert.equal(tournament.finished, false);
  tournament.scorePoint(1);
  assert.equal(tournament.finished, true);
  assert.equal(tournament.currentMatch.winner, 1);
});

test('championship is marked finished after the final real match', () => {
  const tournament = new Tournament();
  for (const opponent of [1, 2, 3]) {
    for (let i = 0; i < 11; i++) tournament.scorePoint(0);
    if (opponent !== 3) assert.equal(tournament.finished, false);
  }
  assert.equal(tournament.finished, true);
  assert.equal(tournament.matches.at(-1).winner, 0);
});
