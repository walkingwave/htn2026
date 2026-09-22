import './ui.css';
import { createPoseSender } from './net.js';
import { MarkerPaddleTracker, TRACKER_STATE } from './vision/markerPaddleTracker.js';

export class PhonePoseCompanion {
  constructor(code) {
    this.code = String(code || '').trim().toUpperCase();
    this.tracker = null;
    this.sender = null;
    this.frame = null;
    this.frameHandle = null;
    this.overlay = null;
    this.status = null;
    this.calibrateButton = null;
  }

  async start() {
    if (!/^[A-Z0-9]{4,32}$/.test(this.code)) throw new Error('Invalid pose room code.');
    this._buildOverlay();
    this._setStatus('Connecting to the game…');
    this.sender = createPoseSender(this.code);
    await this.sender.connect();

    this.tracker = new MarkerPaddleTracker();
    this.tracker.attachDebugCanvas(this.frame);
    this.tracker.predictionLead = 0.08;
    this.tracker.onState = (state, error) => {
      if (state === TRACKER_STATE.CALIBRATING) this._setStatus('Show the marked paddle, then tap Calibrate.');
      else if (state === TRACKER_STATE.TRACKING) this._setStatus('Tracking live — keep the whole paddle visible.');
      else if (state === TRACKER_STATE.LOST) this._setStatus('Paddle lost — move it back into view.');
      else if (state === TRACKER_STATE.ERROR) this._setStatus(error || 'Camera unavailable.');
    };
    await this.tracker.start();
    this._sendLoop();
  }

  _sendLoop() {
    if (!this.tracker || !this.sender) return;
    if (this.tracker.state === TRACKER_STATE.TRACKING) {
      this.sender.send(
        this.tracker.position,
        this.tracker.quaternion,
        this.tracker.confidence,
        performance.now()
      );
      this._setConfidence(this.tracker.confidence);
    }
    this.frameHandle = requestAnimationFrame(() => this._sendLoop());
  }

  _buildOverlay() {
    const overlay = document.createElement('main');
    overlay.className = 'phone-pose';
    overlay.innerHTML = `
      <div class="phone-pose__eyebrow">PADDLELAB · PHONE CAMERA</div>
      <h1>Track the paddle</h1>
      <p>Room <b data-pose-code></b> · keep the marker board in frame.</p>
      <canvas data-pose-frame width="640" height="480"></canvas>
      <div class="phone-pose__status" data-pose-status></div>
      <div class="phone-pose__confidence" data-pose-confidence>NO SIGNAL</div>
      <button class="key" data-pose-calibrate>Calibrate neutral pose</button>
      <p class="phone-pose__help">Use the same Wi‑Fi as the game host. Camera frames stay on this phone; only pose data is sent.</p>
    `;
    document.body.appendChild(overlay);
    this.overlay = overlay;
    this.frame = overlay.querySelector('[data-pose-frame]');
    this.status = overlay.querySelector('[data-pose-status]');
    this.calibrateButton = overlay.querySelector('[data-pose-calibrate]');
    overlay.querySelector('[data-pose-code]').textContent = this.code;
    this.calibrateButton.onclick = () => {
      if (!this.tracker?.calibrateColour()) this._setStatus('Show the marked paddle before calibrating.');
    };
  }

  _setStatus(text) {
    if (this.status) this.status.textContent = text;
  }

  _setConfidence(confidence) {
    const label = confidence > 0.8 ? 'LOCKED' : confidence > 0.45 ? 'WEAK' : 'LOW CONFIDENCE';
    const node = this.overlay?.querySelector('[data-pose-confidence]');
    if (node) node.textContent = `${label} · ${Math.round(confidence * 100)}%`;
  }

  stop() {
    if (this.frameHandle !== null) cancelAnimationFrame(this.frameHandle);
    this.frameHandle = null;
    this.tracker?.stop();
    this.sender?.close();
    this.tracker = null;
    this.sender = null;
    this.overlay?.remove();
    this.overlay = null;
  }
}
