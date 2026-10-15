// Small WebGPU toolkit for full-screen image passes, shared by Process and
// Edit: render targets (optionally with mip chains), mip generation, pipeline
// caching, and a per-frame uniform arena so many passes with different
// uniforms can go into one command buffer.
import { FULLSCREEN_VS } from './wgsl';

export type Fmt = 'rgba8unorm' | 'rgba16float' | GPUTextureFormat;

export interface Target {
  tex: GPUTexture;
  /** mip 0 only: render into it, and sample it wherever mips aren't generated (an ungenerated mip
   *  holds garbage, and implicit-LOD sampling would read it when drawing at a smaller size) */
  view: GPUTextureView;
  /** the whole mip chain: sample it only after genMips() */
  mipView: GPUTextureView;
  w: number; h: number; fmt: Fmt; mips: number;
}

const mipCount = (w: number, h: number) => Math.floor(Math.log2(Math.max(w, h))) + 1;

const MIP_FS = /* wgsl */`
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@fragment fn fs(in: VSOut) -> @location(0) vec4f { return textureSampleLevel(src, samp, in.uv, 0.0); }`;

export class Kit {
  readonly linear: GPUSampler;      // bilinear, clamped
  readonly trilinear: GPUSampler;   // + linear between mips
  private pipes = new Map<string, GPURenderPipeline>();
  private modules = new Map<string, GPUShaderModule>();

  constructor(readonly device: GPUDevice) {
    this.linear = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge', addressModeW: 'clamp-to-edge' });
    this.trilinear = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
  }

  get maxTex(): number { return this.device.limits.maxTextureDimension2D; }

  /** A render target; reuses `old` when it already has this size and format. */
  target(old: Target | null | undefined, w: number, h: number, fmt: Fmt = 'rgba8unorm', mips = false): Target {
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
    const n = mips ? mipCount(w, h) : 1;
    if (old && old.w === w && old.h === h && old.fmt === fmt && old.mips >= n) return old;
    old?.tex.destroy();
    const tex = this.device.createTexture({
      size: [w, h], format: fmt, mipLevelCount: n,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
    });
    return { tex, view: tex.createView({ baseMipLevel: 0, mipLevelCount: 1 }), mipView: tex.createView(), w, h, fmt, mips: n };
  }

  /** A 1×1 texture of one colour, for unused bindings. */
  solid(rgba: [number, number, number, number] = [0, 0, 0, 1]): Target {
    const t = this.target(null, 1, 1);
    this.device.queue.writeTexture({ texture: t.tex }, new Uint8Array(rgba.map((v) => Math.round(v * 255))), { bytesPerRow: 4 }, [1, 1]);
    return t;
  }

  /** Shader module = shared full-screen vertex stage + the pass's fragment code. */
  module(key: string, fs: string): GPUShaderModule {
    let m = this.modules.get(key);
    if (!m) { m = this.device.createShaderModule({ label: key, code: FULLSCREEN_VS + fs }); this.modules.set(key, m); }
    return m;
  }

  pipeline(key: string, fs: string, fmt: Fmt, blend?: GPUBlendState): GPURenderPipeline {
    const k = key + '|' + fmt + (blend ? '|blend' : '');
    let p = this.pipes.get(k);
    if (!p) {
      const module = this.module(key, fs);
      p = this.device.createRenderPipeline({
        label: k, layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: fmt as GPUTextureFormat, blend }] },
        primitive: { topology: 'triangle-list' },
      });
      this.pipes.set(k, p);
    }
    return p;
  }

  /** Fills mip levels 1… of a target from level 0 (bilinear 2× steps). */
  genMips(enc: GPUCommandEncoder, t: Target): void {
    if (t.mips < 2) return;
    const pipe = this.pipeline('mip', MIP_FS, t.fmt);
    for (let l = 1; l < t.mips; l++) {
      const src = t.tex.createView({ baseMipLevel: l - 1, mipLevelCount: 1 });
      const dst = t.tex.createView({ baseMipLevel: l, mipLevelCount: 1 });
      const bg = this.device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: src }, { binding: 1, resource: this.linear }] });
      const pass = enc.beginRenderPass({ colorAttachments: [{ view: dst, loadOp: 'clear', storeOp: 'store' }] });
      pass.setPipeline(pipe); pass.setBindGroup(0, bg); pass.draw(3); pass.end();
    }
  }
}

/** Uniform data for one frame: each draw takes a 256-byte-aligned slice of one
 *  buffer, written once before submit — so every pass keeps its own values
 *  inside a single command buffer. 1 MB holds ~4000 draws; a frame uses a few
 *  dozen. */
export class Arena {
  static readonly SIZE = 1 << 20;
  private buf: GPUBuffer;
  private data = new ArrayBuffer(Arena.SIZE);
  private used = 0;
  constructor(private device: GPUDevice) {
    this.buf = device.createBuffer({ size: Arena.SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }
  reset() { this.used = 0; }
  /** Copies `f` in and returns the binding resource for it. */
  push(f: Float32Array): GPUBufferBinding {
    const bytes = Math.max(16, f.byteLength);
    if (this.used + bytes > Arena.SIZE) throw new Error('uniform arena full');
    new Float32Array(this.data, this.used, f.length).set(f);
    const r = { buffer: this.buf, offset: this.used, size: bytes };
    this.used = Math.ceil((this.used + bytes) / 256) * 256;
    return r;
  }
  flush() { if (this.used) this.device.queue.writeBuffer(this.buf, 0, this.data, 0, this.used); }
}

/** One full-screen draw into `out` (a target or a canvas view). */
export function draw(enc: GPUCommandEncoder, device: GPUDevice, pipe: GPURenderPipeline, out: GPUTextureView, entries: GPUBindGroupEntry[]): void {
  const bg = device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries });
  const pass = enc.beginRenderPass({ colorAttachments: [{ view: out, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
  pass.setPipeline(pipe);
  pass.setBindGroup(0, bg);
  pass.draw(3);
  pass.end();
}


/** float32 → float16 bits, for rgba16float uploads (3D LUTs). */
export function toHalf(src: Float32Array): Uint16Array<ArrayBuffer> {
  const out = new Uint16Array(src.length);
  const f = new Float32Array(1), u = new Uint32Array(f.buffer);
  for (let i = 0; i < src.length; i++) {
    f[0] = src[i];
    const x = u[0], sign = (x >>> 16) & 0x8000;
    let e = ((x >>> 23) & 0xff) - 127 + 15, m = x & 0x7fffff;
    if (e <= 0) { out[i] = sign; continue; }                  // tiny → 0 (LUT values are 0…1)
    if (e >= 31) { out[i] = sign | 0x7c00; continue; }        // overflow → inf
    m += 0x1000;                                             // round
    if (m & 0x800000) { m = 0; e++; }
    out[i] = sign | (e << 10) | (m >>> 13);
  }
  return out;
}
