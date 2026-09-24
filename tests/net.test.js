import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPhonePairRoom,
  createRoom,
  createTournamentRoom,
  isRealtimeAvailable,
  makeRoomCode,
  makeTournamentPlayerId,
  relayConfigured,
  roomFromUrl,
  selectTournamentRoster,
  roomLinkFor,
  tournamentFromUrl,
  tournamentLinkFor,
} from '../src/net.js';
import {
  MULTIPLAYER_PROTOCOL,
  decodeMessage,
  encodeMessage,
  isClientMessage,
  isValidRoomCode,
} from '../src/multiplayerProtocol.js';

// These are the pieces of the multiplayer layer that do not need a socket, a
// channel, or an opponent — the ones that, when they are wrong, present as
// "the link doesn't work" and send you looking in the wrong place.

test('room codes stay readable out loud', () => {
  const codes = Array.from({ length: 200 }, () => makeRoomCode());

  for (const code of codes) {
    assert.match(code, /^[A-Z0-9]{6}$/, `${code} is not a six-character code`);
    // O/0 and I/1 are the pairs people mix up when reading a code to somebody.
    assert.doesNotMatch(code, /[O0I1]/, `${code} contains an ambiguous character`);
  }
  assert.ok(new Set(codes).size > 150, 'codes should not repeat in practice');
});

test('room and tournament links carry the code, and say which game it is', () => {
  const room = new URL(roomLinkFor('ABC234', 'https://paddlelab.example/play?stale=1#x'));
  assert.equal(room.origin, 'https://paddlelab.example');
  assert.equal(room.searchParams.get('room'), 'ABC234');
  assert.equal(room.searchParams.get('tournament'), null);
  assert.equal(room.hash, '', 'a stale hash is dropped');
  assert.equal(room.searchParams.get('stale'), null, 'stale query params are dropped');

  const tournament = new URL(
    tournamentLinkFor('XYZ789', 'https://paddlelab.example', 'relay.example')
  );
  assert.equal(tournament.searchParams.get('room'), 'XYZ789');
  // Without this flag a shared bracket link would silently become a 1v1 match.
  assert.equal(tournament.searchParams.get('tournament'), '1');
  assert.equal(tournament.searchParams.get('relay'), 'relay.example');
});

test('links opened without a room code are not treated as invitations', () => {
  // Node has no window.location, which is exactly the "no invitation here"
  // case these helpers are written to survive.
  assert.equal(roomFromUrl(), null);
  assert.equal(tournamentFromUrl(), null);
});

test('the relay only forwards the message types it knows', () => {
  const message = decodeMessage(encodeMessage('paddle', { c: [1, 0, 0] }));
  assert.equal(message.protocol, MULTIPLAYER_PROTOCOL);
  assert.equal(message.type, 'paddle');
  assert.deepEqual(message.data, { c: [1, 0, 0] });

  assert.equal(isClientMessage({ type: 'paddle' }), true);
  assert.equal(isClientMessage({ type: 'phone-pose' }), true);
  // Anything unrecognised would turn the room into a general-purpose bus.
  assert.equal(isClientMessage({ type: 'eval' }), false);
  assert.equal(isClientMessage(null), false);
});

test('malformed packets never reach a handler', () => {
  assert.equal(decodeMessage('not json'), null);
  // Byte-compatible with the original protocol: a message from the other
  // implementation is accepted, a differently-versioned one is not.
  assert.equal(decodeMessage(JSON.stringify({ protocol: 'other', type: 'paddle' })), null);
  assert.equal(decodeMessage(JSON.stringify({ protocol: MULTIPLAYER_PROTOCOL })), null);
  assert.equal(decodeMessage(JSON.stringify({ protocol: MULTIPLAYER_PROTOCOL, type: 'x'.repeat(40) })), null);
});

test('room codes are validated before anything is opened', () => {
  assert.equal(isValidRoomCode('ABC234'), true);
  assert.equal(isValidRoomCode('semi-1a'), true);
  assert.equal(isValidRoomCode(''), false);
  assert.equal(isValidRoomCode('has space'), false);
  assert.equal(isValidRoomCode('emoji🎾'), false);
  assert.equal(isValidRoomCode(null), false);

  // Every entry point refuses a code the relay would refuse, so the failure is
  // local and immediate instead of a socket that closes with no reason.
  assert.throws(() => createRoom({ code: 'no!', role: 'host', transport: 'local' }), /Invalid room code/);
  assert.throws(() => createPhonePairRoom({ code: 'no!' }), /Invalid .*room code/);
  assert.throws(() => createTournamentRoom({ code: 'no!', player: { id: 'a' } }), /Invalid .*room code/);
  assert.throws(
    () => createTournamentRoom({ code: 'ABC234', player: { id: '' } }),
    /player id is required/
  );
});

test('a build with no Supabase configuration falls back instead of failing', () => {
  // No VITE_SUPABASE_* in a test environment: this is the "no account, still
  // playable" path that the dev server and a bare clone rely on.
  assert.equal(isRealtimeAvailable(), false);
  assert.equal(relayConfigured(), false);

  // Asking for the internet explicitly is the one case that must fail loudly,
  // because silently degrading would look like the room simply not working.
  assert.throws(() => createRoom({ code: 'ABC234', role: 'host', transport: 'supabase' }), /VITE_SUPABASE_URL/);
  assert.throws(() => createRoom({ code: 'ABC234', role: 'host', transport: 'webrtc' }), /VITE_SUPABASE_URL/);
  assert.throws(
    () => createTournamentRoom({ code: 'ABC234', player: { id: 'a' }, transport: 'supabase' }),
    /VITE_SUPABASE_URL/
  );

  // And the automatic path degrades to two tabs on one machine.
  const local = createRoom({ code: 'ABC234', role: 'host', transport: 'local' });
  assert.equal(local.kind, 'local');
  assert.deepEqual(local.lanUrls, []);
  local.close();
});

test('tournament entrants are identifiable and bounded', () => {
  const id = makeTournamentPlayerId();
  assert.equal(typeof id, 'string');
  assert.ok(id.length > 0);
  assert.notEqual(id, makeTournamentPlayerId());
});

test('the first four to join own the bracket and everyone later watches', () => {
  const lobby = [
    { id: 'ada', name: 'Ada', joinedAt: 300 },
    { id: 'blake', name: 'Blake', joinedAt: 100 },
    { id: 'casey', name: 'Casey', joinedAt: 200 },
    { id: 'dev', name: 'Dev', joinedAt: 400 },
    { id: 'eve', name: 'Eve', joinedAt: 500 },
    { id: 'frank', name: 'Frank', joinedAt: 600 },
  ];

  const { entrants, spectators } = selectTournamentRoster(lobby);
  // Seeding is by join time, not by the order the list happened to arrive in,
  // so a reconnecting player lands back on the side they were already on.
  assert.deepEqual(entrants.map((player) => player.id), ['blake', 'casey', 'ada', 'dev']);
  assert.deepEqual(spectators.map((player) => player.id), ['eve', 'frank']);
});

test('a roster of exactly four leaves nobody watching', () => {
  const { entrants, spectators } = selectTournamentRoster([
    { id: 'a', joinedAt: 1 },
    { id: 'b', joinedAt: 2 },
    { id: 'c', joinedAt: 3 },
    { id: 'd', joinedAt: 4 },
  ]);
  assert.equal(entrants.length, 4);
  assert.deepEqual(spectators, []);
});

test('malformed and duplicate lobby entries are dropped before seeding', () => {
  const { entrants, spectators } = selectTournamentRoster([
    { id: 'a', joinedAt: 1 },
    { id: 'a', joinedAt: 2 },
    { name: 'no id', joinedAt: 3 },
    { id: 'b', joinedAt: 4 },
    { id: 'c', joinedAt: 5 },
    { id: 'd', joinedAt: 6 },
  ]);
  assert.deepEqual(entrants.map((player) => player.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(spectators, []);
});
