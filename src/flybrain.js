// FlyBrain — a connectome-reservoir controller for the "Play a Fly" bot.
//
// Loads the exported retina->descending subgraph + trained readout
// (public/flybrain/model.json, produced by scripts/flybrain/build_flybrain.py),
// runs one leaky-tanh reservoir step per tick driven by the ball's lateral
// position on the "retina", and reads a paddle target out of the descending
// readout:
//
//     x_{t+1} = (1-leak)*x + leak*tanh(gain*(W @ x) + drive)
//     target  = readoutW · [descending activations, 1, x, vx, z, vz]
//
// The connectome wiring (W) is fixed biological data; only the linear readout
// was fitted. Until the artifact is fetched — or if it's missing — a
// near-perfect analytic intercept is used so the fly is always playable.

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export class FlyBrain {
  constructor() {
    this.ready = false;
    this.numNodes = 0;
    this.x = null;            // reservoir state (also the activation the viz reads)
    this.layout = null;       // [[x,y], ...] node positions for the viz
    this.offsets = null;      // CSR row offsets (row = destination neuron)
    this.source = null;       // CSR presynaptic indices
    this.weight = null;       // CSR signed weights (dequantized)
    this.retinaNodes = null;
    this.retinaPrefX = null;
    this.descendingNodes = null;
    this.readoutW = null;     // [2][D] : rows = [targetX, targetY]
    this.leak = 0.25; this.gain = 1.0; this.sigma = 0.18; this.amp = 1.2;
    this.ballNorm = { x: 0.7625, vx: 5, z: 1.37, vz: 5 };
    this.planeZ = -1.02; this.planeYMin = 0.81; this.planeYMax = 1.21;
    this._nx = null; this._drive = null; this._feat = null;
  }

  async load(url = '/flybrain/model.json') {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
      this._init(await res.json());
      this.ready = true;
      return true;
    } catch (e) {
      console.warn('[FlyBrain] model unavailable, using analytic fallback:', e.message);
      this.ready = false;
      return false;
    }
  }

  _init(m) {
    const csr = m.csr;
    this.numNodes = m.numNodes;
    this.offsets = Int32Array.from(csr.offsets);
    this.source = Int32Array.from(csr.source);
    const scale = csr.weightScale;
    this.weight = Float32Array.from(csr.weightQ, (q) => q * scale);
    this.retinaNodes = Int32Array.from(m.retinaNodes);
    this.retinaPrefX = Float32Array.from(m.retinaPrefX);
    this.descendingNodes = Int32Array.from(m.descendingNodes);
    this.readoutW = m.readout.W;
    this.ballNorm = m.readout.ballNorm;
    this.leak = m.reservoir.leak; this.gain = m.reservoir.gain;
    this.sigma = m.reservoir.sigma; this.amp = m.reservoir.amp;
    this.planeZ = m.planeZ; this.planeYMin = m.planeYMin; this.planeYMax = m.planeYMax;
    this.layout = m.layout;
    this.x = new Float32Array(this.numNodes);
    this._nx = new Float32Array(this.numNodes);
    this._drive = new Float32Array(this.numNodes);
    this._feat = new Float32Array(this.descendingNodes.length + 5);
  }

  reset() { if (this.x) this.x.fill(0); }

  // One controller step. ball = {x, y, vx, vy, z, vz} in fly-relative meters.
  // Returns { targetX, targetY }. Updates this.x (activations) for the viz.
  step(ball) {
    if (!this.ready) return this._analytic(ball);

    const { offsets, source, weight, x, _drive, _nx } = this;
    const N = this.numNodes;

    // Encode the ball's lateral position as a gaussian bump across the retina.
    _drive.fill(0);
    const bx = clamp(ball.x / this.ballNorm.x, -1, 1);
    const s2 = 2 * this.sigma * this.sigma;
    for (let i = 0; i < this.retinaNodes.length; i++) {
      const d = this.retinaPrefX[i] - bx;
      _drive[this.retinaNodes[i]] = this.amp * Math.exp(-(d * d) / s2);
    }

    // Leaky-tanh reservoir step. W is destination-major CSR, so
    // (W·x)[dest] = sum_k weight[k]·x[source[k]] over dest's incoming edges.
    for (let dest = 0; dest < N; dest++) {
      let sum = 0;
      const hi = offsets[dest + 1];
      for (let k = offsets[dest]; k < hi; k++) sum += weight[k] * x[source[k]];
      _nx[dest] = (1 - this.leak) * x[dest] +
        this.leak * Math.tanh(this.gain * sum + _drive[dest]);
    }
    x.set(_nx);

    // Readout: feature = [descending activations..., 1, x, vx, z, vz].
    const dn = this.descendingNodes, nb = this.ballNorm, feat = this._feat;
    for (let i = 0; i < dn.length; i++) feat[i] = x[dn[i]];
    const b = dn.length;
    feat[b] = 1;
    feat[b + 1] = ball.x / nb.x;
    feat[b + 2] = ball.vx / nb.vx;
    feat[b + 3] = ball.z / nb.z;
    feat[b + 4] = ball.vz / nb.vz;

    const w0 = this.readoutW[0], w1 = this.readoutW[1];
    let tx = 0, ty = 0;
    for (let i = 0; i < feat.length; i++) { tx += w0[i] * feat[i]; ty += w1[i] * feat[i]; }
    return {
      targetX: clamp(tx, -0.9, 0.9),
      targetY: clamp(ty, this.planeYMin, this.planeYMax),
    };
  }

  // Near-perfect analytic intercept — fallback before/if the model is absent.
  _analytic(ball) {
    const t = Math.abs(ball.vz) > 1e-3 ? (this.planeZ - ball.z) / ball.vz : 0;
    const tHit = t > 0 ? t : 0;
    const targetX = ball.x + ball.vx * tHit;
    const targetY = clamp(
      ball.y + ball.vy * tHit + 0.5 * -9.81 * tHit * tHit,
      this.planeYMin, this.planeYMax
    );
    return { targetX: clamp(targetX, -0.9, 0.9), targetY };
  }
}
