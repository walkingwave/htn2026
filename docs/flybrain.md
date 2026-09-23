# Play a Fly — the connectome-reservoir bot

"Play a Fly" is a near-unbeatable table-tennis opponent whose paddle is driven by
the **real wiring of a fruit fly's brain**. The fly's connectome is used as a
fixed recurrent *reservoir*: the ball is encoded as visual input on the fly's
**retina** neurons, activity propagates through the measured biological synapses,
and a trained linear **readout** on the **descending** (motor) neurons produces
the paddle target. The top-right overlay lights up the actual neurons as the
signal sweeps from eye to motor output.

Only the readout is learned. The connectome itself is untouched biological data.

## Data source

- **Dataset:** [`fernandofernandes/fly-connectome-malecns-166k`](https://huggingface.co/datasets/fernandofernandes/fly-connectome-malecns-166k)
  — the complete MaleCNS v1.0 connectome (166,700 neurons, 25.5M signed synaptic
  edges), with labeled `retina` (visual input) and `descending` (motor output)
  populations and `hops_from_retina` / `hops_to_descending` distance arrays.
- **License / attribution (CC BY 4.0):** connectome data © FlyEM / HHMI Janelia
  Research Campus, University of Cambridge, MRC Laboratory of Molecular Biology,
  and Google Research. Packaging by `fernandofernandes`.

The raw dataset (~210 MB) is **not** committed — it lives in the gitignored
`data/` directory. Only the small exported model (`public/flybrain/model.json`)
is committed.

## How it works

```
ball (x, vx, z, vz)
      │  encode lateral position as a gaussian bump on retina neurons
      ▼
retina ──▶ [ fixed connectome reservoir ] ──▶ descending
              x ← (1-leak)·x + leak·tanh(gain·(W·x) + drive)
                                                   │  trained linear readout
                                                   ▼
                                        paddle target (x, y)
```

- **Reservoir:** the pruned retina→descending subgraph (a few thousand neurons /
  ~30k strongest synapses), rescaled to a stable spectral radius so the recurrent
  dynamics have the echo-state property. This is standard **reservoir computing**:
  the connectome supplies rich nonlinear temporal features; the readout does the
  task learning.
- **Readout:** ridge-regressed against a perfect analytic intercept teacher, so
  the fly plays near-unbeatably. Feature vector = descending activations + a few
  ball helper features.
- **Fallback:** if `model.json` is missing, `FlyBrain.step()` uses a direct
  analytic intercept, so the fly is playable (and still near-unbeatable) before
  the model is built — the viz then shows a "fly brain offline" placeholder.

## Build the model

The raw connectome and the training run happen offline in Python; the browser only
loads the exported artifact.

```bash
# 1. Download the connectome into the gitignored data/ dir (~210 MB)
python -m pip install numpy scipy huggingface_hub
python - <<'PY'
from huggingface_hub import snapshot_download
snapshot_download("fernandofernandes/fly-connectome-malecns-166k",
                  repo_type="dataset",
                  local_dir="data/fly-connectome-malecns-166k")
PY

# 2. Carve the subgraph, train the readout, export public/flybrain/model.json
python scripts/flybrain/build_flybrain.py
```

The script prints the subgraph size and the **train RMSE (meters)** — the
near-unbeatable dial. RMSE well under the paddle radius (0.077 m) means the fly
intercepts almost everything. Tunables (`NODE_BUDGET`, `EDGE_BUDGET`, `N_TRAJ`,
`SPECTRAL_RHO`, `LEAK`, `GAIN`) are at the top of `build_flybrain.py`.

### Optional tactical policy

The connectome readout controls paddle placement, while the opponent's physics
controller validates the return. A separate high-level policy can choose target
lane, depth, pace, and risk without being allowed to teleport the paddle or
change the ball directly:

```bash
python scripts/flybrain/train_policy.py \
  --model public/flybrain/model.json \
  --out public/flybrain/policy.json \
  --merge-model
```

This offline trainer uses cross-entropy policy search over synthetic rallies and
writes a bounded linear policy into `model.json`. The browser only loads the
exported weights; `chooseTactic()` remains a safe fallback when no policy is
present. Evaluate a policy against the actual browser physics before shipping a
new artifact. This is deliberately a high-level policy layer, not end-to-end
RL: contact and legality remain deterministic and physics-authoritative.

## In-game

Start menu → **Play a Fly**. The connectome activation overlay appears in the top
right and lights up as the ball comes in. **Play a Standard Bot** is the original
analytic opponent (now fixed to reliably return balls via post-bounce intercept
prediction).

## Files

- `scripts/flybrain/build_flybrain.py` — offline extraction + readout training + export.
- `scripts/flybrain/train_policy.py` — offline bounded tactical policy search.
- `public/flybrain/model.json` — exported artifact loaded by the browser (generated).
- `src/flybrain.js` — in-browser reservoir controller + tactical policy fallback.
- `src/flybrain/flyBrainViz.js` — top-right activation visualization.
- `src/opponent.js` — candidate return validation, safe fallback, and physical swing planning.
- `src/main.js` — "Play a Fly" wiring + the standard-bot return fix.
