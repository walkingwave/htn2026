# PaddleLab XR

A table tennis trainer and versus game for the Meta Quest 3S, running entirely in the Meta Quest Browser via **WebXR** — no Unity, no app store, no sideloading. It plays on a laptop too, with a mouse or a real bat through a webcam.

Built at Hack the North 2026.

## The name on screen

The wordmark is set in **Ping Pong**, drawn by Elżbieta Krużyńska in 1974 and digitised by Mateusz Machalski and Małgorzata Bartosik in 2020 ([Capitalics](https://capitalics.wtf/en/font/ping-pong)). The font is free but account-gated, so it is not committed here — see `public/fonts/README.md` to add it. Without it the logo falls back to the interface's monospace face rather than breaking.

## Stack

- [Three.js](https://threejs.org/) — rendering + WebXR session management
- [Vite](https://vite.dev/) — dev server + build
- Custom lightweight physics (fixed timestep, table/net/paddle collisions)

## Getting started

```bash
npm install
npm run dev
```

The dev server runs on **HTTPS** (self-signed cert via `@vitejs/plugin-basic-ssl`) because WebXR requires a secure context.

### On desktop

Open `https://localhost:5173`, accept the cert warning. You get an orbit-camera view of the scene for development without a headset.

### On the Quest 3S

1. Make sure the headset and your laptop are on the **same Wi-Fi network**.
2. Find your laptop's LAN IP (`ipconfig getifaddr en0` on macOS). Vite also prints the Network URL on startup.
3. In the Meta Quest Browser, go to `https://<laptop-ip>:5173`.
4. Accept the self-signed certificate warning (Advanced → Proceed).
5. Click **Enter AR** for passthrough mixed reality (virtual table in your real room), or **Enter VR** for a fully virtual space.

### Controls

| | In headset | Desktop |
| --- | --- | --- |
| Swing the bat | Move your hand | Move the mouse; click or <kbd>F</kbd> to drive |
| Pause / arm the machine | Trigger | <kbd>Space</kbd> |
| Next mode | Grip | <kbd>D</kbd> |
| Open the menu | A / X / B / Y | <kbd>Tab</kbd> |
| Serve one ball | — | <kbd>S</kbd> |
| Reset the score | — | <kbd>R</kbd> |
| Back to main menu | Menu → Quit | <kbd>Esc</kbd> |
| Look around | Head tracking | The view follows your bat |

### The paddle

The bat is parented to the controller's **grip space**, so it inherits the
tracked pose every frame — your hand *is* the paddle, one to one, with no
smoothing or lag added on our side. The paddle also measures its own linear
and angular velocity between frames, which is what the physics needs: blade
speed sets how hard the ball leaves, and the speed of the face across the
ball — mostly a product of wrist rotation — is what puts spin on it.

You hold one bat, not two. The off hand keeps its controller model visible so
you can see where it is but carries no paddle, otherwise it swats balls out
of the air by accident. Swap hands under **Paddle hand** in the menu.

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

## Training modes

Cycle with **grip** (or <kbd>D</kbd>). Stats appear on the in-world scoreboard behind the far end.

| Mode | What it does |
| --- | --- |
| Topspin drive | Heavy topspin, dips and kicks forward off the bounce |
| Backspin push | Floats in, then checks up and loses pace |
| Flat block | No spin, steady pace — timing practice |
| Sidespin mix | Alternating side spin, curves and skids sideways |
| **Infinite** | Machine roams the baseline and randomises pace, spin, axis and interval every ball |
| **Target practice** | Machine steps aside and lobs the ball up in front of you; drive it into the pad on the far half. Hitting it scores and moves the pad |

Scoring: a **hit** is any paddle contact, a **return** is a hit that lands back on the far half, and the **streak** counts consecutive hits.

## Versus — play a friend

Pick **Versus** on the start menu (<kbd>3</kbd>), then either host a match or type in the code a friend read out to you. Hosting shows a room code and a link; open that link on the other device and it lands on the join step with the code already filled in. Whoever reaches the room first is the host — you can both press Join and it still works.

After a three-second countdown the ball is tossed up in front of the server's bat for them to hit, the way a real point starts. A toss nobody swings at costs nothing: it is not a serve until it has been struck, so the ball is simply put up again.

Games are to 11, win by 2, and the server alternates with the point — the winner of a point serves the next one.

### How it stays in sync

One side simulates. The host runs the same physics the trainer uses and streams the ball's position at 30 Hz; the guest renders that and streams only its own bat back. There is exactly one simulation, so there is nothing to reconcile between the two views.

Each player swings locally with no round trip, which is the part that has to feel immediate. The cost is that contact is resolved on the host against a bat pose up to one tick old — fine on a LAN, and much better than waiting for an acknowledgement before the ball moves.

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

A run is recorded when you quit to the menu, and only if you actually played one — walking in and straight back out does not put a zero on the board. Scores go to Supabase when `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` are set (table `leaderboard_entries`, columns `player_name`, `score`, `best_streak`, `category`), and to this browser's `localStorage` when they aren't. If the backend is unreachable mid-submit the run is kept locally rather than lost.

There is no seeded demo data: an empty board means nobody has played yet.

## Playing with a real bat on a laptop

**Settings → Paddle → Webcam bat.** A webcam watches your actual paddle and drives the on-screen one, so a flat-screen player swings a real bat instead of pushing a mouse — the desktop counterpart to hand tracking in the headset.

It finds the rubber by colour, so it needs to be shown the colour once: hold the bat up face-on and click. From there, the blob's ellipse gives pose — apparent size is depth, the centroid is x/y, and the minor/major axis ratio is tilt. If it loses the bat, or you never calibrate, the pointer stays in charge, so you are never left with nothing to play with.

Good light and a bat whose rubber isn't the same colour as your shirt both help a lot. A thumbnail in the corner shows exactly what the camera is matching, which turns most problems into something you can see rather than guess at. <kbd>V</kbd> re-learns the colour without leaving the game — worth pressing after you move to different light. <kbd>B</kbd> flips the tilt if the bat reads back to front: a paddle leaning away projects identically to one leaning toward the camera, and that ambiguity cannot be resolved from the picture alone.

The colour gate adapts as you play, widening when nothing matches and tightening when too much does, so walking under a lamp no longer means recalibrating. A dropped frame or two — a hand across the rubber, a fast swing blurring it — holds the last pose rather than yanking the bat away.

## The view on a computer

The camera rides with your bat rather than flying around on its own. A free camera is fine for looking at a scene and hopeless for playing in one: judging where the ball is in depth depends on knowing where *you* are, and a viewpoint that drifts means re-learning that every rally. Anchored to the bat, the ball grows straight toward you and the only thing to read is its flight.

It follows at a fraction of the bat's travel rather than one to one — matching exactly swings the whole world about whenever you move, which is unreadable and faintly sickening.

### Playing with your hand

Choose **Hand Tracking** on the start menu, or **Settings → Bat follows → Hand Tracking** while playing on a computer. Allow camera access and show an open palm. Move left/right and up/down, move closer/farther for depth, and tilt your palm to angle the paddle. Press **C** to recenter. The hand-controlled paddle is 40% larger, with a matching collision surface.

A small mirrored preview helps keep your hand visible. Tracking loss pauses paddle hits; leaving the mode releases the camera. The hand model downloads on first use, while the matching MediaPipe runtime is bundled locally. Use the HTTPS URL printed by the dev server; deployed camera access also requires HTTPS.

### Limits worth knowing

- Webcam hand control needs a visible palm and a camera permission grant. If the hand leaves the frame, paddle collisions pause until it is tracked again.
- The host drives the simulation from its animation loop, which browsers stop in a backgrounded tab. If the host tabs away, the match pauses for both players until it comes back.

## Physics

The simulation is hand-rolled rather than a rigid-body engine — the only interesting contact is ball-against-plane, and doing it directly keeps spin tunable.

- **Quadratic drag**, which a 2.7 g ball feels strongly — it takes several m/s off a hard drive over the table's length.
- **Magnus force** (`a = C·ω×v`), so topspin dips and backspin floats.
- **Spin-aware bounces.** Every contact resolves a normal impulse plus a Coulomb-limited tangential impulse capped at the `(2/7)m|u|` that starts a sphere rolling. This coupling is what makes topspin kick forward off the table and brushing the paddle load spin onto the ball. Measured: topspin keeps its pace through the bounce (−4% horizontal) where flat and backspin shed ~29%.
- **Swept collision** against the paddle and net. A drive covers several centimetres per step and the blade is 15 mm thick, so a position-only test would let fast balls pass straight through the bat.
- **Resting contacts** are detected and settled instead of bouncing, which otherwise re-triggers every step forever.

The ball machine aims by simulating the shot with those same forces and iterating, rather than using a closed-form ballistic solve — with drag and Magnus in play, an analytic aim puts topspin straight into the net.

## Project structure

```
src/
  main.js         Entry point: renderer, XR session, controllers, game loop
  constants.js    Regulation dimensions, palette, physics tuning
  table.js        Table, net, and the VR venue
  textures.js     Procedural canvas textures (no image assets to load)
  paddle.js       Controller paddle with linear + angular velocity tracking
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
  xr.js           WebXR session management
```

## Working on the desktop build

The **Computer** entry on the start menu is the hand-off point for the
screen-and-keyboard version. `UI`'s `onStart` callback receives the chosen
mode — an XR session mode, or `null` for the on-screen path — so the desktop
build can branch there without touching the VR code. Everything below the UI
layer (physics, modes, scoring, the machine) is input-agnostic and already
shared.

## Ideas / next steps

- Hit/bounce audio (positional `THREE.Audio`)
- Hand tracking fallback (Quest Browser supports WebXR hand input)
- AR table placement via hit-test (anchor the table to a real surface)
- Per-mode stats history and a session summary
