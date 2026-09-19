import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// Desktop and webcam CV work over http://localhost. Use `vite --mode https`
// only when testing WebXR on a device that requires a secure LAN context.
export default defineConfig(({ mode }) => ({
  plugins: mode === 'https' ? [basicSsl()] : [],
  server: {
    host: true,
    port: 5173,
  },
}));
