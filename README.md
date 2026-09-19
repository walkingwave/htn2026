# flyball. Ping Pong Trainer

A WebXR ping-pong trainer for Quest and desktop. The simulated ball is authoritative: it serves, collides with the paddle, bounces through the custom physics world, and records fundamentals while the player trains against escalating drills.

## Run it

```bash
npm install
npm run dev
```

The Vite server uses HTTPS because WebXR requires a secure context. Open the printed LAN URL in the Quest Browser, accept the local certificate, then choose **Enter AR** or **Enter VR**. Desktop users get an orbit-camera fallback.

## Training modes

- **Foundation** — slower, wider serves for learning contact.
- **Standard** — balanced fundamentals training.
- **Boss run** — faster, tighter serves; survive as long as possible.
- **Hit the zone** — a six-move coaching sequence: forehand/backhand cross-court, down-the-line, short touch, and deep drive. Each move requires five successful target bounces before the next move unlocks.
- Every target move displays a live target, technique cue, repetition counter, and move-completion feedback. A miss keeps the current move active rather than silently advancing.

The HUD tracks score, current and best rally, accuracy, table bounces, boss level, misses, net errors, survival time, estimated reaction timing, and target-sequence progress. Target sessions finish when all six moves are complete or after five missed balls; other sessions finish after five missed balls. Results can be submitted to the fundamentals or boss leaderboard.

## Input modes

- **Quest controllers:** paddles attach to controller grips and transfer controller velocity into the physics simulation.
- **Browser CV:** `@mediapipe/tasks-vision` tracks the wrist/index pose from the webcam and drives a virtual paddle through the same physics path. Camera access requires HTTPS.
- **Future referee mode:** the OpenCV approach from [Computer-Vision-Ping-Pong](https://github.com/dsaha04/Computer-Vision-Ping-Pong) is represented as a future service seam for HSV ball segmentation, table calibration, homography, and real-camera event validation. It is Python/OpenCV code and is intentionally not bundled into the browser runtime.

## Shared Supabase leaderboard

This app reuses the leaderboard model from `../fly` and supports local demo rankings when credentials are absent.

1. Copy `.env.example` to `.env.local`.
2. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` to the same project used by `../fly`.
3. Apply [`supabase/schema.sql`](./supabase/schema.sql) to that project.

The production-safe next step is to route score inserts through the existing server-side validation endpoint from `../fly`; direct browser inserts should be protected with stricter RLS/rate limits before public deployment.

## Project structure

```text
src/main.js          Three.js/WebXR scene and game loop
src/session.js       Metrics, difficulty profiles, and score summaries
src/ui.js             Trainer HUD, lobby, results, and leaderboard panels
src/physics.js        Fixed-step ball/table/net/paddle physics
src/paddle.js         Controller paddle geometry and velocity tracking
src/handTracking.js   MediaPipe browser CV adapter
src/leaderboard.js    Shared Supabase client plus local fallback rankings
src/ballMachine.js    Difficulty-aware simulated serve machine
src/table.js          Table/net/floor scene
supabase/schema.sql   Shared leaderboard schema
```
