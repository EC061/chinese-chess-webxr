import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const src = (pkg: string) => fileURLToPath(new URL(`../${pkg}/src/index.ts`, import.meta.url));

/**
 * The AI runs several search workers against a shared transposition table, which
 * needs `SharedArrayBuffer`, which needs the page to be cross-origin isolated.
 * Production sends these from the Node server; dev has to send them too or the
 * engine silently drops to one thread while you are working on it.
 */
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

/**
 * The XR device emulator is a development tool that drags roughly six megabytes
 * of scanned rooms into the bundle. It is switched off in production (see
 * `XRApp`), so the chunks would only ever sit in the image unread — this
 * replaces the module at build time so they are never emitted.
 *
 * The import inside @pmndrs/xr is relative (`./emulate.js`), so it has to be
 * matched by importer rather than by a path alias.
 */
const stubXrEmulator = (): Plugin => ({
  name: 'stub-xr-emulator',
  apply: 'build',
  enforce: 'pre',
  resolveId(source, importer) {
    if (source !== './emulate.js') return null;
    if (!importer || !importer.includes('@pmndrs/xr')) return null;
    return fileURLToPath(new URL('./src/xr/emulatorStub.ts', import.meta.url));
  },
});

export default defineConfig({
  plugins: [react(), stubXrEmulator()],
  resolve: {
    alias: [
      { find: '@ccx/shared', replacement: src('shared') },
      { find: '@ccx/ai', replacement: src('ai') },
    ],
  },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        // Keep three and the React runtime out of the app chunk so a code change
        // does not invalidate ~700 KB of vendor code in the headset's cache.
        manualChunks: {
          three: ['three'],
          react: ['react', 'react-dom'],
        },
      },
    },
  },
  server: {
    host: true,
    port: 5173,
    headers: isolationHeaders,
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: true },
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
  },
  preview: { headers: isolationHeaders },
});
