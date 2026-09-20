"""
Build the FlyBrain browser artifact from the MaleCNS 166k connectome.

Pipeline
--------
1. Load the destination-major CSR connectome (offsets/source/weight).
2. Carve a retina -> descending sensorimotor subgraph using the provided
   hop-distance arrays (keep neurons on short retina->descending paths).
3. Prune to the strongest synapses, reindex to a compact 0..K-1 graph, and
   rescale so the recurrent matrix has a stable spectral radius (echo-state).
4. Treat the subgraph as a fixed RESERVOIR:
       x_{t+1} = (1-leak)*x_t + leak*tanh(gain*(W @ x_t) + drive)
   Encode the ball onto retina neurons; read descending neurons.
5. Generate (ball-state -> perfect-intercept) data with a light ballistic pong
   sim, push it through the reservoir, and RIDGE-REGRESS a linear readout from
   [descending activations + ball helper features] -> paddle target.
6. Export public/flybrain/model.json for the browser.

Nothing in the connectome is modified; only the readout is fitted.
Data: CC BY 4.0 - FlyEM/HHMI Janelia, U. Cambridge, MRC LMB, Google Research.
"""
import json, argparse
from pathlib import Path
import numpy as np
from scipy.sparse import csr_matrix

# ---- game constants (mirror src/constants.js) ------------------------------
TABLE_LEN, TABLE_W, TABLE_H, BALL_R, G = 2.74, 1.525, 0.76, 0.02, -9.81
BOT_HOME_Z = -(TABLE_LEN / 2 - 0.35)          # -1.02 : fly paddle plane
PLANE_Y_MIN, PLANE_Y_MAX = TABLE_H + 0.05, TABLE_H + 0.45

# ---- tunables --------------------------------------------------------------
NODE_BUDGET   = 3000     # neurons in the live subgraph (browser perf + viz)
EDGE_BUDGET   = 30000    # strongest synapses kept
RETINA_KEEP   = 400      # retina neurons used as the visual input map
SPECTRAL_RHO  = 0.95     # target spectral radius of the scaled reservoir
LEAK          = 0.25
GAIN          = 1.0
RIDGE_LAMBDA  = 1e-2
N_TRAJ        = 4000     # training trajectories


def load(root: Path):
    off = np.fromfile(root / "graph/edges_offsets.i32", dtype=np.int32)   # N+1
    src = np.fromfile(root / "graph/edges_source.i32",  dtype=np.int32)   # E
    w   = np.fromfile(root / "graph/edges_weight.f32",  dtype=np.float32) # E
    retina     = np.fromfile(root / "populations/retina.i32",      dtype=np.int32)
    descending = np.fromfile(root / "populations/descending.i32",  dtype=np.int32)
    hfr = np.fromfile(root / "derived/hops_from_retina.i32",  dtype=np.int32)
    htd = np.fromfile(root / "derived/hops_to_descending.i32", dtype=np.int32)
    N = len(off) - 1
    return off, src, w, retina, descending, hfr, htd, N


def carve_subgraph(off, src, w, retina, descending, hfr, htd, N):
    reachable = (hfr >= 0) & (htd >= 0)
    total = np.where(reachable, hfr + htd, 1 << 30)

    # retina input: closest-to-motor retina neurons, subsampled
    ret_ok = retina[(htd[retina] >= 0)]
    ret_ok = ret_ok[np.argsort(htd[ret_ok])][:RETINA_KEEP]

    desc_ok = descending[htd[descending] >= 0] if (htd[descending] >= 0).any() else descending
    keep = set(ret_ok.tolist()) | set(desc_ok.tolist())

    # fill remaining budget with intermediates on the shortest retina->desc paths
    order = np.argsort(total)
    for n in order:
        if len(keep) >= NODE_BUDGET:
            break
        if reachable[n]:
            keep.add(int(n))
    nodes = np.array(sorted(keep), dtype=np.int64)

    remap = -np.ones(N, dtype=np.int64)
    remap[nodes] = np.arange(len(nodes))

    # induced edges (destination-major CSR): dest = row index
    dest_full = np.repeat(np.arange(N, dtype=np.int64), np.diff(off))
    m = (remap[dest_full] >= 0) & (remap[src] >= 0)
    sd, ss, sw = remap[dest_full[m]], remap[src[m]], w[m]

    # prune to strongest |weight|
    if len(sw) > EDGE_BUDGET:
        idx = np.argpartition(np.abs(sw), -EDGE_BUDGET)[-EDGE_BUDGET:]
        sd, ss, sw = sd[idx], ss[idx], sw[idx]

    K = len(nodes)
    W = csr_matrix((sw, (sd, ss)), shape=(K, K)).astype(np.float32)
    ret_local  = remap[ret_ok]
    desc_local = remap[desc_ok]
    return nodes, W, ret_local.astype(np.int64), desc_local.astype(np.int64), hfr[nodes], htd[nodes]


def rescale(W):
    # power iteration for dominant |eigenvalue|
    K = W.shape[0]
    v = np.random.default_rng(0).standard_normal(K).astype(np.float32)
    v /= np.linalg.norm(v) + 1e-9
    rho = 1.0
    for _ in range(50):
        u = W @ v
        nrm = np.linalg.norm(u)
        if nrm < 1e-12:
            break
        rho = nrm
        v = u / nrm
    return W * np.float32(SPECTRAL_RHO / (rho + 1e-9)), float(rho)


def retina_pref_x(ret_local):
    # spread the kept retina neurons evenly across a normalized [-1, 1] eye
    order = np.argsort(ret_local)
    pref = np.empty(len(ret_local), dtype=np.float32)
    pref[order] = np.linspace(-1, 1, len(ret_local), dtype=np.float32)
    return pref


def drive_vector(K, ret_local, pref_x, ball_x_norm, sigma=0.18, amp=1.2):
    d = np.zeros(K, dtype=np.float32)
    d[ret_local] = amp * np.exp(-((pref_x - ball_x_norm) ** 2) / (2 * sigma * sigma))
    return d


def sim_trajectory(rng):
    """One incoming ball from the player side toward the fly. Returns
    (states, target) where each state=[x,vx,z,vz] is sampled before the paddle
    plane and target=[x*,y*] is the true intercept at z=BOT_HOME_Z."""
    x = rng.uniform(-0.3, 0.3); z = 0.8
    y = TABLE_H + 0.35
    vx = rng.uniform(-0.7, 0.7); vz = rng.uniform(-4.2, -2.6); vy = rng.uniform(1.0, 1.8)
    states = []
    pos = np.array([x, y, z], dtype=np.float64)
    vel = np.array([vx, vy, vz], dtype=np.float64)
    dt, bounced = 1 / 120, False
    target = None
    for _ in range(1200):
        prev_z = pos[2]
        vel[1] += G * dt
        pos += vel * dt
        # one table bounce on the fly half
        if (pos[1] <= TABLE_H + BALL_R and vel[1] < 0 and abs(pos[0]) < TABLE_W / 2
                and pos[2] < 0 and not bounced):
            pos[1] = TABLE_H + BALL_R; vel[1] = -vel[1] * 0.9; bounced = True
        if pos[2] > BOT_HOME_Z:
            states.append([pos[0], vel[0], pos[2], vel[2]])
        # crossing the paddle plane -> record intercept
        if prev_z > BOT_HOME_Z >= pos[2]:
            t = (prev_z - BOT_HOME_Z) / max(prev_z - pos[2], 1e-6)
            xi = pos[0] - vel[0] * dt * (1 - t)
            yi = np.clip(pos[1] - vel[1] * dt * (1 - t), PLANE_Y_MIN, PLANE_Y_MAX)
            target = [float(np.clip(xi, -TABLE_W / 2, TABLE_W / 2)), float(yi)]
            break
    if target is None or not states:
        return None
    return states, target


def features(x_res, desc_local, state):
    x, vx, z, vz = state
    ball = np.array([1.0, x / (TABLE_W / 2), vx / 5.0, z / (TABLE_LEN / 2), vz / 5.0],
                    dtype=np.float32)
    return np.concatenate([x_res[desc_local], ball])


def train(W, ret_local, desc_local, pref_x):
    rng = np.random.default_rng(1)
    K = W.shape[0]
    F, Y = [], []
    for _ in range(N_TRAJ):
        tr = sim_trajectory(rng)
        if tr is None:
            continue
        states, target = tr
        x_res = np.zeros(K, dtype=np.float32)
        for st in states:
            bx = float(np.clip(st[0] / (TABLE_W / 2), -1, 1))
            d = drive_vector(K, ret_local, pref_x, bx)
            x_res = (1 - LEAK) * x_res + LEAK * np.tanh(GAIN * (W @ x_res) + d)
            F.append(features(x_res, desc_local, st)); Y.append(target)
    F = np.asarray(F, np.float32); Y = np.asarray(Y, np.float32)
    D = F.shape[1]
    A = F.T @ F + RIDGE_LAMBDA * np.eye(D, dtype=np.float32)
    Wout = np.linalg.solve(A, F.T @ Y)             # (D, 2)
    rmse = float(np.sqrt(np.mean((F @ Wout - Y) ** 2)))
    print(f"  readout: {len(Y)} samples, dim {D}, train RMSE {rmse:.4f} m")
    return Wout, rmse


def layout(hfr_n, htd_n, ret_local, desc_local, K):
    # left-to-right sensory->motor flow for the viz
    pos = np.zeros((K, 2), dtype=np.float32)
    hfr = np.where(hfr_n >= 0, hfr_n, 0).astype(np.float32)
    htd = np.where(htd_n >= 0, htd_n, 0).astype(np.float32)
    denom = np.maximum(hfr + htd, 1)
    pos[:, 0] = -1 + 2 * (hfr / denom)
    rng = np.random.default_rng(2)
    pos[:, 1] = rng.uniform(-1, 1, K)
    pos[ret_local, 0] = -1.0
    pos[desc_local, 0] = 1.0
    return pos


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data/fly-connectome-malecns-166k")
    ap.add_argument("--out",  default="public/flybrain/model.json")
    args = ap.parse_args()
    root = Path(args.data)

    print("loading connectome...")
    off, src, w, retina, descending, hfr, htd, N = load(root)
    print(f"  {N} neurons, {len(src)} edges; retina={len(retina)} descending={len(descending)}")

    print("carving retina->descending subgraph...")
    nodes, W, ret_local, desc_local, hfr_n, htd_n = carve_subgraph(
        off, src, w, retina, descending, hfr, htd, N)
    print(f"  subgraph: {W.shape[0]} neurons, {W.nnz} edges")

    W, rho = rescale(W)
    print(f"  spectral radius {rho:.2f} -> rescaled to {SPECTRAL_RHO}")

    pref_x = retina_pref_x(ret_local)
    Wout, rmse = train(W, ret_local, desc_local, pref_x)
    pos = layout(hfr_n, htd_n, ret_local, desc_local, W.shape[0])

    # quantize edge weights to int16 for a small JSON payload
    Wcoo = W.tocsr()
    wq_scale = float(np.abs(Wcoo.data).max()) / 32000.0 if Wcoo.nnz else 1.0
    wq = np.round(Wcoo.data / wq_scale).astype(np.int16)

    out = Path(args.out); out.parent.mkdir(parents=True, exist_ok=True)
    model = {
        "version": 1,
        "attribution": "Connectome CC BY 4.0 FlyEM/HHMI Janelia, U.Cambridge, MRC LMB, Google Research",
        "numNodes": int(W.shape[0]),
        "reservoir": {"leak": LEAK, "gain": GAIN, "sigma": 0.18, "amp": 1.2},
        "csr": {  # W[dest, src], destination-major
            "offsets": Wcoo.indptr.astype(np.int32).tolist(),
            "source":  Wcoo.indices.astype(np.int32).tolist(),
            "weightQ": wq.tolist(),
            "weightScale": wq_scale,
        },
        "retinaNodes": ret_local.astype(np.int32).tolist(),
        "retinaPrefX": pref_x.astype(np.float32).round(4).tolist(),
        "descendingNodes": desc_local.astype(np.int32).tolist(),
        "readout": {  # feature = [descending activations..., 1, x, vx, z, vz]
            "W": np.round(Wout, 6).T.tolist(),   # (2, D): rows = [targetX, targetY]
            "featureOrder": ["descending", "bias", "x", "vx", "z", "vz"],
            "ballNorm": {"x": TABLE_W / 2, "vx": 5.0, "z": TABLE_LEN / 2, "vz": 5.0},
        },
        "layout": np.round(pos, 4).tolist(),
        "planeZ": BOT_HOME_Z, "planeYMin": PLANE_Y_MIN, "planeYMax": PLANE_Y_MAX,
        "trainRMSE": rmse,
    }
    out.write_text(json.dumps(model))
    print(f"wrote {out}  ({out.stat().st_size/1e6:.2f} MB)")


if __name__ == "__main__":
    main()
