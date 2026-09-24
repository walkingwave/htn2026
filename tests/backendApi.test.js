import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';

import {
  analyzeShot,
  getProfileSummary,
  narrate,
  recordProfileEvent,
  sendInvite,
} from '../src/backendApi.js';

const ORIGINAL_ENV = { ...process.env };
const originalFetch = globalThis.fetch;
const ORIGINAL_STORAGERS = { localStorage: globalThis.localStorage, Audio: globalThis.Audio };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = originalFetch;
  globalThis.localStorage = ORIGINAL_STORAGERS.localStorage;
  globalThis.Audio = ORIGINAL_STORAGERS.Audio;
});

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('a request posts JSON and hands back the parsed body', async () => {
  let seen;
  globalThis.fetch = async (url, options) => {
    seen = { url, options };
    return jsonResponse({ ok: true });
  };

  const result = await analyzeShot({ total: 80 }, { scenario: 'drive' });
  assert.deepEqual(result, { ok: true });
  assert.equal(seen.url, '/api/coach/shot');
  assert.equal(seen.options.method, 'POST');
  assert.equal(seen.options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(seen.options.body).shot, { total: 80 });
});

test('a server error surfaces its own message rather than a status code', async () => {
  globalThis.fetch = async () => jsonResponse({ error: 'Invalid shot payload.' }, 400);
  await assert.rejects(
    () => analyzeShot({ total: 80 }),
    /Invalid shot payload\./
  );
});

test('a non-JSON error response still produces a readable failure', async () => {
  globalThis.fetch = async () => new Response('<html>502</html>', {
    status: 502,
    headers: { 'content-type': 'text/html' },
  });
  await assert.rejects(() => sendInvite('+14165551234', 'https://flyball.app/?room=A1'), /502/);
});

test('a slow endpoint is cut off rather than hanging the caller', async () => {
  globalThis.fetch = (_url, options) =>
    new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });

  await assert.rejects(
    () => analyzeShot({ total: 1 }),
    /timed out/
  );
});

// Vite's SPA fallback answers an unknown path with index.html and a 200, so a
// narration request can come back as HTML. Treating that as an MP3 makes
// playback fail silently; the client checks instead.
test('narration refuses an HTML response instead of trying to play it', async () => {
  globalThis.fetch = async () => new Response('<!doctype html><title>app</title>', {
    status: 200,
    headers: { 'content-type': 'text/html' },
  });

  await assert.rejects(() => narrate('Nice forehand.'), /did not return audio/);
});

test('narration plays returned audio and revokes the object URL', async () => {
  let revoked = null;
  let played = false;
  globalThis.URL.createObjectURL = () => 'blob:narration';
  globalThis.URL.revokeObjectURL = (url) => { revoked = url; };
  globalThis.Audio = class {
    constructor(url) {
      this.src = url;
      this.listeners = new Map();
      // The real element fires `ended` once playback finishes.
      setTimeout(() => this.listeners.get('ended')?.(), 0);
    }
    addEventListener(name, fn) { this.listeners.set(name, fn); }
    async play() { played = true; }
    pause() {}
  };
  globalThis.fetch = async () =>
    new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'content-type': 'audio/mpeg' },
    });

  await narrate('Nice forehand.');
  assert.equal(played, true);
  // `ended` fires on a later tick than play() resolving, which is exactly why
  // the cleanup is event-driven rather than inline.
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(revoked, 'blob:narration', 'the blob is released after playback');
});

test('profile events remember their thread across calls', async () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, value),
  };

  let firstBody;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.event) firstBody = body;
    return jsonResponse({ threadId: 'thread-1' });
  };

  await recordProfileEvent('drive', 'player-1');
  assert.equal(firstBody.threadId, undefined, 'the first event has no thread yet');

  await recordProfileEvent('push', 'player-1');
  assert.equal(
    JSON.parse(JSON.stringify(store.get('paddlelab.backboard.thread.player-1'))),
    'thread-1',
    'the server-assigned thread is remembered and reused'
  );
});

test('asking for a profile with no history fails before hitting the network', async () => {
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return jsonResponse({});
  };
  globalThis.localStorage = {
    getItem: () => null,
    setItem: () => {},
  };

  await assert.rejects(() => getProfileSummary('player-1'), /No profile history/);
  assert.equal(called, false, 'there is nothing to ask the server for');
});
