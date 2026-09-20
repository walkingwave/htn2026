# Ping Pong VR Trainer (HTN 2026)

Web-based ping pong trainer/simulator for the Meta Quest 3S, running entirely in the Meta Quest Browser via **WebXR** — no Unity, no app store, no sideloading.

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
| Swing the bat | Move your hand | — |
| Pause / arm the machine | Trigger | <kbd>Space</kbd> |
| Next mode | Grip | <kbd>D</kbd> |
| Open the menu | A / X / B / Y | <kbd>Tab</kbd> |
| Serve one ball | — | <kbd>S</kbd> |
| Reset the score | — | <kbd>R</kbd> |
| Back to main menu | Menu → Quit | <kbd>Esc</kbd> |
| Look around | Head tracking | Drag to orbit |

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

Pick **Versus** on the start menu (<kbd>3</kbd>), then either host a match or type in the code a friend read out to you. Hosting shows a room code and a link; open that link on the other device and it lands on the join step with the code already filled in. Once both sides are in, pick your entry (VR, passthrough or computer) and the host serves after a three-second countdown.

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

### Limits worth knowing

- A desktop browser has no tracked bat, so a computer player can watch a match but cannot return a ball. Versus is meant to be played in the headset.
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
