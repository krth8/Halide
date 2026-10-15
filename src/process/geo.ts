import type { Params } from './model';

/** Stabilisation correction for one frame: shift (fraction of width/height), rotation (radians), scale. */
export interface Corr { x: number; y: number; a: number; s: number }

type M3 = number[]; // 3×3, row-major
const mul = (A: M3, B: M3): M3 => {
  const o = new Array(9).fill(0);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) o[r * 3 + c] += A[r * 3 + k] * B[k * 3 + c];
  return o;
};
const T = (x: number, y: number): M3 => [1, 0, x, 0, 1, y, 0, 0, 1];
const Sc = (x: number, y: number): M3 => [x, 0, 0, 0, y, 0, 0, 0, 1];
const Ro = (t: number): M3 => [Math.cos(t), -Math.sin(t), 0, Math.sin(t), Math.cos(t), 0, 0, 0, 1];

export interface Geometry {
  /** Output size in source pixels (only the aspect ratio matters to callers). */
  w: number; h: number;
  /** Maps output uv (0..1, y down) to source uv, column-major for a GLSL mat3. */
  m: Float32Array;
  /** Same mapping as a function, for picking colours from the source. */
  map: (u: number, v: number) => [number, number];
  /** Framing offset after clamping (fractions of the oriented image), and the oriented image size. */
  fx: number; fy: number; Wr: number; Hr: number;
}

/**
 * Crop, straighten, quarter-turn rotation, flip and stabilisation as one affine map from the output frame
 * to the source image. The crop is the largest rectangle of the chosen aspect that fits inside the
 * straightened image (so no empty corners), shrunk by the framing zoom and moved by the framing offset.
 */
export function geometry(W0: number, H0: number, P: Pick<Params, 'aspect' | 'frame' | 'angle' | 'rot' | 'flip'>, corr?: Corr | null): Geometry {
  const rot = ((Math.round(P.rot) % 4) + 4) % 4;
  const Wr = rot % 2 ? H0 : W0, Hr = rot % 2 ? W0 : H0;
  const A = P.aspect > 0 ? P.aspect : Wr / Hr;
  const th = (P.angle * Math.PI) / 180, c = Math.abs(Math.cos(th)), s = Math.abs(Math.sin(th));
  const w1 = Math.min(Wr / (c + s / A), Hr / (s + c / A));
  const z = Math.max(1, P.frame?.zoom ?? 1);
  const w = w1 / z, h = w1 / A / z;

  // Keep the framing offset inside the image: test the crop's corners, back off along the offset if needed.
  const inside = (ox: number, oy: number) => {
    for (const [dx, dy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const px = (dx * w) / 2 + ox, py = (dy * h) / 2 + oy;
      const qx = Math.cos(th) * px - Math.sin(th) * py, qy = Math.sin(th) * px + Math.cos(th) * py;
      if (Math.abs(qx) > Wr / 2 + 1e-6 || Math.abs(qy) > Hr / 2 + 1e-6) return false;
    }
    return true;
  };
  let ox = (P.frame?.x ?? 0) * Wr, oy = (P.frame?.y ?? 0) * Hr;
  if (!inside(ox, oy)) {
    let lo = 0, hi = 1;
    for (let i = 0; i < 20; i++) { const m = (lo + hi) / 2; if (inside(ox * m, oy * m)) lo = m; else hi = m; }
    ox *= lo; oy *= lo;
  }

  // output uv → crop px → straightened → oriented uv
  let M = mul(Sc(w, h), [1, 0, 0, 0, 1, 0, 0, 0, 1]);
  M = mul(T(-w / 2 + ox, -h / 2 + oy), M);
  M = mul(Ro(th), M);
  M = mul(T(Wr / 2, Hr / 2), M);
  M = mul(Sc(1 / Wr, 1 / Hr), M);
  // flip, then undo the quarter turns: oriented uv → source uv
  if (P.flip) M = mul([-1, 0, 1, 0, 1, 0, 0, 0, 1], M);
  const ROT: M3[] = [[1, 0, 0, 0, 1, 0, 0, 0, 1], [0, 1, 0, -1, 0, 1, 0, 0, 1], [-1, 0, 1, 0, -1, 1, 0, 0, 1], [0, -1, 1, 1, 0, 0, 0, 0, 1]];
  M = mul(ROT[rot], M);
  // stabilisation: the displayed frame is the source moved by the correction, so sample at its inverse
  if (corr) {
    let S = T(-0.5, -0.5);
    S = mul(Sc(W0, H0), S);
    S = mul(T(-corr.x * W0, -corr.y * H0), S);
    S = mul(Ro(-corr.a), S);
    S = mul(Sc(1 / corr.s, 1 / corr.s), S);
    S = mul(Sc(1 / W0, 1 / H0), S);
    S = mul(T(0.5, 0.5), S);
    M = mul(S, M);
  }
  const m = new Float32Array([M[0], M[3], M[6], M[1], M[4], M[7], M[2], M[5], M[8]]);
  return { w, h, m, map: (u, v) => [M[0] * u + M[1] * v + M[2], M[3] * u + M[4] * v + M[5]], fx: ox / Wr, fy: oy / Hr, Wr, Hr };
}
