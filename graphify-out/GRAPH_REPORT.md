# Graph Report - htn2026  (2026-09-19)

## Corpus Check
- 17 files · ~8,568 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 150 nodes · 208 edges · 15 communities (9 shown, 6 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 1 edges (avg confidence: 0.5)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `316769fd`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- main.js
- package.json
- constants.js
- ui.js
- TrainerSession
- environment.js
- paddle.js
- PhysicsWorld
- public.leaderboard_entries
- Ball
- BallMachine
- xrButtons.js
- handTracking.js
- flyball. Ping Pong Trainer

## God Nodes (most connected - your core abstractions)
1. `TrainerSession` - 13 edges
2. `createTrainerUI()` - 7 edges
3. `flyball. Ping Pong Trainer` - 7 edges
4. `PhysicsWorld` - 6 edges
5. `scripts` - 5 edges
6. `Ball` - 5 edges
7. `BallMachine` - 5 edges
8. `TABLE` - 5 edges
9. `submitScore()` - 5 edges
10. `Paddle` - 5 edges

## Surprising Connections (you probably didn't know these)
- `applyLandscape()` --calls--> `updatePalette()`  [EXTRACTED]
  src/main.js → src/environment.js
- `createTrainerUI()` --calls--> `scoreFor()`  [EXTRACTED]
  src/ui.js → src/leaderboard.js
- `createTrainerUI()` --calls--> `submitScore()`  [EXTRACTED]
  src/ui.js → src/leaderboard.js
- `createTrainerUI()` --calls--> `getLeaderboard()`  [EXTRACTED]
  src/ui.js → src/leaderboard.js

## Import Cycles
- None detected.

## Communities (15 total, 6 thin omitted)

### Community 0 - "main.js"
Cohesion: 0.06
Nodes (27): balls, camera, clock, controllerModelFactory, cvHands, cvPaddle, cvRig, flyAnchor (+19 more)

### Community 1 - "package.json"
Cohesion: 0.09
Nodes (21): @mediapipe/tasks-vision, dependencies, @mediapipe/tasks-vision, @supabase/supabase-js, three, devDependencies, vite, @vitejs/plugin-basic-ssl (+13 more)

### Community 2 - "constants.js"
Cohesion: 0.23
Nodes (10): BALL, NET, PADDLE, PHYSICS, PLAY_AREA, TABLE, _n, _rel (+2 more)

### Community 3 - "ui.js"
Cohesion: 0.21
Nodes (14): demo, getLeaderboard(), readLocalScores(), scoreFor(), submitScore(), supabase, writeLocalScore(), DIFFICULTIES (+6 more)

### Community 5 - "environment.js"
Cohesion: 0.22
Nodes (9): buildDiscoGear(), buildEnvironment(), _camera, gridGeo, groundGeo, makeGridMesh(), _projector, updatePalette() (+1 more)

### Community 6 - "paddle.js"
Cohesion: 0.32
Nodes (3): buildPaddleMesh(), createBladeShape(), Paddle

### Community 8 - "public.leaderboard_entries"
Cohesion: 0.50
Nodes (3): auth, auth.users, public.leaderboard_entries

### Community 14 - "flyball. Ping Pong Trainer"
Cohesion: 0.25
Nodes (7): flyball. Ping Pong Trainer, Input modes, Product flow, Project structure, Run it, Shared Supabase leaderboard, Training modes

## Knowledge Gaps
- **58 isolated node(s):** `name`, `version`, `private`, `type`, `dev` (+53 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **6 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `TrainerSession` connect `TrainerSession` to `main.js`, `ui.js`?**
  _High betweenness centrality (0.099) - this node is a cross-community bridge._
- **Why does `PhysicsWorld` connect `PhysicsWorld` to `main.js`, `constants.js`?**
  _High betweenness centrality (0.040) - this node is a cross-community bridge._
- **Why does `Ball` connect `Ball` to `main.js`, `constants.js`?**
  _High betweenness centrality (0.030) - this node is a cross-community bridge._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _58 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `main.js` be split into smaller, more focused modules?**
  _Cohesion score 0.058823529411764705 - nodes in this community are weakly interconnected._
- **Should `package.json` be split into smaller, more focused modules?**
  _Cohesion score 0.09090909090909091 - nodes in this community are weakly interconnected._