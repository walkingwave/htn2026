"""Train a bounded high-level FlyBrain return policy offline.

This is intentionally separate from the browser controller. It uses a small
cross-entropy policy search (an evolutionary RL method) over a linear policy:

    [target_x, target_z, pace, risk] = policy.W @ [ball_x, ball_vx,
                                                     confidence, rally, risk, 1]

The environment reward is deliberately high-level. The browser's full physics
and analytic contact controller remain authoritative after the policy chooses
an intent. This keeps training stable and prevents an exported policy from
teleporting paddles or mutating ball velocity.

Usage:
    python scripts/flybrain/train_policy.py \
      --model public/flybrain/model.json \
      --episodes 12000 \
      --out public/flybrain/policy.json

The generated policy can be merged into model.json with --merge-model, or
loaded independently by tooling. No model is generated during a browser run.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

TABLE_W = 1.525
TABLE_L = 2.74
BALL_R = 0.02
TABLE_H = 0.76
NET_H = 0.1525
GRAVITY = -9.81
DRAG = 0.112
MAGNUS = 0.0062

FEATURES = 6
ACTIONS = 4


def clamp(value, low, high):
    return np.minimum(np.maximum(value, low), high)


def flight(origin, velocity, spin, target_y):
    """Approximate the shared browser flight model for one candidate shot."""
    pos = np.array(origin, dtype=np.float64)
    vel = np.array(velocity, dtype=np.float64)
    spin = np.array(spin, dtype=np.float64)
    dt = 1.0 / 240.0
    net_clearance = -10.0

    for _ in range(240 * 3):
        previous = pos.copy()
        acceleration = np.array([0.0, GRAVITY, 0.0])
        speed = np.linalg.norm(vel)
        if speed > 1e-6:
            acceleration -= DRAG * speed * vel
            acceleration += MAGNUS * np.cross(spin, vel)
        vel += acceleration * dt
        pos += vel * dt
        spin *= 0.985 ** dt

        if previous[2] < 0 <= pos[2]:
            ratio = abs(previous[2]) / max(abs(previous[2] - pos[2]), 1e-9)
            net_y = previous[1] + (pos[1] - previous[1]) * ratio
            net_clearance = net_y - (TABLE_H + NET_H)

        if vel[1] < 0 and pos[1] <= target_y:
            return {
                "landed": True,
                "x": float(pos[0]),
                "z": float(pos[2]),
                "net_clearance": float(net_clearance),
            }

    return {
        "landed": False,
        "x": float(pos[0]),
        "z": float(pos[2]),
        "net_clearance": float(net_clearance),
    }


def candidate_action(weights, features):
    raw = weights @ features
    # The action bounds mirror FlyBrain.chooseTactic().
    return np.array([
        clamp(raw[0], -0.62, 0.62),
        clamp(raw[1], 0.22, 1.05),
        clamp(raw[2], 3.2, 5.4),
        clamp(raw[3], 0.05, 0.9),
    ], dtype=np.float64)


def evaluate(weights, rng, episodes):
    total = 0.0
    legal = 0
    for _ in range(episodes):
        x = rng.uniform(-0.72, 0.72)
        vx = rng.uniform(-1.7, 1.7)
        confidence = rng.uniform(0.25, 1.0)
        rally = rng.uniform(0.0, 1.0)
        risk = rng.uniform(0.1, 0.8)
        features = np.array([x, vx, confidence, rally, risk, 1.0])
        target_x, target_z, pace, chosen_risk = candidate_action(weights, features)

        # The policy is evaluated at the same approximate bot contact plane as
        # the browser. The target z is on the player's half after the net.
        origin = [x, TABLE_H + 0.04, -(TABLE_L / 2) - 0.10]
        target_y = TABLE_H + BALL_R
        direction = np.array([target_x - origin[0], 0.0, target_z - origin[2]])
        horizontal = max(np.linalg.norm(direction[[0, 2]]), 0.01)
        direction[[0, 2]] /= horizontal
        velocity = [direction[0] * pace, 1.0 + confidence * 0.9, direction[2] * pace]
        spin = [120.0 * (0.5 - chosen_risk), 80.0 * (x / TABLE_W), 0.0]
        shot = flight(origin, velocity, spin, target_y)

        inside = (
            shot["landed"]
            and shot["net_clearance"] >= 0.10
            and abs(shot["x"]) <= TABLE_W / 2 - BALL_R
            and BALL_R <= shot["z"] <= TABLE_L / 2 - BALL_R
        )
        if inside:
            legal += 1
            margin = min(
                TABLE_W / 2 - BALL_R - abs(shot["x"]),
                TABLE_L / 2 - BALL_R - shot["z"],
            )
            placement = np.hypot(shot["x"] - target_x, shot["z"] - target_z)
            # Legal returns dominate. Risk and placement are secondary.
            total += 1.0 + min(0.25, max(0.0, margin)) + max(0.0, 0.12 - placement)
            total += 0.08 * chosen_risk
        else:
            total -= 1.2

    return total / max(episodes, 1), legal / max(episodes, 1)


def train(rng, population, elites, generations, episodes):
    # Start with a safe central policy; CEM explores around it.
    mean = np.array([
        [0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        [0.0, 0.0, 0.0, 0.0, 0.0, 0.25],
        [0.0, 0.0, 0.0, 0.0, 0.0, 4.2],
        [0.0, 0.0, 0.0, 0.0, 0.0, 0.35],
    ], dtype=np.float64)
    scale = np.full((ACTIONS, FEATURES), 0.18, dtype=np.float64)
    scale[1, -1] = 0.12
    scale[2, -1] = 0.5
    scale[3, -1] = 0.12
    best = mean.copy()
    best_score = -float("inf")

    for generation in range(generations):
        candidates = mean + rng.normal(size=(population, ACTIONS, FEATURES)) * scale
        scored = []
        for policy in candidates:
            score, legal_rate = evaluate(policy, rng, episodes)
            scored.append((score, legal_rate, policy))
        scored.sort(key=lambda item: item[0], reverse=True)
        top = scored[:elites]
        top_policies = np.stack([item[2] for item in top])
        mean = top_policies.mean(axis=0)
        scale = np.maximum(top_policies.std(axis=0) * 1.15, 0.015)
        if top[0][0] > best_score:
            best_score = top[0][0]
            best = top[0][2].copy()
        if generation % 5 == 0 or generation == generations - 1:
            print(
                f"generation {generation + 1:03d}: "
                f"score={top[0][0]:.3f} legal={top[0][1]:.1%}"
            )

    return best, best_score


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="public/flybrain/model.json")
    parser.add_argument("--out", default="public/flybrain/policy.json")
    parser.add_argument("--merge-model", action="store_true")
    parser.add_argument("--seed", type=int, default=11)
    parser.add_argument("--population", type=int, default=32)
    parser.add_argument("--elites", type=int, default=8)
    parser.add_argument("--generations", type=int, default=40)
    parser.add_argument("--episodes", type=int, default=180)
    args = parser.parse_args()

    rng = np.random.default_rng(args.seed)
    policy, score = train(
        rng,
        population=max(args.elites, args.population),
        elites=max(2, min(args.elites, args.population)),
        generations=max(1, args.generations),
        episodes=max(8, args.episodes),
    )
    artifact = {
        "version": 1,
        "method": "cross_entropy_policy_search",
        "featureOrder": ["ball_x", "ball_vx", "confidence", "rally_norm", "risk", "bias"],
        "actionOrder": ["targetX", "targetZ", "pace", "risk"],
        "W": np.round(policy, 6).tolist(),
        "score": float(score),
        "bounds": {
            "targetX": [-0.62, 0.62],
            "targetZ": [0.22, 1.05],
            "pace": [3.2, 5.4],
            "risk": [0.05, 0.9],
        },
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(artifact, separators=(",", ":")))
    print(f"wrote {out} ({out.stat().st_size} bytes)")

    if args.merge_model:
        model_path = Path(args.model)
        model = json.loads(model_path.read_text())
        model["policy"] = artifact
        model_path.write_text(json.dumps(model, separators=(",", ":")))
        print(f"merged policy into {model_path}")


if __name__ == "__main__":
    main()
