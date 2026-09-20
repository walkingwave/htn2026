async function request(path, body, init = {}) {
  const response = await fetch(path, {
    ...init,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
    body: JSON.stringify(body),
  });
  const contentType = response.headers.get('content-type') || '';
  if (!response.ok) {
    let message = `${path} failed (${response.status})`;
    if (contentType.includes('application/json')) {
      const data = await response.json().catch(() => null);
      if (data?.error) message = data.error;
    }
    throw new Error(message);
  }
  return contentType.includes('application/json') ? response.json() : response;
}

export function analyzeShot(shot, context = {}) {
  return request('/api/coach/shot', { shot, context });
}

export function summarizeMatch(match) {
  return request('/api/coach/match', { match });
}

let activeNarration = null;
const NARRATION_ENABLED_KEY = 'paddlelab.narration.enabled';
const NARRATOR_MODE_KEY = 'paddlelab.narration.voice';

export function getNarrationSettings() {
  let enabled = true;
  let mode = 'auto';
  try {
    enabled = localStorage.getItem(NARRATION_ENABLED_KEY) !== 'false';
    mode = localStorage.getItem(NARRATOR_MODE_KEY) || 'auto';
  } catch {
    // Defaults are fine when storage is unavailable.
  }
  return { enabled, mode: ['auto', 'a', 'b'].includes(mode) ? mode : 'auto' };
}

export function setNarrationEnabled(enabled) {
  try {
    localStorage.setItem(NARRATION_ENABLED_KEY, String(Boolean(enabled)));
  } catch {
    // Session-only setting.
  }
  if (!enabled) activeNarration?.pause();
  return Boolean(enabled);
}

export function setNarratorMode(mode) {
  const next = ['auto', 'a', 'b'].includes(mode) ? mode : 'auto';
  try {
    localStorage.setItem(NARRATOR_MODE_KEY, next);
  } catch {
    // Session-only setting.
  }
  return next;
}

export async function narrate(text, narrator = 'a') {
  const settings = getNarrationSettings();
  if (!settings.enabled) return;
  const selectedNarrator = settings.mode === 'auto' ? narrator : settings.mode;
  const response = await request('/api/coach/narrate', { text, narrator: selectedNarrator });
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  activeNarration?.pause();
  if (activeNarration?.src) URL.revokeObjectURL(activeNarration.src);
  const audio = new Audio(url);
  activeNarration = audio;
  audio.addEventListener('ended', () => {
    URL.revokeObjectURL(url);
    if (activeNarration === audio) activeNarration = null;
  }, { once: true });
  await audio.play();
}

const PROFILE_THREAD_PREFIX = 'paddlelab.backboard.thread.';

function profileThreadKey(playerId = 'anonymous') {
  return `${PROFILE_THREAD_PREFIX}${String(playerId).trim().slice(0, 64) || 'anonymous'}`;
}

export function recordProfileEvent(event, playerId, threadId, assistantId) {
  let existingThread = threadId;
  try {
    existingThread ||= localStorage.getItem(profileThreadKey(playerId)) || undefined;
  } catch {
    // Private browsing or blocked storage: the event still gets sent.
  }

  return request('/api/profile/event', {
    event,
    playerId,
    threadId: existingThread,
    assistantId,
  }).then((data) => {
    if (data?.threadId) {
      try {
        localStorage.setItem(profileThreadKey(playerId), data.threadId);
      } catch {
        // The server-side event succeeded even if this browser cannot persist.
      }
    }
    return data;
  });
}

export function getProfileSummary(playerId, threadId) {
  let existingThread = threadId;
  try {
    existingThread ||= localStorage.getItem(profileThreadKey(playerId)) || undefined;
  } catch {
    // Profile history is optional if storage is unavailable.
  }
  if (!existingThread) return Promise.reject(new Error('No profile history yet.'));
  return request('/api/profile/summary', { playerId, threadId: existingThread });
}

export function sendInvite(phoneNumber, roomLink) {
  return request('/api/contact/invite', { phoneNumber, roomLink });
}
