// ProRes straight from the original, no proxy: frames are read from the file
// on demand and decoded on the GPU by the renderer (shared/codec/prores). This
// module keeps the per-media sample table, a small read-ahead cache of frame
// bytes, the PCM audio and the thumbnail.
import { readMov, readPcm } from '../../shared/codec/mov.ts';
import { PRORES_TAGS, bitsForTag } from '../../shared/codec/prores/bitstream.ts';
import { ProResDecoder } from '../../shared/codec/prores/decoder.ts';
import { gpuDevice } from '../../shared/gpu/device.ts';

/** ProRes in a QuickTime/MP4 container: its track info, or null. */
export async function probeProRes(file) {
  if (!/\.(mov|mp4|m4v|mxf)$/i.test(file.name || '') && !/quicktime|mp4/.test(file.type || '')) return null;
  if (!(await gpuDevice())) return null;   // no WebGPU: the proxy path takes it
  let mov;
  try { mov = await readMov(file); } catch { return null; }
  const v = mov.video;
  if (!v || !PRORES_TAGS.includes(v.tag) || !v.sizes.length) return null;
  return { mov, width: v.width, height: v.height, duration: v.duration, fps: v.fps };
}

const AHEAD = 8;        // frames read ahead of the playhead
const KEEP = 24;        // frames kept in memory per clip
const PARALLEL = 3;     // concurrent reads per clip

class Source {
  constructor(file, mov) {
    this.file = file; this.mov = mov; this.v = mov.video;
    this.bits = bitsForTag(this.v.tag);
    this.cache = new Map();     // sample index -> Uint8Array
    this.loading = new Set();
    this.last = null;           // the newest frame handed out, held while the next one loads
  }
  index(t) {
    const ts = this.v.times;
    let lo = 0, hi = ts.length - 1;
    // the sample showing at time t (half a frame of slack against float drift)
    const x = t + 0.5 / (this.v.fps || 25);
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ts[mid] <= x) lo = mid; else hi = mid - 1; }
    return lo;
  }
  async read(i) {
    const o = this.v.offsets[i], n = this.v.sizes[i];
    return new Uint8Array(await this.file.slice(o, o + n).arrayBuffer());
  }
  want(i, onReady) {
    const n = this.v.sizes.length;
    for (let k = i; k < Math.min(n, i + AHEAD); k++) {
      if (this.cache.has(k) || this.loading.has(k)) continue;
      if (this.loading.size >= PARALLEL) break;
      this.loading.add(k);
      this.read(k).then((b) => {
        this.cache.set(k, b);
        // keep the frames around the playhead, drop the rest
        if (this.cache.size > KEEP) for (const key of [...this.cache.keys()].sort((a, c) => Math.abs(a - i) - Math.abs(c - i)).slice(KEEP)) this.cache.delete(key);
        if (k === i) onReady?.();
      }).catch(() => {}).finally(() => { this.loading.delete(k); this.want(i, null); });
    }
  }
  frame(id, i) {
    const b = this.cache.get(i);
    return b ? { prores: true, key: id + ':' + i, bytes: b, bits: this.bits, w: this.v.width, h: this.v.height } : null;
  }
}

const sources = new Map();   // media.id -> { file, src | null, p }
function sourceOf(m, onReady) {
  if (!m?.file) return null;
  let e = sources.get(m.id);
  if (e && e.file !== m.file) { sources.delete(m.id); e = null; }
  if (!e) {
    e = { file: m.file, src: null, p: null };
    sources.set(m.id, e);
    e.p = readMov(m.file).then((mov) => { e.src = new Source(m.file, mov); onReady?.(); return e.src; })
      .catch((err) => { console.warn('[prores] open failed', m.name, err); sources.delete(m.id); return null; });
  }
  return e.src;
}

/** The frame at `srcTime` for drawing now, or the last one while it loads (null before any). */
export function proresFrame(m, srcTime, onReady) {
  const s = sourceOf(m, onReady);
  if (!s) return null;
  const i = s.index(srcTime);
  s.want(i, onReady);
  const f = s.frame(m.id, i);
  if (f) { s.last = f; return f; }
  return s.last;
}

/** The exact frame at `srcTime` (export). */
export async function proresFrameAsync(m, srcTime) {
  sourceOf(m);
  const s = await sources.get(m.id)?.p;
  if (!s) return null;
  const i = s.index(srcTime);
  let b = s.cache.get(i);
  if (!b) { b = await s.read(i); s.cache.set(i, b); if (s.cache.size > KEEP) s.cache.delete(s.cache.keys().next().value); }
  s.want(i + 1, null);
  return s.frame(m.id, i);
}

/** The clip's audio as planar float PCM ({ rate, data }), or null when it has none. */
export async function proresAudio(m) {
  if (!m?.file) return null;
  const mov = await readMov(m.file).catch(() => null);
  if (!mov?.audio) return null;
  try { return await readPcm(m.file, mov.audio, 2); } catch (e) { console.warn('[prores] audio failed', m.name, e); return null; }
}

/** A 640 px JPEG data URL of the frame at `t` (decoded on the GPU). */
export async function proresThumb(file, mov, t = 0) {
  const dev = await gpuDevice();
  if (!dev) return null;
  const s = new Source(file, mov);
  const i = s.index(Math.min(t, Math.max(0, mov.video.duration - 0.05)));
  const bytes = await s.read(i);
  const dec = new ProResDecoder(dev);
  try {
    const enc = dev.createCommandEncoder();
    const pl = dec.decode(enc, bytes, s.bits);
    const { width: w, height: h } = pl.frame;
    const tex = dev.createTexture({ size: [w, h], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    dec.toRGB(enc, pl, tex.createView(), 'rgba8unorm');
    const bpr = Math.ceil((w * 4) / 256) * 256;
    const buf = dev.createBuffer({ size: bpr * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: bpr }, [w, h]);
    dev.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const src = new Uint8Array(buf.getMappedRange()), px = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) px.set(src.subarray(y * bpr, y * bpr + w * 4), y * w * 4);
    buf.unmap(); buf.destroy(); tex.destroy();
    const full = new OffscreenCanvas(w, h);
    full.getContext('2d').putImageData(new ImageData(px, w, h), 0, 0);
    const k = Math.min(1, 640 / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.round(w * k); c.height = Math.round(h * k);
    c.getContext('2d').drawImage(full, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.8);
  } finally { dec.destroy(); }
}
