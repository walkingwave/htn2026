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
    // Optional high-level policy. The reservoir remains the perception layer;
    // a policy may choose return target/risk while the opponent's analytic
    // controller still guarantees a reachable physical swing.
    this.policy = null;
    this.leak = 0.25; this.gain = 1.0; this.sigma = 0.18; this.amp = 1.2;
    this.ballNorm = { x: 0.7625, vx: 5, z: 1.37, vz: 5 };
    this.planeZ = -1.02; this.planeYMin = 0.81; this.planeYMax = 1.21;
    this._nx = null; this._drive = null; this._feat = null;
    this.lastOutput = { targetX: 0, targetY: 1.0, confidence: 0 };
    this.lastBall = null;
    this.stepCount = 0;
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
      this.x = null;
      this.policy = null;
      this.reset();
      return false;
    }
  }

  _init(m) {
    const csr = m?.csr;
    if (!m || !Number.isInteger(m.numNodes) || m.numNodes <= 0 ||
        !csr || !Array.isArray(csr.offsets) || !Array.isArray(csr.source) ||
        !Array.isArray(csr.weightQ) || !Array.isArray(m.retinaNodes) ||
        !Array.isArray(m.descendingNodes) || !Array.isArray(m.readout?.W)) {
      throw new Error('invalid FlyBrain model schema');
    }
    this.numNodes = m.numNodes;
    this.offsets = Int32Array.from(csr.offsets);
    this.source = Int32Array.from(csr.source);
    const scale = Number(csr.weightScale);
    if (!Number.isFinite(scale) || this.offsets.length !== this.numNodes + 1 ||
        this.source.length !== csr.weightQ.length) {
      throw new Error('invalid FlyBrain reservoir arrays');
    }
    this.weight = Float32Array.from(csr.weightQ, (q) => q * scale);
    this.retinaNodes = Int32Array.from(m.retinaNodes);
    this.retinaPrefX = Float32Array.from(m.retinaPrefX);
    this.descendingNodes = Int32Array.from(m.descendingNodes);
    this.readoutW = m.readout.W;
    this.ballNorm = m.readout.ballNorm;
    this.policy = m.policy ?? null;
    this.leak = m.reservoir.leak; this.gain = m.reservoir.gain;
    this.sigma = m.reservoir.sigma; this.amp = m.reservoir.amp;
    this.planeZ = m.planeZ; this.planeYMin = m.planeYMin; this.planeYMax = m.planeYMax;
    this.layout = m.layout;
    this.x = new Float32Array(this.numNodes);
    this._nx = new Float32Array(this.numNodes);
    this._drive = new Float32Array(this.numNodes);
    this._feat = new Float32Array(this.descendingNodes.length + 5);
    this.reset();
  }

  reset() {
    if (this.x) this.x.fill(0);
    if (this._nx) this._nx.fill(0);
    if (this._drive) this._drive.fill(0);
    this.lastOutput = { targetX: 0, targetY: (this.planeYMin + this.planeYMax) * 0.5, confidence: 0 };
    this.lastBall = null;
    this.stepCount = 0;
  }

  // Convert the reservoir state into a high-level tactical intent. A trained
  // policy artifact can replace this readout later; until then the bounded
  // fallback is intentionally conservative and only affects target selection,
  // never contact geometry or ball velocity.
  chooseTactic({ ball, confidence = 0.5, rally = 0, risk = 0.5 } = {}) {
    const x = Number(ball?.x) || 0;
    const vx = Number(ball?.vx) || 0;
    const confidence01 = clamp(confidence, 0, 1);
    const rally01 = clamp((Number(rally) || 0) / 8, 0, 1);
    const policy = this.policy;
    if (policy?.W?.length) {
      const features = [x, vx, confidence01, rally01, clamp(risk, 0, 1), 1];
      const dot = (row) => row.reduce((sum, weight, index) =>
        sum + (Number(weight) || 0) * (features[index] ?? 0), 0);
      return {
        targetX: clamp(dot(policy.W[0] ?? []) , -0.62, 0.62),
        targetZ: clamp(dot(policy.W[1] ?? []) , 0.22, 1.05),
        pace: clamp(dot(policy.W[2] ?? []) , 3.2, 5.4),
        risk: clamp(dot(policy.W[3] ?? []) , 0.05, 0.9),
      };
    }
    // The learned intercept is useful tactical information too. Blend it
    // with a conservative lane change rather than throwing it away after the
    // paddle-placement step; low confidence keeps the fly near the middle.
    const interceptX = Number.isFinite(this.lastOutput?.targetX)
      ? this.lastOutput.targetX
      : 0;
    const lane = interceptX * 0.30 - vx * 0.10 + x * (0.12 + confidence01 * 0.18);
    return {
      targetX: clamp(lane, -0.55, 0.55),
      targetZ: 0.24 + (1 - confidence01) * 0.12 + rally01 * 0.18,
      pace: 4.2 + confidence01 * 0.8,
      risk: clamp(risk * 0.7 + confidence01 * 0.2, 0.08, 0.8),
    };
  }

  // One controller step. ball = {x, y, vx, vy, z, vz} in fly-relative meters.
  // Returns { targetX, targetY }. Updates this.x (activations) for the viz.
  step(ball) {
    if (!this.ready) return this._analytic(ball);

    const { offsets, source, weight, x, _drive, _nx } = this;
    const N = this.numNodes;

    const input = {
      x: Number(ball?.x) || 0,
      y: Number(ball?.y) || 0,
      z: Number(ball?.z) || 0,
      vx: Number(ball?.vx) || 0,
      vy: Number(ball?.vy) || 0,
      vz: Number(ball?.vz) || 0,
    };
    this.lastBall = input;
    this.stepCount++;

    // Encode both where the ball is and where it is moving. The old retina
    // drive was position-only, so a left-moving and right-moving ball looked
    // identical until the reservoir caught up. A short visual-motion lead
    // gives the descending readout the same cue a real fly gets from optic
    // flow, without changing the exported model format.
    _drive.fill(0);
    const bx = clamp(input.x / this.ballNorm.x, -1, 1);
    const predictedBx = clamp(bx + (input.vx / this.ballNorm.vx) * 0.08, -1, 1);
    const heightGain = clamp(0.88 + (input.y - this.planeYMin) * 0.55, 0.65, 1.2);
    const s2 = 2 * this.sigma * this.sigma;
    for (let i = 0; i < this.retinaNodes.length; i++) {
      const d = this.retinaPrefX[i] - bx;
      const lead = this.retinaPrefX[i] - predictedBx;
      _drive[this.retinaNodes[i]] = this.amp * heightGain *
        (0.72 * Math.exp(-(d * d) / s2) + 0.28 * Math.exp(-(lead * lead) / s2));
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
    feat[b + 1] = input.x / nb.x;
    feat[b + 2] = input.vx / nb.vx;
    feat[b + 3] = input.z / nb.z;
    feat[b + 4] = input.vz / nb.vz;

    const w0 = this.readoutW[0], w1 = this.readoutW[1];
    let tx = 0, ty = 0;
    for (let i = 0; i < feat.length; i++) {
      tx += (Number(w0[i]) || 0) * feat[i];
      ty += (Number(w1[i]) || 0) * feat[i];
    }
    const rawX = clamp(tx, -0.9, 0.9);
    const rawY = clamp(ty, this.planeYMin, this.planeYMax);
    const approach = clamp(-input.vz / Math.max(this.ballNorm.vz, 0.1), 0, 1);
    const confidence = clamp(0.35 + approach * 0.45 + (1 - Math.abs(input.x) / this.ballNorm.x) * 0.2, 0, 1);
    const smoothing = this.stepCount <= 1 ? 1 : 0.34 + confidence * 0.28;
    const output = {
      targetX: this.lastOutput.targetX + (rawX - this.lastOutput.targetX) * smoothing,
      targetY: this.lastOutput.targetY + (rawY - this.lastOutput.targetY) * smoothing,
      confidence,
    };
    this.lastOutput = output;
    return output;
  }

  // Near-perfect analytic intercept — fallback before/if the model is absent.
  _analytic(ball) {
    const input = {
      x: Number(ball?.x) || 0,
      y: Number(ball?.y) || 0,
      z: Number(ball?.z) || 0,
      vx: Number(ball?.vx) || 0,
      vy: Number(ball?.vy) || 0,
      vz: Number(ball?.vz) || 0,
    };
    const t = Math.abs(input.vz) > 1e-3 ? (this.planeZ - input.z) / input.vz : 0;
    const tHit = t > 0 ? t : 0;
    const output = {
      targetX: clamp(input.x + input.vx * tHit, -0.9, 0.9),
      targetY: clamp(input.y + input.vy * tHit + 0.5 * -9.81 * tHit * tHit, this.planeYMin, this.planeYMax),
      confidence: clamp(0.55 + Math.min(tHit, 0.5), 0, 1),
    };
    this.lastBall = input;
    this.lastOutput = output;
    return output;
  }
}
