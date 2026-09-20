// FlyBrainViz — a top-right canvas that draws the fly connectome subgraph and
// lights up neurons by their live reservoir activation as the ball comes in.
//
// Layout flows left (retina / visual input) -> right (descending / motor out),
// so you can watch a wave of activity sweep from the eye to the motor neurons
// each time the ball approaches.

export class FlyBrainViz {
  constructor(brain, { size = 220 } = {}) {
    this.brain = brain;
    const c = document.createElement('canvas');
    c.id = 'flybrain-viz';
    c.width = size;
    c.height = size;
    c.style.cssText =
      'position:fixed;top:16px;right:16px;width:' + size + 'px;height:' + size + 'px;' +
      'border:1px solid rgba(226,35,26,0.35);border-radius:8px;z-index:40;' +
      'box-shadow:0 6px 24px rgba(0,0,0,0.45);pointer-events:none;display:none;';
    this.canvas = c;
    this.ctx = c.getContext('2d');
    this._pts = null;        // node pixel positions
    this._edges = null;      // sampled edge list for the wiring backdrop
  }

  mount(parent = document.body) { if (!this.canvas.isConnected) parent.appendChild(this.canvas); }
  unmount() { this.canvas.remove(); }
  show() { this.canvas.style.display = 'block'; }
  hide() { this.canvas.style.display = 'none'; }

  _prepare() {
    const b = this.brain;
    if (!b.layout) return;
    const W = this.canvas.width, H = this.canvas.height, pad = 14;
    this._pts = b.layout.map(([x, y]) => [
      pad + (x * 0.5 + 0.5) * (W - 2 * pad),
      pad + (y * 0.5 + 0.5) * (H - 2 * pad),
    ]);
    // Sample a sparse subset of edges for a static wiring backdrop (drawing all
    // ~30k every frame is needless; a couple thousand reads as a dense net).
    const off = b.offsets, src = b.source, E = src.length;
    const stride = Math.max(1, Math.floor(E / 1500));
    const edges = [];
    for (let dest = 0; dest < b.numNodes; dest++) {
      for (let k = off[dest]; k < off[dest + 1]; k += stride) edges.push([src[k], dest]);
    }
    this._edges = edges;
  }

  render() {
    const b = this.brain, ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    if (!b.ready || !b.layout) { this._placeholder(); return; }
    if (!this._pts) this._prepare();

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(6,8,12,0.82)';
    ctx.fillRect(0, 0, W, H);

    // wiring backdrop
    ctx.strokeStyle = 'rgba(226,35,26,0.05)';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    for (const [a, c] of this._edges) {
      const pa = this._pts[a], pc = this._pts[c];
      ctx.moveTo(pa[0], pa[1]);
      ctx.lineTo(pc[0], pc[1]);
    }
    ctx.stroke();

    // neurons lit by |activation|
    const x = b.x;
    for (let i = 0; i < b.numNodes; i++) {
      const a = Math.min(1, Math.abs(x[i]) * 2.4);
      if (a < 0.06) continue;
      const p = this._pts[i];
      const g = 120 + Math.floor(120 * a);
      ctx.fillStyle = `rgba(255,${g},40,${0.15 + 0.85 * a})`;
      const r = 0.8 + 2.0 * a;
      ctx.beginPath();
      ctx.arc(p[0], p[1], r, 0, 6.2832);
      ctx.fill();
    }

    // labels
    ctx.fillStyle = 'rgba(242,239,230,0.55)';
    ctx.font = '9px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('retina', 6, H - 6);
    ctx.textAlign = 'right';
    ctx.fillText('descending', W - 6, H - 6);
    ctx.textAlign = 'left';
  }

  _placeholder() {
    const ctx = this.ctx, W = this.canvas.width, H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(6,8,12,0.82)';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(242,239,230,0.5)';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('fly brain offline', W / 2, H / 2 - 4);
    ctx.font = '8px monospace';
    ctx.fillText('run build_flybrain.py', W / 2, H / 2 + 10);
    ctx.textAlign = 'left';
  }
}
