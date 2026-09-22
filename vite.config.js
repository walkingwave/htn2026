import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import os from 'node:os';
import { WebSocketServer } from 'ws';
import {
  decodeMessage,
  encodeMessage,
  isClientMessage,
  isValidRoomCode,
} from './src/multiplayerProtocol.js';

const WS_PATH = '/__flyball_ws';

// Every non-loopback IPv4 address this machine answers on, so the host can be
// handed a link that the headset on the same Wi-Fi can actually open —
// `localhost` is useless to the other device.
function lanUrlsFor(request) {
  const host = request.headers.host || 'localhost:5173';
  const port = new URL(`http://${host}`).port || '5173';
  const protocol = request.socket.encrypted ? 'https' : 'http';
  const urls = [];
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const address of interfaces || []) {
      if (address.family === 'IPv4' && !address.internal) {
        urls.push(`${protocol}://${address.address}:${port}`);
      }
    }
  }
  return [...new Set(urls)];
}

// Two-player relay attached to the dev server. It keeps no game state — it
// pairs sockets by room code and forwards whitelisted messages to the other
// side — which is all online versus needs when both players are on one LAN.
function multiplayerRelay() {
  return {
    name: 'pingpong-multiplayer-relay',
    configureServer(server) {
      const rooms = new Map();
      const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

      const tournamentPlayers = (peers) =>
        [...(peers ?? [])]
          .map((peer) => peer.player)
          .filter(Boolean)
          .sort((a, b) => a.joinedAt - b.joinedAt || a.id.localeCompare(b.id));

      const broadcastTournamentRoster = (peers) => {
        const data = { players: tournamentPlayers(peers) };
        for (const peer of peers ?? []) {
          if (peer.readyState === 1) peer.send(encodeMessage('__tournament-roster', data));
        }
      };

      const removeClient = (client) => {
        if (!client.room) return;
        const peers = rooms.get(client.room);
        peers?.delete(client);
        if (peers?.size === 0) rooms.delete(client.room);
        else if (client.kind === 'tournament') broadcastTournamentRoster(peers);
        else {
          for (const peer of peers) {
            peer.send(encodeMessage('__presence', { present: false }));
          }
        }
        client.room = null;
        client.kind = null;
        client.player = null;
      };

      // A TCP socket can stay open long after the device behind it has gone —
      // a sleeping headset reports nothing at all. Ping every few seconds and
      // cut anything that hasn't answered the last one, so the other player
      // learns their opponent is gone instead of waiting on a corpse.
      const HEARTBEAT_MS = 8000;
      const heartbeat = setInterval(() => {
        for (const client of wss.clients) {
          if (client.isAlive === false) {
            removeClient(client);
            client.terminate();
            continue;
          }
          client.isAlive = false;
          client.ping();
        }
      }, HEARTBEAT_MS);

      wss.on('connection', (client, request) => {
        client.room = null;
        client.role = null;
        client.kind = null;
        client.player = null;
        client.isPose = false;
        client.isAlive = true;
        client.on('pong', () => {
          client.isAlive = true;
        });

        client.on('message', (raw) => {
          const message = decodeMessage(raw.toString());
          if (!message) return client.close(1003, 'Invalid multiplayer message');

          if (message.type === '__tournament-join') {
            const code = message.data?.code;
            const rawPlayer = message.data?.player;
            const id = typeof rawPlayer?.id === 'string' ? rawPlayer.id.trim() : '';
            const name = typeof rawPlayer?.name === 'string' ? rawPlayer.name.trim() : '';
            if (!isValidRoomCode(code) || !id || id.length > 96 || name.length > 24) {
              return client.close(1008, 'Invalid tournament join');
            }

            const roomKey = `tournament:${code}`;
            const peers = rooms.get(roomKey) ?? new Set();
            for (const peer of [...peers]) {
              if (peer.readyState !== 1 /* OPEN */) peers.delete(peer);
            }
            if (peers.size >= 4) return client.close(1008, 'Tournament room is full');

            client.room = roomKey;
            client.kind = 'tournament';
            // The relay clock decides the bracket seed, not a device clock.
            client.player = { id, name: name || 'Player', joinedAt: Date.now() };
            peers.add(client);
            rooms.set(roomKey, peers);
            client.send(
              encodeMessage('__tournament-joined', {
                players: tournamentPlayers(peers),
                lanUrls: lanUrlsFor(request),
              })
            );
            broadcastTournamentRoster(peers);
            return;
          }

          if (message.type === '__join') {
            const code = message.data?.code;
            if (!isValidRoomCode(code)) {
              return client.close(1008, 'Invalid room join');
            }
            const peers = rooms.get(code) ?? new Set();
            const poseClient = message.data?.kind === 'pose';

            // Pose clients are camera companions, not additional players. A
            // phone can therefore stream paddle poses into an existing
            // two-player room without making the room appear full.
            for (const peer of [...peers]) {
              if (peer.readyState !== 1 /* OPEN */) peers.delete(peer);
            }
            const players = [...peers].filter((peer) => !peer.isPose);
            if (!poseClient && players.length >= 2) {
              return client.close(1008, 'Room is full');
            }

            // Game roles are decided by arrival. Pose clients get a dedicated
            // role and never participate in game presence.
            const role = poseClient ? 'pose' : players.length === 0 ? 'host' : 'guest';
            client.room = code;
            client.role = role;
            client.isPose = poseClient;
            peers.add(client);
            rooms.set(code, peers);
            client.send(
              encodeMessage('__joined', {
                role,
                present: players.length >= 2,
                lanUrls: lanUrlsFor(request),
              })
            );
            if (!poseClient && players.length >= 2) {
              for (const peer of peers) {
                if (!peer.isPose) peer.send(encodeMessage('__presence', { present: true }));
              }
            }
            return;
          }

          if (!client.room) return;
          if (message.type === '__leave' || message.type === '__tournament-leave') {
            return client.close(1000, 'Left room');
          }
          if (!isClientMessage(message)) return;
          if (client.kind === 'tournament' && message.type !== 'tournament') return;
          if (client.kind !== 'tournament' && message.type === 'tournament') return;

          const peers = rooms.get(client.room);
          if (!peers) return;
          for (const peer of peers) {
            if (peer === client || peer.readyState !== 1) continue;
            // Pose packets go from a phone to game clients only. Match packets
            // go between game clients and are not echoed to the phone.
            const sameChannel = message.type === 'pose'
              ? !peer.isPose
              : !client.isPose && !peer.isPose;
            if (sameChannel) peer.send(encodeMessage(message.type, message.data));
          }
        });
        client.on('close', () => removeClient(client));
        client.on('error', () => removeClient(client));
      });

      server.httpServer?.on('upgrade', (request, socket, head) => {
        const pathname = new URL(request.url, 'http://localhost').pathname;
        if (pathname !== WS_PATH) return;
        wss.handleUpgrade(request, socket, head, (client) =>
          wss.emit('connection', client, request)
        );
      });

      server.httpServer?.once('close', () => {
        clearInterval(heartbeat);
        for (const peers of rooms.values()) for (const client of peers) client.close();
        wss.close();
      });
    },
  };
}

// WebXR requires a secure context. basic-ssl gives us a self-signed cert so
// the Quest browser can connect over the LAN (https://<your-ip>:5173).
export default defineConfig({
  plugins: [
    multiplayerRelay(),
    basicSsl({
      // Keep the certificate outside node_modules.
      //
      // By default it lives in node_modules/.vite, which is exactly what
      // gets deleted to clear Vite's cache — and regenerating it invalidates
      // the trust exception you granted in the headset, so the browser
      // starts blocking the page and the app looks like it broke. Parking it
      // here means the cert survives a cache clear and a reinstall, and you
      // only have to accept the warning once per machine.
      certDir: '.certs',
    }),
  ],
  server: {
    host: true, // expose on LAN so the headset can reach the dev server
    port: 5173,
  },
});
