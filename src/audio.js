// Procedural sound effects via WebAudio. Synthesised rather than sampled so
// the bundle stays asset-free, which keeps first load over a LAN dev server
// fast and avoids a second round trip in the Quest browser.
//
// A ping pong hit is essentially a very short pitched click with a noise
// transient, which synthesises convincingly: a fast-decaying sine for the
// body and a filtered noise burst for the contact.

export class Sfx {
  constructor(settings) {
    this.settings = settings;
    this.ctx = null;
    this.master = null;
    this._noiseBuffer = null;
  }

  // Must be called from a user gesture — browsers start AudioContext
  // suspended. The start menu's first click is that gesture.
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;

    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(this.ctx.destination);

    // One second of white noise, reused for every transient
    const len = this.ctx.sampleRate;
    this._noiseBuffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = this._noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  }

  get _enabled() {
    return this.ctx && this.settings.get('sound');
  }

  _click({ frequency, gain, decay, noiseGain, filter }) {
    if (!this._enabled) return;
    const t = this.ctx.currentTime;

    const body = this.ctx.createOscillator();
    body.type = 'sine';
    body.frequency.setValueAtTime(frequency, t);
    body.frequency.exponentialRampToValueAtTime(frequency * 0.55, t + decay);

    const bodyGain = this.ctx.createGain();
    bodyGain.gain.setValueAtTime(gain, t);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, t + decay);

    body.connect(bodyGain).connect(this.master);
    body.start(t);
    body.stop(t + decay + 0.02);

    if (noiseGain > 0) {
      const noise = this.ctx.createBufferSource();
      noise.buffer = this._noiseBuffer;

      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = filter;
      bp.Q.value = 1.1;

      const ng = this.ctx.createGain();
      ng.gain.setValueAtTime(noiseGain, t);
      ng.gain.exponentialRampToValueAtTime(0.0001, t + decay * 0.6);

      noise.connect(bp).connect(ng).connect(this.master);
      noise.start(t);
      noise.stop(t + decay);
    }
  }

  // `speed` scales brightness and level, so a hard drive cracks and a soft
  // touch taps.
  contact(surface, speed = 3) {
    const intensity = Math.min(1, speed / 7);

    switch (surface) {
      case 'table':
        this._click({
          frequency: 1500 + intensity * 700,
          gain: 0.12 + intensity * 0.16,
          decay: 0.05,
          noiseGain: 0.06 + intensity * 0.08,
          filter: 3200,
        });
        break;
      case 'paddle':
        this._click({
          frequency: 620 + intensity * 260,
          gain: 0.2 + intensity * 0.2,
          decay: 0.08,
          noiseGain: 0.1 + intensity * 0.1,
          filter: 1800,
        });
        break;
      case 'net':
        this._click({
          frequency: 220,
          gain: 0.12,
          decay: 0.12,
          noiseGain: 0.14,
          filter: 900,
        });
        break;
      case 'floor':
        this._click({
          frequency: 900,
          gain: 0.07,
          decay: 0.06,
          noiseGain: 0.05,
          filter: 1600,
        });
        break;
    }
  }

  // Bright two-note flourish when a return lands in the target pad.
  targetHit() {
    if (!this._enabled) return;
    [880, 1320].forEach((f, i) => {
      const t = this.ctx.currentTime + i * 0.09;
      const osc = this.ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(f, t);

      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.22, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);

      osc.connect(g).connect(this.master);
      osc.start(t);
      osc.stop(t + 0.28);
    });
  }

  // Soft blip for UI presses and mode changes.
  ui(up = true) {
    if (!this._enabled) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(up ? 520 : 400, t);
    osc.frequency.exponentialRampToValueAtTime(up ? 780 : 300, t + 0.07);

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.1, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);

    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.14);
  }
}
