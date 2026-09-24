import './phone.css';
import { encodeMessage, decodeMessage } from './multiplayerProtocol.js';
import { markerBoardMarkup } from './phoneMarkers.js';
import { loadSupabase, supabaseConfigured } from './supabaseClient.js';

const params = new URLSearchParams(window.location.search);
const code = (params.get('phone') || '').toUpperCase();
const relay = params.get('relay');
const app = document.querySelector('#phone-app') || document.body;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const now = () => performance.now();

const state = {
  connected: false,
  transport: 'connecting',
  permission: false,
  calibrated: false,
  beta: 0,
  gamma: 0,
  zeroBeta: 0,
  zeroGamma: 0,
  lastSent: 0,
  lastFlick: -Infinity,
  lastHealth: 0,
  gravity: 9.81,
  swingArmed: true,
  reconnectTimer: null,
  reconnectAttempts: 0,
  confirmed: false,
  cvLocked: false,
};

const PHONE_CHANNEL = code ? `flyball-phone-${code}` : null;

app.innerHTML = `
  <main class="phone-shell">
    <div class="crt" aria-hidden="true"></div>
    <div class="phone-brand"><span>Paddle</span>·Lab XR <em>PHONE PADDLE</em></div>
    <section class="phone-card">
      <p class="phone-kicker">PHONE PADDLE — HOLD LIKE A RACKET</p>
      <h1>Tilt to aim.<br>Flick to swing.</h1>
      <p class="phone-copy">Your laptop owns the table and physics. This phone is just the face angle and the swing.</p>

      <div class="phone-steps" aria-hidden="true">
        <div class="phone-step" data-step="connect">1 · link</div>
        <div class="phone-step" data-step="motion">2 · motion</div>
        <div class="phone-step" data-step="calibrate">3 · calibrate</div>
        <div class="phone-step" data-step="ready">4 · ready</div>
      </div>

      <div class="phone-status" data-status><span class="phone-dot" data-dot></span><span data-status-text>Connecting to room <b>${code || '—'}</b>…</span></div>
      <button class="phone-button" data-start>Enable motion controls</button>
      <button class="phone-button phone-button--secondary" data-calibrate hidden>Calibrate neutral pose</button>
      <button class="phone-button phone-button--confirm" data-confirm hidden>Confirm phone and start</button>
      <div class="phone-meter"><span data-meter></span></div>
      <div class="phone-meter__label" data-meter-label>tilt to see aim — flick forward to swing</div>
      <div class="phone-cv-target" aria-label="Keep this marker board visible to the desktop camera">
        <div class="phone-cv-target__label">KEEP THIS FACING THE DESKTOP CAMERA</div>
        <div class="phone-marker-board">${markerBoardMarkup()}</div>
      </div>
      <p class="phone-help" data-help>Portrait, screen facing the ball. Keep the four markers visible to the laptop camera.</p>
    </section>
    <footer class="phone-footer">Keep the phone secure · <span data-transport>connecting…</span> · haptics on contact</footer>
  </main>`;

const statusWrap = app.querySelector('[data-status]');
const statusText = app.querySelector('[data-status-text]');
const statusDot = app.querySelector('[data-dot]');
const transportLabel = app.querySelector('[data-transport]');
const help = app.querySelector('[data-help]');
const startButton = app.querySelector('[data-start]');
const calibrateButton = app.querySelector('[data-calibrate]');
const confirmButton = app.querySelector('[data-confirm]');
const meter = app.querySelector('[data-meter]');
const steps = {
  connect: app.querySelector('[data-step="connect"]'),
  motion: app.querySelector('[data-step="motion"]'),
  calibrate: app.querySelector('[data-step="calibrate"]'),
  ready: app.querySelector('[data-step="ready"]'),
};

function setStatus(text, tone = '') {
  statusText.textContent = text;
  statusWrap.dataset.tone = tone;
  statusDot.dataset.tone = tone === 'good' ? 'good' : tone === 'bad' ? 'bad' : '';
  // also update transport label colour hint
  if (tone === 'good') statusDot.style.opacity = '1';
}

function setTransport(text) {
  if (transportLabel) transportLabel.textContent = text;
}

function setSteps() {
  const s = state;
  // connect step done when socket/supabase connected
  steps.connect.dataset.done = String(s.connected);
  steps.connect.dataset.active = String(!s.connected);
  steps.motion.dataset.done = String(s.permission);
  steps.motion.dataset.active = String(s.connected && !s.permission);
  steps.calibrate.dataset.done = String(s.calibrated);
  steps.calibrate.dataset.active = String(s.permission && !s.calibrated);
  steps.ready.dataset.done = String(s.confirmed);
  steps.ready.dataset.active = String(s.calibrated && s.cvLocked && !s.confirmed);
  Object.values(steps).forEach((el) => {
    if (el.dataset.done === 'true') el.dataset.active = 'false';
  });
}

function socketUrl() {
  const base = relay || window.location.origin;
  const url = new URL(base.includes('://') ? base : `https://${base}`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/__flyball_ws';
  url.search = '';
  return url.toString();
}

// --- Transport abstraction ---------------------------------------------------
// Tries WebSocket (LAN, fast) then falls back to Supabase Realtime (internet).
// The first successful handshake wins; both can be active if both succeed.

let socket = null;
let supabaseChannel = null;
let activeSend = null;

function wsSend(type, data) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(encodeMessage(type, data));
}
function supaSend(type, data) {
  if (supabaseChannel) supabaseChannel.send({ type: 'broadcast', event: 'phone', payload: { type, data } });
}
function unifiedSend(type, data) {
  // Send on whichever is alive; if both, send on both so host mux picks either
  let sent = false;
  if (socket?.readyState === WebSocket.OPEN) { wsSend(type, data); sent = true; }
  if (supabaseChannel) { supaSend(type, data); sent = true; }
  if (!sent && activeSend) activeSend(type, data);
}

function handleMessage(message) {
  if (!message) return;
  if (message.type === '__joined') {
    state.connected = true;
    setStatus(state.calibrated ? 'Connected · confirm when ready' : 'Connected · enable motion, then calibrate', 'good');
    setTransport(state.transport === 'supabase' ? 'internet · Supabase' : state.transport === 'websocket' ? 'Wi-Fi · direct' : 'connected');
    confirmButton.hidden = !state.calibrated;
    confirmButton.disabled = !state.cvLocked;
    setSteps();
    // Immediately announce sensors so desktop knows we're alive
    unifiedSend('phone-hello', { version: 2, at: Date.now() });
  } else if (message.type === 'phone-cv-status') {
    state.cvLocked = Boolean(message.data?.locked);
    confirmButton.disabled = !state.cvLocked;
    if (state.cvLocked && state.calibrated) setStatus('CV locked · confirm when ready', 'good');
    else if (!state.cvLocked) setStatus('Connected · hold the marker board in the desktop camera', '');
    setSteps();
  } else if (message.type === 'phone-haptic') {
    if (navigator.vibrate) navigator.vibrate(message.data?.pattern || message.data?.duration || 35);
  } else if (message.type === '__presence' && !message.data?.present) {
    state.connected = false;
    setStatus('Desktop disconnected · reconnecting…', 'bad');
    setSteps();
  }
}

let wsFailed = false;
let supaFailed = false;

function connectWebSocket() {
  if (!code) return;
  if (typeof WebSocket === 'undefined') { wsFailed = true; trySupabase(); return; }
  let url;
  try { url = socketUrl(); } catch { wsFailed = true; trySupabase(); return; }
  try { socket = new WebSocket(url); } catch { wsFailed = true; trySupabase(); return; }

  const timeout = setTimeout(() => {
    if (!state.connected) {
      try { socket?.close(); } catch {}
      wsFailed = true;
      setTransport('Wi-Fi unavailable · trying internet…');
      trySupabase();
    }
  }, 1100);

  socket.addEventListener('open', () => {
    socket.send(encodeMessage('__join', { code, role: 'phone', kind: 'phone' }));
    state.transport = 'websocket';
    setTransport('Wi-Fi · connecting…');
  });
  socket.addEventListener('message', (event) => {
    const message = decodeMessage(String(event.data));
    if (!message) return;
    clearTimeout(timeout);
    handleMessage(message);
    if (message.type === '__joined') {
      state.transport = 'websocket';
      setTransport('Wi-Fi · direct');
    }
  });
  socket.addEventListener('error', () => {
    clearTimeout(timeout);
    if (!state.connected) {
      wsFailed = true;
      setTransport('Wi-Fi unavailable · trying internet…');
      trySupabase();
    } else setStatus('Relay hiccup · holding…', 'bad');
  });
  socket.addEventListener('close', () => {
    clearTimeout(timeout);
    if (!state.connected && !supabaseChannel) {
      wsFailed = true;
      scheduleReconnect();
      trySupabase();
    } else if (state.connected) {
      state.connected = false;
      setStatus('Connection lost · reconnecting…', 'bad');
      setSteps();
      scheduleReconnect();
    }
  });
}

async function trySupabase() {
  if (!supabaseConfigured || !PHONE_CHANNEL || supaFailed) {
    if (!supabaseConfigured) setStatus('No internet relay configured — use same Wi-Fi as the laptop.', 'bad');
    return;
  }
  if (supabaseChannel) return; // already trying/connected
  setTransport('internet · Supabase · connecting…');
  try {
    // Loaded on demand so the phone page paints before supabase-js arrives.
    const client = await loadSupabase();
    if (!client || supabaseChannel || supaFailed) return;
    supabaseChannel = client.channel(PHONE_CHANNEL, { config: { broadcast: { self: false }, presence: { key: `phone-${Date.now()}-${Math.random().toString(36).slice(2,6)}` } } });
    supabaseChannel.on('broadcast', { event: 'phone' }, ({ payload }) => {
      if (!payload) return;
      // Supabase wraps as {type,data} already
      handleMessage(payload);
    });
    // Also listen for direct CV status broadcasts that desktop sends as phone-cv-status
    supabaseChannel.on('broadcast', { event: 'msg' }, ({ payload }) => {
      if (payload) handleMessage(payload);
    });
    supabaseChannel.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await supabaseChannel.track({ role: 'phone', at: Date.now() });
        // Simulate __joined for Supabase path so UI unlocks without WS
        if (!state.connected) {
          state.transport = 'supabase';
          setTransport('internet · Supabase');
          handleMessage({ type: '__joined', data: { present: true } });
        }
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        supaFailed = true;
        setStatus('Internet relay error · retrying…', 'bad');
        setTimeout(() => { supaFailed = false; trySupabase(); }, 2500);
      }
    });
  } catch {
    supaFailed = true;
  }
}

function scheduleReconnect() {
  clearTimeout(state.reconnectTimer);
  state.reconnectAttempts += 1;
  const delay = Math.min(4000, 400 * Math.pow(1.6, state.reconnectAttempts));
  state.reconnectTimer = setTimeout(() => {
    if (!state.connected) {
      wsFailed = false;
      supaFailed = false;
      if (socket?.readyState !== WebSocket.OPEN) connectWebSocket();
      if (!supabaseChannel) trySupabase();
    }
  }, delay);
}

function connect() {
  if (!code) return setStatus('This phone link is missing its room code.', 'bad');
  setSteps();
  setTransport('connecting…');
  // Both transports start immediately and race — cuts ~1s of serial wait on slow Wi-Fi
  connectWebSocket();
  trySupabase();
}

function orientationPose() {
  const angle = Number(screen.orientation?.angle || window.orientation || 0);
  const portrait = angle === 0 || angle === 180;
  const beta = state.beta - state.zeroBeta;
  const gamma = state.gamma - state.zeroGamma;
  const x = portrait ? gamma : (angle === 90 ? -beta : beta);
  const y = portrait ? -beta : (angle === 90 ? -gamma : gamma);
  return { x: clamp(x / 35, -1, 1), y: clamp(y / 28, -1, 1) };
}

function sendPose(timestamp, flick = false) {
  if (!state.calibrated) return;
  const hasWs = socket?.readyState === WebSocket.OPEN;
  const hasSupa = Boolean(supabaseChannel);
  if (!hasWs && !hasSupa) return;
  if (!flick && timestamp - state.lastSent < 32) return;
  state.lastSent = timestamp;
  const pose = orientationPose();
  meter.style.transform = `scaleX(${Math.min(1, Math.hypot(pose.x, pose.y) / 1.2)})`;
  unifiedSend('phone-pose', {
    ...pose,
    roll: state.gamma - state.zeroGamma,
    pitch: state.beta - state.zeroBeta,
    beta: state.beta,
    gamma: state.gamma,
    flick,
    at: Date.now(),
  });
  if (timestamp - state.lastHealth > 1400) {
    state.lastHealth = timestamp;
    unifiedSend('phone-hello', { version: 2, at: Date.now() });
  }
}
function onOrientation(event) {
  if (!Number.isFinite(event.beta) || !Number.isFinite(event.gamma)) return;
  state.beta = event.beta; state.gamma = event.gamma;
  if (state.calibrated) sendPose(now());
}
function onMotion(event) {
  const a = event.acceleration; const g = event.accelerationIncludingGravity;
  if (!g || !state.calibrated) return;
  const magnitude = Math.hypot(a?.x || 0, a?.y || 0, a?.z || 0);
  const total = Math.hypot(g.x || 0, g.y || 0, g.z || 0);
  state.gravity = state.gravity * 0.92 + total * 0.08;
  const timestamp = now();
  if (magnitude > 7.5 && timestamp - state.lastFlick > 280 && state.swingArmed) {
    state.lastFlick = timestamp; state.swingArmed = false; sendPose(timestamp, true);
    if (navigator.vibrate) navigator.vibrate(18);
  }
  if (magnitude < 3) state.swingArmed = true;
}
async function enableMotion() {
  try {
    if (!('DeviceMotionEvent' in window) || !('DeviceOrientationEvent' in window)) throw new Error('This browser does not expose motion sensors.');
    if (typeof DeviceMotionEvent.requestPermission === 'function') {
      const motion = await DeviceMotionEvent.requestPermission();
      const orientation = await DeviceOrientationEvent.requestPermission();
      if (motion !== 'granted' || orientation !== 'granted') throw new Error('Motion permission was declined.');
    }
    window.addEventListener('deviceorientation', onOrientation, true);
    window.addEventListener('devicemotion', onMotion, true);
    state.permission = true; startButton.hidden = true; calibrateButton.hidden = false;
    setStatus('Motion enabled · hold still to calibrate', 'good');
    help.textContent = 'Tap calibrate in your neutral ready position, screen flat.';
    setSteps();
    if (navigator.vibrate) navigator.vibrate(20);
    // Nudge desktop that we're ready to calibrate
    unifiedSend('phone-hello', { version: 2, permission: true, at: Date.now() });
  } catch (error) { setStatus(error.message || 'Motion permission failed.', 'bad'); }
}
function calibrate() {
  state.zeroBeta = state.beta; state.zeroGamma = state.gamma; state.calibrated = true;
  calibrateButton.textContent = 'Recalibrate neutral pose';
  confirmButton.hidden = false;
  setStatus(state.cvLocked ? 'Calibrated & CV locked · confirm to start' : 'Calibrated · hold markers to the laptop camera', 'good');
  help.textContent = 'Tilt to aim, then confirm when you are holding the phone securely.';
  unifiedSend('phone-calibrate', { beta: state.zeroBeta, gamma: state.zeroGamma });
  if (navigator.vibrate) navigator.vibrate([20, 30, 20]);
  setSteps();
}
function confirmPhone() {
  if (!state.calibrated || !state.connected) {
    setStatus('Connect and calibrate first.', 'bad');
    return;
  }
  if (!state.cvLocked) {
    // Allow confirm even without CV if user insists — desktop will still gate but we warn
    setStatus('CV not yet locked — hold the markers to the camera, then confirm again.', 'bad');
    // Still send ready so desktop can decide; after 2s we force confirm if user double-taps
    const nowTs = Date.now();
    if (confirmPhone._lastWarn && nowTs - confirmPhone._lastWarn < 4000) {
      // second tap within 4s — force through
    } else {
      confirmPhone._lastWarn = nowTs;
      return;
    }
  }
  state.confirmed = true;
  confirmButton.hidden = true;
  setStatus('Confirmed · tilt to aim, flick to swing', 'good');
  unifiedSend('phone-hello', {
    version: 2,
    ready: true,
    sensors: ['orientation', 'motion'],
    haptics: Boolean(navigator.vibrate),
  });
  if (navigator.vibrate) navigator.vibrate([25, 40, 25]);
  setSteps();
  // Keep sending poses immediately
  sendPose(now(), false);
}
startButton.addEventListener('click', enableMotion); calibrateButton.addEventListener('click', calibrate); confirmButton.addEventListener('click', confirmPhone);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
// Keep screen awake where supported
if ('wakeLock' in navigator) {
  const requestWake = async () => { try { await navigator.wakeLock.request('screen'); } catch {} };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') requestWake(); });
  requestWake();
}
connect();
setSteps();
