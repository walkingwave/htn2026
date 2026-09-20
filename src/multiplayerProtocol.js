// Wire format shared by the browser client and the dev-server relay, which is
// why it lives in its own file: vite.config.js imports it at build time and
// net.js imports it at run time.
//
// Kept byte-compatible with the original flyball implementation so a client
// from either codebase can share a room.

export const MULTIPLAYER_PROTOCOL = 'flyball-multiplayer-v1';
export const MAX_ROOM_CODE_LENGTH = 32;
export const MAX_MESSAGE_BYTES = 16 * 1024;

export function isValidRoomCode(code) {
  return typeof code === 'string' && /^[A-Z0-9-]{1,32}$/i.test(code);
}

export function encodeMessage(type, data = null) {
  return JSON.stringify({ protocol: MULTIPLAYER_PROTOCOL, type, data });
}

export function decodeMessage(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_MESSAGE_BYTES) return null;
  try {
    const message = JSON.parse(raw);
    if (
      !message ||
      message.protocol !== MULTIPLAYER_PROTOCOL ||
      typeof message.type !== 'string' ||
      message.type.length > 32
    ) {
      return null;
    }
    return message;
  } catch {
    return null;
  }
}

// The relay forwards only these. Anything else is dropped rather than
// broadcast, so a malformed or hostile client can't use the room as a
// general-purpose message bus.
const RELAYED = new Set([
  '__join',
  '__leave',
  'paddle',
  'state',
  'phone-hello',
  'phone-pose',
  'phone-calibrate',
  'phone-haptic',
]);

export function isClientMessage(message) {
  return Boolean(message && RELAYED.has(message.type));
}
