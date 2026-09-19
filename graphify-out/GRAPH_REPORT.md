# Graph Report - .  (2026-09-19)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 115 nodes · 161 edges · 14 communities (8 shown, 6 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 1 edges (avg confidence: 0.5)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `34ab9756`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- main.js
- package.json
- constants.js
- ui.js
- TrainerSession
- dependencies
- paddle.js
- PhysicsWorld
- public.leaderboard_entries
- Ball
- BallMachine
- xrButtons.js
- handTracking.js

## God Nodes (most connected - your core abstractions)
1. `TrainerSession` - 11 edges
2. `createTrainerUI()` - 7 edges
3. `PhysicsWorld` - 6 edges
4. `Ball` - 5 edges
5. `BallMachine` - 5 edges
6. `TABLE` - 5 edges
7. `Paddle` - 5 edges
8. `scripts` - 4 edges
9. `scoreFor()` - 4 edges
10. `submitScore()` - 4 edges

## Surprising Connections (you probably didn't know these)
- `createTrainerUI()` --calls--> `scoreFor()`  [EXTRACTED]
  src/ui.js → src/leaderboard.js
- `createTrainerUI()` --calls--> `submitScore()`  [EXTRACTED]
  src/ui.js → src/leaderboard.js
- `createTrainerUI()` --calls--> `getLeaderboard()`  [EXTRACTED]
  src/ui.js → src/leaderboard.js

## Import Cycles
- None detected.

## Communities (14 total, 6 thin omitted)

### Community 0 - "main.js"
Cohesion: 0.07
Nodes (23): balls, camera, clock, controllerModelFactory, cvPaddle, cvRig, flyOpponent, flyPaddle (+15 more)

### Community 1 - "package.json"
Cohesion: 0.14
Nodes (13): devDependencies, vite, @vitejs/plugin-basic-ssl, name, private, scripts, build, dev (+5 more)

### Community 2 - "constants.js"
Cohesion: 0.24
Nodes (9): BALL, NET, PHYSICS, PLAY_AREA, TABLE, _n, _rel, _tmp (+1 more)

### Community 3 - "ui.js"
Cohesion: 0.32
Nodes (9): demo, getLeaderboard(), scoreFor(), submitScore(), supabase, DIFFICULTIES, DRILLS, createTrainerUI() (+1 more)

### Community 5 - "dependencies"
Cohesion: 0.29
Nodes (7): @mediapipe/tasks-vision, dependencies, @mediapipe/tasks-vision, @supabase/supabase-js, three, @supabase/supabase-js, three

### Community 6 - "paddle.js"
Cohesion: 0.33
Nodes (3): PADDLE, buildPaddleMesh(), Paddle

### Community 8 - "public.leaderboard_entries"
Cohesion: 0.50
Nodes (3): auth, auth.users, public.leaderboard_entries

## Knowledge Gaps
- **41 isolated node(s):** `name`, `version`, `private`, `type`, `dev` (+36 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **6 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `TrainerSession` connect `TrainerSession` to `main.js`, `ui.js`?**
  _High betweenness centrality (0.105) - this node is a cross-community bridge._
- **Why does `PhysicsWorld` connect `PhysicsWorld` to `main.js`, `constants.js`?**
  _High betweenness centrality (0.053) - this node is a cross-community bridge._
- **Why does `Ball` connect `Ball` to `main.js`, `constants.js`?**
  _High betweenness centrality (0.040) - this node is a cross-community bridge._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _41 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `main.js` be split into smaller, more focused modules?**
  _Cohesion score 0.07142857142857142 - nodes in this community are weakly interconnected._
- **Should `package.json` be split into smaller, more focused modules?**
  _Cohesion score 0.14285714285714285 - nodes in this community are weakly interconnected._