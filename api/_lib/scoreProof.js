import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

// A short-lived token the client must return with its score.
//
// This is not authentication and does not pretend to be. Someone who reads
// the page source can still forge a plausible run. What it does remove is the
// cheapest attack by a wide margin: a script that posts to /api/leaderboard in
// a loop, or one that never talks to the app at all, now has to obtain a fresh
// token from this deployment moments before each write, which shows up in the
// server's own logs and can be rate limited per instance.
//
// Set SCORE_PROOF_SECRET to turn this on. Without it the route still accepts
// submissions and marks them unverified, so a deployment that has not set the
// secret keeps working — it just does not get the extra gate.

const PROOF_TTL_MS = 10 * 60 * 1000; // ten minutes: long enough to finish a run, short enough to expire

function secret() {
  return String(process.env.SCORE_PROOF_SECRET ?? '').trim();
}

function sign(body) {
  return createHmac('sha256', secret()).update(body).digest('base64url');
}

export function scoreProofEnabled() {
  return secret().length >= 16;
}

export function issueScoreProof() {
  if (!scoreProofEnabled()) return null;
  const body = `${Date.now()}.${randomUUID()}`;
  return `${body}.${sign(body)}`;
}

// Returns true when the proof was signed by this deployment and is still fresh.
export function verifyScoreProof(proof) {
  if (!scoreProofEnabled()) return false;
  if (typeof proof !== 'string' || proof.length > 200) return false;
  const parts = proof.split('.');
  if (parts.length !== 3) return false;
  const [issuedAt, nonce, mac] = parts;
  const stamp = Number(issuedAt);
  if (!Number.isInteger(stamp)) return false;
  const age = Date.now() - stamp;
  // A token from the future is as suspect as an expired one: clocks drift, but
  // not by enough to matter, and a large positive skew is a forged timestamp.
  if (age < -PROOF_TTL_MS || age > PROOF_TTL_MS) return false;
  if (!/^[0-9a-f-]{36}$/i.test(nonce)) return false;

  const expected = Buffer.from(sign(`${issuedAt}.${nonce}`));
  const actual = Buffer.from(mac);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
