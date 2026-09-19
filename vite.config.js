import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// WebXR requires a secure context. basic-ssl gives us a self-signed cert so
// the Quest browser can connect over the LAN (https://<your-ip>:5173).
export default defineConfig({
  plugins: [
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
