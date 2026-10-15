import type { BufferTarget, VideoCodec } from 'mediabunny';
import { Renderer } from './gl/renderer';
import type { CubeLut } from './cube';
import type { Item, Params } from './model';
import { decodeFull } from './media';
import { geometry } from './geo';
import { corrAt } from './stab';

export type ImgFormat = 'jpeg' | 'webp' | 'png';
export interface ExportSettings {
  format: ImgFormat;
  quality: number;        // 50–100
  size: number;           // images: long side in px, 0 = original
  codec: VideoCodec;
  vRes: number;           // video: short side in px (2160/1080/720), 0 = original
  vQuality: VideoQuality;
  vBitrate: number;       // Mbit/s, used when vQuality is 'custom'
  fps: number;            // 0 = keep the original frame rate
  audio: boolean;
  name: string;           // pattern, {name} is replaced
}
export type VideoQuality = 'medium' | 'high' | 'very_high' | 'custom';
export const DEFAULT_EXPORT: ExportSettings = {
  format: 'jpeg', quality: 92, size: 0, codec: 'avc', name: '{name}_filmlab',
  vRes: 0, vQuality: 'high', vBitrate: 20, fps: 0, audio: true,
};

const MIME: Record<ImgFormat, string> = { jpeg: 'image/jpeg', webp: 'image/webp', png: 'image/png' };
const EXT: Record<ImgFormat, string> = { jpeg: 'jpg', webp: 'webp', png: 'png' };

const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
/** iOS Safari refuses canvases above ~16.7 MP. */
const MAX_PIXELS = isIOS ? 16_000_000 : 100_000_000;

export function outName(it: Item, s: ExportSettings): string {
  const base = it.name.replace(/\.[^.]+$/, '');
  const ext = it.kind === 'video' ? 'mp4' : EXT[s.format];
  return `${(s.name || '{name}').replace(/\{(name|navn)\}/g, base)}.${ext}`;
}

/** Video output size: the short side is capped at `vRes`. Dimensions are even, as encoders require. */
export function videoSize(w: number, h: number, s: ExportSettings, maxTex: number): [number, number] {
  let k = s.vRes ? Math.min(1, s.vRes / Math.min(w, h)) : 1;
  k = Math.min(k, maxTex / Math.max(w, h), Math.sqrt(MAX_PIXELS / (w * h)));
  const ow = Math.max(2, Math.round(w * k)), oh = Math.max(2, Math.round(h * k));
  return [ow - (ow % 2), oh - (oh % 2)];
}

export function outSize(w: number, h: number, s: ExportSettings, maxTex: number, even = false): [number, number] {
  let k = s.size ? Math.min(1, s.size / Math.max(w, h)) : 1;
  k = Math.min(k, maxTex / Math.max(w, h), Math.sqrt(MAX_PIXELS / (w * h)));
  let ow = Math.max(2, Math.round(w * k)), oh = Math.max(2, Math.round(h * k));
  if (even) { ow -= ow % 2; oh -= oh % 2; }
  return [ow, oh];
}

/* ---------- destinations ---------- */

export interface Dest {
  label: string;
  /** Writes to a file; returns a writable stream if the destination supports streaming. */
  stream(name: string): Promise<FileSystemWritableFileStream | null>;
  write(name: string, data: Blob): Promise<void>;
}

export function folderDest(dir: FileSystemDirectoryHandle): Dest {
  const used = new Set<string>();
  const unique = async (name: string) => {
    const dot = name.lastIndexOf('.');
    for (let n = 1; ; n++) {
      const cand = n === 1 ? name : `${name.slice(0, dot)} (${n})${name.slice(dot)}`;
      if (used.has(cand)) continue;
      try { await dir.getFileHandle(cand); } catch { used.add(cand); return cand; }
    }
  };
  return {
    label: dir.name,
    async stream(name) {
      const fh = await dir.getFileHandle(await unique(name), { create: true });
      return fh.createWritable();
    },
    async write(name, data) {
      const w = (await this.stream(name))!;
      await w.write(data);
      await w.close();
    },
  };
}

/** Collects files in memory; the UI then offers Share / Download (both need a fresh tap). */
export function memoryDest(out: File[]): Dest {
  return {
    label: 'this device',
    async stream() { return null; },
    async write(name, data) { out.push(new File([data], name, { type: data.type })); },
  };
}

/* ---------- export ---------- */

export interface ExportJob {
  items: Item[];
  params: (it: Item) => Params;
  lut: (id: string | null) => CubeLut | null;
  settings: ExportSettings;
  dest: Dest;
  signal: AbortSignal;
  onProgress: (index: number, fraction: number) => void;
}
export interface ExportResult { done: number; failed: { name: string; reason: string }[]; notes: string[] }

export async function runExport(job: ExportJob): Promise<ExportResult> {
  const canvas = document.createElement('canvas');
  const R = new Renderer(canvas, true);
  const res: ExportResult = { done: 0, failed: [], notes: [] };
  for (let i = 0; i < job.items.length; i++) {
    if (job.signal.aborted) break;
    const it = job.items[i];
    job.onProgress(i, 0);
    try {
      if (it.kind === 'image') await exportImage(R, it, job);
      else await exportVideo(R, it, job, res);
      res.done++;
    } catch (e) {
      if (job.signal.aborted) break;
      res.failed.push({ name: it.name, reason: (e as Error)?.message || String(e) });
      await new Promise((r) => setTimeout(r, 300)); // let the browser reclaim memory before the next file
    }
    job.onProgress(i, 1);
  }
  (R.gl.getExtension('WEBGL_lose_context'))?.loseContext();
  return res;
}

async function exportImage(R: Renderer, it: Item, job: ExportJob) {
  const s = job.settings;
  let bm = await decodeFull(it);
  const P = job.params(it);
  // Output size follows the crop; the source is only scaled down as far as the output needs.
  const g = geometry(bm.width, bm.height, P);
  const [w, h] = outSize(g.w, g.h, s, R.maxTex);
  const k = Math.min(1, w / g.w, R.maxTex / Math.max(bm.width, bm.height));
  if (k < 0.999) {
    const small = await createImageBitmap(bm, { resizeWidth: Math.max(1, Math.round(bm.width * k)), resizeHeight: Math.max(1, Math.round(bm.height * k)), resizeQuality: 'high' });
    bm.close();
    bm = small;
  }
  R.setSource(bm, bm.width, bm.height);
  R.render(P, w, h, { lut: job.lut(P.lut.id), seed: it.id, masks: it.masks });
  bm.close();
  if (R.gl.drawingBufferWidth < w) throw new Error('The image is too large for this device. Choose a smaller export size.');
  const blob = await new Promise<Blob | null>((r) => R.canvas.toBlob(r, MIME[s.format], s.quality / 100));
  if (!blob) throw new Error('Could not encode the image');
  await job.dest.write(outName(it, s), blob);
}

async function exportVideo(R: Renderer, it: Item, job: ExportJob, res: ExportResult) {
  const s = job.settings;
  const {
    ALL_FORMATS, BlobSource, BufferTarget, Conversion, Input, Mp4OutputFormat, Output, QUALITY_HIGH, QUALITY_MEDIUM, QUALITY_VERY_HIGH, StreamTarget, getFirstEncodableVideoCodec,
  } = await import('mediabunny');
  const input = new Input({ source: new BlobSource(it.file), formats: ALL_FORMATS });
  const name = outName(it, s);
  const writable = await job.dest.stream(name);
  const target = writable ? new StreamTarget(writable as unknown as WritableStream, { chunked: true }) : new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: writable ? false : 'in-memory' }), target });
  try {
    const P = job.params(it);
    const g = geometry(it.width, it.height, P);
    const [w, h] = videoSize(g.w, g.h, s, R.maxTex);
    const order: VideoCodec[] = [s.codec, ...(['avc', 'hevc', 'vp9', 'av1'] as VideoCodec[]).filter((c) => c !== s.codec)];
    const codec = await getFirstEncodableVideoCodec(order, { width: w, height: h });
    if (!codec) throw new Error('This browser cannot encode video at this size');
    if (codec !== s.codec) res.notes.push(`${it.name}: used ${codec.toUpperCase()} because ${s.codec.toUpperCase()} is not supported here`);
    const lut = job.lut(P.lut.id);
    let frame = 0;
    const clipStart = Math.max(it.trim?.in ?? 0, it.motion?.t[0] ?? 0);
    const conv = await Conversion.init({
      input, output, showWarnings: false,
      trim: it.trim ? { start: it.trim.in, end: it.trim.out } : undefined,
      video: {
        codec, forceTranscode: true,
        ...(s.vQuality === 'custom' ? { bitrate: Math.round(s.vBitrate * 1e6) } : { quality: { medium: QUALITY_MEDIUM, high: QUALITY_HIGH, very_high: QUALITY_VERY_HIGH }[s.vQuality] }),
        frameRate: s.fps || undefined,
        // Frames arrive at full size; crop, rotation and stabilisation happen in the renderer.
        process: (sample) => {
          R.setSource(sample.toCanvasImageSource() as TexImageSource, it.width, it.height);
          // Conversion shifts timestamps so the (trimmed) output starts at 0; map back to the clip's timeline.
          const corr = P.stabilize > 0 ? corrAt(it, sample.timestamp + clipStart, P.stabilize) : null;
          R.render(P, w, h, { lut, seed: frame++, masks: it.masks, corr });
          return R.canvas;
        },
        processedWidth: w, processedHeight: h,
      },
      audio: s.audio ? undefined : { discard: true },
    });
    if (!conv.isValid) throw new Error('This video cannot be converted in this browser');
    if (s.audio && conv.discardedTracks.some((d) => d.track.type === 'audio' && d.reason !== 'discarded_by_user')) res.notes.push(`${it.name}: the audio track could not be included in this browser`);
    conv.onProgress = (p) => job.onProgress(job.items.indexOf(it), p);
    const abort = () => conv.cancel();
    job.signal.addEventListener('abort', abort);
    try { await conv.execute(); } finally { job.signal.removeEventListener('abort', abort); }
    if (!writable) {
      const buf = (target as BufferTarget).buffer!;
      await job.dest.write(name, new Blob([buf], { type: 'video/mp4' }));
    }
  } catch (e) {
    if (writable) await writable.abort().catch(() => {});
    throw e;
  } finally {
    input.dispose();
  }
}
