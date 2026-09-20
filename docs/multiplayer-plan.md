# Handoff — Play-a-Friend Multiplayer (all inputs) + VS Intro

> **Audience:** the teammate picking this up. This doc is self-contained — you should be
> able to execute the whole feature from here without additional context.
>
> **Branch:** all work happens on `multiplayer`. Do **not** push or open a PR without the
> team's OK.

---

## 0. TL;DR

The online-versus engine is ~90% built already (transport abstraction, host-authoritative
match loop, lobby UI, win overlay). What's missing to make "Play a Friend" real:

1. A **WebSocket relay** mounted on the Vite dev server (same-origin `wss://`).
2. A **"same WiFi / different network"** choice that picks which share-link to hand out.
3. **Input-agnostic paddle sync** (today it hardcodes the mouse paddle → VR is broken online).
4. **Phone-as-a-paddle** input (gyro/orientation streamed from the phone to the laptop).
5. A **Wii-Sports-style "VS" intro animation** before the first serve.
6. **Latency tuning** (30 → 60 Hz + tighter interpolation).
7. **Docs cleanup** + this plan committed.

Everything is transport-agnostic, so the intro/match/paddle work is independent of the
networking work and can be parallelised.

---

## 1. Getting started

```bash
git checkout multiplayer
npm install
npm run dev          # http://localhost:5173  (desktop / mouse / webcam on localhost)
npm run dev:https    # https LAN URL — REQUIRED for VR / webcam / phone on a *remote* device
```

- Desktop dev on `localhost` works over plain http (localhost is a "secure context").
- Any **remote** device using VR, webcam, or phone input **must** load the app over **HTTPS**
  (`npm run dev:https`) and accept the self-signed dev cert once. This is a hard browser
  requirement (see §4), not a preference.
- Shell note: the dev machine is Windows PowerShell — chain commands with `;`, not `&&`.

---

## 2. Problem statement

Complete the "Play a Friend" flow: host creates a room with a join code, the player picks
whether the friend is on the same WiFi or a different network, the friend joins over a
WebSocket, a Wii-Sports-style "VS" animation plays, then the match starts with the host
serving. It must work with **any** input on either side — VR headset, webcam CV paddle,
phone-as-paddle, or mouse — and be tuned for low latency.

---

## 3. Current architecture (what already exists)

### `src/net.js` — transport layer
- `makeRoomCode()` — ambiguity-free 6-char code (no O/0/I/1).
- `roomLinkFor(code)` — builds a share link with `?room=CODE` (currently off `window.location`,
  path `/live-game`). **Will need updating to a reachable HTTPS/LAN URL — see Task 3.**
- `roomFromUrl()` / `clearRoomFromUrl()` — auto-join helpers.
- Transport **contract** every backend implements: `connect()`, `send(type, data)`,
  `on(type, cb)`, `onOpponent(cb)`, `close()`, plus a `code`/`role`/`kind` and
  `opponentPresent` getter.
- Two backends today:
  - `SupabaseTransport` — Realtime broadcast + presence (cross-device, needs Supabase keys).
  - `BroadcastChannelTransport` — same-machine two-tab fallback (no backend).
- `createRoom({ code, role })` picks the transport (`supabase ? Supabase : BroadcastChannel`).
- Presence semantics: `onOpponent(present)` fires with a boolean; subscribers are called
  immediately with the current state (so late subscribers sync).

### `src/versus.js` — pure match state (no DOM, no network)
- `VersusMatch` — first to 11, win by 2 (deuce continues). Tracks `scoreHost`, `scoreGuest`,
  `server` (`'host'`/`'guest'`), `winner`, `rally`.
- `scorePoint(scorer)` — increments, sets `server = scorer` (scorer serves next), returns the
  winner or `null`.
- `snapshot()` / `apply(snap)` — for host→guest state replication.

### `src/main.js` — host-authoritative online loop (already wired)
- `enterVersus(role, code)` / `leaveVersus()` — join/leave a networked 1v1. Host sits at `+Z`,
  guest at `-Z` (player rig rotated 180° and pointer mapping mirrored).
- Host is authoritative: serves the ball, resolves floor bounces into points
  (`handleVersusHostBounce`), and broadcasts state at **30 Hz** (`NET_TICK = 1/30`).
- Guest renders host state (`applyHostState`) and sends only its paddle
  (`runVersusGuest` → `room.send('paddle', …)`), lerping the ball toward the authoritative
  position (`versusBall.mesh.position.lerp(guestBallTarget, min(1, dt*16))`).
- `bladePacket(paddle)` — serialises `{c: bladeCenter, n: bladeNormal, v: velocity}`.
- `applyRemotePaddle(pkt)` — poses the generic `remotePaddle` (attached to `remoteAnchor`).
- Serve/countdown: `startVersusServe()` (3s), `serveVersusBall()`, `VERSUS_SERVE_SECONDS = 3`.
- Presence hook already exists in `enterVersus`:
  ```js
  room.onOpponent((present) => {
    ui.setVersusOpponent(present);
    if (present && role === 'host' && !match.winner && !versusBall && versusServeTimer <= 0) {
      startVersusServe();          // ← Task 8 inserts the intro before this
    }
  });
  ```
- Auto-join from a shared link at the bottom of the file (`roomFromUrl()` → `openVersusLobby`
  + `enterVersus('guest', …)`).
- There is also a **local bot** path (`startBotGame` / `updateBotPaddle` / `endBotMatch`) that
  reuses the host loop with no room.

### `src/ui.js` — menus, lobby, scoreboard, win overlay
- Mode step entries include `{ id: 'friend', label: 'Play a Friend', note: 'beta' }`.
- Selecting **friend** already does the real thing (NOT the bot):
  ```js
  if (entry.id === 'friend') {
    const info = await this.onVersusCreate?.();   // main.js: makeRoomCode + enterVersus('host')
    if (info) this.openVersusLobby(info);
    return;
  }
  ```
- `_buildVersus()` builds `#versus` (lobby: code + copy-link + "Waiting for opponent…"; plus a
  hidden scoreboard) and `#versus-win`. **Task 7 adds the `#versus-intro` overlay here.**
- `openVersusLobby({role, code, link, kind})`, `setVersusOpponent(present)` (flips
  lobby→scoreboard), `updateVersusScore(snapshot, myRole)`, `showVersusWin(didWin, snapshot)`,
  `showBotMatch(name)`, `closeVersus()`.

### `package.json` / `vite.config.js`
- Vite 6, three 0.170, `@supabase/supabase-js`, `@mediapipe/tasks-vision`,
  `@vitejs/plugin-basic-ssl`. Scripts: `dev`, `dev:https`, `build`, `preview`. **No test
  framework yet.**
- `vite.config.js` loads `basicSsl()` only in `--mode https`; `server: { host: true, port: 5173 }`.

---

## 4. Key decisions & rationale (already agreed — do not relitigate)

- **Transport = WebSockets.** WebRTC/STUN/TURN and a cloud-primary relay are **out of scope**.
- **Same WiFi vs different network is chosen by asking the player**, not auto-detected.
  - Same WiFi → direct LAN `wss` (single-digit-ms latency).
  - Different network → same-origin `wss` reached via a public tunnel/deploy (configurable origin).
- **Mount the relay on the Vite dev server** so it's same-origin `wss://${location.host}`. Why:
  - VR (WebXR) and webcam (`getUserMedia`) require a **secure context**; a remote device on
    plain `http://<lan-ip>` is **not** secure → those inputs are blocked. So friend play must be
    **HTTPS** (repo already supports `dev:https`).
  - An HTTPS page **cannot** open an insecure `ws://` (mixed content) → the relay must be `wss://`.
  - Same-origin means it reuses the already-accepted self-signed cert and the same port — no
    second cert prompt, no extra firewall hole.
- **Phone is just another paddle input** (like the webcam CV paddle). The phone connects to the
  laptop over `wss` and continuously feeds orientation + gyro + accelerometer; the laptop turns
  that stream into the paddle pose, driving the paddle rig exactly like the CV tracker drives the
  mouse rig. iOS 13+ needs `DeviceOrientationEvent.requestPermission()` from a user tap over
  HTTPS. It is a **live sensor feed**, not a one-shot pairing.
- **All four inputs must interoperate on either side.** The receive side already renders a generic
  remote paddle from packets; the only fix needed is the **send** side (Task 5).
- **Latency:** 30 → 60 Hz + tighter interpolation. WiFi jitter is absorbed by interpolation.

---

## 5. Gaps to fix (maps 1:1 to the tasks)

| # | Gap | Task |
|---|-----|------|
| 1 | No WebSocket relay transport (only Supabase/BroadcastChannel) | 2, 3 |
| 2 | No "same WiFi?" step | 4 |
| 3 | Paddle sync hardcodes `bladePacket(mousePaddle)` → VR broken online | 5 |
| 4 | No phone input (menu stub toasts "coming — using the mouse") | 6 |
| 5 | No VS intro animation | 7, 8 |
| 6 | 30 Hz + guest `lerp(…, dt*16)` add felt lag | 9 |
| 7 | Secure-context inputs need HTTPS; links use `localhost` | 2, 3 |
| 8 | Stale README "falls back to bot"; dead `mode==='friend'` branch in `main.js` `onStart` | 10 |

---

## 6. Task breakdown (test-driven, incremental, each demoable)

Work top-to-bottom, but Tasks 5, 7, 8, 9 are transport-independent and can be done in parallel
with 2–4/6 if you split the work.

### Task 1 — Baseline + match-rule tests
- Add **Vitest**: `npm install -D vitest`, add `"test": "vitest run"` (and optionally
  `"test:watch": "vitest"`) to `package.json` scripts.
- Create `src/versus.test.js` covering `VersusMatch`:
  - scoring to 11 and the winner is set;
  - **win-by-2 / deuce** (10–10 keeps going until a 2-point gap);
  - **server alternation** (the scorer serves next);
  - `snapshot()` → `apply()` round-trip preserves scores/server/winner/target.
- Sanity-check the existing friend flow tab-to-tab via the BroadcastChannel fallback
  (no Supabase keys needed): "Play a Friend" in tab A, open the copied link in tab B.
- **Demo:** `npm test` passes; two tabs rally a point and the score updates.

### Task 2 — Same-origin `wss` relay on the Vite dev server + HTTPS default
- `npm install -D ws`.
- Add a small Vite plugin (in `vite.config.js` or `server/relayPlugin.js`) that, in
  `configureServer(server)`, attaches a `ws` server via **`new WebSocketServer({ noServer: true })`**
  and handles `server.httpServer.on('upgrade', …)` for a dedicated path (e.g. `/relay`).
  - Parse `?room=CODE&role=…` from the upgrade request URL.
  - Keep a `Map<code, Set<socket>>`. On message, forward to the **other** peer(s) in the room.
  - Track presence: when the room size crosses 2, notify both peers (send a reserved
    `{type:'__opponent', data:true/false}` message, or mirror however the transport in Task 3
    expects presence). Clean up on `close`.
- Because it's mounted on Vite's server, it inherits `dev:https`'s TLS and origin, so clients use
  `wss://${location.host}/relay`.
- Log the shareable **LAN HTTPS URL** on server start (Vite already prints a "Network:" URL;
  surface the relay-ready link too).
- **Demo:** two `wscat`/browser clients on the same `?room=` exchange messages; LAN HTTPS URL printed.

### Task 3 — `WebSocketTransport` in `net.js` + wiring
- Add a `WebSocketTransport` class implementing the same contract as the existing transports:
  - `connect()` opens `new WebSocket(`${wsProto}//${location.host}/relay?room=${code}&role=${role}`)`
    where `wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:'`.
  - `send(type, data)` → `ws.send(JSON.stringify({type, data}))`.
  - `on(type, cb)` / dispatch in `ws.onmessage` (JSON parse). Route the reserved
    `__opponent` message to `onOpponent`.
  - `close()` → `ws.close()`.
- Update `createRoom` to prefer `WebSocketTransport`, falling back to `BroadcastChannelTransport`
  for same-machine dev (Supabase becomes optional / removed from the default path). Consider a
  `url`/origin param so Task 4 can point it at a public origin.
- Update `roomLinkFor(code)` to build a **reachable** link (host LAN address over the current
  protocol, not `localhost`).
- **Demo:** two devices on the same WiFi connect via the shared HTTPS link and reach the scoreboard.

### Task 4 — "Same WiFi?" step in the friend flow (`ui.js`)
- After selecting **Play a Friend**, insert a choice step: **"Is your friend on the same WiFi?"**
  - **Same WiFi** → build/share the **LAN-IP HTTPS** link.
  - **Different network** → build/share a **public HTTPS** link (configurable public origin, e.g.
    `VITE_RELAY_URL` for a tunnel/deploy — the actual endpoint can be decided later).
- The transport stays same-origin `wss` in both cases; the difference is only which link is shared
  / how the host is reached. Thread the choice through `onVersusCreate`/`onVersusJoin` → `createRoom`.
- Reuse the existing step scaffolding in `ui.js` (`_stepConfig` / `_gotoStep` / `_activateMenu`).
- **Demo:** each option yields a link the friend can actually open, and connecting works.

### Task 5 — Input-agnostic paddle sync (`main.js`)
- Replace the hardcoded `bladePacket(mousePaddle)` in **both** `broadcastHostState()` and the guest
  send path (`runVersusGuest`) with a helper that returns the **active** paddle:
  - the enabled XR grip paddle when `renderer.xr.isPresenting` (see `paddles[0]/[1]` +
    `applyHandedness()` for which one is held), otherwise
  - the mouse/CV/phone rig paddle (`mousePaddle`).
- The receive/render path (`applyRemotePaddle` + `remotePaddle`) is already generic — no change.
- **Demo:** a VR player and a mouse player see each other's paddles move; a point plays across
  mismatched inputs.

### Task 6 — Phone-as-paddle input
- Build a lightweight **phone controller client** (a route/page, e.g. `?controller=CODE`, or a
  small `controller.html`) that:
  - pairs into a session via **QR / join code** over `wss` (show the QR on the laptop lobby;
    encode the HTTPS controller URL with the room code);
  - requests `DeviceOrientationEvent.requestPermission()` / `DeviceMotionEvent.requestPermission()`
    from a **user tap** (iOS 13+), over HTTPS;
  - streams `deviceorientation` (alpha/beta/gamma → blade angle) + `devicemotion` acceleration
    (→ swing velocity / spin) continuously.
- On the laptop, consume the feed to drive the paddle rig — **mirror `src/vision/paddleTracker.js`**
  (the CV tracker) which already drives `mousePaddleRig` in `main.js`'s `tick()`. Once it drives the
  rig, Task 5's active-paddle sync relays it to the opponent automatically.
- Wire **"A Phone"** as a working input in the input step (remove the "coming — using the mouse"
  stub for this path in `main.js` `onStart`).
- **Demo:** pair a phone via QR, swing it, the on-screen paddle follows tilt/swing; play a point
  against a friend using the phone.

### Task 7 — VS intro overlay (pure timing first)
- Add `src/versusIntro.js` — a **pure** helper that, given `elapsed` and `total` (~2.5 s), returns
  the current phase/progress: `slideIn` → `stamp` (the "VS" scales/flashes in) → `hold` → `fade`.
  Keep it DOM-free so it's unit-testable. Add `src/versusIntro.test.js` (correct phase at
  representative `t`; clamps at `0` and `total`).
- Add a `#versus-intro` DOM overlay in `ui.js._buildVersus()` (two name/paddle panels that slide in
  from each edge, a big "VS" stamp) with CSS keyframes in `ui.css`/`styles.css`.
- Add `playVersusIntro({ youName, themName, onDone })` on the UI: reveal the overlay, run the
  ~2.5 s animation (drive it off the pure helper or CSS animationend), hide it, reveal the
  scoreboard, then call `onDone`.
- **Demo:** call `window.__probe.ui.playVersusIntro(...)` from the console; the reveal plays and
  hands off to the scoreboard.

### Task 8 — Wire the intro into opponent-connected; host serves after it
- In `main.js`'s `room.onOpponent(present)` handler, when `present === true`, call
  `ui.playVersusIntro(...)` on **both** host and guest (both trigger locally on the presence
  transition, keeping them roughly in sync).
  - Host schedules `startVersusServe()` inside the intro's `onDone` (instead of calling it
    immediately). Guest plays the intro visually only.
- Handle **opponent-left mid-intro** (cancel/hide the overlay cleanly) and **re-entry reset** so a
  second match replays the intro (reset any "intro already played" flag in `leaveVersus`).
- `match.server` defaults to `'host'`, so the host serves first — matches the "you serve" goal.
- **Demo:** friend joins → both see the VS animation → 3-2-1 → host serves. End-to-end friend match.

### Task 9 — Latency tuning
- Raise the versus send rate 30 → 60 Hz: `NET_TICK = 1/60` in `main.js`.
- Tighten the guest ball/paddle interpolation — increase the lerp factor (e.g. `dt*16` → higher) or
  make it adaptive to packet arrival — so the guest tracks the authoritative state closely without
  stuttering on WiFi jitter. Keep payloads compact/numeric (already close).
- **Demo:** side-by-side play feels responsive on same-WiFi.

### Task 10 — Docs + save plan + commit
- Update `README.md`: describe the friend flow, `npm run dev:https` for cross-device play, the
  same-WiFi vs different-network choice, and all four inputs including phone pairing (QR + motion
  permission). **Remove** the stale "friend mode falls back to the bot" line.
- **Remove** the misleading `mode==='friend'` bot-fallback branch in `main.js` `onStart` (it's
  unreachable via the menu, which returns early after `openVersusLobby`).
- Keep this document (`docs/multiplayer-plan.md`) as the source of truth.
- Verify `npm run build` passes and `npm test` is green, then commit on `multiplayer`.
  **Do not push without the team's OK.**
- **Demo:** `git log` shows the commit; app builds; tests pass.

---

## 7. Gotchas & environment notes

- **PowerShell:** chain commands with `;`, not `&&`.
- **HTTPS is mandatory for VR/CV/phone on a remote device** — there is no way around the
  secure-context requirement. Friend accepts the self-signed dev cert once. Mouse-only play works
  over plain http on the LAN, but standardise on `dev:https` so every input works.
- **Mixed content:** an HTTPS page must use `wss://`, never `ws://`. The same-origin relay handles
  this automatically (`wss://${location.host}`).
- **`main.js` already disables the mouse paddle in XR** (`sessionstart`/`sessionend` listeners) and
  networked paddles skip `Paddle.update()` (guarded by `paddle.networked`). Keep that invariant when
  wiring the active-paddle sync (Task 5).
- **iOS motion permission** must be requested from a real user gesture (a tap), or it silently fails.
- **Different-network reach:** the same-origin `wss` design means the host must be publicly reachable
  for cross-network play — via a tunnel (e.g. cloudflared/ngrok, which provide valid TLS) or a
  deploy. Wire the public origin behind a config value (`VITE_RELAY_URL`) so it can be set later
  without code changes.
- **Verification split:** pure logic (`VersusMatch`, intro timing) is unit-tested with Vitest; the
  networked / three.js / WebXR paths are verified manually with two devices/tabs (not practical to
  unit-test).

---

## 8. Definition of done

- [ ] `npm test` green (VersusMatch + intro-timing units).
- [ ] `npm run build` passes.
- [ ] "Play a Friend" → room code → "same WiFi / different network" → friend joins over `wss` →
      **VS intro plays** → host serves. Verified with two devices on the same WiFi.
- [ ] VR, webcam CV paddle, phone, and mouse all drive the paddle and sync to the opponent
      (interoperable across sides).
- [ ] 60 Hz sync; play feels responsive on same-WiFi.
- [ ] README updated; dead `mode==='friend'` fallback removed; this doc committed on `multiplayer`
      (no push without the team's OK).

---

## 9. Scope notes (out of scope)

- WebRTC / STUN / TURN.
- Cloud relay as the **primary** transport.
- A standalone full-mobile-client game (the phone is a paddle **controller** for the laptop, not
  its own renderer).
