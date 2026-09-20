import test from 'node:test';
import assert from 'node:assert/strict';
import { Tournament } from '../src/tournament.js';

const players = [
  { id: 'ada', name: 'Ada' },
  { id: 'blake', name: 'Blake' },
  { id: 'casey', name: 'Casey' },
  { id: 'dev', name: 'Dev' },
];

test('four entrants receive two real semifinals and a final', () => {
  const tournament = new Tournament(players);

  assert.equal(tournament.getMatch('semi-1').player1.name, 'Ada');
  assert.equal(tournament.getMatch('semi-1').player2.name, 'Blake');
  assert.equal(tournament.getMatch('semi-2').player1.name, 'Casey');
  assert.equal(tournament.getMatch('semi-2').player2.name, 'Dev');
  assert.equal(tournament.getMatch('final').player1, null);

  assert.equal(
    tournament.recordMatchResult({ matchId: 'semi-1', winnerId: 'ada', score1: 11, score2: 7 }),
    true
  );
  assert.equal(tournament.getMatch('final').player1.name, 'Ada');
  assert.equal(tournament.matchFor('ada'), null);

  assert.equal(
    tournament.recordMatchResult({ matchId: 'semi-2', winnerId: 'dev', score1: 8, score2: 11 }),
    true
  );
  assert.equal(tournament.getMatch('final').player2.name, 'Dev');
  assert.equal(tournament.matchFor('dev').id, 'final');
});

test('rejects stale, foreign, and invalid match results', () => {
  const tournament = new Tournament(players);

  assert.equal(
    tournament.recordMatchResult({ matchId: 'semi-1', winnerId: 'casey', score1: 11, score2: 9 }),
    false
  );
  assert.equal(
    tournament.recordMatchResult({ matchId: 'final', winnerId: 'ada', score1: 11, score2: 4 }),
    false
  );
  assert.equal(
    tournament.recordMatchResult({ matchId: 'semi-1', winnerId: 'ada', score1: 11, score2: 10 }),
    false
  );
  assert.equal(
    tournament.recordMatchResult({ matchId: 'semi-1', winnerId: 'ada', score1: 12, score2: 10 }),
    true
  );
  assert.equal(
    tournament.recordMatchResult({ matchId: 'semi-1', winnerId: 'ada', score1: 12, score2: 10 }),
    false
  );
});

test('point scoring observes deuce and completing the final crowns a champion', () => {
  const tournament = new Tournament(players);
  for (let i = 0; i < 10; i += 1) {
    tournament.scorePoint('semi-1', 'ada');
    tournament.scorePoint('semi-1', 'blake');
  }
  assert.equal(tournament.getMatch('semi-1').winnerId, null);
  tournament.scorePoint('semi-1', 'ada');
  tournament.scorePoint('semi-1', 'ada');
  assert.equal(tournament.getMatch('semi-1').winnerId, 'ada');

  tournament.recordMatchResult({ matchId: 'semi-2', winnerId: 'casey', score1: 11, score2: 4 });
  tournament.recordMatchResult({ matchId: 'final', winnerId: 'casey', score1: 9, score2: 11 });

  assert.equal(tournament.finished, true);
  assert.equal(tournament.championId, 'casey');
});

test('a canonical snapshot can hydrate another bracket without changing seeds', () => {
  const source = new Tournament(players);
  source.recordMatchResult({ matchId: 'semi-1', winnerId: 'blake', score1: 7, score2: 11 });

  const replica = new Tournament(players);
  assert.equal(replica.apply(source.snapshot()), true);
  assert.deepEqual(replica.snapshot(), source.snapshot());
});
