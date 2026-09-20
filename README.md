# flyball. Ping Pong Trainer

A desktop-first ping-pong coaching product for webcam, pointer, and optional WebXR play. The landing page introduces the training loop, drills, coaching system, and rankings before the simulated ball serves. The ball is authoritative: it collides with the paddle, bounces through the custom physics world, and records fundamentals while the player trains against escalating drills.

## Run it

```bash
npm install
npm run dev
```

The default Vite server uses plain HTTP for desktop play, webcam CV, and same-machine development. Run `npm run dev:https` for WebXR or same-WiFi multiplayer, open the printed HTTPS LAN URL on both devices, and accept the development certificate. Desktop users do not need VR or HTTPS. Run `npm test` for the unit suite.

## Product flow

The app opens on a product landing page inspired by the editorial feel of `../spark`, then moves into the trainer without requiring VR:

```text
Landing page → drill selection → desktop/CV training → coaching results → leaderboard
```

The landing page highlights skill-building, playing against the fly, and the pro Versus progression. Use **Start training** to choose **Casual Drills** or **Ranked Drills**, then select a session landscape: Classic Arena, Sunset Court, or Neon Night. The arena setup keeps a rotating table visible behind the selection panel. Once inside, the coaching controls live in a collapsible sidebar and the arrows at the top switch drills without returning home. Versus is currently represented as the competitive product direction; the playable modes today are target, rally, and fly training.

## Training modes

- **Foundation** — slower, wider serves for learning contact.
- **Standard** — balanced fundamentals training.
- **Boss run** — faster, tighter serves; survive as long as possible.
- **Hit the zone** — a six-move coaching sequence: forehand/backhand cross-court, down-the-line, short touch, and deep drive. Each move requires five successful target bounces before the next move unlocks.
- **Face the fly** — the fly's paddle predicts incoming ball position, moves to intercept it, and returns it through the same physics engine. The match tracks fly returns and fly misses.
- Every target move displays a live target, technique cue, repetition counter, and move-completion feedback. A miss keeps the current move active rather than silently advancing.

The HUD tracks score, current and best rally, accuracy, table bounces, boss level, misses, net errors, survival time, estimated reaction timing, and target-sequence progress. Drills are practice-first: a dropped ball ends the current rally, but the ball machine keeps serving until you reset or, for the target drill, complete all six moves. Results can be submitted to the fundamentals or boss leaderboard.

## Input modes

- **Quest controllers:** paddles attach to controller grips and transfer controller velocity into the physics simulation.
- **Browser CV:** `@mediapipe/tasks-vision` tracks the wrist/index pose from the webcam and drives a virtual paddle through the same physics path. Camera access works on localhost during development; deployed/non-localhost sites require HTTPS.
- **Future referee mode:** the OpenCV approach from [Computer-Vision-Ping-Pong](https://github.com/dsaha04/Computer-Vision-Ping-Pong) is represented as a future service seam for HSV ball segmentation, table calibration, homography, and real-camera event validation. It is Python/OpenCV code and is intentionally not bundled into the browser runtime.

## Multiplayer

Choose **Play a Friend**, then select **Yes — same WiFi** to use the Vite server's capped two-peer WebSocket relay. Both players must open the host's LAN URL and be on the same WiFi network; HTTPS mode is recommended for headset/browser security requirements. The relay is intended for development and local demos, not production hosting. Choose the online option when Supabase Realtime is configured for cross-network play.

Paddle synchronization is input-agnostic: mouse, webcam, and tracked XR paddles all publish their active world-space pose and velocity through the same versus transport.

### Future telemetry decision

Keep Supabase as the live multiplayer and leaderboard backend for now. Do not add Tiger Data to the runtime yet. A future Tiger Data/Tiger Cloud integration should be reserved for high-volume time-series coaching telemetry, including paddle velocity, ball trajectories, reaction timing, miss locations, rally replay, and long-term session analytics. When that feature is defined, gameplay events should be batched from the browser rather than writing every physics tick directly to the database.

## Deploy to Vercel

This is a Vite single-page app and can be deployed directly to Vercel. The included [`vercel.json`](./vercel.json) rewrites shared `/live-game?room=...` and tournament URLs to the app shell.

1. Import the repository into Vercel with the default Vite build settings.
2. Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` as Production environment variables.
3. Deploy and open the HTTPS Vercel URL.
4. Choose **Play a Friend → No — use online relay**. Both devices can be anywhere on the internet; they do not need to share WiFi.

The production transport is Supabase Realtime Broadcast + Presence. Vercel's WebSocket support is currently beta, and persistent room coordination would still require an external shared state/pub-sub service, which Supabase already provides here. The Vite WebSocket relay remains useful for local LAN development only.

## Shared Supabase leaderboard

This app reuses the leaderboard model from `../fly`, persists scores to Supabase when configured, and falls back to a device-local leaderboard plus demo rankings when credentials are absent.

1. Copy `.env.example` to `.env.local` for local online testing, or set the same values in Vercel's project environment settings.
2. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` to the same project used by `../fly`.
3. Apply [`supabase/schema.sql`](./supabase/schema.sql) to that project.

The production-safe next step is to route score inserts through the existing server-side validation endpoint from `../fly`; direct browser inserts should be protected with stricter RLS/rate limits before public deployment.

## Project structure

```text
src/main.js          Three.js/WebXR scene and game loop
src/net.js            Multiplayer transports and room links
src/multiplayerProtocol.js Shared relay message validation
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
