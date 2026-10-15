import { clamp, type Params, type Pt } from './model';

/** Monotone cubic (Fritsch–Carlson) interpolation through the control points, sampled to 256 entries. */
export function curveLUT(pts: Pt[]): Float32Array {
  const p = pts.slice().sort((a, b) => a[0] - b[0]);
  const n = p.length, lut = new Float32Array(256);
  const xs = p.map((q) => q[0]), ys = p.map((q) => q[1]);
  const d: number[] = [], m: number[] = [];
  for (let i = 0; i < n - 1; i++) d[i] = (ys[i + 1] - ys[i]) / Math.max(1e-6, xs[i + 1] - xs[i]);
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  let i = 0;
  for (let k = 0; k < 256; k++) {
    const x = k / 255;
    if (x <= xs[0]) { lut[k] = ys[0]; continue; }
    if (x >= xs[n - 1]) { lut[k] = ys[n - 1]; continue; }
    while (i < n - 2 && x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
    lut[k] = clamp((2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1]);
  }
  return lut;
}

const isLinear = (p: Pt[]) => p.length === 2 && p[0][0] === 0 && p[0][1] === 0 && p[1][0] === 1 && p[1][1] === 1;

/** RGBA 256×1 table: master curve, then per-channel curve, then whites/blacks and fade. */
export function finalLUT(P: Params): Uint8Array {
  const c = P.curves, L = curveLUT(c.rgb);
  const fade = (P.fade / 100) * 0.22, bl = (P.blacks / 100) * 0.12, wh = (P.whites / 100) * 0.12;
  const out = new Uint8Array(256 * 4);
  (['r', 'g', 'b'] as const).forEach((ch, ci) => {
    const C = isLinear(c[ch]) ? null : curveLUT(c[ch]);
    for (let k = 0; k < 256; k++) {
      let v = L[k];
      if (C) v = C[Math.round(v * 255)];
      v = v * (1 + wh - bl) + bl;
      v = fade + v * (1 - fade);
      out[k * 4 + ci] = Math.round(clamp(v) * 255);
    }
  });
  for (let k = 0; k < 256; k++) out[k * 4 + 3] = 255;
  return out;
}
