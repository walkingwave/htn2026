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
    ) return null;
    return message;
  } catch {
    return null;
  }
}

export function isClientMessage(message) {
  return Boolean(message && (message.type === '__join' || message.type === '__leave' ||
    message.type === 'paddle' || message.type === 'state' || message.type === 'join' ||
    message.type === 'roster' || message.type === 'bracket'));
}
