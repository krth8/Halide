// A small QuickTime / MP4 reader for codecs the browser can't play (ProRes):
// it reads only the `moov` box, never the media data, and returns where each
// video sample lives, plus the PCM audio track when there is one.

export interface MovVideo {
  tag: string;            // sample entry four-cc, e.g. 'apch'
  width: number; height: number;
  timescale: number;
  /** per sample: byte offset, size, presentation time (seconds) */
  offsets: Float64Array; sizes: Uint32Array; times: Float64Array;
  fps: number; duration: number;
}
export interface MovAudio {
  tag: string; channels: number; rate: number;
  /** bytes per sample per channel, and how to read one */
  bytes: number; float: boolean; bigEndian: boolean;
  /** contiguous runs of interleaved frames: byte offset and frame count */
  chunks: { offset: number; frames: number }[];
}
export interface Mov { video: MovVideo | null; audio: MovAudio | null }

interface Box { type: string; start: number; end: number; body: number }

function boxes(v: DataView, from: number, to: number): Box[] {
  const out: Box[] = [];
  for (let p = from; p + 8 <= to;) {
    let size = v.getUint32(p);
    const type = String.fromCharCode(v.getUint8(p + 4), v.getUint8(p + 5), v.getUint8(p + 6), v.getUint8(p + 7));
    let body = p + 8;
    if (size === 1) { size = Number(v.getBigUint64(p + 8)); body = p + 16; }
    else if (size === 0) size = to - p;
    if (size < 8 || p + size > to) break;
    out.push({ type, start: p, end: p + size, body });
    p += size;
  }
  return out;
}
const child = (v: DataView, b: Box, type: string) => boxes(v, b.body, b.end).find((x) => x.type === type);
const path = (v: DataView, b: Box | undefined, ...types: string[]) => {
  for (const t of types) { if (!b) return undefined; b = child(v, b, t); }
  return b;
};

/** Finds and reads the `moov` box: top-level headers are walked with small reads. */
async function readMoov(file: Blob): Promise<DataView> {
  for (let p = 0; p + 8 <= file.size;) {
    const h = new DataView(await file.slice(p, p + 16).arrayBuffer());
    let size = h.getUint32(0);
    const type = String.fromCharCode(h.getUint8(4), h.getUint8(5), h.getUint8(6), h.getUint8(7));
    if (size === 1) size = Number(h.getBigUint64(8));
    else if (size === 0) size = file.size - p;
    if (size < 8) break;
    if (type === 'moov') return new DataView(await file.slice(p, p + size).arrayBuffer());
    p += size;
  }
  throw new Error('no moov box');
}

/** Sample → chunk mapping from stsc/stco/co64. */
function chunks(v: DataView, stbl: Box): { offsets: number[]; perChunk: number[] } {
  const offsets: number[] = [];
  const stco = child(v, stbl, 'stco'), co64 = child(v, stbl, 'co64');
  if (stco) { const n = v.getUint32(stco.body + 4); for (let i = 0; i < n; i++) offsets.push(v.getUint32(stco.body + 8 + i * 4)); }
  else if (co64) { const n = v.getUint32(co64.body + 4); for (let i = 0; i < n; i++) offsets.push(Number(v.getBigUint64(co64.body + 8 + i * 8))); }
  const stsc = child(v, stbl, 'stsc')!;
  const n = v.getUint32(stsc.body + 4);
  const perChunk = new Array(offsets.length).fill(0);
  for (let i = 0; i < n; i++) {
    const first = v.getUint32(stsc.body + 8 + i * 12) - 1;
    const spc = v.getUint32(stsc.body + 12 + i * 12);
    const next = i + 1 < n ? v.getUint32(stsc.body + 8 + (i + 1) * 12) - 1 : offsets.length;
    for (let c = first; c < next && c < offsets.length; c++) perChunk[c] = spc;
  }
  return { offsets, perChunk };
}

function videoTrack(v: DataView, trak: Box): MovVideo {
  const mdhd = path(v, trak, 'mdia', 'mdhd')!;
  const ver = v.getUint8(mdhd.body);
  const timescale = v.getUint32(mdhd.body + (ver === 1 ? 20 : 12));
  const stbl = path(v, trak, 'mdia', 'minf', 'stbl')!;
  const stsd = child(v, stbl, 'stsd')!;
  const e = stsd.body + 8;   // first sample entry
  const tag = String.fromCharCode(v.getUint8(e + 4), v.getUint8(e + 5), v.getUint8(e + 6), v.getUint8(e + 7));
  const width = v.getUint16(e + 32), height = v.getUint16(e + 34);
  // sizes
  const stsz = child(v, stbl, 'stsz')!;
  const fixed = v.getUint32(stsz.body + 4), count = v.getUint32(stsz.body + 8);
  const sizes = new Uint32Array(count);
  for (let i = 0; i < count; i++) sizes[i] = fixed || v.getUint32(stsz.body + 12 + i * 4);
  // offsets
  const { offsets: co, perChunk } = chunks(v, stbl);
  const offsets = new Float64Array(count);
  for (let c = 0, s = 0; c < co.length && s < count; c++) {
    let o = co[c];
    for (let k = 0; k < perChunk[c] && s < count; k++, s++) { offsets[s] = o; o += sizes[s]; }
  }
  // times (decode order = presentation order: ProRes is intra-only)
  const stts = child(v, stbl, 'stts')!;
  const times = new Float64Array(count);
  let t = 0, s = 0;
  const n = v.getUint32(stts.body + 4);
  for (let i = 0; i < n; i++) {
    const c = v.getUint32(stts.body + 8 + i * 8), d = v.getUint32(stts.body + 12 + i * 8);
    for (let k = 0; k < c && s < count; k++, s++) { times[s] = t / timescale; t += d; }
  }
  const duration = t / timescale;
  return { tag, width, height, timescale, offsets, sizes, times, fps: duration ? count / duration : 25, duration };
}

const PCM: Record<string, { bytes: number; float: boolean; be: boolean }> = {
  twos: { bytes: 2, float: false, be: true }, sowt: { bytes: 2, float: false, be: false },
  in24: { bytes: 3, float: false, be: true }, in32: { bytes: 4, float: false, be: true },
  fl32: { bytes: 4, float: true, be: true }, fl64: { bytes: 8, float: true, be: true },
};

function audioTrack(v: DataView, trak: Box): MovAudio | null {
  const stbl = path(v, trak, 'mdia', 'minf', 'stbl')!;
  const stsd = child(v, stbl, 'stsd')!;
  const e = stsd.body + 8;
  const end = e + v.getUint32(e);
  const tag = String.fromCharCode(v.getUint8(e + 4), v.getUint8(e + 5), v.getUint8(e + 6), v.getUint8(e + 7));
  const ver = v.getUint16(e + 16);
  let channels = v.getUint16(e + 24), rate = v.getUint32(e + 32) / 65536;
  let fmt = PCM[tag] ? { ...PCM[tag] } : null;
  let ext = e + 36 + (ver === 1 ? 16 : 0);
  if (ver === 2) {
    // SoundDescription v2: rate (float64) at 40, channels 48, bits 56, flags 60
    rate = v.getFloat64(e + 40);
    channels = v.getUint32(e + 48);
    const bits = v.getUint32(e + 56), flags = v.getUint32(e + 60);
    if (tag === 'lpcm') fmt = { bytes: bits / 8, float: !!(flags & 1), be: !!(flags & 2) };
    ext = e + 72;
  }
  if (!fmt) return null;
  // 'enda' (in a 'wave' box) says little-endian for in24/in32/fl32
  const scan = (from: number, to: number): void => {
    for (const b of boxes(v, from, to)) {
      if (b.type === 'wave') scan(b.body, b.end);
      if (b.type === 'enda') fmt!.be = v.getUint16(b.body) === 0;
    }
  };
  if (ext < end) scan(ext, end);
  if (tag === 'sowt' || tag === 'twos') fmt.be = tag === 'twos';
  const { offsets, perChunk } = chunks(v, stbl);
  return {
    tag, channels, rate, bytes: fmt.bytes, float: fmt.float, bigEndian: fmt.be,
    chunks: offsets.map((offset, i) => ({ offset, frames: perChunk[i] })),
  };
}

/** Reads the container's tracks without touching the media data. */
export async function readMov(file: Blob): Promise<Mov> {
  const v = await readMoov(file);
  const moov = { type: 'moov', start: 0, end: v.byteLength, body: 8 };
  let video: MovVideo | null = null, audio: MovAudio | null = null;
  for (const trak of boxes(v, moov.body, moov.end).filter((b) => b.type === 'trak')) {
    const hdlr = path(v, trak, 'mdia', 'hdlr');
    if (!hdlr) continue;
    const h = String.fromCharCode(v.getUint8(hdlr.body + 8), v.getUint8(hdlr.body + 9), v.getUint8(hdlr.body + 10), v.getUint8(hdlr.body + 11));
    try {
      if (h === 'vide' && !video) video = videoTrack(v, trak);
      else if (h === 'soun' && !audio) audio = audioTrack(v, trak);
    } catch { /* a track we can't read is skipped */ }
  }
  return { video, audio };
}

/** Decodes the PCM track into planar float channels (at most `maxCh`). */
export async function readPcm(file: Blob, a: MovAudio, maxCh = 2): Promise<{ rate: number; data: Float32Array[] }> {
  const ch = Math.min(maxCh, a.channels), frameBytes = a.bytes * a.channels;
  const total = a.chunks.reduce((s, c) => s + c.frames, 0);
  const data = Array.from({ length: ch }, () => new Float32Array(total));
  let at = 0;
  // read in runs of adjacent chunks so a long file isn't thousands of tiny reads
  for (let i = 0; i < a.chunks.length;) {
    let j = i, end = a.chunks[i].offset + a.chunks[i].frames * frameBytes;
    while (j + 1 < a.chunks.length && a.chunks[j + 1].offset === end && end - a.chunks[i].offset < 32e6) { j++; end += a.chunks[j].frames * frameBytes; }
    const v = new DataView(await file.slice(a.chunks[i].offset, end).arrayBuffer());
    const frames = v.byteLength / frameBytes | 0;
    for (let f = 0; f < frames; f++) {
      for (let c = 0; c < ch; c++) {
        const p = f * frameBytes + c * a.bytes;
        let s: number;
        if (a.float) s = a.bytes === 8 ? v.getFloat64(p, !a.bigEndian) : v.getFloat32(p, !a.bigEndian);
        else if (a.bytes === 2) s = v.getInt16(p, !a.bigEndian) / 32768;
        else if (a.bytes === 4) s = v.getInt32(p, !a.bigEndian) / 2147483648;
        else {
          const b0 = v.getUint8(p), b1 = v.getUint8(p + 1), b2 = v.getUint8(p + 2);
          const x = a.bigEndian ? (b0 << 16) | (b1 << 8) | b2 : (b2 << 16) | (b1 << 8) | b0;
          s = ((x << 8) >> 8) / 8388608;
        }
        data[c][at + f] = s;
      }
    }
    at += frames;
    i = j + 1;
  }
  return { rate: a.rate, data };
}
