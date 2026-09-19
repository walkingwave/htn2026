import { supabase } from './leaderboard.js';

// Networking for online versus. Two interchangeable transports sit behind one
// interface so the game code never cares how bytes move:
//   - SupabaseTransport: Realtime broadcast + presence. Works cross-device
//     whenever VITE_SUPABASE_URL/ANON_KEY are configured.
//   - BroadcastChannelTransport: same-origin fallback so two browser tabs on
//     one machine can play with no backend at all (great for local demos).
//
// Message model: send(type, data) / on(type, cb). Reserved control messages are
// prefixed with '__' and handled internally to drive opponent presence.

const CHANNEL_PREFIX = 'flyball-room-';

export function makeRoomCode() {
  // Ambiguity-free alphabet (no O/0/I/1) for codes that are easy to read aloud.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i += 1) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}

export function roomLinkFor(code) {
  const url = new URL(window.location.href);
  url.pathname = '/live-game';
  url.searchParams.set('room', code);
  url.hash = '';
  return url.toString();
}

export function roomFromUrl() {
  try {
    return new URL(window.location.href).searchParams.get('room');
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

// Tournament lobby links use a separate `?t=` param so they don't collide with
// 1v1 versus `?room=` links. Kept on the current path so the shared link loads
// the same app (no server-side route needed).
export function tourneyLinkFor(code) {
  const url = new URL(window.location.href);
  url.searchParams.delete('room');
  url.searchParams.set('t', code);
  url.hash = '';
  return url.toString();
}

export function tourneyFromUrl() {
  try {
    return new URL(window.location.href).searchParams.get('t');
  } catch {
    return null;
  }
}

export function clearTourneyFromUrl() {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete('t');
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
          reject(new Error('Realtime channel error — check Supabase Realtime is enabled.'));
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
      throw new Error('This browser cannot host a local match. Configure Supabase for online play.');
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

// Create a room handle. role is 'host' (created the game) or 'guest' (joined a link).
export function createRoom({ code, role }) {
  const transport = supabase
    ? new SupabaseTransport(code, role)
    : new BroadcastChannelTransport(code, role);
  let opponentPresent = false;
  const opponentSubscribers = new Set();
  transport.onOpponent = (present) => {
    if (present === opponentPresent) return;
    opponentPresent = present;
    opponentSubscribers.forEach((cb) => cb(present));
  };
  return {
    code,
    role,
    kind: supabase ? 'supabase' : 'local',
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
    get opponentPresent() {
      return opponentPresent;
    },
    close() {
      transport.close();
      opponentSubscribers.clear();
    },
  };
}
