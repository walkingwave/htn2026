import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// WebXR requires a secure context. basic-ssl gives us a self-signed cert so
// the Quest browser can connect over the LAN (https://<your-ip>:5173).
export default defineConfig({
  plugins: [basicSsl()],
  server: {
    host: true, // expose on LAN so the headset can reach the dev server
    port: 5173,
  },
});
