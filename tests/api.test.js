import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';

import shotHandler from '../api/coach/shot.js';
import matchHandler from '../api/coach/match.js';
import postmatchHandler from '../api/coach/postmatch.js';
import narrateHandler from '../api/coach/narrate.js';
import profileEventHandler from '../api/profile/event.js';
import profileSummaryHandler from '../api/profile/summary.js';
import inviteHandler from '../api/contact/invite.js';
import leaderboardHandler from '../api/leaderboard.js';
import telemetryHandler from '../api/telemetry.js';

const ORIGINAL_ENV = { ...process.env };
const originalFetch = globalThis.fetch;

function mockRequest(body, method = 'POST') {
  return { method, body };
}

function mockResponse() {
  const response = {
    statusCode: null,
    headers: {},
    payload: undefined,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
    send(payload) {
      this.payload = payload;
      return this;
    },
    end() {
      this.ended = true;
    },
  };
  return response;
}

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = originalFetch;
});

test('OpenAI shot route validates and forwards a server-side request', async () => {
  process.env.OPENAI_API_KEY = 'test-openai-key';
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return jsonResponse({ output_text: 'Keep the face closed through contact.' });
  };

  const res = mockResponse();
  await shotHandler(mockRequest({ shot: { total: 82 }, context: { scenario: 'drive' } }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.analysis, 'Keep the face closed through contact.');
  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  assert.equal(request.options.headers.Authorization, 'Bearer test-openai-key');
  assert.match(request.options.body, /drive/);
});

test('Baseten post-match route uses the OpenAI-compatible API', async () => {
  process.env.BASETEN_API_KEY = 'test-baseten-key';
  process.env.BASETEN_MODEL_ID = 'zai-org/GLM-5.3-Fast';
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return jsonResponse({ choices: [{ message: { content: 'Strong serve placement; prioritize backhand timing; drill cross-court blocks.' } }] });
  };

  const res = mockResponse();
  await postmatchHandler(mockRequest({ match: { scoreHost: 11, scoreGuest: 8 } }), res);

  assert.equal(res.statusCode, 200);
  assert.match(res.payload.summary, /Strong serve placement/);
  assert.equal(request.url, 'https://inference.baseten.co/v1/chat/completions');
  assert.equal(request.options.headers.Authorization, 'Bearer test-baseten-key');
  assert.match(request.options.body, /GLM-5\.3-Fast/);
});

test('Gemini match route returns a holistic summary', async () => {
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return jsonResponse({ output_text: 'Strong returns; work on serve depth.' });
  };

  const res = mockResponse();
  await matchHandler(mockRequest({ match: { scoreHost: 11, scoreGuest: 8 } }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.summary, 'Strong returns; work on serve depth.');
  assert.equal(request.options.headers['x-goog-api-key'], 'test-gemini-key');
});

test('ElevenLabs route selects the requested narrator and returns audio', async () => {
  process.env.ELEVENLABS_API_KEY = 'test-eleven-key';
  process.env.ELEVENLABS_NARRATOR_B_VOICE_ID = 'voice-b';
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'content-type': 'audio/mpeg' },
    });
  };

  const res = mockResponse();
  await narrateHandler(mockRequest({ text: 'Great shot.', narrator: 'b' }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'audio/mpeg');
  assert.match(request.url, /voice-b/);
  assert.equal(request.options.headers['xi-api-key'], 'test-eleven-key');
});

test('Backboard event and trend routes share a profile thread', async () => {
  process.env.BACKBOARD_API_KEY = 'test-backboard-key';
  let calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return jsonResponse(
      calls.length === 1
        ? { thread_id: 'thread-123', message_id: 'message-1' }
        : { content: 'Timing is consistently early.' }
    );
  };

  const eventRes = mockResponse();
  await profileEventHandler(mockRequest({ event: { timing: 76 } }), eventRes);
  const summaryRes = mockResponse();
  await profileSummaryHandler(mockRequest({ threadId: eventRes.payload.threadId }), summaryRes);

  assert.equal(eventRes.statusCode, 200);
  assert.equal(summaryRes.statusCode, 200);
  assert.equal(summaryRes.payload.summary, 'Timing is consistently early.');
  assert.match(calls[1].options.body, /thread-123/);
  assert.equal(calls[0].options.headers['X-API-Key'], 'test-backboard-key');
});

test('Linq invite route creates a chat from a phone number', async () => {
  process.env.LINQ_INTEGRATION_TOKEN = 'test-linq-token';
  process.env.LINQ_SEND_FROM = '+14165550000';
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return jsonResponse({ data: { id: 7, chat_messages: { text: 'Join me' } } });
  };

  const res = mockResponse();
  await inviteHandler(mockRequest({ phoneNumber: '+14165551234', roomLink: 'https://flyball.app/?room=ABC123' }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.chat.id, 7);
  assert.equal(request.url, 'https://api.linqapp.com/api/partner/v2/chats');
  assert.equal(request.options.headers['X-LINQ-INTEGRATION-TOKEN'], 'test-linq-token');
  const body = JSON.parse(request.options.body);
  assert.equal(body.send_from, '+14165550000');
  assert.deepEqual(body.chat.phone_numbers, ['+14165551234']);
  assert.match(body.message.text, /flyball\.app/);
});

test('the invite route only answers requests from the app itself', async () => {
  process.env.LINQ_INTEGRATION_TOKEN = 'test-linq-token';
  process.env.LINQ_SEND_FROM = '+14165550000';
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return jsonResponse({ data: {} });
  };

  const crossSite = mockRequest({ phoneNumber: '+14165551234', text: 'hi' });
  crossSite.headers = { origin: 'https://evil.example', host: 'flyball.vercel.app' };
  const blocked = mockResponse();
  await inviteHandler(crossSite, blocked);

  assert.equal(blocked.statusCode, 403);
  assert.equal(called, false, 'a cross-site caller must not reach Linq');

  // The same request from the deployment's own origin still works.
  const sameSite = mockRequest({ phoneNumber: '+14165551234', text: 'hi' });
  sameSite.headers = { origin: 'https://flyball.vercel.app', host: 'flyball.vercel.app' };
  const allowed = mockResponse();
  await inviteHandler(sameSite, allowed);
  assert.equal(allowed.statusCode, 200);
  assert.equal(called, true);
});

test('the invite route obeys a pinned APP_ORIGIN when one is set', async () => {
  process.env.APP_ORIGIN = 'https://flyball.vercel.app';
  process.env.LINQ_INTEGRATION_TOKEN = 'test-linq-token';
  globalThis.fetch = async () => jsonResponse({ data: { id: 1 } });

  const request = mockRequest({ phoneNumber: '+14165551234', text: 'hi' });
  // Same host, different scheme: still a different origin.
  request.headers = { origin: 'http://flyball.vercel.app', host: 'flyball.vercel.app' };
  const res = mockResponse();
  await inviteHandler(request, res);
  assert.equal(res.statusCode, 403);
});

test('the leaderboard derives its own score and refuses a forged run', async () => {
  const forged = mockRequest({
    player_name: 'Cheater',
    category: 'arcade',
    score: 1_000_000, // ignored entirely: the route never reads this
    summary: { hits: 10, returns: 900_000, misses: 0, bestStreak: 5_000, accuracy: 100 },
  });
  const res = mockResponse();
  await leaderboardHandler(forged, res);

  // Rejected on plausibility before the database is ever touched.
  assert.equal(res.statusCode, 400);
  assert.match(res.payload.error, /plausible range/);
});

test('the leaderboard will not take a run that never happened', async () => {
  const res = mockResponse();
  await leaderboardHandler(
    mockRequest({ player_name: 'Idle', category: 'arcade', summary: {} }),
    res
  );
  assert.equal(res.statusCode, 400);
  assert.match(res.payload.error, /did not score/);
});

test('a configured score proof is required before a score is written', async () => {
  process.env.SCORE_PROOF_SECRET = 'a'.repeat(32);
  const body = {
    player_name: 'Ada',
    category: 'versus',
    summary: { pointsWon: 11, matchWon: true },
  };

  const unsigned = mockResponse();
  await leaderboardHandler(mockRequest({ ...body, proof: 'made.up' }), unsigned);
  assert.equal(unsigned.statusCode, 400);
  assert.match(unsigned.payload.error, /could not be verified/);

  // With the guard off, the same request gets past validation and on to the
  // database, which is not configured in tests — so the failure is a database
  // one, not a verification one.
  delete process.env.SCORE_PROOF_SECRET;
  const unconfigured = mockResponse();
  await leaderboardHandler(mockRequest(body), unconfigured);
  assert.notEqual(unconfigured.payload.error, 'This score could not be verified. Reload the page and try again.');
});

test('Linq invite route sends an idempotent multipart message', async () => {
  process.env.LINQ_INTEGRATION_TOKEN = 'test-linq-token';
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return jsonResponse({ data: { id: 42, text: 'Play?' } }, 201);
  };

  const res = mockResponse();
  await inviteHandler(mockRequest({ chatId: 'chat-7', text: 'Play?' }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.message.id, 42);
  assert.match(request.url, /chats\/chat-7\/chat_messages/);
  assert.equal(request.options.headers['X-LINQ-INTEGRATION-TOKEN'], 'test-linq-token');
});

test('provider routes fail clearly when credentials are missing', async () => {
  delete process.env.OPENAI_API_KEY;
  const res = mockResponse();
  await shotHandler(mockRequest({ shot: 'test' }), res);
  assert.equal(res.statusCode, 503);
  assert.match(res.payload.error, /OPENAI_API_KEY/);
});

test('Tiger leaderboard and telemetry routes fail clearly before database setup', async () => {
  delete process.env.TIGER_DATABASE_URL;
  delete process.env.DATABASE_URL;

  const leaderboardRes = mockResponse();
  await leaderboardHandler({ method: 'GET', url: '/api/leaderboard?category=arcade' }, leaderboardRes);
  assert.equal(leaderboardRes.statusCode, 503);
  assert.match(leaderboardRes.payload.error, /TIGER_DATABASE_URL/);

  // Tournament is a first-class board category, not a client-only label.
  const tournamentRes = mockResponse();
  await leaderboardHandler({ method: 'GET', url: '/api/leaderboard?category=tournament' }, tournamentRes);
  assert.equal(tournamentRes.statusCode, 503);
  assert.match(tournamentRes.payload.error, /TIGER_DATABASE_URL/);

  const telemetryRes = mockResponse();
  await telemetryHandler(mockRequest({ event_type: 'coach_score' }), telemetryRes);
  assert.equal(telemetryRes.statusCode, 503);
  assert.match(telemetryRes.payload.error, /TIGER_DATABASE_URL/);
});
