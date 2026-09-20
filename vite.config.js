import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import os from 'node:os';
import { WebSocketServer } from 'ws';
import { decodeMessage, encodeMessage, isClientMessage, isValidRoomCode } from './src/multiplayerProtocol.js';

const WS_PATH = '/__flyball_ws';

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

function multiplayerRelay() {
  return {
    name: 'flyball-multiplayer-relay',
    configureServer(server) {
      const rooms = new Map();
      const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

      const removeClient = (client) => {
        if (!client.room) return;
        const peers = rooms.get(client.room);
        peers?.delete(client);
        if (peers?.size === 0) rooms.delete(client.room);
        else for (const peer of peers) peer.send(encodeMessage('__presence', { present: false }));
        client.room = null;
      };

      wss.on('connection', (client, request) => {
        client.room = null;
        client.role = null;

        client.on('message', (raw) => {
          const message = decodeMessage(raw.toString());
          if (!message) return client.close(1003, 'Invalid multiplayer message');

          if (message.type === '__join') {
            const code = message.data?.code;
            const role = message.data?.role;
            if (!isValidRoomCode(code) || (role !== 'host' && role !== 'guest')) {
              return client.close(1008, 'Invalid room join');
            }
            const peers = rooms.get(code) ?? new Set();
            if (peers.size >= 2) return client.close(1008, 'Room is full');
            client.room = code;
            client.role = role;
            peers.add(client);
            rooms.set(code, peers);
            client.send(encodeMessage('__joined', {
              role,
              present: peers.size >= 2,
              lanUrls: lanUrlsFor(request),
            }));
            if (peers.size >= 2) for (const peer of peers) peer.send(encodeMessage('__presence', { present: true }));
            return;
          }

          if (!client.room) return;
          if (message.type === '__leave') return client.close(1000, 'Left room');
          if (!isClientMessage(message)) return;

          const peers = rooms.get(client.room);
          if (!peers) return;
          for (const peer of peers) {
            if (peer !== client && peer.readyState === 1) peer.send(encodeMessage(message.type, message.data));
          }
        });
        client.on('close', () => removeClient(client));
        client.on('error', () => removeClient(client));
      });

      server.httpServer?.on('upgrade', (request, socket, head) => {
        const pathname = new URL(request.url, 'http://localhost').pathname;
        if (pathname !== WS_PATH) return;
        wss.handleUpgrade(request, socket, head, (client) => wss.emit('connection', client, request));
      });

      server.httpServer?.once('close', () => {
        for (const peers of rooms.values()) for (const client of peers) client.close();
        wss.close();
      });
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [multiplayerRelay(), ...(mode === 'https' ? [basicSsl()] : [])],
  server: {
    host: true,
    port: 5173,
  },
}));
