import test from 'node:test';
import assert from 'node:assert/strict';
import { Tournament, RESULT_STATUS } from '../src/tournament.js';

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

test('a match result is held until both players report the same outcome', () => {
  const tournament = new Tournament(players);

  const first = tournament.recordResultReport({
    matchId: 'semi-1', reporterId: 'ada', winnerId: 'ada', score1: 11, score2: 7,
  });
  assert.equal(first.status, RESULT_STATUS.PENDING);
  // One claim is not a result. The bracket must not move on the host's word.
  assert.equal(tournament.getMatch('semi-1').winnerId, null);

  const second = tournament.recordResultReport({
    matchId: 'semi-1', reporterId: 'blake', winnerId: 'ada', score1: 11, score2: 7,
  });
  assert.equal(second.status, RESULT_STATUS.AGREED);
  assert.equal(tournament.getMatch('semi-1').winnerId, 'ada');
  assert.equal(tournament.getMatch('semi-1').score2, 7);
  assert.equal(tournament.pendingResultCount, 0);
});

test('players who disagree block the bracket instead of the first claim winning', () => {
  const tournament = new Tournament(players);

  tournament.recordResultReport({
    matchId: 'semi-1', reporterId: 'ada', winnerId: 'ada', score1: 11, score2: 7,
  });
  const disputed = tournament.recordResultReport({
    // Blake's version clears the win condition too — it is a different truth,
    // not an impossible one, which is exactly the case that needs a human.
    matchId: 'semi-1', reporterId: 'blake', winnerId: 'blake', score1: 5, score2: 11,
  });

  assert.equal(disputed.status, RESULT_STATUS.DISPUTED);
  assert.equal(tournament.getMatch('semi-1').winnerId, null);
  assert.equal(tournament.getMatch('final').player1, null);

  // The coordinator breaks the tie on the record rather than stalling forever.
  const applied = tournament.resolveDisputedResult('semi-1', 'ada');
  assert.equal(applied.winnerId, 'ada');
  assert.equal(tournament.getMatch('semi-1').winnerId, 'ada');
});

test('reports from outsiders, impostors, and impossible scores are refused', () => {
  const tournament = new Tournament(players);

  assert.equal(
    tournament.recordResultReport({
      matchId: 'semi-1', reporterId: 'casey', winnerId: 'casey', score1: 11, score2: 0,
    }).status,
    RESULT_STATUS.REJECTED
  );
  assert.equal(
    tournament.recordResultReport({
      matchId: 'semi-1', reporterId: 'ada', winnerId: 'blake', score1: 11, score2: 7,
    }).status,
    RESULT_STATUS.REJECTED
  );
  assert.equal(
    tournament.recordResultReport({
      matchId: 'semi-1', reporterId: 'ada', winnerId: 'ada', score1: 11, score2: 10,
    }).status,
    RESULT_STATUS.REJECTED
  );
  assert.equal(tournament.pendingResultCount, 0);
});

test('a lone report is applied after the grace period but flagged unconfirmed', () => {
  const tournament = new Tournament(players);
  tournament.recordResultReport({
    matchId: 'semi-1', reporterId: 'ada', winnerId: 'ada', score1: 11, score2: 7,
  });

  const applied = tournament.resolveUnopposedResult('semi-1');
  assert.equal(applied.unconfirmed, true);
  assert.equal(applied.reporterId, 'ada');
  assert.equal(tournament.getMatch('semi-1').winnerId, 'ada');
  // Nothing left to resolve, so a second call cannot rewrite a finished match.
  assert.equal(tournament.resolveUnopposedResult('semi-1'), null);
});

test('starting a fresh bracket discards reports left over from the previous one', () => {
  const tournament = new Tournament(players);
  tournament.recordResultReport({
    matchId: 'semi-1', reporterId: 'ada', winnerId: 'ada', score1: 11, score2: 7,
  });
  assert.equal(tournament.pendingResultCount, 1);

  tournament.reset(players);
  assert.equal(tournament.pendingResultCount, 0);
  assert.equal(tournament.getMatch('semi-1').winnerId, null);
});
