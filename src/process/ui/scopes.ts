// Scopes over the Process stage — the shared Halide scopes (src/shared/scopes.ts):
// histogram, waveform, RGB parade and vectorscope of the developed picture.
import { drawScopes } from '../../shared/scopes';
import { R, draw, isPlaying, onRendered } from './stage';
import { $ } from './dom';
import { I } from './icons';

const box = $('#scopes');
const btn = $<HTMLButtonElement>('#scopesBtn');
const KEY = 'halide.process.scopes';
let last = 0;

function setOn(on: boolean) {
  box.hidden = !on;
  btn.classList.toggle('on', on);
  btn.setAttribute('aria-pressed', String(on));
  try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* private mode */ }
  if (on) draw();   // a fresh render fills them at once
}

export function initScopes() {
  btn.innerHTML = I.scopes;
  let on = false;
  try { on = localStorage.getItem(KEY) === '1'; } catch { /* private mode */ }
  setOn(on);
  btn.onclick = () => setOn(box.hidden);
  onRendered(() => {
    if (box.hidden) return;
    const now = performance.now();
    if (isPlaying() && now - last < 250) return;   // readback is the cost: lighter while a video plays
    last = now;
    try {
      drawScopes(R.canvas, { hist: $<HTMLCanvasElement>('#scopeHist'), wave: $<HTMLCanvasElement>('#scopeWave'), parade: $<HTMLCanvasElement>('#scopeParade'), vector: $<HTMLCanvasElement>('#scopeVector') });
    } catch { /* a frame without pixels yet */ }
  });
}
