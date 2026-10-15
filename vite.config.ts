import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const root = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Cross-origin isolation (SharedArrayBuffer for the multi-thread ffmpeg core).
// The dev/preview servers send the headers; on GitHub Pages public/sw.js adds
// them, since Pages can't set response headers.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  // Pages serves the repo under /Halide/ — CI passes HALIDE_BASE; local is '/'.
  base: process.env.HALIDE_BASE || '/',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
    // one page per workspace: the launcher, Process and Edit never load each
    // other's code — shared modules split into common chunks
    rollupOptions: {
      input: {
        launcher: root('./index.html'),
        process: root('./process/index.html'),
        edit: root('./edit/index.html'),
      },
    },
  },
  server: { headers: isolation },
  preview: { headers: isolation },
});
