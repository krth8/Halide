// The develop pipeline on WebGPU, shared by Process (whole look) and Edit (its
// image effects): colour grade → presence (dehaze / clarity / texture) →
// local masks → blur → bloom / halation → vignette and grain.
//
// It takes plain numbers (gains, slopes, amounts, a curve table), not a
// workspace's slider model — each workspace maps its own controls onto a
// DevelopSpec, so the maths lives here once.
import { Arena, draw, toHalf, type Kit, type Target } from './kit';
import { COLOR, CURVE, GRAIN, LUT3D, VIGNETTE } from './wgsl';

/* ---------- spec ---------- */

export interface Look { mono: boolean; k: number; warm: number; con: number; sat: number; split: number; fade: number; sh: [number, number, number]; hh: [number, number, number] }

/** One colour grade (the base, or a local mask's). */
export interface GradeSpec {
  /** output uv → source uv, column-major 3×3 (crop, straighten, rotate, flip, stabilise) */
  geo: Float32Array;
  /** exposure × white balance, linear gains */
  wb: [number, number, number];
  contrast: number;          // midtone slope, 1 = unchanged
  highlights: number;        // -1…1
  shadows: number;           // -1…1
  saturation: number;        // multiplier, 1 = unchanged
  vibrance: number;          // -1…1
  look: Look | null;
  lutK: number;              // 0…1, applies when a LUT is set
  hsl: Float32Array | null;  // 8 bands × (hue°, sat %, lum %)
  /** 256 × rgba8 per-channel curve table, and a key identifying it */
  curve: { key: string; table: Uint8Array<ArrayBuffer> };
  dehaze: number; clarity: number; texture: number;   // -1…1
}

export interface MaskSpec { grade: GradeSpec; linear: boolean; invert: boolean; a: [number, number]; b: [number, number]; feather: number; amount: number }

export interface DevelopSpec {
  base: GradeSpec;
  masks: MaskSpec[];
  lut: { id: string; size: number; data: Float32Array } | null;
  /** blur radius as a fraction of the width (0 = off) and its shape */
  blur: number; blurMode: 0 | 1 | 2;   // tilt, radial, full
  bloom: number;                       // 0…1
  bloomThreshold: number;              // 0…1
  bloomRadius: number;                 // 0…1
  halation: number;                    // 0…1
  vignette: number; vignetteInner: number; vignetteWidth: number;
  grain: number;                       // amplitude
  grainSize: number;                   // cell size in output px
  seed: number;
  /** show the source through the geometry only (before/after) */
  bypass?: boolean;
}

/* ---------- shaders ---------- */

const BAND_H = '0.0, 30.0, 58.0, 115.0, 180.0, 222.0, 270.0, 318.0';

const GRADE = COLOR + CURVE + LUT3D + /* wgsl */`
struct Grade {
  g0: vec4f, g1: vec4f, g2: vec4f,   // geometry columns
  wb: vec4f,
  t0: vec4f,   // contrast, highlights, shadows, saturation
  t1: vec4f,   // vibrance, lookOn, mono, lookK
  f0: vec4f,   // look warm, contrast, saturation, split
  f1: vec4f,   // look fade, lutOn, lutK, lutSize
  fS: vec4f, fH: vec4f,
  h0: vec4f,   // hslOn
  hsl: array<vec4f, 8>,
};
@group(0) @binding(0) var<uniform> u: Grade;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var srcS: sampler;
@group(0) @binding(3) var curveT: texture_2d<f32>;
@group(0) @binding(4) var linS: sampler;
@group(0) @binding(5) var lutT: texture_3d<f32>;
const BAND_H = array<f32, 8>(${BAND_H});

@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  let M = mat3x3f(u.g0.xyz, u.g1.xyz, u.g2.xyz);
  let suv = (M * vec3f(in.uv, 1.0)).xy;
  var c = textureSample(src, srcS, suv).rgb;
  if (any(suv < vec2f(-0.002)) || any(suv > vec2f(1.002))) { c = vec3f(0.0); }
  c = toGam(toLin(c) * u.wb.xyz);
  var l = luma(c);

  if (u.t1.y > 0.5) {
    let c0 = c;
    c.r = c.r * (1.0 + u.f0.x * 0.16); c.b = c.b * (1.0 - u.f0.x * 0.16);
    c = sCurve(c, max(0.15, 1.0 + u.f0.y * 0.7));
    l = luma(c);
    if (u.t1.z > 0.5) { l = dot(c, vec3f(0.3, 0.59, 0.11)); c = vec3f(l); }
    else { c = l + (c - l) * (1.0 + u.f0.z); }
    if (u.f0.w > 0.0) {
      let lc = clamp(l, 0.0, 1.0);
      let ws = (1.0 - lc) * (1.0 - lc);
      let wh = lc * lc;
      c = c + u.f0.w * 0.32 * (ws * (u.fS.xyz - 0.5) + wh * (u.fH.xyz - 0.5));
    }
    let fa = u.f1.x * 0.25;
    c = fa + c * (1.0 - fa);
    c = mix(c0, c, u.t1.w);
  }
  c = clamp(c, vec3f(0.0), vec3f(1.0));

  if (u.f1.y > 0.5) { c = mix(c, lutLookup(lutT, linS, c, u.f1.w), u.f1.z); }

  // tone and saturation sit on top of the look, so saturation -100 always gives black and white
  l = luma(c);
  let sh = u.t0.z;
  if (sh != 0.0) { let q = 1.0 - min(1.0, l); c = c * (1.0 + sh * 1.3 * q * q * q); }
  let hi = u.t0.y;
  if (hi != 0.0) {
    let lc = min(1.0, l);
    let k = lc * lc;
    if (hi < 0.0) { c = c * (1.0 + hi * 0.55 * k); } else { c = c + hi * 0.45 * k * (1.0 - c); }
  }
  if (u.t0.x != 1.0) { c = sCurve(c, u.t0.x); }
  l = luma(c);
  let mx = max(c.r, max(c.g, c.b));
  let mn = min(c.r, min(c.g, c.b));
  c = l + (c - l) * (u.t0.w * (1.0 + u.t1.x * (1.0 - clamp(mx - mn, 0.0, 1.0)) * 1.2));
  c = clamp(c, vec3f(0.0), vec3f(1.0));

  if (u.h0.x > 0.5) {
    let M2 = max(c.r, max(c.g, c.b));
    let m2 = min(c.r, min(c.g, c.b));
    let d = M2 - m2;
    if (d > 0.01) {
      let L = (M2 + m2) * 0.5;
      let S = select(d / (M2 + m2), d / (2.0 - M2 - m2), L > 0.5);
      var H: f32;
      if (M2 == c.r) { H = (c.g - c.b) / d + select(0.0, 6.0, c.g < c.b); }
      else if (M2 == c.g) { H = (c.b - c.r) / d + 2.0; }
      else { H = (c.r - c.g) / d + 4.0; }
      H = H * 60.0;
      var acc = vec3f(0.0);
      for (var k = 0; k < 8; k++) {
        var df = abs(H - BAND_H[k]);
        if (df > 180.0) { df = 360.0 - df; }
        acc = acc + u.hsl[k].xyz * max(0.0, 1.0 - df / 42.0);
      }
      if (any(acc != vec3f(0.0))) {
        let nS = clamp(S * (1.0 + acc.y / 100.0), 0.0, 1.0);
        let nL = clamp(L + acc.z / 100.0 * 0.3 * S, 0.0, 1.0);
        c = hsl2rgb(vec3f(modf1(H + acc.x, 360.0) / 360.0, nS, nL));
      }
    }
  }

  return vec4f(curveLookup(curveT, linS, c), 1.0);
}`;

const COPY = /* wgsl */`
struct Geo { g0: vec4f, g1: vec4f, g2: vec4f };
@group(0) @binding(0) var<uniform> u: Geo;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var srcS: sampler;
@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  let M = mat3x3f(u.g0.xyz, u.g1.xyz, u.g2.xyz);
  return vec4f(textureSample(src, srcS, (M * vec3f(in.uv, 1.0)).xy).rgb, 1.0);
}`;

/** Darkest channel: the dehaze haze estimate ("dark channel"). */
const MINCH = /* wgsl */`
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var s: sampler;
@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  let c = textureSample(src, s, in.uv).rgb;
  return vec4f(vec3f(min(c.r, min(c.g, c.b))), 1.0);
}`;

/** Presence: dehaze, clarity (large-radius midtone contrast), texture (fine detail). */
const LOCAL = COLOR + /* wgsl */`
struct P { k: vec4f };   // dehaze, clarity, texture
@group(0) @binding(0) var<uniform> u: P;
@group(0) @binding(1) var a: texture_2d<f32>;
@group(0) @binding(2) var dark: texture_2d<f32>;
@group(0) @binding(3) var cla: texture_2d<f32>;
@group(0) @binding(4) var tex: texture_2d<f32>;
@group(0) @binding(5) var s: sampler;
@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  var c = textureSample(a, s, in.uv).rgb;
  let dk = textureSample(dark, s, in.uv).r;
  let lb = luma(textureSample(cla, s, in.uv).rgb);
  let tb = textureSample(tex, s, in.uv).rgb;
  let dehaze = u.k.x; let clarity = u.k.y; let texture = u.k.z;
  if (dehaze != 0.0) {
    let A = 0.94;
    let d = mix(dk, min(c.r, min(c.g, c.b)), 0.5);   // follow edges: fewer halos
    if (dehaze > 0.0) {
      let t = max(1.0 - 0.6 * dehaze * d / A, 0.3);
      let j = (c - A) / t + A;
      c = j + (luma(c) - luma(j)) * 0.35 * dehaze;
    } else {
      c = mix(c, vec3f(A * 0.92), -dehaze * 0.55 * (0.35 + 0.65 * (1.0 - d)));
    }
    c = clamp(c, vec3f(0.0), vec3f(1.0));
  }
  if (clarity != 0.0) {
    let L = luma(c);
    if (clarity > 0.0) {
      let m = clamp(1.0 - pow(2.0 * L - 1.0, 2.0), 0.0, 1.0);
      let dd = clamp(L - lb, -0.12, 0.12);
      c = c + clarity * 1.4 * dd * (0.25 + 0.75 * m);
    } else {
      c = mix(c, c + (lb - L), -clarity * 0.6);
    }
  }
  if (texture != 0.0) {
    if (texture > 0.0) { c = c + texture * 1.6 * clamp(luma(c) - luma(tb), -0.12, 0.12); }
    else { c = mix(c, tb, -texture * 0.75); }
  }
  return vec4f(clamp(c, vec3f(0.0), vec3f(1.0)), 1.0);
}`;

/** A mask's graded image over the base: linear (full at a → none at b) or radial (ellipse at a, radii b). */
const MASK = /* wgsl */`
struct M { t: vec4f, p: vec4f };   // linear, invert, feather, amount | a.xy, b.xy
struct A { aspect: vec4f };
@group(0) @binding(0) var<uniform> u: M;
@group(0) @binding(1) var a: texture_2d<f32>;
@group(0) @binding(2) var b: texture_2d<f32>;
@group(0) @binding(3) var s: sampler;
@group(0) @binding(4) var<uniform> asp: A;
@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  let ca = textureSample(a, s, in.uv).rgb;
  let cb = textureSample(b, s, in.uv).rgb;
  let p0 = u.p.xy; let p1 = u.p.zw; let ar = asp.aspect.x;
  var m: f32;
  if (u.t.x > 0.5) {
    let d = (p1 - p0) * vec2f(ar, 1.0);
    let q = (in.uv - p0) * vec2f(ar, 1.0);
    m = 1.0 - smoothstep(0.0, 1.0, dot(q, d) / max(dot(d, d), 1e-6));
  } else {
    let r = length((in.uv - p0) / max(p1, vec2f(1e-4)));
    let f = clamp(u.t.z, 0.01, 1.0);
    m = 1.0 - smoothstep(1.0 - f, 1.0, r);
  }
  if (u.t.y > 0.5) { m = 1.0 - m; }
  return vec4f(mix(ca, cb, m * u.t.w), 1.0);
}`;

/** Separable 13-tap gaussian reading the source at a mip level, so large radii stay cheap. */
const GAUSS = /* wgsl */`
struct G { d: vec4f };   // dir.xy, lod
@group(0) @binding(0) var<uniform> u: G;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var s: sampler;
@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  let w = array<f32, 4>(0.1964825501511404, 0.2969069646728344, 0.09447039785044732, 0.010381362401148057);
  let o = array<f32, 4>(0.0, 1.411764705882353, 3.2941176470588234, 5.176470588235294);
  let dir = u.d.xy; let lod = u.d.z;
  var c = textureSampleLevel(src, s, in.uv, lod).rgb * w[0];
  for (var i = 1; i < 4; i++) {
    c = c + textureSampleLevel(src, s, in.uv + dir * o[i], lod).rgb * w[i];
    c = c + textureSampleLevel(src, s, in.uv - dir * o[i], lod).rgb * w[i];
  }
  return vec4f(c, 1.0);
}`;

/** Soft-knee bright pass for bloom / halation (half resolution). */
const BRIGHT = COLOR + /* wgsl */`
struct B { t: vec4f };
@group(0) @binding(0) var<uniform> u: B;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var s: sampler;
@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  let c = textureSample(src, s, in.uv).rgb;
  let k = max(0.0, (luma(c) - u.t.x) / (1.0 - u.t.x));
  return vec4f(c * k * k, 1.0);
}`;

/** Dual-filter (Kawase) downsample. */
const DOWN = /* wgsl */`
struct D { t: vec4f };   // texel.xy
@group(0) @binding(0) var<uniform> u: D;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var s: sampler;
@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  let h = u.t.xy * 0.5;
  var c = textureSample(src, s, in.uv).rgb * 4.0;
  c = c + textureSample(src, s, in.uv - h).rgb + textureSample(src, s, in.uv + h).rgb;
  c = c + textureSample(src, s, in.uv + vec2f(h.x, -h.y)).rgb + textureSample(src, s, in.uv - vec2f(h.x, -h.y)).rgb;
  return vec4f(c / 8.0, 1.0);
}`;

/** Dual-filter upsample of the coarser level, added onto this level's downsample. */
const UP = /* wgsl */`
struct Up { t: vec4f };   // texel of the coarse level .xy, weight
@group(0) @binding(0) var<uniform> u: Up;
@group(0) @binding(1) var coarse: texture_2d<f32>;
@group(0) @binding(2) var cur: texture_2d<f32>;
@group(0) @binding(3) var s: sampler;
@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  let h = u.t.xy * 0.5;
  var c = textureSample(coarse, s, in.uv + vec2f(-h.x * 2.0, 0.0)).rgb;
  c = c + textureSample(coarse, s, in.uv + vec2f(-h.x, h.y)).rgb * 2.0;
  c = c + textureSample(coarse, s, in.uv + vec2f(0.0, h.y * 2.0)).rgb;
  c = c + textureSample(coarse, s, in.uv + vec2f(h.x, h.y)).rgb * 2.0;
  c = c + textureSample(coarse, s, in.uv + vec2f(h.x * 2.0, 0.0)).rgb;
  c = c + textureSample(coarse, s, in.uv + vec2f(h.x, -h.y)).rgb * 2.0;
  c = c + textureSample(coarse, s, in.uv + vec2f(0.0, -h.y * 2.0)).rgb;
  c = c + textureSample(coarse, s, in.uv + vec2f(-h.x, -h.y)).rgb * 2.0;
  return vec4f(textureSample(cur, s, in.uv).rgb + c / 12.0 * u.t.z, 1.0);
}`;

/** Finish: blur mask, bloom (screen), halation, vignette, grain. */
const FINISH = COLOR + VIGNETTE + GRAIN + /* wgsl */`
struct F {
  a: vec4f,   // blurOn, blurMode, bloomK, halK
  v: vec4f,   // vignette amount, inner, width, aspect
  g: vec4f,   // grain amount, size, seed
};
@group(0) @binding(0) var<uniform> u: F;
@group(0) @binding(1) var a: texture_2d<f32>;
@group(0) @binding(2) var blurT: texture_2d<f32>;
@group(0) @binding(3) var bloomT: texture_2d<f32>;
@group(0) @binding(4) var halT: texture_2d<f32>;
@group(0) @binding(5) var s: sampler;
@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  var c = textureSample(a, s, in.uv).rgb;
  let bl = textureSample(blurT, s, in.uv).rgb;
  let bm = textureSample(bloomT, s, in.uv).rgb;
  let hl = textureSample(halT, s, in.uv).rgb;
  if (u.a.x > 0.5) {
    var m = 1.0;
    if (u.a.y < 0.5) { m = smoothstep(0.12, 0.42, abs(in.uv.y - 0.47)); }
    else if (u.a.y < 1.5) {
      let p = (in.uv - 0.5) * vec2f(u.v.w, 1.0);
      m = smoothstep(0.18, 0.62, length(p) / max(u.v.w, 1.0) * 1.3);
    }
    c = mix(c, bl, m);
  }
  if (u.a.z > 0.0) { let b = clamp(bm * u.a.z, vec3f(0.0), vec3f(1.0)); c = 1.0 - (1.0 - c) * (1.0 - b); }
  if (u.a.w > 0.0) { c = c + vec3f(1.0, 0.27, 0.11) * luma(hl) * u.a.w; }
  if (u.v.x != 0.0) { c = vignette(c, in.uv, u.v.x, u.v.y, u.v.z); }
  if (u.g.x > 0.0) { c = grain(c, in.pos.xy, u.g.x, u.g.y, u.g.z); }
  return vec4f(clamp(c, vec3f(0.0), vec3f(1.0)), 1.0);
}`;

/* ---------- pipeline ---------- */

const geoCols = (m: Float32Array) => [m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0];

export class Develop {
  private slots: Record<string, Target> = {};
  private down: Target[] = [];
  private up: Target[] = [];
  private curves = new Map<string, GPUTexture>();
  private lutTex: GPUTexture;
  private lutId: string | null = null;
  private lutSize = 2;
  private black: Target;

  constructor(readonly kit: Kit, readonly arena: Arena) {
    this.black = kit.solid([0, 0, 0, 1]);
    this.lutTex = this.makeLut(2, new Float32Array(2 * 2 * 2 * 4));
  }

  private get device() { return this.kit.device; }

  private slot(name: string, w: number, h: number, mips = true): Target {
    return (this.slots[name] = this.kit.target(this.slots[name], w, h, 'rgba8unorm', mips));
  }

  private makeLut(size: number, data: Float32Array): GPUTexture {
    const t = this.device.createTexture({ size: [size, size, size], dimension: '3d', format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    this.device.queue.writeTexture({ texture: t }, toHalf(data), { bytesPerRow: size * 8, rowsPerImage: size }, [size, size, size]);
    return t;
  }

  private curveTex(c: GradeSpec['curve']): GPUTexture {
    let t = this.curves.get(c.key);
    if (!t) {
      t = this.device.createTexture({ size: [256, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      this.device.queue.writeTexture({ texture: t }, c.table, { bytesPerRow: 1024 }, [256, 1]);
      if (this.curves.size >= 12) { const [k0, t0] = this.curves.entries().next().value!; t0.destroy(); this.curves.delete(k0); }
      this.curves.set(c.key, t);
    }
    return t;
  }

  /** Releases every GPU resource this pipeline holds. */
  destroy() {
    for (const t of Object.values(this.slots)) t.tex.destroy();
    for (const t of [...this.down, ...this.up]) t.tex.destroy();
    for (const t of this.curves.values()) t.destroy();
    this.lutTex.destroy(); this.black.tex.destroy();
    this.slots = {}; this.down = []; this.up = []; this.curves.clear();
  }

  /** Encodes the whole develop of `src` into `out` (W×H, format `outFmt`). */
  encode(enc: GPUCommandEncoder, spec: DevelopSpec, src: Target, out: GPUTextureView, outFmt: GPUTextureFormat, W: number, H: number): void {
    const { kit, device, arena } = this;
    // a source much larger than the output is read through its mips (no shimmer when downscaling)
    const srcMips = src.mips > 1 && src.w > W * 1.6;
    if (srcMips) kit.genMips(enc, src);
    const srcView = srcMips ? src.mipView : src.view;

    if (spec.bypass) {
      draw(enc, device, kit.pipeline('dev-copy', COPY, outFmt), out, [
        { binding: 0, resource: arena.push(new Float32Array(geoCols(spec.base.geo))) },
        { binding: 1, resource: srcView }, { binding: 2, resource: kit.trilinear },
      ]);
      return;
    }

    if (spec.lut && spec.lut.id !== this.lutId) {
      this.lutTex.destroy();
      this.lutTex = this.makeLut(spec.lut.size, spec.lut.data);
      this.lutId = spec.lut.id; this.lutSize = spec.lut.size;
    }

    // 1. grade (+ presence), then each mask's own grade blended over it
    let base = this.grade(enc, spec, spec.base, srcView, W, H, 'b');
    let mixes = 0;
    for (const m of spec.masks) {
      if (!m.amount) continue;
      const graded = this.grade(enc, spec, m.grade, srcView, W, H, 'm' + (mixes % 2));
      const o = this.slot('mix' + (mixes++ % 2), W, H);
      draw(enc, device, kit.pipeline('dev-mask', MASK, o.fmt), o.view, [
        { binding: 0, resource: arena.push(new Float32Array([m.linear ? 1 : 0, m.invert ? 1 : 0, m.feather, m.amount, m.a[0], m.a[1], m.b[0], m.b[1]])) },
        { binding: 1, resource: base.view }, { binding: 2, resource: graded.view }, { binding: 3, resource: kit.linear },
        { binding: 4, resource: arena.push(new Float32Array([W / H, 0, 0, 0])) },
      ]);
      base = o;
    }

    // 2. blur
    const blurOn = spec.blur > 0;
    const blurTex = blurOn ? this.gaussian(enc, base, spec.blur * W, 'blur') : this.black;

    // 3. bloom: bright pass, dual-filter down chain, weighted up chain; halation reuses a mid level
    let bloomTex = this.black, halTex = this.black, norm = 1;
    if (spec.bloom > 0 || spec.halation > 0) {
      let w = Math.ceil(W / 2), h = Math.ceil(H / 2);
      const n = Math.max(2, Math.min(10, Math.floor(Math.log2(Math.min(w, h))) - 2));
      for (let k = 0; k < n; k++) {
        this.down[k] = kit.target(this.down[k], w, h, 'rgba16float');
        this.up[k] = kit.target(this.up[k], w, h, 'rgba16float');
        w = Math.max(1, Math.ceil(w / 2)); h = Math.max(1, Math.ceil(h / 2));
      }
      draw(enc, device, kit.pipeline('dev-bright', BRIGHT, 'rgba16float'), this.down[0].view, [
        { binding: 0, resource: arena.push(new Float32Array([spec.bloomThreshold, 0, 0, 0])) },
        { binding: 1, resource: base.view }, { binding: 2, resource: kit.linear },
      ]);
      const pd = kit.pipeline('dev-down', DOWN, 'rgba16float');
      for (let k = 1; k < n; k++) {
        const s = this.down[k - 1];
        draw(enc, device, pd, this.down[k].view, [
          { binding: 0, resource: arena.push(new Float32Array([1 / s.w, 1 / s.h, 0, 0])) },
          { binding: 1, resource: s.view }, { binding: 2, resource: kit.linear },
        ]);
      }
      const wgt = 0.4 + spec.bloomRadius * 0.6;
      const pu = kit.pipeline('dev-up', UP, 'rgba16float');
      let coarse = this.down[n - 1];
      for (let k = n - 2; k >= 0; k--) {
        draw(enc, device, pu, this.up[k].view, [
          { binding: 0, resource: arena.push(new Float32Array([1 / coarse.w, 1 / coarse.h, wgt, 0])) },
          { binding: 1, resource: coarse.view }, { binding: 2, resource: this.down[k].view }, { binding: 3, resource: kit.linear },
        ]);
        coarse = this.up[k];
      }
      for (let k = 0; k < n; k++) norm += Math.pow(wgt, k + 1);
      bloomTex = this.up[0];
      halTex = this.down[Math.min(2, n - 1)];
    }

    // 4. finish into the output
    draw(enc, device, kit.pipeline('dev-finish', FINISH, outFmt), out, [
      { binding: 0, resource: arena.push(new Float32Array([
        blurOn ? 1 : 0, spec.blurMode, spec.bloom > 0 ? (spec.bloom * 2.2) / norm : 0, spec.halation * 1.6,
        spec.vignette, spec.vignetteInner, spec.vignetteWidth, W / H,
        spec.grain, spec.grainSize, spec.seed % 997, 0,
      ])) },
      { binding: 1, resource: base.view }, { binding: 2, resource: blurTex.view },
      { binding: 3, resource: bloomTex.view }, { binding: 4, resource: halTex.view },
      { binding: 5, resource: kit.linear },
    ]);
  }

  /** Separable gaussian with sigma in pixels: the 13-tap kernel has sigma ≈ 2.5 taps; large radii read
   *  a smaller mip, small radii shrink the tap spacing, so the look is the same at any render size. */
  private gaussian(enc: GPUCommandEncoder, src: Target, sigma: number, key: string): Target {
    const { kit, device, arena } = this;
    const W = src.w, H = src.h;
    const step = Math.max(1e-3, sigma / 2.5), f = Math.max(1, step), lod = Math.log2(f);
    const bw = Math.max(1, Math.ceil(W / f)), bh = Math.max(1, Math.ceil(H / f));
    const t1 = this.slot(key + '1', bw, bh, false);
    const t2 = this.slot(key + '2', bw, bh, false);
    if (lod > 0) kit.genMips(enc, src);
    const pipe = kit.pipeline('dev-gauss', GAUSS, 'rgba8unorm');
    draw(enc, device, pipe, t1.view, [
      { binding: 0, resource: arena.push(new Float32Array([step / W, 0, lod, 0])) },
      { binding: 1, resource: lod > 0 ? src.mipView : src.view }, { binding: 2, resource: kit.trilinear },
    ]);
    draw(enc, device, pipe, t2.view, [
      { binding: 0, resource: arena.push(new Float32Array([0, step / f / bh, 0, 0])) },
      { binding: 1, resource: t1.view }, { binding: 2, resource: kit.trilinear },
    ]);
    return t2;
  }

  /** One colour grade into a slot, plus presence when used. */
  private grade(enc: GPUCommandEncoder, spec: DevelopSpec, g: GradeSpec, src: GPUTextureView, W: number, H: number, slot: string): Target {
    const { kit, device, arena } = this;
    const A = this.slot(slot + 'A', W, H);
    const L = g.look;
    const lutOn = !!spec.lut && g.lutK > 0;
    const u = new Float32Array(4 * (11 + 8));
    u.set(geoCols(g.geo), 0);
    u.set([...g.wb, 0], 12);
    u.set([g.contrast, g.highlights, g.shadows, g.saturation], 16);
    u.set([g.vibrance, L ? 1 : 0, L?.mono ? 1 : 0, L?.k ?? 0], 20);
    u.set([L?.warm ?? 0, L?.con ?? 0, L?.sat ?? 0, L?.split ?? 0], 24);
    u.set([L?.fade ?? 0, lutOn ? 1 : 0, g.lutK, this.lutSize], 28);
    u.set([...(L?.sh ?? [0, 0, 0]), 0], 32);
    u.set([...(L?.hh ?? [0, 0, 0]), 0], 36);
    u.set([g.hsl ? 1 : 0, 0, 0, 0], 40);
    if (g.hsl) for (let k = 0; k < 8; k++) u.set([g.hsl[k * 3], g.hsl[k * 3 + 1], g.hsl[k * 3 + 2], 0], 44 + k * 4);
    draw(enc, device, kit.pipeline('dev-grade', GRADE, A.fmt), A.view, [
      { binding: 0, resource: arena.push(u) },
      { binding: 1, resource: src }, { binding: 2, resource: kit.trilinear },
      { binding: 3, resource: this.curveTex(g.curve).createView() }, { binding: 4, resource: kit.linear },
      { binding: 5, resource: this.lutTex.createView({ dimension: '3d' }) },
    ]);
    if (!g.dehaze && !g.clarity && !g.texture) return A;

    const long = Math.max(W, H);
    let dark = this.black, cla = this.black, tex = this.black;
    if (g.dehaze) {
      const D = this.slot(slot + 'D', W, H);
      draw(enc, device, kit.pipeline('dev-minch', MINCH, D.fmt), D.view, [{ binding: 0, resource: A.view }, { binding: 1, resource: kit.linear }]);
      dark = this.gaussian(enc, D, long * 0.02, slot + 'dark');
    }
    if (g.clarity) cla = this.gaussian(enc, A, long * 0.015, slot + 'cla');
    if (g.texture) tex = this.gaussian(enc, A, long * 0.0025, slot + 'tex');
    const A2 = this.slot(slot + 'A2', W, H);
    draw(enc, device, kit.pipeline('dev-local', LOCAL, A2.fmt), A2.view, [
      { binding: 0, resource: arena.push(new Float32Array([g.dehaze, g.clarity, g.texture, 0])) },
      { binding: 1, resource: A.view }, { binding: 2, resource: dark.view }, { binding: 3, resource: cla.view },
      { binding: 4, resource: tex.view }, { binding: 5, resource: kit.linear },
    ]);
    return A2;
  }
}
