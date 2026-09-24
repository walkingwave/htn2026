import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';

import {
  isWorthRecording,
  normaliseSummary,
  scoreFor,
} from '../src/leaderboardScore.js';
import { issueScoreProof, scoreProofEnabled, verifyScoreProof } from '../api/_lib/scoreProof.js';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

const arcadeRun = {
  hits: 120,
  returns: 80,
  misses: 25,
  bestStreak: 12,
  longestRally: 30,
  targetsHit: 9,
  accuracy: 76,
  lessonBest: 0,
  lessonAttempts: 0,
  pointsWon: 0,
  matchWon: false,
};

test('the score is derived from the run, and the three categories differ', () => {
  const arcade = scoreFor(arcadeRun, 'arcade');
  assert.equal(arcade, 80 * 12 + 12 * 30 + 30 * 20 + 76 * 8 + 9 * 18 - 25 * 15);

  assert.equal(
    scoreFor({ lessonBest: 80, lessonAttempts: 5 }, 'coach'),
    80 * 12 + 5 * 3
  );
  assert.equal(scoreFor({ pointsWon: 7, matchWon: false }, 'versus'), 700);
  assert.equal(scoreFor({ pointsWon: 7, matchWon: true }, 'tournament'), 1200);
});

test('an ordinary session survives the plausibility check', () => {
  const clean = normaliseSummary(arcadeRun);
  assert.equal(clean.hits, 120);
  assert.equal(clean.accuracy, 76);
  assert.equal(clean.matchWon, false);
  assert.equal(isWorthRecording(clean, 'arcade'), true);
});

test('a run nobody played is not worth recording', () => {
  const idle = normaliseSummary({});
  assert.equal(isWorthRecording(idle, 'arcade'), false);
  assert.equal(isWorthRecording(idle, 'coach'), false);
  assert.equal(isWorthRecording(idle, 'versus'), false);
  // A win with no points is still a result worth keeping.
  assert.equal(isWorthRecording({ pointsWon: 0, matchWon: true }, 'versus'), true);
});

// This is the control that matters: without it a script can post any number it
// likes straight into the table.
test('stats beyond a plausible session are rejected rather than trimmed', () => {
  assert.throws(() => normaliseSummary({ ...arcadeRun, returns: 900_000 }), /plausible range/);
  assert.throws(() => normaliseSummary({ ...arcadeRun, pointsWon: 50_000 }), /plausible range/);
  assert.throws(() => normaliseSummary({ ...arcadeRun, accuracy: 400 }), /plausible range/);
  assert.throws(() => normaliseSummary({ ...arcadeRun, hits: -1 }), /plausible range/);
  assert.throws(() => normaliseSummary({ ...arcadeRun, hits: 'lots' }), /not a number/);
  assert.throws(() => normaliseSummary(null), /summary is required/);
});

test('the limits still keep the worst case under the column ceiling', () => {
  const worst = normaliseSummary({
    hits: 100_000, returns: 50_000, misses: 0, bestStreak: 5_000, longestRally: 2_000,
    targetsHit: 5_000, accuracy: 100, lessonBest: 100, lessonAttempts: 5_000,
    pointsWon: 2_000, matchWon: true,
  });
  assert.ok(scoreFor(worst, 'arcade') <= 1_000_000);
  assert.ok(scoreFor(worst, 'versus') <= 1_000_000);
});

test('a score proof round-trips, and a tampered or forged one does not', () => {
  process.env.SCORE_PROOF_SECRET = 'a'.repeat(32);
  assert.equal(scoreProofEnabled(), true);

  const proof = issueScoreProof();
  assert.equal(verifyScoreProof(proof), true);

  // Flip a character of the signature.
  const forged = `${proof.slice(0, -2)}${proof.endsWith('AA') ? 'BB' : 'AA'}`;
  assert.equal(verifyScoreProof(forged), false);
  // A well-formed token signed with somebody else's secret.
  assert.equal(verifyScoreProof(`${Date.now()}.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.${'b'.repeat(43)}`), false);
  assert.equal(verifyScoreProof('nonsense'), false);
  assert.equal(verifyScoreProof(undefined), false);
});

test('an expired score proof stops verifying', () => {
  process.env.SCORE_PROOF_SECRET = 'a'.repeat(32);
  const proof = issueScoreProof();
  assert.equal(verifyScoreProof(proof), true);

  // Just inside the window it still stands; past it, it does not.
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 9 * 60 * 1000;
    assert.equal(verifyScoreProof(proof), true);
    Date.now = () => realNow() + 11 * 60 * 1000;
    assert.equal(verifyScoreProof(proof), false);
  } finally {
    Date.now = realNow;
  }
});

test('without a secret the proof is off rather than broken', () => {
  delete process.env.SCORE_PROOF_SECRET;
  assert.equal(scoreProofEnabled(), false);
  assert.equal(issueScoreProof(), null);
  assert.equal(verifyScoreProof(null), false);
});
