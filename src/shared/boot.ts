// Shared page boot: registers the one Halide service worker (offline cache +
// cross-origin isolation on GitHub Pages, which can't send COOP/COEP itself).
// `isolate` pages (Edit: SharedArrayBuffer for the multi-thread ffmpeg core)
// reload once on a first visit, when the worker only takes control after load.
import { BASE } from './paths';

export function boot({ isolate = false } = {}): void {
  if (!('serviceWorker' in navigator) || !import.meta.env.PROD) return;
  const sw = navigator.serviceWorker;
  const uncontrolled = !sw.controller;
  sw.register(BASE + 'sw.js', { scope: BASE }).catch(() => {});
  if (isolate && uncontrolled && !self.crossOriginIsolated) {
    sw.addEventListener('controllerchange', () => {
      try {
        if (sessionStorage.getItem('halide.coiReload')) return;   // never loop
        sessionStorage.setItem('halide.coiReload', '1');
      } catch { /* storage blocked: reload once anyway */ }
      location.reload();
    }, { once: true });
  }
}
