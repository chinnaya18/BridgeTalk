import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

/**
 * Vite reads `.env` from the *frontend* folder by default. Our single source of
 * truth is the repository-root `.env`, so `envDir` points one level up. Only
 * variables prefixed with VITE_ are exposed to client code — that prefix is
 * what stops the JWT secret and database password leaking into the bundle.
 *
 * TWO-DEVICE DEVELOPMENT MODE
 * ---------------------------
 * Interview mode and speech recognition cannot be tested honestly with two
 * windows on one laptop: fullscreen in one window and clicking the other
 * counts as a violation, and both windows share a single microphone.
 *
 * `npm run dev:lan` sets BRIDGETALK_LAN=1, which turns on three things:
 *
 *   1. `host: true` — listen on every interface, so another device on the same
 *      Wi-Fi can reach it.
 *   2. HTTPS via a self-signed certificate. Not optional: `getUserMedia`
 *      requires a *secure context*, and only `localhost` is exempt. Over plain
 *      http on a LAN address the camera prompt never appears at all.
 *   3. A proxy for `/api` and `/ws`, so the second device needs ONE address and
 *      trusts ONE certificate. Without it the browser would also have to accept
 *      a second self-signed certificate for the backend, which it will not do
 *      silently for a WebSocket — the connection fails with no usable error.
 *
 * The production build is untouched: none of this applies to `vite build`.
 */
const LAN = process.env.BRIDGETALK_LAN === '1';

// The backend to proxy to in LAN mode. Localhost is right even here: Vite runs
// on the same machine as the API, and only the BROWSER is remote.
const BACKEND = process.env.BRIDGETALK_BACKEND ?? 'http://127.0.0.1:8000';

export default defineConfig({
  plugins: [react(), ...(LAN ? [basicSsl()] : [])],
  envDir: '..',
  server: {
    port: 5173,
    // Fail loudly instead of silently moving to :5174, which would break CORS
    // and the WebSocket origin checks configured on the backend.
    strictPort: true,
    ...(LAN
      ? {
          host: true,
          proxy: {
            '/api': { target: BACKEND, changeOrigin: true },
            // `ws: true` is what upgrades the connection. Without it the three
            // sockets are proxied as plain HTTP and every one of them fails.
            '/ws': { target: BACKEND, ws: true, changeOrigin: true },
            '/health': { target: BACKEND, changeOrigin: true },
          },
        }
      : {}),
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  // The MediaPipe WASM runtime is served as a static asset from public/models.
  // Excluding it from dependency pre-bundling stops Vite trying to parse the
  // .wasm binaries as JavaScript modules.
  optimizeDeps: {
    exclude: ['@mediapipe/tasks-vision'],
  },
});
