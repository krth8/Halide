import type { Corr } from './geo';
import type { Item, Motion } from './model';

/*
 * Video stabilisation.
 *
 * Analysis: frames are decoded small (about 320 px wide) and converted to grey. In each frame ~100 textured
 * points spread over a grid are tracked into the next frame with two-level block matching. RANSAC then
 * finds the similarity transform (shift, rotation, scale) that the largest group of points agrees on, so
 * the dominant, coherent motion (usually the background, i.e. the camera) wins and people or objects
 * moving through the shot are treated as outliers. The per-frame motions are summed into a camera path.
 *
 * Correction: the path is smoothed with a gaussian whose width follows the strength slider; each frame is
 * moved by (smoothed - actual) and zoomed just enough to hide the moving borders.
 */

const AW = 320;          // analysis width
const GRID_X = 12, GRID_Y = 9;
const SEARCH1 = 8;       // half-res search radius (≈ ±16 px at analysis width)

type Gray = { d: Float32Array; w: number; h: number };

/** Small grey image straight from a decoded frame. YUV formats give luma directly (first plane); RGB formats
 *  are converted. Reading the decoder's own buffer avoids a slow GPU readback per frame. */
function lumaOf(buf: Uint8Array, layout: PlaneLayout[], format: string, cw: number, ch: number, w: number, h: number): Gray {
  const d = new Float32Array(w * h);
  const sx = cw / w, sy = ch / h, step = Math.max(1, Math.floor(Math.min(sx, sy) / 2));
  const rgb = /^(RGB|BGR)/.test(format), bgr = format.startsWith('BGR');
  const hi = /P1[02]$/.test(format) ? (format.endsWith('P10') ? 4 : 16) : 0; // 10/12-bit little-endian
  const { offset, stride } = layout[0];
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy);
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx);
      let s = 0, n = 0;
      for (let yy = y0; yy < Math.min(ch, y0 + Math.ceil(sy)); yy += step) for (let xx = x0; xx < Math.min(cw, x0 + Math.ceil(sx)); xx += step) {
        if (rgb) {
          const i = offset + yy * stride + xx * 4;
          const r = buf[bgr ? i + 2 : i], g = buf[i + 1], b = buf[bgr ? i : i + 2];
          s += 0.299 * r + 0.587 * g + 0.114 * b;
        } else if (hi) {
          const i = offset + yy * stride + xx * 2;
          s += (buf[i] | (buf[i + 1] << 8)) / hi;
        } else s += buf[offset + yy * stride + xx];
        n++;
      }
      d[y * w + x] = s / Math.max(1, n);
    }
  }
  return { d, w, h };
}
function half(g: Gray): Gray {
  const w = g.w >> 1, h = g.h >> 1, d = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = 2 * y * g.w + 2 * x;
    d[y * w + x] = (g.d[i] + g.d[i + 1] + g.d[i + g.w] + g.d[i + g.w + 1]) / 4;
  }
  return { d, w, h };
}
function sad(A: Gray, B: Gray, ax: number, ay: number, bx: number, by: number, r: number): number {
  let s = 0;
  for (let dy = -r; dy <= r; dy++) {
    const ia = (ay + dy) * A.w + ax, ib = (by + dy) * B.w + bx;
    for (let dx = -r; dx <= r; dx++) s += Math.abs(A.d[ia + dx] - B.d[ib + dx]);
  }
  return s;
}

/** Strongest corner-like point in each grid cell (by gradient energy in both directions). */
function features(g: Gray): [number, number][] {
  const out: [number, number][] = [];
  const m = SEARCH1 * 2 + 8;
  const cw = (g.w - 2 * m) / GRID_X, ch = (g.h - 2 * m) / GRID_Y;
  for (let cy = 0; cy < GRID_Y; cy++) for (let cx = 0; cx < GRID_X; cx++) {
    let best = 0, bx = 0, by = 0;
    for (let y = Math.floor(m + cy * ch); y < m + (cy + 1) * ch; y += 2) for (let x = Math.floor(m + cx * cw); x < m + (cx + 1) * cw; x += 2) {
      let gx2 = 0, gy2 = 0, gxy = 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const i = (y + dy) * g.w + x + dx;
        const ix = g.d[i + 1] - g.d[i - 1], iy = g.d[i + g.w] - g.d[i - g.w];
        gx2 += ix * ix; gy2 += iy * iy; gxy += ix * iy;
      }
      // smaller eigenvalue of the structure tensor (Shi–Tomasi): high only at corners, not along edges
      const tr = gx2 + gy2, det = gx2 * gy2 - gxy * gxy, e = tr / 2 - Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
      if (e > best) { best = e; bx = x; by = y; }
    }
    if (best > 400) out.push([bx, by]);
  }
  return out;
}

/** Track a point from A to B: coarse search at half resolution, refine at full, sub-pixel by parabola fit. */
function track(A: Gray, B: Gray, A2: Gray, B2: Gray, x: number, y: number): [number, number] | null {
  const hx = x >> 1, hy = y >> 1;
  let best = Infinity, second = Infinity, ux = 0, uy = 0;
  for (let dy = -SEARCH1; dy <= SEARCH1; dy++) for (let dx = -SEARCH1; dx <= SEARCH1; dx++) {
    const s = sad(A2, B2, hx, hy, hx + dx, hy + dy, 3);
    if (s < best) { second = best; best = s; ux = dx; uy = dy; } else if (s < second) second = s;
  }
  if (best > 0.92 * second && best > 50) return null; // ambiguous (flat area or repeating pattern)
  let fx = 2 * ux, fy = 2 * uy, b0 = Infinity;
  const sc = new Map<string, number>();
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const tx = x + 2 * ux + dx, ty = y + 2 * uy + dy;
    if (tx < 6 || ty < 6 || tx >= B.w - 6 || ty >= B.h - 6) continue;
    const s = sad(A, B, x, y, tx, ty, 4);
    sc.set(dx + ',' + dy, s);
    if (s < b0) { b0 = s; fx = 2 * ux + dx; fy = 2 * uy + dy; }
  }
  if (!isFinite(b0) || b0 / 81 > 18) return null; // poor match (occlusion, motion blur)
  const sub = (l?: number, c?: number, r?: number) => (l === undefined || r === undefined || c === undefined ? 0 : (l - r) / (2 * Math.max(1e-6, l - 2 * c + r)));
  const ox = fx - 2 * ux, oy = fy - 2 * uy;
  fx += clampSub(sub(sc.get(ox - 1 + ',' + oy), b0, sc.get(ox + 1 + ',' + oy)));
  fy += clampSub(sub(sc.get(ox + ',' + (oy - 1)), b0, sc.get(ox + ',' + (oy + 1))));
  return [fx, fy];
}
const clampSub = (v: number) => (v > 0.5 ? 0.5 : v < -0.5 ? -0.5 : v);

/** Similarity x' = a·x − b·y + tx, y' = b·x + a·y + ty fitted to point pairs (least squares). */
function fitSimilarity(P: number[][], Q: number[][]): [number, number, number, number] | null {
  const n = P.length;
  if (n < 2) return null;
  let mx = 0, my = 0, nx = 0, ny = 0;
  for (let i = 0; i < n; i++) { mx += P[i][0]; my += P[i][1]; nx += Q[i][0]; ny += Q[i][1]; }
  mx /= n; my /= n; nx /= n; ny /= n;
  let sxx = 0, sab = 0, sba = 0;
  for (let i = 0; i < n; i++) {
    const px = P[i][0] - mx, py = P[i][1] - my, qx = Q[i][0] - nx, qy = Q[i][1] - ny;
    sxx += px * px + py * py; sab += px * qx + py * qy; sba += px * qy - py * qx;
  }
  if (sxx < 1e-9) return null;
  const a = sab / sxx, b = sba / sxx;
  return [a, b, nx - (a * mx - b * my), ny - (b * mx + a * my)];
}

let seed = 1;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

/** RANSAC: the transform most points agree on. Returns null when there is no clear majority. */
function dominantMotion(P: number[][], Q: number[][]): [number, number, number, number] | null {
  const n = P.length;
  if (n < 6) return null;
  let bestIn: number[] = [];
  for (let it = 0; it < 150; it++) {
    const i = Math.floor(rnd() * n), j = Math.floor(rnd() * n);
    if (i === j) continue;
    const m = fitSimilarity([P[i], P[j]], [Q[i], Q[j]]);
    if (!m) continue;
    const [a, b, tx, ty] = m;
    if (Math.abs(Math.hypot(a, b) - 1) > 0.1) continue; // implausible zoom between neighbouring frames
    const inl: number[] = [];
    for (let k = 0; k < n; k++) {
      const ex = a * P[k][0] - b * P[k][1] + tx - Q[k][0], ey = b * P[k][0] + a * P[k][1] + ty - Q[k][1];
      if (ex * ex + ey * ey < 1.2 * 1.2) inl.push(k);
    }
    if (inl.length > bestIn.length) bestIn = inl;
  }
  if (bestIn.length < Math.max(6, n * 0.2)) return null;
  return fitSimilarity(bestIn.map((k) => P[k]), bestIn.map((k) => Q[k]));
}

/** Analyses the whole clip. `onProgress` gets 0..1. */
export async function analyze(it: Item, onProgress: (f: number) => void, signal?: AbortSignal): Promise<Motion> {
  const { ALL_FORMATS, BlobSource, VideoSampleSink, Input } = await import('mediabunny');
  const input = new Input({ source: new BlobSource(it.file), formats: ALL_FORMATS });
  try {
    const trackV = (await input.getPrimaryVideoTrack())!;
    const sink = new VideoSampleSink(trackV);
    const t0 = await trackV.getFirstTimestamp();
    const dur = Math.max(0.001, it.duration);
    let out: Motion | null = null;
    let prev: Gray | null = null, prev2: Gray | null = null, buf: Uint8Array | null = null;
    let X = 0, Y = 0, A = 0, Sc = 0, lastM: [number, number, number, number] = [1, 0, 0, 0];
    let rot = 0, w = AW, h = AW;
    seed = 1;
    let n = 0;
    for await (const sample of sink.samples()) {
      try {
        if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
        const cw = sample.codedWidth, ch = sample.codedHeight;
        if (!out) {
          rot = ((sample.rotation % 360) + 360) % 360;
          w = AW; h = Math.max(16, Math.round((AW * ch) / cw / 2) * 2);
          // motion is stored in display orientation (rotated frames swap width and height)
          out = { t: [], x: [], y: [], a: [], s: [], w: rot % 180 ? h : w, h: rot % 180 ? w : h };
        }
        const size = sample.allocationSize();
        if (!buf || buf.byteLength < size) buf = new Uint8Array(size);
        const layout = await sample.copyTo(buf);
        const g = lumaOf(buf, layout, String(sample.format ?? 'I420'), cw, ch, w, h);
        const g2 = half(g);
        if (prev && prev2) {
          const cx = w / 2, cy = h / 2;
          const P: number[][] = [], Q: number[][] = [];
          for (const [x, y] of features(prev)) {
            const m = track(prev, g, prev2, g2, x, y);
            if (m) { P.push([x - cx, y - cy]); Q.push([x + m[0] - cx, y + m[1] - cy]); }
          }
          // Without a clear majority (e.g. a cut or heavy blur), assume the camera kept its last motion, damped.
          const m = dominantMotion(P, Q) ?? ([1 + (lastM[0] - 1) * 0.5, lastM[1] * 0.5, lastM[2] * 0.5, lastM[3] * 0.5] as [number, number, number, number]);
          lastM = m;
          // to display orientation, as fractions of the display frame
          const fx = m[2] / w, fy = m[3] / h;
          const [dx, dy] = rot === 90 ? [-fy, fx] : rot === 180 ? [-fx, -fy] : rot === 270 ? [fy, -fx] : [fx, fy];
          X += dx; Y += dy; A += Math.atan2(m[1], m[0]); Sc += Math.log(Math.hypot(m[0], m[1]));
        }
        out.t.push(sample.timestamp); out.x.push(X); out.y.push(Y); out.a.push(A); out.s.push(Sc);
        prev = g; prev2 = g2;
        if (++n % 8 === 0) { onProgress(Math.min(1, (sample.timestamp - t0) / dur)); await new Promise((r) => setTimeout(r, 0)); }
      } finally {
        sample.close();
      }
    }
    onProgress(1);
    if (!out) throw new Error('No frames found in the video');
    return out;
  } finally {
    input.dispose();
  }
}

/* ---------- correction ---------- */

interface Smoothed { cx: Float32Array; cy: Float32Array; ca: Float32Array; cs: Float32Array; zoom: number }
const cache = new WeakMap<Motion, Map<number, Smoothed>>();

function smooth(mo: Motion, strength: number): Smoothed {
  let per = cache.get(mo);
  if (!per) cache.set(mo, (per = new Map()));
  const key = Math.round(strength);
  const hit = per.get(key);
  if (hit) return hit;
  const n = mo.t.length;
  const fps = n > 1 ? (n - 1) / Math.max(1e-3, mo.t[n - 1] - mo.t[0]) : 30;
  const sigma = Math.max(1, (0.15 + (strength / 100) * 1.6) * fps);   // seconds of smoothing → frames
  const rad = Math.ceil(sigma * 3);
  const k = Array.from({ length: 2 * rad + 1 }, (_, i) => Math.exp(-((i - rad) ** 2) / (2 * sigma * sigma)));
  const g = (v: number[]) => {
    const o = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0, ws = 0;
      for (let j = -rad; j <= rad; j++) { const idx = Math.min(n - 1, Math.max(0, i + j)); s += v[idx] * k[j + rad]; ws += k[j + rad]; }
      o[i] = s / ws;
    }
    return o;
  };
  const sx = g(mo.x), sy = g(mo.y), sa = g(mo.a), ss = g(mo.s);
  const r: Smoothed = { cx: new Float32Array(n), cy: new Float32Array(n), ca: new Float32Array(n), cs: new Float32Array(n), zoom: 1 };
  let mx = 0, my = 0, ma = 0;
  for (let i = 0; i < n; i++) {
    r.cx[i] = sx[i] - mo.x[i]; r.cy[i] = sy[i] - mo.y[i]; r.ca[i] = sa[i] - mo.a[i]; r.cs[i] = ss[i] - mo.s[i];
    mx = Math.max(mx, Math.abs(r.cx[i])); my = Math.max(my, Math.abs(r.cy[i])); ma = Math.max(ma, Math.abs(r.ca[i]));
  }
  // Zoom just enough that the shifted, rotated frame still covers the output.
  const asp = Math.max(mo.w / mo.h, mo.h / mo.w);
  r.zoom = Math.min(1.35, (1 / Math.max(0.3, 1 - 2 * Math.max(mx, my))) * (Math.cos(ma) + Math.sin(ma) * asp));
  per.set(key, r);
  return r;
}

/** Stabilisation correction for item `it` at time `t` (seconds). */
export function corrAt(it: Item, t: number, strength: number): Corr | null {
  const mo = it.motion;
  if (!mo || mo.t.length < 2 || strength <= 0) return null;
  const sm = smooth(mo, strength);
  // binary search for the frame at or before t, then interpolate
  let lo = 0, hi = mo.t.length - 1;
  if (t <= mo.t[0]) hi = 0; else if (t >= mo.t[hi]) lo = hi;
  else while (hi - lo > 1) { const m = (lo + hi) >> 1; if (mo.t[m] <= t) lo = m; else hi = m; }
  const f = hi === lo ? 0 : (t - mo.t[lo]) / (mo.t[hi] - mo.t[lo]);
  const L = (a: Float32Array) => a[lo] + (a[hi] - a[lo]) * f;
  return { x: L(sm.cx), y: L(sm.cy), a: L(sm.ca), s: Math.exp(L(sm.cs)) * sm.zoom };
}
