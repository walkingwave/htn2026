import { supabase } from './supabaseClient.js';
import { encodeMessage, MULTIPLAYER_PROTOCOL } from './multiplayerProtocol.js';

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
const WS_PATH = '/__flyball_ws';

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

export function isRealtimeAvailable() {
  return Boolean(supabase);
}

class SupabaseTransport {
  constructor(code, role) {
    this.code = code;
    this.role = role;
    this.handlers = {};
    this.onOpponent = null;
    this.channel = null;
  }

  async connect() {
    this.channel = supabase.channel(`${CHANNEL_PREFIX}${this.code}`, {
      config: { broadcast: { self: false }, presence: { key: this.role } },
    });
    this.channel.on('broadcast', { event: 'msg' }, ({ payload }) => {
      const handler = this.handlers[payload.type];
      if (handler) handler(payload.data);
    });
    this.channel.on('presence', { event: 'sync' }, () => {
      const present = Object.keys(this.channel.presenceState()).length >= 2;
      this.onOpponent?.(present);
    });
    await new Promise((resolve, reject) => {
      this.channel.subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          this.channel.track({ role: this.role, at: Date.now() });
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
    if (this.channel) supabase.removeChannel(this.channel);
    this.channel = null;
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
  }

  async connect() {
    this.channel = supabase.channel(`${CHANNEL_PREFIX}${this.code}`, {
      config: { broadcast: { self: false }, presence: { key: this.role } },
    });
    this.channel.on('broadcast', { event: 'signal' }, ({ payload }) => {
      this._handleSignal(payload).catch((error) => {
        console.error('WebRTC signalling failed', error);
        this.onClosed?.(error.message);
      });
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
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });
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
    if (present === this.connected) return;
    this.connected = present;
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

  send(type, data) {
    if (this.data?.readyState === 'open') this.data.send(encodeMessage(type, data));
  }

  on(type, cb) {
    this.handlers[type] = cb;
  }

  close() {
    this._setConnected(false);
    this.data?.close();
    this.pc?.close();
    if (this.channel) supabase.removeChannel(this.channel);
    this.data = null;
    this.pc = null;
    this.channel = null;
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
      const timeout = setTimeout(
        () =>
          fail(
            new Error(
              'LAN relay did not respond. Restart the host with npm run dev and try again.'
            )
          ),
        8000
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
  if ((requested === 'supabase' || requested === 'webrtc') && !supabase) {
    throw new Error(
      'Online multiplayer needs VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.'
    );
  }
  const useWebRTC =
    requested === 'webrtc' || (requested === 'auto' && Boolean(supabase));
  // Keep the Vite relay as a no-account development fallback. Production
  // matches use Supabase for signalling and direct WebRTC for game packets.
  const useWebSocket =
    requested === 'websocket' ||
    (requested === 'auto' && !useWebRTC && import.meta.env.DEV);
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
    kind: useWebRTC ? 'webrtc' : useWebSocket ? 'websocket' : useSupabase ? 'supabase' : 'local',
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
