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
5. Click **Enter VR**.

Controls:
- Paddles are attached to both controllers.
- **Trigger** toggles the ball machine on/off.

## Project structure

```
src/
  main.js         Entry point: renderer, XR session, controllers, game loop
  constants.js    Regulation table/ball/paddle dimensions, physics tuning
  table.js        Table, net, lines, floor meshes
  paddle.js       Controller-attached paddle with velocity tracking
  ball.js         Pooled ball object
  ballMachine.js  Trainer: serves balls at the player on an interval
  physics.js      Fixed-timestep physics: gravity, bounces, paddle hits
```

## Ideas / next steps

- Haptic pulse on paddle hit (`gamepad.hapticActuators[0].pulse(...)`)
- Hit/bounce audio (positional `THREE.Audio`)
- Scoring + drill modes (target zones on the table)
- Spin (Magnus effect) in `physics.js`
- Hand tracking fallback (Quest Browser supports WebXR hand input)
- Passthrough mixed reality (`immersive-ar` session on Quest 3S)
