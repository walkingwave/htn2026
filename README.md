# PaddleLab XR

A browser-based table tennis trainer and versus game, tested on the Meta Quest 3S through **WebXR** — no Unity, app store, or sideloading required. It also runs on a laptop with a mouse, webcam hand tracking, mobile phone, or a physical paddle fitted with printed markers.

Built at Hack the North 2026.

## Stack

- [Three.js](https://threejs.org/) — rendering + WebXR session management
- [Vite](https://vite.dev/) — dev server + build
- [MediaPipe Tasks Vision](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker) — webcam hand landmarks
- [js-aruco2](https://github.com/damianofalcioni/js-aruco2) — printed-marker detection and pose estimation for a physical paddle
- Supabase Realtime, a development WebSocket relay, and `BroadcastChannel` — multiplayer transports
- Web Audio — generated paddle, table, net, floor, target, and interface sounds
- Custom lightweight physics (fixed timestep, table/net/paddle collisions)

The physical-paddle tracker uses `js-aruco2` and its JavaScript computer-vision routines. It does not run Python or load the native OpenCV library.

## Getting started

```bash
npm install
npm run dev
```

The dev server runs on **HTTPS** (self-signed cert via `@vitejs/plugin-basic-ssl`) because WebXR requires a secure context.

### On desktop

Open `https://localhost:5173` and accept the certificate warning. Choose **On this screen** for mouse or physical-paddle play, or **Hand tracking** to use a bare hand through the webcam.

### On the Quest 3S

1. Make sure the headset and your laptop are on the **same Wi-Fi network**.
2. Find your laptop's LAN IP (`ipconfig getifaddr en0` on macOS). Vite also prints the Network URL on startup.
3. In the Meta Quest Browser, go to `https://<laptop-ip>:5173`.
4. Accept the self-signed certificate warning (Advanced → Proceed).
5. Choose **In my room** for passthrough mixed reality, or **In the arena** for a fully virtual venue.

### Controls

| | In headset | Desktop |
| --- | --- | --- |
| Swing the paddle | Move the controller or tracked hand | Move the mouse; click or press <kbd>F</kbd> to swing |
| Pause / arm the Arcade machine | Trigger | <kbd>Space</kbd> |
| Next Arcade mode | Grip | <kbd>D</kbd> |
| Open the menu | A / X / B / Y | <kbd>Tab</kbd> |
| Serve one Arcade ball | — | <kbd>S</kbd> |
| Reset the score | — | <kbd>R</kbd> |
| Back to main menu | Menu → Quit | <kbd>Esc</kbd> |
| Look around | Head tracking | The view follows your paddle |
| Recenter | Menu → Recentre table | <kbd>C</kbd> (or recenter webcam hand tracking) |

### The paddle

With a controller selected, the paddle is parented to the controller's **grip space**, so it inherits the
tracked pose every frame — your hand *is* the paddle, one to one, with no
smoothing or lag added on our side. The paddle also measures its own linear
and angular velocity between frames, which is what the physics needs: blade
speed sets how hard the ball leaves, and the speed of the face across the
ball — mostly a product of wrist rotation — is what puts spin on it.

By default, one hand holds the paddle and the other keeps its controller model
visible. Choose **Paddle hand → Right, Left, or Both** in the menu to change it.

### Menus in VR

DOM overlays are invisible inside an immersive session, so the pause menu is
rendered in world space as well. Point a controller and pull the trigger, or
just look at a row and hold your gaze — the dwell bar fills and commits, so
the menu is fully usable on head tracking alone.

### AR vs VR

| Mode | Background | Floor |
| ---- | ---------- | ----- |
| AR (`immersive-ar`) | Camera passthrough | Your real floor |
| VR (`immersive-vr`) | Dark hall | Virtual hall floor |

Both modes use the `local-floor` reference space, so the table sits at real floor height and its 0.76 m surface lines up with a real one.

## Arcade modes

In Arcade, cycle modes with **grip** (or <kbd>D</kbd>). Stats appear on the in-world scoreboard behind the far end.

| Mode | What it does |
| --- | --- |
| Topspin drive | Heavy topspin, dips and kicks forward off the bounce |
| Backspin push | Floats in, then checks up and loses pace |
| Flat block | No spin, steady pace — timing practice |
| Sidespin mix | Alternating side spin, curves and skids sideways |
| **Infinite** | Machine roams the baseline and randomises pace, spin, axis and interval every ball |
| **Target practice** | Machine steps aside and lobs the ball up in front of you; drive it into the pad on the far half. Hitting it scores and moves the pad |
| **Rally** | A computer opponent returns the ball using the same paddle physics as the player |

Scoring: a **hit** is any paddle contact, a **return** is a hit that lands back on the far half, and the **streak** counts consecutive hits.

## Coach

Coach provides scored stroke paths for serving, a topspin drive, a backspin push, returning a serve, and blocking a drive. The in-world guide shows the intended movement and gives haptic feedback in a headset while the paddle follows it.

## Versus — play a friend

Pick **Versus** on the start menu (<kbd>3</kbd>), then either host a match or type in the code a friend read out to you. Hosting shows a room code and a link; open that link on the other device and it lands on the join step with the code already filled in. Whoever reaches the room first is the host — you can both press Join and it still works.

After a three-second countdown the ball is tossed up in front of the server's paddle for them to hit, the way a real point starts. A toss nobody swings at costs nothing: it is not a serve until it has been struck, so the ball is simply put up again.

Games are to 11 and win by 2. The player who scores a point serves next.

### How it stays in sync

One side simulates. The host runs the same physics the trainer uses and streams the ball's position at 30 Hz; the guest renders that and streams only its own paddle back. There is exactly one simulation, so there is nothing to reconcile between the two views.

Each player swings locally with no round trip, which is the part that has to feel immediate. The cost is that contact is resolved on the host against a paddle pose up to one tick old — fine on a LAN, and much better than waiting for an acknowledgement before the ball moves.

### Transports

The room picks one of three, in this order:

| Transport | When it is used | Reaches |
| --- | --- | --- |
| LAN relay | `npm run dev` (a WebSocket relay built into the dev server) | Anyone on the same Wi-Fi |
| Supabase Realtime | A built app with `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` set | Anywhere |
| BroadcastChannel | Neither of the above | Two tabs on one machine |

Copy `.env.example` to `.env.local` and fill it in for the Supabase path. Nothing else needs configuring — the LAN relay is on whenever the dev server is.

## Scores

Press <kbd>L</kbd> on the start menu. One board per game, because Arcade, Coach and Versus ask completely different things of you and a single number across them would mean nothing. Set the name you want on the board at the top of that screen.

A run is recorded when you quit to the menu, and only if you actually played one — walking in and straight back out does not put a zero on the board. Scores go to Tiger Cloud through `/api/leaderboard` when `TIGER_DATABASE_URL` is configured (table `leaderboard_entries`, columns `player_name`, `score`, `best_streak`, `category`), and to this browser's `localStorage` when it isn't. If the backend is unreachable mid-submit the run is kept locally rather than lost.

There is no seeded demo data: an empty board means nobody has played yet.

## Playing with a physical paddle on a laptop

Choose **On this screen**, then select **Settings → Paddle input → Webcam paddle**. Attach the supported 2×2 printed marker boards to the paddle: IDs 1–4 identify one face and IDs 5–8 identify the other. Hold a marked face toward the webcam and click once to set the neutral pose.

The tracker estimates position and angle from the marker corners. It uses marker spacing for a steadier depth estimate and red/black colour segmentation as an additional paddle-region hint. Multiple marker poses are combined, inconsistent measurements are rejected, and brief marker dropouts are bridged with optical flow.

The expensive detection and pose work runs in a Web Worker instead of the rendering loop. An alpha–beta predictor offsets some camera latency, while position and quaternion filtering reduce jitter. The preview shows the marker corners the tracker is using. Press <kbd>V</kbd> to re-zero the neutral pose and <kbd>T</kbd> to open the webcam tuning panel.

Even lighting, matte marker sheets, a white quiet border around each marker, and keeping at least two markers visible all improve tracking. After the first successful lock, losing the markers briefly holds the last usable paddle position rather than returning control to the mouse.

## The view on a computer

The camera rides with your paddle rather than flying around on its own. A free camera is fine for looking at a scene and hopeless for playing in one: judging where the ball is in depth depends on knowing where *you* are, and a viewpoint that drifts means re-learning that every rally. Anchored to the paddle, the ball grows straight toward you and the only thing to read is its flight.

It follows at a fraction of the paddle's travel rather than one to one — matching exactly swings the whole world about whenever you move, which is unreadable and faintly sickening.

### Playing with your hand

Choose **Hand tracking** on the start menu, or select **Settings → Paddle input → Hand tracking** while playing on a computer. Allow camera access and show an open palm. MediaPipe detects 21 hand landmarks; stable palm joints determine position and orientation, while apparent palm size estimates depth. Press <kbd>C</kbd> to recenter.

A small mirrored preview helps keep your hand visible. Tracking loss pauses paddle collisions, and leaving the mode releases the camera. The model downloads from Google on first use, while the matching MediaPipe runtime and WebAssembly files are bundled with the app. All desktop input methods use a paddle scaled to 140% of its regulation-sized VR counterpart, with collision dimensions scaled to match. Camera access requires HTTPS except on `localhost`.

### Limits worth knowing

- Webcam hand control needs camera permission, a visible palm, and internet access the first time the model is downloaded. If the hand leaves the frame, paddle collisions pause until it is tracked again.
- Physical-paddle control requires the printed marker target; colour alone is only an assist and does not replace the markers.
- The host drives the simulation from its animation loop, which browsers stop in a backgrounded tab. If the host tabs away, the match pauses for both players until it comes back.

## Physics

The simulation is hand-rolled rather than a rigid-body engine — the only interesting contact is ball-against-plane, and doing it directly keeps spin tunable.

- **Quadratic drag**, which a 2.7 g ball feels strongly — it takes several m/s off a hard drive over the table's length.
- **Magnus force** (`a = C·ω×v`), so topspin dips and backspin floats.
- **Spin-aware bounces.** Every contact resolves a normal impulse plus a Coulomb-limited tangential impulse capped at the `(2/7)m|u|` that starts a sphere rolling. This coupling makes topspin kick forward off the table and lets a brushing paddle contact load spin onto the ball.
- **Swept collision** against the paddle and net. A drive covers several centimetres per step and the blade is 15 mm thick, so a position-only test would let fast balls pass straight through the paddle.
- **Resting contacts** are detected and settled instead of bouncing, which otherwise re-triggers every step forever.

The ball machine aims by simulating the shot with those same forces and iterating, rather than using a closed-form ballistic solve — with drag and Magnus in play, an analytic aim puts topspin straight into the net.

## Project structure

```
src/
  main.js         Entry point: renderer, XR session, controllers, game loop
  constants.js    Regulation dimensions, palette, physics tuning
  table.js        Table, net, and the VR venue
  textures.js     Procedural canvas textures (no image assets to load)
  paddle.js       Shared paddle mesh and pose-derived velocity tracking
  handPaddle.js   WebXR hand-joint pose for a headset paddle
  handTracking.js Webcam hand-tracking lifecycle
  vision/         MediaPipe hand pose and ArUco marker-paddle tracking
  ball.js         Pooled ball with spin state
  ballMachine.js  Modes, roaming, feeding, and the launch solver
  physics.js      Fixed-timestep physics: drag, Magnus, spin, swept contacts
  target.js       Target-practice pad
  game.js         Scoring and streaks
  hud.js          In-world scoreboard
  menuModel.js    Menu contents, shared by the flat and VR renderers
  ui.js / ui.css  Start menu, status bar and settings on a screen
  vrMenu.js       The same menu in world space, for inside the headset
  settings.js     Player settings, persisted to localStorage
  audio.js        Procedural WebAudio sound effects
  net.js          WebSocket, Supabase Realtime and local-tab transports
  versus.js       First-to-11, win-by-two match state
  xr.js           WebXR session management
```

## Input architecture

Controllers, WebXR hands, a mouse, webcam hand tracking, and marker tracking all place the same `Paddle` object. Physics reads that paddle's world-space centre, face normal, linear velocity, and angular velocity, so rendering, collisions, scoring, and multiplayer do not need input-specific implementations.

## Service roles

The production data architecture assigns each service one job:

```text
Supabase Realtime
  → live multiplayer Broadcast, Presence, paddle packets, ball state, and score updates

Tiger Cloud / TimescaleDB
  → canonical leaderboard, match results, coaching events, telemetry, and analytics

Backboard.io
  → per-player AI memory and recurring coaching trends

Vercel Functions
  → server-side bridge to Tiger Cloud, OpenAI, Gemini, Baseten, ElevenLabs, Backboard, and Linq

Baseten
  → OpenAI-compatible GLM-5.3-Fast inference for FlyBrain/post-match analysis; configured with `BASETEN_API_KEY` and `BASETEN_MODEL_ID`
```

Tiger leaderboard and telemetry setup lives in `tiger/schema.sql` and `tiger/README.md`. Set `TIGER_DATABASE_URL` only in the Vercel/server environment; never expose it with a `VITE_` prefix. The browser calls `/api/leaderboard` and `/api/telemetry`, while Supabase remains the low-latency realtime transport. Baseten post-match analysis is exposed through `/api/coach/postmatch`; the existing Gemini route remains a fallback if Baseten is unavailable.

## Sponsor tracks

Each sponsor API does one job in the product. Every credential stays server-side in Vercel Functions except Supabase's publishable key, which is designed for the browser.

### Supabase — multiplayer across networks

Supabase Realtime is the transport for online versus matches: Broadcast channels carry paddle and ball packets between the two players, and Presence tracks who is in the room. This is what lets two people on different networks play the same point; on one Wi-Fi the built-in dev-server relay handles it instead. The publishable key (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`) is the only credential that reaches the browser.

### Tiger Data — leaderboard and telemetry

Tiger Cloud (TimescaleDB) is the durable data plane. `leaderboard_entries` holds the canonical per-category leaderboard, and `coaching_events` is a hypertable of stroke scores and match results for later analytics. Both are read and written only through server-only Vercel Functions over a pooled `pg` client (`TIGER_DATABASE_URL`, `TIGER_DATABASE_SSL`); the schema lives in `tiger/schema.sql`.

### OpenAI — per-shot coaching

Each completed Coach stroke is scored locally, then sent to `/api/coach/shot`, where the OpenAI Responses API turns the numbers into one specific correction. The text appears in the coaching panel and is narrated aloud (`OPENAI_API_KEY`, `OPENAI_MODEL`).

### Baseten — post-match analysis

Baseten's OpenAI-compatible endpoint (`inference.baseten.co/v1`) serves `zai-org/GLM-5.3-Fast` for the post-match breakdown at `/api/coach/postmatch` (`BASETEN_API_KEY`, `BASETEN_MODEL_ID`). The original plan was to train the bot and FlyBrain with reinforcement learning on Baseten H100s; with no GPUs allocated this weekend, we use their hosted inference API for match analysis instead, with Gemini as an automatic fallback.

### Gemini — holistic match summary

Google Gemini writes the holistic post-match summary at `/api/coach/match` (`GEMINI_API_KEY`, `GEMINI_MODEL`). It doubles as the fallback when Baseten is unavailable, which also spreads load across providers.

### Backboard — player memory and recurring trends

Coach scores and versus results are appended to a persistent Backboard thread through `/api/profile/event`; the browser stores only the thread ID. On the next session, `/api/profile/summary` has Backboard review the accumulated history and surface recurring tendencies — timing that runs early, a face that opens on pushes — shown in the panel under "Your recurring trends" (`BACKBOARD_API_KEY`, `BACKBOARD_API_BASE_URL`).

### ElevenLabs — narration

Every LLM response is spoken, not just shown: per-shot feedback, the match summary, and the trends recap all go through `/api/coach/narrate`, which renders speech with two distinct narrator voices. The coaching panel can mute narration or pin a voice, and the choice persists across sessions (`ELEVENLABS_API_KEY`, `ELEVENLABS_MODEL_ID`, `ELEVENLABS_NARRATOR_A_VOICE_ID`, `ELEVENLABS_NARRATOR_B_VOICE_ID`).

### Linq — iMessage invitations

Hosting a match can start with a text. Enter a contact's phone number in the lobby and `/api/contact/invite` uses Linq's Partner API to create (or reuse) an iMessage chat and send the room link, so a friend joins from a message instead of hunting for a URL (`LINQ_INTEGRATION_TOKEN`, `LINQ_SEND_FROM`, `LINQ_API_BASE_URL`).

### Vercel — hosting and the server bridge

The frontend deploys as a static Vite build, and every secret-bearing integration above runs as a Vercel Function under `api/`, so the browser never sees a provider key. `npx vercel dev` serves the same routes locally.

### Devin — planning and end-to-end testing

Devin drove planning, end-to-end testing against the deployed Vercel app, and general assistance throughout the build.

## Ideas / next steps

- AR table placement via hit-test (anchor the table to a real surface)
- Per-mode stats history and a session summary
- Easier generation and calibration of printable paddle-marker targets
- More robust webcam tracking under motion blur and difficult lighting
