import './phone.css';
import { encodeMessage, decodeMessage } from './multiplayerProtocol.js';
import { markerBoardMarkup } from './phoneMarkers.js';

const params = new URLSearchParams(window.location.search);
const code = (params.get('phone') || '').toUpperCase();
const relay = params.get('relay');
const app = document.querySelector('#phone-app') || document.body;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const now = () => performance.now();

const state = {
  connected: false, permission: false, calibrated: false,
  beta: 0, gamma: 0, zeroBeta: 0, zeroGamma: 0,
  lastSent: 0, lastFlick: -Infinity, lastHealth: 0,
  gravity: 9.81, swingArmed: true, reconnectTimer: null, confirmed: false, cvLocked: false,
};

app.innerHTML = `
  <main class="phone-shell">
    <div class="phone-brand"><span>🏓</span> PaddleLab</div>
    <section class="phone-card">
      <p class="phone-kicker">PHONE PADDLE</p>
      <h1>Hold your phone like a racket.</h1>
      <p class="phone-copy">Tilt to aim. Flick forward to swing. Your laptop handles the table, physics, and coaching.</p>
      <div class="phone-status" data-status>Connecting to room <b>${code || '—'}</b>…</div>
      <button class="phone-button" data-start>Enable motion controls</button>
      <button class="phone-button phone-button--secondary" data-calibrate hidden>Calibrate neutral pose</button>
      <button class="phone-button phone-button--confirm" data-confirm hidden>Confirm phone and start</button>
      <div class="phone-meter"><span data-meter></span></div>
      <div class="phone-cv-target" aria-label="Keep this marker board visible to the desktop camera">
        <div class="phone-cv-target__label">KEEP THIS FACING THE DESKTOP CAMERA</div>
        <div class="phone-marker-board">${markerBoardMarkup()}</div>
      </div>
      <p class="phone-help" data-help>Use portrait mode and hold the phone flat, screen facing the ball.</p>
    </section>
    <footer class="phone-footer">Keep the phone secure · motion, haptics, and reconnect are enabled</footer>
  </main>`;

const status = app.querySelector('[data-status]');
const help = app.querySelector('[data-help]');
const startButton = app.querySelector('[data-start]');
const calibrateButton = app.querySelector('[data-calibrate]');
const confirmButton = app.querySelector('[data-confirm]');
const meter = app.querySelector('[data-meter]');

function setStatus(text, tone = '') { status.textContent = text; status.dataset.tone = tone; }
function socketUrl() {
  const base = relay || window.location.origin;
  const url = new URL(base.includes('://') ? base : `https://${base}`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/__flyball_ws'; url.search = ''; return url.toString();
}

let socket;
function connect() {
  if (!code) return setStatus('This phone link is missing its room code.', 'bad');
  try { socket = new WebSocket(socketUrl()); } catch { return setStatus('Could not open the relay.', 'bad'); }
  socket.addEventListener('open', () => socket.send(encodeMessage('__join', { code, role: 'phone', kind: 'phone' })));
  socket.addEventListener('message', (event) => {
    const message = decodeMessage(String(event.data)); if (!message) return;
    if (message.type === '__joined') {
      state.connected = true;
      state.confirmed = false;
      confirmButton.hidden = !state.calibrated;
      confirmButton.disabled = !state.cvLocked;
      setStatus(state.calibrated ? 'Connected · confirm when ready' : 'Connected · enable motion, then calibrate', 'good');
    } else if (message.type === 'phone-cv-status') {
      state.cvLocked = Boolean(message.data?.locked);
      confirmButton.disabled = !state.cvLocked;
      if (state.cvLocked && state.calibrated) setStatus('CV locked · confirm when ready', 'good');
      else if (!state.cvLocked) setStatus('Connected · hold the marker board in the desktop camera', '');
    } else if (message.type === 'phone-haptic') {
      if (navigator.vibrate) navigator.vibrate(message.data?.pattern || message.data?.duration || 35);
    } else if (message.type === '__presence' && !message.data?.present) {
      state.connected = false; setStatus('Desktop disconnected · reconnecting…', 'bad');
    }
  });
  socket.addEventListener('error', () => setStatus('Relay unavailable · retrying…', 'bad'));
  socket.addEventListener('close', () => {
    state.connected = false; setStatus('Connection lost · reconnecting…', 'bad');
    clearTimeout(state.reconnectTimer); state.reconnectTimer = setTimeout(connect, 1200);
  });
}

function orientationPose() {
  const angle = Number(screen.orientation?.angle || window.orientation || 0);
  const portrait = angle === 0 || angle === 180;
  const beta = state.beta - state.zeroBeta;
  const gamma = state.gamma - state.zeroGamma;
  // Landscape rotation swaps the axes, so rotating the phone in either
  // orientation still maps to the same virtual paddle direction.
  const x = portrait ? gamma : (angle === 90 ? -beta : beta);
  const y = portrait ? -beta : (angle === 90 ? -gamma : gamma);
  return { x: clamp(x / 35, -1, 1), y: clamp(y / 28, -1, 1) };
}

function sendPose(timestamp, flick = false) {
  if (!socket || socket.readyState !== WebSocket.OPEN || !state.calibrated) return;
  if (!flick && timestamp - state.lastSent < 33) return;
  state.lastSent = timestamp;
  const pose = orientationPose();
  meter.style.transform = `scaleX(${Math.min(1, Math.hypot(pose.x, pose.y) / 1.2)})`;
  socket.send(encodeMessage('phone-pose', {
    ...pose,
    roll: state.gamma - state.zeroGamma,
    pitch: state.beta - state.zeroBeta,
    beta: state.beta,
    gamma: state.gamma,
    flick,
    at: Date.now(),
  }));
  if (timestamp - state.lastHealth > 2000) {
    state.lastHealth = timestamp;
    socket.send(encodeMessage('phone-hello', { version: 2, battery: navigator.getBattery ? 'available' : 'unknown', at: Date.now() }));
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
  // Remove gravity with a one-pole filter. This makes the gesture detector
  // respond to a real forward flick instead of a phone simply being tilted.
  const magnitude = Math.hypot(a?.x || 0, a?.y || 0, a?.z || 0);
  const total = Math.hypot(g.x || 0, g.y || 0, g.z || 0);
  state.gravity = state.gravity * 0.92 + total * 0.08;
  const timestamp = now();
  if (magnitude > 7.5 && timestamp - state.lastFlick > 300 && state.swingArmed) {
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
    setStatus('Motion enabled · hold still to calibrate', 'good'); help.textContent = 'Tap calibrate in your neutral ready position.';
  } catch (error) { setStatus(error.message || 'Motion permission failed.', 'bad'); }
}
function calibrate() {
  state.zeroBeta = state.beta; state.zeroGamma = state.gamma; state.calibrated = true;
  calibrateButton.textContent = 'Recalibrate neutral pose';
  confirmButton.hidden = false;
  setStatus('Calibrated · confirm when ready', 'good');
  help.textContent = 'Tilt to aim, then confirm when you are holding the phone securely.';
  socket?.send(encodeMessage('phone-calibrate', { beta: state.zeroBeta, gamma: state.zeroGamma }));
  if (navigator.vibrate) navigator.vibrate([20, 30, 20]);
}
function confirmPhone() {
  if (!state.calibrated || !state.connected || !state.cvLocked) {
    setStatus('Connect, calibrate, and wait for the desktop camera lock.', 'bad');
    return;
  }
  state.confirmed = true;
  confirmButton.hidden = true;
  setStatus('Confirmed · tilt to aim, flick to swing', 'good');
  socket?.send(encodeMessage('phone-hello', {
    version: 2,
    ready: true,
    sensors: ['orientation', 'motion'],
    haptics: Boolean(navigator.vibrate),
  }));
  if (navigator.vibrate) navigator.vibrate([25, 40, 25]);
}
startButton.addEventListener('click', enableMotion); calibrateButton.addEventListener('click', calibrate); confirmButton.addEventListener('click', confirmPhone);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
connect();
