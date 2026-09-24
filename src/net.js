import { loadSupabase, supabaseConfigured } from './supabaseClient.js';
import { encodeMessage, isValidRoomCode, MULTIPLAYER_PROTOCOL } from './multiplayerProtocol.js';

// Networking for online versus. Three interchangeable transports sit behind
// one interface so the game code never cares how bytes move:
//
//   - WebSocketTransport: same-origin relay exposed by the Vite dev server.
//     This is the one that matters at a hackathon — the headset and the laptop
//     are on the same LAN and the host is already serving the page.
//   - SupabaseTransport: Realtime broadcast + presence. Works between any two
//     networks once VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are set, which
//     is what a deployed build uses.
//   - BroadcastChannelTransport: same-origin fallback so two tabs on one
//     machine can play with no backend at all. Useful for testing the whole
//     flow without a second device.
//
// Message model: send(type, data) / on(type, cb). Control messages are
// prefixed with '__' and handled internally to drive opponent presence.

const CHANNEL_PREFIX = 'flyball-room-';
const PHONE_CHANNEL_PREFIX = 'flyball-phone-';
const WS_PATH = '/__flyball_ws';

// ICE servers for the direct WebRTC path. STUN alone gets two browsers on the
// same Wi-Fi talking, but a symmetric NAT — campus and hotel networks, and
// essentially every phone on cellular — hands out no usable candidate, so the
// peer connection never opens. A TURN relay is the fix, and it is read from
// the environment rather than hard-coded so the credentials stay in Vercel's
// project settings and out of the bundle:
//
//   VITE_TURN_URL         turn:host:3478 (comma-separated list also accepted)
//   VITE_TURN_USERNAME
//   VITE_TURN_CREDENTIAL
//
// With no TURN configured the match still plays: game packets now also travel
// over the Supabase Realtime channel as a fallback (see WebRTCTransport), so a
// failed NAT traversal costs latency rather than the whole match.
const DEFAULT_STUN_URL = 'stun:stun.l.google.com:19302';

// `import.meta.env` does not exist outside a Vite build, so every read goes
// through this and the module stays importable from a plain Node test.
const ENV = import.meta.env ?? {};

function iceServers() {
  const servers = [{ urls: DEFAULT_STUN_URL }];
  const urls = String(ENV.VITE_TURN_URL ?? '')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);
  if (urls.length) {
    servers.push({
      urls,
      username: ENV.VITE_TURN_USERNAME,
      credential: ENV.VITE_TURN_CREDENTIAL,
    });
  }
  return servers;
}

export function relayConfigured() {
  return iceServers().length > 1;
}

function clientId() {
  try { return crypto.randomUUID(); } catch { return `${Date.now()}-${Math.random()}`; }
}

export function makeRoomCode() {
  // Ambiguity-free alphabet (no O/0/I/1) for codes that are easy to read aloud.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

export function roomLinkFor(code, origin = window.location.origin, relay = null) {
  const url = new URL(origin);
  url.search = '';
  url.hash = '';
  url.searchParams.set('room', code);
  if (relay) url.searchParams.set('relay', relay);
  return url.toString();
}

export function roomFromUrl() {
  try {
    return new URL(window.location.href).searchParams.get('room');
  } catch {
    return null;
  }
}

export function roomRelayFromUrl() {
  try {
    return new URL(window.location.href).searchParams.get('relay');
  } catch {
    return null;
  }
}

export function clearRoomFromUrl() {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete('room');
    window.history.replaceState({}, '', url.toString());
  } catch {
    /* no-op */
  }
}

// Tournament invitations deliberately carry an explicit mode flag. A normal
// ?room= code is still a one-on-one friend match; otherwise opening a shared
// bracket link would quietly drop somebody into the wrong lobby.
export function tournamentLinkFor(code, origin = window.location.origin, relay = null) {
  const url = new URL(origin);
  url.search = '';
  url.hash = '';
  url.searchParams.set('room', code);
  url.searchParams.set('tournament', '1');
  if (relay) url.searchParams.set('relay', relay);
  return url.toString();
}

export function tournamentFromUrl() {
  try {
    const url = new URL(window.location.href);
    return url.searchParams.get('tournament') === '1' ? url.searchParams.get('room') : null;
  } catch {
    return null;
  }
}

export function clearTournamentFromUrl() {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete('room');
    url.searchParams.delete('tournament');
    window.history.replaceState({}, '', url.toString());
  } catch {
    /* no-op */
  }
}

export function makeTournamentPlayerId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `player-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function isRealtimeAvailable() {
  return supabaseConfigured;
}

// A phone companion uses the same LAN relay as the game, but joins as a pose
// client so it does not consume one of the room's two player slots. The phone
// only sends compact pose packets; camera frames never leave the device.
export function createPoseSender(code) {
  let socket = null;
  let closed = false;
  let resolveJoin;
  let rejectJoin;
  let joinTimer;
  const joined = new Promise((resolve, reject) => {
    resolveJoin = (value) => { clearTimeout(joinTimer); resolve(value); };
    rejectJoin = (error) => { clearTimeout(joinTimer); reject(error); };
  });

  return {
    async connect() {
      if (!import.meta.env.DEV) {
        throw new Error('Phone paddle mode is available on the local Vite host for now. Use the deployed room link for network play.');
      }
      if (typeof WebSocket === 'undefined') throw new Error('WebSockets are unavailable in this browser.');
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${protocol}//${window.location.host}${WS_PATH}`);
      socket.addEventListener('open', () => {
        socket.send(encodeMessage('__join', { code, role: 'pose', kind: 'pose' }));
        joinTimer = setTimeout(
          () => rejectJoin(new Error('The game did not accept the phone paddle connection.')),
          8000
        );
      });
      socket.addEventListener('message', (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message.protocol !== MULTIPLAYER_PROTOCOL) return;
          if (message.type === '__joined') resolveJoin(message.data);
        } catch {
          // Ignore malformed relay messages; the relay validates them too.
        }
      });
      socket.addEventListener('error', () => rejectJoin(new Error('Pose relay connection failed.')));
      socket.addEventListener('close', () => {
        closed = true;
        rejectJoin(new Error('The phone paddle connection closed.'));
      });
      await joined;
    },
    send(position, quaternion, confidence = 1, timestamp = performance.now()) {
      if (closed || socket?.readyState !== WebSocket.OPEN) return;
      const p = Array.isArray(position) ? position : [position.x, position.y, position.z];
      const q = Array.isArray(quaternion)
        ? quaternion
        : [quaternion.x, quaternion.y, quaternion.z, quaternion.w];
      if (p.length !== 3 || q.length !== 4 || !p.every(Number.isFinite) || !q.every(Number.isFinite)) return;
      socket.send(encodeMessage('pose', {
        position: p,
        quaternion: q,
        confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
        timestamp: Number.isFinite(timestamp) ? timestamp : 0,
      }));
    },
    close() {
      closed = true;
      if (socket?.readyState === WebSocket.OPEN) socket.send(encodeMessage('__leave'));
      socket?.close();
      socket = null;
    },
  };
}

// Phone paddle pairing — hybrid transport so the phone can connect over LAN
// (fast WebSocket relay) or over the internet (Supabase Realtime) without
// the user choosing. Whichever handshake wins is used; both stay live so a
// mid-game network switch does not drop the controller.
//
// The phone and desktop share the same PHONE_CHANNEL_PREFIX room so either
// pipe can carry phone-pose / phone-haptic / cv-status messages.
export function createPhonePairRoom({ code }) {
  if (!isValidRoomCode(code)) throw new Error('Invalid phone room code.');
  const handlers = {};
  const opponentSubscribers = new Set();
  const closedSubscribers = new Set();
  let opponentPresent = false;
  let closed = false;
  let wsSocket = null;
  let supaChannel = null;
  let supaClient = null;
  let wsLanUrls = [];
  let wsConnected = false;
  let supaConnected = false;

  function notifyOpponent(present) {
    if (present === opponentPresent) return;
    opponentPresent = present;
    opponentSubscribers.forEach((cb) => cb(present));
  }
  function dispatch(type, data) {
    const handler = handlers[type];
    if (handler) handler(data);
    // Any phone activity implies the phone is present, which speeds up the
    // "waiting for phone" state without waiting for explicit presence.
    if (['phone-hello', 'phone-pose', 'phone-calibrate'].includes(type)) {
      if (!opponentPresent) notifyOpponent(true);
    }
  }

  async function connectWebSocket() {
    if (typeof WebSocket === 'undefined') return;
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      try {
        wsSocket = new WebSocket(relaySocketUrl(null));
      } catch {
        resolve(null);
        return;
      }
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (ok) {
          wsConnected = true;
          resolve(true);
        } else {
          try { wsSocket?.close(); } catch {}
          wsSocket = null;
          resolve(null);
        }
      };
      timer = setTimeout(() => finish(false), 1400);
      wsSocket.addEventListener('open', () => {
        wsSocket.send(encodeMessage('__join', { code, role: 'host' }));
      });
      wsSocket.addEventListener('message', (event) => {
        const msg = decodeMessage(String(event.data));
        if (!msg) return;
        if (msg.type === '__joined') {
          wsLanUrls = Array.isArray(msg.data?.lanUrls) ? msg.data.lanUrls : [];
          finish(true);
          if (msg.data?.present) notifyOpponent(true);
          return;
        }
        if (msg.type === '__presence') {
          notifyOpponent(Boolean(msg.data?.present));
          return;
        }
        // Phone companion messages arrive here (relay forwards between host and phone)
        dispatch(msg.type, msg.data);
      });
      wsSocket.addEventListener('error', () => finish(false));
      wsSocket.addEventListener('close', () => {
        if (!wsConnected) finish(false);
        else {
          wsConnected = false;
          // Don't mark opponent absent immediately — supabase may still be holding the phone
          if (!supaConnected) notifyOpponent(false);
        }
      });
    });
  }

  async function connectSupabase() {
    supaClient = await loadSupabase();
    if (!supaClient) return null;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        if (ok) { supaConnected = true; resolve(true); } else resolve(null);
      };
      try {
        supaChannel = supaClient.channel(`${PHONE_CHANNEL_PREFIX}${code}`, {
          config: { broadcast: { self: false }, presence: { key: `host-${Date.now()}-${Math.random().toString(36).slice(2,6)}` } },
        });
        supaChannel.on('broadcast', { event: 'phone' }, ({ payload }) => {
          if (!payload || typeof payload.type !== 'string') return;
          dispatch(payload.type, payload.data);
        });
        // Back-compat: phone fallback also broadcasts on generic 'msg' event for SupabaseTransport interop
        supaChannel.on('broadcast', { event: 'msg' }, ({ payload }) => {
          if (!payload || typeof payload.type !== 'string') return;
          dispatch(payload.type, payload.data);
        });
        supaChannel.on('presence', { event: 'sync' }, () => {
          const members = Object.values(supaChannel.presenceState()).flat();
          // Host + at least one phone means someone else is there
          if (members.length >= 2) notifyOpponent(true);
        });
        supaChannel.subscribe(async (status) => {
          if (status === 'SUBSCRIBED') {
            await supaChannel.track({ role: 'host', at: Date.now() });
            finish(true);
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            finish(false);
          }
        });
        setTimeout(() => { if (!settled) finish(false); }, 3000);
      } catch {
        finish(false);
      }
    });
  }

  return {
    code,
    get kind() {
      if (wsConnected && supaConnected) return 'hybrid';
      if (supaConnected) return 'supabase';
      if (wsConnected) return 'websocket';
      return supabaseConfigured ? 'supabase' : 'websocket';
    },
    get lanUrls() { return wsLanUrls; },
    async connect() {
      // Race both transports — first success unlocks the QR instantly.
      // Supabase wins off-LAN in ~400–800ms; WS wins on LAN in ~50ms.
      // Don't wait for the slower timeout before showing the pairing link.
      const wsP = connectWebSocket();
      const supaP = connectSupabase();
      await new Promise((resolve, reject) => {
        let settled = 0;
        const total = 2;
        const handle = (ok) => {
          settled += 1;
          if (ok) resolve();
          else if (settled === total) reject(new Error('Phone pairing failed — check Wi-Fi or Supabase connectivity.'));
        };
        wsP.then((v) => handle(!!v)).catch(() => handle(false));
        supaP.then((v) => handle(!!v)).catch(() => handle(false));
      });
    },
    send(type, data) {
      if (wsSocket?.readyState === WebSocket.OPEN) wsSocket.send(encodeMessage(type, data));
      if (supaChannel) supaChannel.send({ type: 'broadcast', event: 'phone', payload: { type, data } });
    },
    on(type, cb) { handlers[type] = cb; },
    onOpponent(cb) {
      opponentSubscribers.add(cb);
      cb(opponentPresent);
    },
    onClosed(cb) {
      closedSubscribers.add(cb);
      if (closed) cb();
    },
    get opponentPresent() { return opponentPresent; },
    close() {
      if (wsSocket) {
        if (wsSocket.readyState === WebSocket.OPEN) try { wsSocket.send(encodeMessage('__leave')); } catch {}
        try { wsSocket.close(); } catch {}
      }
      wsSocket = null;
      wsConnected = false;
      if (supaChannel) supaClient?.removeChannel(supaChannel);
      supaChannel = null;
      supaClient = null;
      supaConnected = false;
      opponentPresent = false;
      closed = true;
      closedSubscribers.forEach((cb) => cb());
      opponentSubscribers.clear();
      closedSubscribers.clear();
    },
  };
}

class SupabaseTransport {
  constructor(code, role) {
    this.code = code;
    this.role = role;
    this.clientId = clientId();
    this.handlers = {};
    this.onOpponent = null;
    this.channel = null;
    this.client = null;
  }

  get kind() { return 'supabase'; }

  async connect() {
    this.client = await loadSupabase();
    if (!this.client) {
      throw new Error('Supabase Realtime is not configured for this build.');
    }
    this.channel = this.client.channel(`${CHANNEL_PREFIX}${this.code}`, {
      config: { broadcast: { self: false }, presence: { key: this.clientId } },
    });
    this.channel.on('broadcast', { event: 'msg' }, ({ payload }) => {
      const handler = this.handlers[payload.type];
      if (handler) handler(payload.data);
    });
    this.channel.on('presence', { event: 'sync' }, () => {
      const state = this.channel.presenceState();
      const members = Object.entries(state)
        .flatMap(([key, values]) => (values || []).map((value) => ({ ...value, key })))
        // Elected by presence key, not by a device clock. Two phones whose
        // clocks disagree by a few seconds would otherwise each believe they
        // arrived first, and both would run the simulation — the exact failure
        // that makes a match look like the ball is in two places at once.
        // Sorting a shared string is the one ordering both ends compute the
        // same way with nothing to synchronise.
        .sort((a, b) => a.key.localeCompare(b.key));
      const first = members[0];
      // Supabase does not assign roles. Elect the same client on both ends so
      // two people who both press Join still get one authoritative host.
      if (first) this.role = first.key === this.clientId ? 'host' : 'guest';
      this.onOpponent?.(members.length >= 2);
    });
    await new Promise((resolve, reject) => {
      this.channel.subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await this.channel.track({
            id: this.clientId,
            role: this.role,
            at: Date.now(),
          });
          resolve();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          reject(
            new Error('Realtime channel error — check Supabase Realtime is enabled.')
          );
        }
      });
    });
  }

  send(type, data) {
    this.channel?.send({ type: 'broadcast', event: 'msg', payload: { type, data } });
  }

  on(type, cb) {
    this.handlers[type] = cb;
  }

  close() {
    if (this.channel) this.client?.removeChannel(this.channel);
    this.channel = null;
    this.client = null;
  }
}

// Supabase only introduces the two browsers. Once the SDP exchange is done,
// game packets use a WebRTC data channel directly between them. On the same
// Wi-Fi this resolves to a LAN candidate automatically, with no host process
// or IP address for players to manage.
class WebRTCTransport {
  constructor(code, role) {
    this.code = code;
    this.role = role;
    this.handlers = {};
    this.onOpponent = null;
    this.onClosed = null;
    this.channel = null;
    this.pc = null;
    this.data = null;
    this.pendingCandidates = [];
    this.offerStarted = false;
    this.connected = false;
    this.relayPeerPresent = false;
    this.opponentPresent = false;
    this.client = null;
  }

  async connect() {
    this.client = await loadSupabase();
    if (!this.client) {
      throw new Error('Supabase Realtime is not configured for this build.');
    }
    this.channel = this.client.channel(`${CHANNEL_PREFIX}${this.code}`, {
      config: { broadcast: { self: false }, presence: { key: this.role } },
    });
    this.channel.on('broadcast', { event: 'signal' }, ({ payload }) => {
      this._handleSignal(payload).catch((error) => {
        console.error('WebRTC signalling failed', error);
        this.onClosed?.(error.message);
      });
    });
    // Relayed game packets. The same channel that carries signalling carries
    // the match when the peer connection cannot be established, which is the
    // only thing standing between a symmetric NAT and two players who simply
    // never see each other's ball. When the direct channel is open it is
    // preferred — lower latency, no relay hop — and the copy arriving here is
    // dropped so a packet is never applied twice.
    this.channel.on('broadcast', { event: 'msg' }, ({ payload }) => {
      if (this.data?.readyState === 'open') return;
      const handler = this.handlers[payload?.type];
      if (handler) handler(payload.data);
    });
    this.channel.on('presence', { event: 'sync' }, () => this._onPresence());

    await new Promise((resolve, reject) => {
      this.channel.subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          this.channel.track({ role: this.role, at: Date.now() });
          resolve();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          reject(new Error('Realtime signalling failed — check Supabase Realtime.'));
        }
      });
    });
  }

  _onPresence() {
    const peers = Object.values(this.channel.presenceState()).flat();
    const guestPresent = peers.some((peer) => peer.role === 'guest');
    const hostPresent = peers.some((peer) => peer.role === 'host');
    // Presence is the fallback's liveness signal: with the relayed path there
    // is no connection state to read, so "the other player is in the room" is
    // what lets the host start serving even when WebRTC never opened.
    this.relayPeerPresent = this.role === 'host' ? guestPresent : hostPresent;
    this._updatePresent();
    if (this.role === 'host' && guestPresent && !this.offerStarted) {
      this.offerStarted = true;
      this._startOffer().catch((error) => {
        console.error('WebRTC offer failed', error);
        this.onClosed?.(error.message);
      });
    }
    if (!guestPresent && !this.connected) this.offerStarted = false;
  }

  _createPeer(host) {
    if (this.pc) return this.pc;
    const pc = new RTCPeerConnection({ iceServers: iceServers() });
    this.pc = pc;
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this._signal('candidate', candidate.toJSON());
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') this._setConnected(true);
      if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
        this._setConnected(false);
      }
    };
    if (host) this._attachDataChannel(pc.createDataChannel('flyball'));
    else pc.ondatachannel = ({ channel }) => this._attachDataChannel(channel);
    return pc;
  }

  _attachDataChannel(channel) {
    this.data = channel;
    channel.onopen = () => this._setConnected(true);
    channel.onclose = () => this._setConnected(false);
    channel.onmessage = ({ data }) => {
      const message = decodeMessage(String(data));
      if (!message) return;
      const handler = this.handlers[message.type];
      if (handler) handler(message.data);
    };
  }

  _setConnected(present) {
    this.connected = present;
    this._updatePresent();
  }

  // A player is present if either pipe reaches them — the direct data channel
  // or Presence on the signalling channel. Reporting only the direct channel
  // was why a NAT'd match looked like an empty room: both players were there
  // and neither was told.
  _updatePresent() {
    const present = this.connected || this.relayPeerPresent;
    if (present === this.opponentPresent) return;
    this.opponentPresent = present;
    this.onOpponent?.(present);
  }

  async _startOffer() {
    const pc = this._createPeer(true);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this._signal('offer', pc.localDescription);
  }

  _signal(kind, data) {
    this.channel?.send({
      type: 'broadcast',
      event: 'signal',
      payload: { kind, data },
    });
  }

  async _handleSignal(signal) {
    if (!signal?.kind) return;
    if (signal.kind === 'offer' && this.role === 'guest') {
      const pc = this._createPeer(false);
      await pc.setRemoteDescription(signal.data);
      await this._flushCandidates();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this._signal('answer', pc.localDescription);
    } else if (signal.kind === 'answer' && this.role === 'host' && this.pc) {
      await this.pc.setRemoteDescription(signal.data);
      await this._flushCandidates();
    } else if (signal.kind === 'candidate') {
      if (this.pc?.remoteDescription) await this.pc.addIceCandidate(signal.data);
      else this.pendingCandidates.push(signal.data);
    }
  }

  async _flushCandidates() {
    const candidates = this.pendingCandidates.splice(0);
    for (const candidate of candidates) await this.pc.addIceCandidate(candidate);
  }

  // Which pipe is actually carrying the match right now, as opposed to which
  // one was selected for it. A NAT'd pair starts on 'webrtc' and settles on
  // 'webrtc-relay' once the fallback takes over, and the player is told.
  get kind() {
    if (this.connected) return 'webrtc';
    return this.relayPeerPresent ? 'webrtc-relay' : 'webrtc';
  }

  send(type, data) {
    if (this.data?.readyState === 'open') {
      this.data.send(encodeMessage(type, data));
      return;
    }
    // Nothing direct to send on: the relay carries it instead. Small packets
    // at 30 Hz are well inside a Realtime channel's budget, and a match that
    // is a little later beats a match that never starts.
    this.channel?.send({ type: 'broadcast', event: 'msg', payload: { type, data } });
  }

  on(type, cb) {
    this.handlers[type] = cb;
  }

  close() {
    this.relayPeerPresent = false;
    this._setConnected(false);
    this.data?.close();
    this.pc?.close();
    if (this.channel) this.client?.removeChannel(this.channel);
    this.data = null;
    this.pc = null;
    this.channel = null;
    this.client = null;
  }
}

class BroadcastChannelTransport {
  constructor(code, role) {
    this.code = code;
    this.role = role;
    this.handlers = {};
    this.onOpponent = null;
    this.bc = null;
    this.peers = new Set();
  }

  get kind() { return 'local'; }

  async connect() {
    if (typeof BroadcastChannel === 'undefined') {
      throw new Error(
        'This browser cannot host a local match. Configure Supabase for online play.'
      );
    }
    this.bc = new BroadcastChannel(`${CHANNEL_PREFIX}${this.code}`);
    this.bc.onmessage = (event) => {
      const { type, data, from } = event.data ?? {};
      if (!type || from === this.role) return;
      if (type === '__hello') {
        this.peers.add(from);
        this.bc.postMessage({ type: '__ack', from: this.role });
        this.onOpponent?.(this.peers.size >= 1);
        return;
      }
      if (type === '__ack') {
        this.peers.add(from);
        this.onOpponent?.(this.peers.size >= 1);
        return;
      }
      if (type === '__bye') {
        this.peers.delete(from);
        this.onOpponent?.(this.peers.size >= 1);
        return;
      }
      const handler = this.handlers[type];
      if (handler) handler(data);
    };
    // Announce ourselves so an already-present peer can ack back.
    this.bc.postMessage({ type: '__hello', from: this.role });
  }

  send(type, data) {
    this.bc?.postMessage({ type, data, from: this.role });
  }

  on(type, cb) {
    this.handlers[type] = cb;
  }

  close() {
    if (this.bc) {
      this.bc.postMessage({ type: '__bye', from: this.role });
      this.bc.close();
    }
    this.bc = null;
  }
}

class WebSocketTransport {
  constructor(code, role, relay = null) {
    this.code = code;
    this.role = role;
    this.handlers = {};
    this.onOpponent = null;
    this.socket = null;
    this.lanUrls = [];
    this.onClosed = null;
    this.relay = relay;
  }

  get kind() { return 'websocket'; }

  async connect() {
    if (typeof WebSocket === 'undefined') {
      throw new Error('WebSockets are unavailable in this browser.');
    }
    this.socket = new WebSocket(relaySocketUrl(this.relay));
    await new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.socket?.close();
        reject(error);
      };
      // Four seconds. A relay on the same Wi-Fi answers in milliseconds, so
      // anything longer is a wrong address or a stopped dev server — and with
      // automatic reconnection on top, waiting eight seconds to be told so is
      // eight seconds of a match nobody can see happening.
      const timeout = setTimeout(
        () =>
          fail(
            new Error(
              'LAN relay did not respond. Restart the host with npm run dev and try again.'
            )
          ),
        4000
      );
      this.socket.addEventListener('open', () => {
        this.socket.send(encodeMessage('__join', { code: this.code, role: this.role }));
      });
      this.socket.addEventListener('message', (event) => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (message.protocol !== MULTIPLAYER_PROTOCOL) return;
        if (message.type === '__joined') {
          this.lanUrls = Array.isArray(message.data?.lanUrls) ? message.data.lanUrls : [];
          // The relay decides who hosts, by arrival — see vite.config.js.
          // Whatever this client asked for, this is what it is.
          if (message.data?.role) this.role = message.data.role;
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            resolve();
          }
          this.onOpponent?.(Boolean(message.data?.present));
          return;
        }
        if (message.type === '__presence') {
          this.onOpponent?.(Boolean(message.data?.present));
          return;
        }
        const handler = this.handlers[message.type];
        if (handler) handler(message.data);
      });
      this.socket.addEventListener('error', () =>
        fail(new Error('LAN relay connection failed.'))
      );
      this.socket.addEventListener('close', (event) => {
        this.onOpponent?.(false);
        // Distinct from "the opponent stepped away": the room itself is gone,
        // and nothing either player does will reach the other until they open
        // a new one. Said out loud rather than left as a match that quietly
        // never resumes.
        if (settled) this.onClosed?.(event.reason);
        // The relay says why it hung up — "Room is full" above all — and that
        // is the one thing the player needs to know. Swallowing it leaves
        // them staring at a lobby that simply never connects.
        fail(new Error(event.reason || 'LAN relay closed before joining the room.'));
      });
    });
  }

  send(type, data) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(encodeMessage(type, data));
    }
  }

  on(type, cb) {
    this.handlers[type] = cb;
  }

  close() {
    if (this.socket) {
      if (this.socket.readyState === WebSocket.OPEN) {
        this.socket.send(encodeMessage('__leave'));
      }
      this.socket.close();
    }
    this.socket = null;
  }
}

// Create a room handle. role is 'host' (created the game) or 'guest' (joined).
export function createRoom({ code, role, transport: requested = 'auto', relay = null }) {
  // Checked here as well as in the relay. A malformed code used to travel to
  // the server and come back as a closed socket with a reason nobody reads,
  // which looks exactly like a room that does not exist.
  if (!isValidRoomCode(code)) throw new Error('Invalid room code.');
  if ((requested === 'supabase' || requested === 'webrtc') && !supabaseConfigured) {
    throw new Error(
      'Online multiplayer needs VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.'
    );
  }
  const useWebRTC =
    requested === 'webrtc' || (requested === 'auto' && supabaseConfigured);
  // Keep the Vite relay as a no-account development fallback. Production
  // matches use Supabase for signalling and direct WebRTC for game packets.
  const useWebSocket =
    requested === 'websocket' ||
    (requested === 'auto' && !useWebRTC && ENV.DEV);
  const useSupabase =
    requested === 'supabase';
  const transport = useWebRTC
    ? new WebRTCTransport(code, role)
    : useWebSocket
    ? new WebSocketTransport(code, role, relay)
    : useSupabase
      ? new SupabaseTransport(code, role)
      : new BroadcastChannelTransport(code, role);

  let opponentPresent = false;
  let closed = false;
  const opponentSubscribers = new Set();
  const closedSubscribers = new Set();
  transport.onClosed = (reason) => {
    if (closed) return;
    closed = true;
    closedSubscribers.forEach((cb) => cb(reason));
  };
  transport.onOpponent = (present) => {
    if (present === opponentPresent) return;
    opponentPresent = present;
    opponentSubscribers.forEach((cb) => cb(present));
  };

  return {
    code,
    // Read through to the transport: over the LAN relay the server assigns
    // this on arrival, so it can differ from what was requested. Callers must
    // read it *after* connect() rather than assuming what they asked for.
    get role() {
      return transport.role ?? role;
    },
    // Read through for the same reason: a WebRTC match that fell back to the
    // relayed channel reports that, instead of claiming a direct link it does
    // not have.
    get kind() {
      return transport.kind ?? (useWebRTC ? 'webrtc' : useWebSocket ? 'websocket' : useSupabase ? 'supabase' : 'local');
    },
    get relayed() {
      return transport.kind === 'webrtc-relay';
    },
    async connect() {
      await transport.connect();
    },
    send(type, data) {
      transport.send(type, data);
    },
    on(type, cb) {
      transport.on(type, cb);
    },
    onOpponent(cb) {
      opponentSubscribers.add(cb);
      // Fire immediately with current state so late subscribers are in sync.
      cb(opponentPresent);
    },
    // The room died under us — server restarted, network dropped, laptop lid
    // closed. Only the LAN relay can tell; the other transports have nothing
    // to report it with.
    onClosed(cb) {
      closedSubscribers.add(cb);
      if (closed) cb();
    },
    get opponentPresent() {
      return opponentPresent;
    },
    get lanUrls() {
      return transport.lanUrls ?? [];
    },
    close() {
      transport.close();
      opponentSubscribers.clear();
      closedSubscribers.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Four-player tournament lobby
//
// The lobby is intentionally separate from a live match room. Supabase
// Broadcast/Presence can hold all four bracket entrants, then each scheduled
// pair gets the established two-player WebRTC room above. Keeping the two
// channels separate means idle semifinalists cannot receive or influence a
// different table's paddle or ball packets.
// ---------------------------------------------------------------------------

function normaliseTournamentPlayer(player) {
  const id = String(player?.id ?? '').trim();
  if (!id) throw new Error('Tournament player id is required.');
  const name = String(player?.name ?? 'Player').trim().slice(0, 24) || 'Player';
  const joinedAt = Number(player?.joinedAt) || Date.now();
  return { id, name, joinedAt };
}

function sortTournamentPlayers(players) {
  const unique = new Map();
  for (const raw of players ?? []) {
    try {
      const player = normaliseTournamentPlayer(raw);
      const previous = unique.get(player.id);
      if (!previous || player.joinedAt < previous.joinedAt) unique.set(player.id, player);
    } catch {
      // A malformed presence payload is not a tournament entrant.
    }
  }
  return [...unique.values()].sort(
    (a, b) => a.joinedAt - b.joinedAt || a.id.localeCompare(b.id)
  );
}

class TournamentTransportBase {
  constructor(code, player) {
    this.code = code;
    this.player = normaliseTournamentPlayer(player);
    this.handlers = {};
    this.rosterSubscribers = new Set();
    this.onClosed = null;
    this.closed = false;
    this._players = [this.player];
  }

  _notifyClosed(reason) {
    if (this.closed) return;
    this.closed = true;
    this.onClosed?.(reason);
  }

  get players() {
    return this._players.map((player) => ({ ...player }));
  }

  on(type, cb) {
    this.handlers[type] = cb;
  }

  onRoster(cb) {
    this.rosterSubscribers.add(cb);
    cb(this.players);
  }

  _setPlayers(players) {
    const next = sortTournamentPlayers(players);
    const previous = JSON.stringify(this._players);
    this._players = next;
    if (JSON.stringify(next) !== previous) {
      const snapshot = this.players;
      this.rosterSubscribers.forEach((cb) => cb(snapshot));
    }
  }

  _dispatch(payload) {
    if (!payload || typeof payload.type !== 'string') return;
    this.handlers[payload.type]?.(payload.data);
  }
}

class SupabaseTournamentTransport extends TournamentTransportBase {
  constructor(code, player) {
    super(code, player);
    this.channel = null;
    this.client = null;
  }

  async connect() {
    this.client = await loadSupabase();
    if (!this.client) {
      throw new Error('Supabase Realtime is not configured for this build.');
    }
    this.channel = this.client.channel(`${CHANNEL_PREFIX}tournament-${this.code}`, {
      config: { broadcast: { self: false }, presence: { key: this.player.id } },
    });
    this.channel.on('broadcast', { event: 'tournament' }, ({ payload }) => {
      this._dispatch(payload);
    });
    this.channel.on('presence', { event: 'sync' }, () => {
      this._setPlayers(Object.values(this.channel.presenceState()).flat());
    });
    let subscribed = false;
    await new Promise((resolve, reject) => {
      this.channel.subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          subscribed = true;
          resolve();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          // Before SUBSCRIBED this is a failure to connect and the caller
          // decides what to do. After it, the lobby we were already using has
          // gone — say so, rather than letting a bracket quietly stop syncing.
          if (subscribed) this._notifyClosed('Tournament lobby disconnected');
          else reject(new Error('Tournament lobby could not connect to Realtime.'));
        } else if (status === 'CLOSED' && subscribed) {
          this._notifyClosed('Tournament lobby closed');
        }
      });
    });
    await this.channel.track(this.player);
    this._setPlayers(Object.values(this.channel.presenceState()).flat());
  }

  send(type, data) {
    this.channel?.send({
      type: 'broadcast',
      event: 'tournament',
      payload: { type, data },
    });
  }

  close() {
    if (this.channel) this.client?.removeChannel(this.channel);
    this.channel = null;
    this.client = null;
    this.rosterSubscribers.clear();
  }
}

class BroadcastTournamentTransport extends TournamentTransportBase {
  constructor(code, player) {
    super(code, player);
    this.bc = null;
    this.members = new Map([[this.player.id, this.player]]);
  }

  async connect() {
    if (typeof BroadcastChannel === 'undefined') {
      throw new Error('This browser cannot open a local tournament lobby.');
    }
    this.bc = new BroadcastChannel(`${CHANNEL_PREFIX}tournament-${this.code}`);
    this.bc.onmessage = ({ data }) => {
      if (!data || data.from === this.player.id) return;
      if (data.type === '__tournament-hello') {
        try {
          const entrant = normaliseTournamentPlayer(data.player);
          this.members.set(entrant.id, entrant);
          this._setPlayers([...this.members.values()]);
          this._sendRoster();
        } catch {
          /* ignore malformed hello */
        }
      } else if (data.type === '__tournament-roster') {
        for (const raw of data.players ?? []) {
          try {
            const entrant = normaliseTournamentPlayer(raw);
            this.members.set(entrant.id, entrant);
          } catch {
            /* ignore malformed roster entry */
          }
        }
        this._setPlayers([...this.members.values()]);
      } else if (data.type === '__tournament-bye') {
        this.members.delete(data.playerId);
        this._setPlayers([...this.members.values()]);
      } else if (data.type === 'tournament') {
        this._dispatch(data.payload);
      }
    };
    this.bc.postMessage({ type: '__tournament-hello', from: this.player.id, player: this.player });
    this._setPlayers([...this.members.values()]);
  }

  _sendRoster() {
    this.bc?.postMessage({
      type: '__tournament-roster',
      from: this.player.id,
      players: [...this.members.values()],
    });
  }

  send(type, data) {
    this.bc?.postMessage({ type: 'tournament', from: this.player.id, payload: { type, data } });
  }

  close() {
    this.bc?.postMessage({ type: '__tournament-bye', from: this.player.id, playerId: this.player.id });
    this.bc?.close();
    this.bc = null;
    this.rosterSubscribers.clear();
  }
}

class WebSocketTournamentTransport extends TournamentTransportBase {
  constructor(code, player, relay = null) {
    super(code, player);
    this.socket = null;
    this.relay = relay;
    this.lanUrls = [];
  }

  async connect() {
    if (typeof WebSocket === 'undefined') {
      throw new Error('WebSockets are unavailable in this browser.');
    }
    this.socket = new WebSocket(relaySocketUrl(this.relay));
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };
      const timeout = setTimeout(
        () => finish(new Error('LAN tournament relay did not respond. Restart npm run dev and try again.')),
        4000
      );
      this.socket.addEventListener('open', () => {
        this.socket.send(
          encodeMessage('__tournament-join', { code: this.code, player: this.player })
        );
      });
      this.socket.addEventListener('message', ({ data }) => {
        const message = decodeMessage(String(data));
        if (!message) return;
        if (message.type === '__tournament-joined') {
          this.lanUrls = Array.isArray(message.data?.lanUrls) ? message.data.lanUrls : [];
          this._setPlayers(message.data?.players);
          finish();
        } else if (message.type === '__tournament-roster') {
          this._setPlayers(message.data?.players);
        } else if (message.type === 'tournament') {
          this._dispatch(message.data);
        }
      });
      this.socket.addEventListener('error', () => finish(new Error('LAN tournament relay connection failed.')));
      this.socket.addEventListener('close', (event) => {
        if (!settled) finish(new Error(event.reason || 'LAN tournament relay closed before joining.'));
        else this._notifyClosed(event.reason || 'LAN tournament relay closed');
      });
    });
  }

  send(type, data) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(encodeMessage('tournament', { type, data }));
    }
  }

  close() {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(encodeMessage('__tournament-leave'));
    }
    this.socket?.close();
    this.socket = null;
    this.rosterSubscribers.clear();
  }
}

// A room has exactly four seeded entrants. The first entrant coordinates the
// canonical bracket; membership itself comes from Presence (or the LAN relay),
// not a fragile client-maintained counter.
export function createTournamentRoom({ code, player, transport: requested = 'auto', relay = null }) {
  if (!isValidRoomCode(code)) throw new Error('Invalid tournament room code.');
  const localPlayer = normaliseTournamentPlayer(player);
  if ((requested === 'supabase') && !supabaseConfigured) {
    throw new Error('Online tournaments need VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.');
  }
  const useSupabase = requested === 'supabase' || (requested === 'auto' && supabaseConfigured);
  const useWebSocket = requested === 'websocket' || (requested === 'auto' && !useSupabase && ENV.DEV);
  const transport = useSupabase
    ? new SupabaseTournamentTransport(code, localPlayer)
    : useWebSocket
      ? new WebSocketTournamentTransport(code, localPlayer, relay)
      : new BroadcastTournamentTransport(code, localPlayer);

  const rosterSubscribers = new Set();
  const admitted = (players) => players.slice(0, 4);
  const notify = (players) => {
    const accepted = admitted(players);
    const member = accepted.some((entrant) => entrant.id === localPlayer.id);
    rosterSubscribers.forEach((cb) => cb(accepted, { total: players.length, admitted: member }));
  };
  transport.onRoster(notify);

  return {
    code,
    player: { ...localPlayer },
    get kind() {
      return useSupabase ? 'supabase' : useWebSocket ? 'websocket' : 'local';
    },
    get players() {
      return admitted(transport.players);
    },
    get totalPlayers() {
      return transport.players.length;
    },
    get admitted() {
      return admitted(transport.players).some((entrant) => entrant.id === localPlayer.id);
    },
    get isHost() {
      return this.admitted && this.players[0]?.id === localPlayer.id;
    },
    get lanUrls() {
      return transport.lanUrls ?? [];
    },
    async connect() {
      await transport.connect();
      notify(transport.players);
    },
    send(type, data) {
      transport.send(type, data);
    },
    on(type, cb) {
      transport.on(type, cb);
    },
    onRoster(cb) {
      rosterSubscribers.add(cb);
      notify(transport.players);
    },
    // The bracket lost its transport — server stopped, network dropped. The
    // caller can reopen the same room with the same player id and keep the
    // slot it already has.
    onClosed(cb) {
      transport.onClosed = cb;
      if (transport.closed) cb();
    },
    close() {
      transport.closed = true; // deliberate: never reported as a lost lobby
      rosterSubscribers.clear();
      transport.close();
    },
  };
}

function relaySocketUrl(relay) {
  if (!relay) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}${WS_PATH}`;
  }

  const raw = /^wss?:\/\//i.test(relay) || /^https?:\/\//i.test(relay)
    ? relay
    : `wss://${relay}`;
  const url = new URL(raw);
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  if (!url.port) url.port = '5173';
  url.pathname = WS_PATH;
  url.search = '';
  url.hash = '';
  return url.toString();
}
