// Process's renderer: maps the workspace's controls (Params) onto the shared
// WebGPU develop pipeline (src/shared/gpu/develop.ts) and draws into a canvas.
// Same API the stage, the film strip and the exporter used with WebGL2.
import { gpuDevice } from '../../shared/gpu/device';
import { Arena, Kit, type Target } from '../../shared/gpu/kit';
import { Develop, type DevelopSpec, type GradeSpec, type Look } from '../../shared/gpu/develop';
import { finalLUT } from '../curves';
import { FMAP } from '../looks';
import { maskParams, wbGains, type Mask, type Params } from '../model';
import { geometry, type Corr } from '../geo';
import type { CubeLut } from '../cube';

export interface RenderOpts { bypass?: boolean; seed?: number; lut?: CubeLut | null; masks?: Mask[]; corr?: Corr | null }

// the page's GPU, resolved before any renderer is constructed
const device = await gpuDevice();
export const gpuOk = !!device;

const hue2rgb = (h: number): [number, number, number] => {
  h = (((h % 360) + 360) % 360) / 60;
  const x = 1 - Math.abs((h % 2) - 1);
  return h < 1 ? [1, x, 0] : h < 2 ? [x, 1, 0] : h < 3 ? [0, 1, x] : h < 4 ? [0, x, 1] : h < 5 ? [x, 0, 1] : [1, 0, x];
};

function look(P: Params): Look | null {
  const fd = FMAP[P.filter.id] ?? FMAP.none;
  if (!fd.v || P.filter.k <= 0) return null;
  const F = { ...fd.v, ...(P.filter.v || {}) };
  return {
    mono: !!fd.mono, k: P.filter.k / 100, warm: F.warm / 100, con: F.con / 100, sat: F.sat / 100,
    split: F.split / 100, fade: F.fade / 100, sh: hue2rgb(F.sh), hh: hue2rgb(F.hh),
  };
}

function grade(P: Params, geo: Float32Array, lutOn: boolean): GradeSpec {
  const ev = Math.pow(2, P.exposure), [wr, wg, wb] = wbGains(P.temp, P.tint);
  const hslOn = P.hsl.some((b) => b.h || b.s || b.l);
  return {
    geo, wb: [ev * wr, ev * wg, ev * wb],
    contrast: Math.max(0.15, 1 + P.contrast / 100),
    highlights: P.highlights / 100, shadows: P.shadows / 100,
    saturation: 1 + P.saturation / 100, vibrance: P.vibrance / 100,
    look: look(P),
    lutK: lutOn && P.lut.k > 0 ? P.lut.k / 100 : 0,
    hsl: hslOn ? new Float32Array(P.hsl.flatMap((b) => [b.h, b.s, b.l])) : null,
    curve: { key: JSON.stringify([P.curves, P.whites, P.blacks, P.fade]), table: finalLUT(P) as Uint8Array<ArrayBuffer> },
    dehaze: P.dehaze / 100, clarity: P.clarity / 100, texture: P.texture / 100,
  };
}

export class Renderer {
  readonly maxTex: number = 8192;
  private readonly kit!: Kit;
  private readonly arena!: Arena;
  private readonly dev!: Develop;
  private readonly ctx!: GPUCanvasContext;
  private readonly fmt!: GPUTextureFormat;
  private src: Target | null = null;
  private own: Target | null = null;                  // texture used by setSource()
  private cache = new WeakMap<object, Target>();       // per-item textures (thumbnails)

  // `preserve` is kept for the old signature: a WebGPU canvas is read (drawImage / toBlob) in the
  // same task it was rendered in, which always sees the frame.
  constructor(readonly canvas: HTMLCanvasElement, _preserve = false) {
    if (!device) return;   // no WebGPU: renders nothing; main.ts tells the user
    this.kit = new Kit(device);
    this.arena = new Arena(device);
    this.dev = new Develop(this.kit, this.arena);
    this.maxTex = this.kit.maxTex;
    this.ctx = canvas.getContext('webgpu')!;
    this.fmt = navigator.gpu.getPreferredCanvasFormat();
    this.ctx.configure({ device, format: this.fmt, alphaMode: 'opaque' });
  }

  private upload(t: Target, img: TexImageSource | VideoFrame, w: number, h: number) {
    if (!device) return;
    device!.queue.copyExternalImageToTexture({ source: img as GPUCopyExternalImageSource }, { texture: t.tex }, [w, h]);
  }

  /** Upload a new source frame (image bitmap, video element, VideoFrame…). */
  setSource(img: TexImageSource, w: number, h: number) {
    if (!device) return;
    this.own = this.kit.target(this.own, w, h, 'rgba8unorm', true);
    this.upload(this.own, img, w, h);
    this.src = this.own;
  }

  /** Use a cached texture for `key` (uploaded once), e.g. a thumbnail bitmap. */
  setCachedSource(key: object, img: TexImageSource, w: number, h: number) {
    if (!device) return;
    let t = this.cache.get(key);
    if (!t) {
      t = this.kit.target(null, w, h, 'rgba8unorm', true);
      this.upload(t, img, w, h);
      this.cache.set(key, t);
    }
    this.src = t;
  }

  render(P: Params, W: number, H: number, opts: RenderOpts = {}) {
    const src = this.src;
    if (!src) return;
    W = Math.max(1, Math.round(W)); H = Math.max(1, Math.round(H));
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
    const geo = geometry(src.w, src.h, P, opts.corr).m;
    const lut = opts.lut && P.lut.id === opts.lut.id ? opts.lut : null;
    const spec: DevelopSpec = {
      base: grade(P, geo, !!lut),
      masks: (opts.masks ?? []).filter((m) => m.on && m.amount).map((m) => ({
        grade: grade(maskParams(P, m), geo, !!lut),
        linear: m.type === 'linear', invert: m.invert, a: m.a, b: m.b,
        feather: m.feather / 100, amount: m.amount / 100,
      })),
      lut: lut ? { id: lut.id, size: lut.size, data: lut.data } : null,
      blur: P.blur > 0 ? (P.blur / 100) * 0.012 : 0,
      blurMode: P.blurMode === 'tilt' ? 0 : P.blurMode === 'radial' ? 1 : 2,
      bloom: P.bloom / 100, bloomThreshold: P.bloomThr / 100, bloomRadius: P.bloomRadius / 100,
      halation: P.halation / 100,
      vignette: P.vignette / 100,
      vignetteInner: 0.78 - (P.vigSize / 100) * 0.6,
      // fall-off width: 0 = hard edge, 100 = very gradual; 50 matches the original look
      vignetteWidth: 0.06 + ((P.vigFeather ?? 50) / 100) * 1.02,
      grain: (P.grain / 100) * 0.16,
      // grain size is relative to the image (a 2000 px long side is the reference)
      grainSize: (P.grainSize * Math.max(W, H)) / 2000,
      seed: opts.seed ?? 0,
      bypass: opts.bypass,
    };
    const enc = device!.createCommandEncoder();
    this.arena.reset();
    this.dev.encode(enc, spec, src, this.ctx.getCurrentTexture().createView(), this.fmt, W, H);
    this.arena.flush();
    device!.queue.submit([enc.finish()]);
  }

  /** Free the texture cached for one key. */
  forget(key: object) {
    const t = this.cache.get(key);
    if (t) { t.tex.destroy(); this.cache.delete(key); }
  }

  /** Release the GPU resources (an export renderer when the job ends). */
  destroy() {
    if (!device) return;
    this.dev.destroy();
    this.own?.tex.destroy();
    this.ctx.unconfigure();
  }
}
