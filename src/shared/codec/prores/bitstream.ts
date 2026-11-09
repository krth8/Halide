// ProRes frame parsing on the CPU: the frame header, the picture header(s)
// and the slice table. The coefficients themselves are decoded on the GPU
// (decoder.ts) — this part only finds where every slice is and how to read it.
// Follows SMPTE RDD 36 and FFmpeg's proresdec.c.

/** One slice per row of the table, SLICE_WORDS u32 each. */
export const SLICE_WORDS = 8;
// [0] byte offset of the slice's luma data in the frame
// [1] luma bytes   [2] Cb bytes   [3] Cr bytes
// [4] first macroblock x   [5] macroblock row (within its field)
// [6] macroblocks in the slice (1, 2, 4 or 8)   [7] qscale | field << 16

export interface ProResFrame {
  width: number;
  height: number;
  /** 4:4:4 chroma (the 4444 profiles) instead of 4:2:2 */
  chroma444: boolean;
  /** 0 progressive, 1 interlaced top field first, 2 bottom field first */
  frameType: number;
  /** 12-bit (4444, 4444 XQ) or 10-bit (the 422 profiles), from the codec tag */
  bits: 10 | 12;
  /** alpha channel present (not decoded yet) */
  alpha: number;
  /** ISO/IEC 23091-2 codes: primaries, transfer, matrix */
  primaries: number; transfer: number; matrix: number;
  qmatLuma: Uint8Array;    // 64, natural order
  qmatChroma: Uint8Array;  // 64, natural order
  mbWidth: number;
  /** macroblock rows per picture (per field when interlaced) */
  mbHeight: number;
  slices: Uint32Array<ArrayBuffer>;
  sliceCount: number;
}

const rb16 = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const rb32 = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

/** Codec tag → bit depth (FFmpeg decodes 4444 and XQ at 12 bits, the rest at 10). */
export const bitsForTag = (tag: string): 10 | 12 => (tag === 'ap4h' || tag === 'ap4x' ? 12 : 10);
export const PRORES_TAGS = ['apco', 'apcs', 'apcn', 'apch', 'ap4h', 'ap4x'];

/** Parses one ProRes frame (a whole sample from the container). */
export function parseFrame(buf: Uint8Array, bits: 10 | 12): ProResFrame {
  if (buf.length < 28 || String.fromCharCode(buf[4], buf[5], buf[6], buf[7]) !== 'icpf') throw new Error('not a ProRes frame');
  let p = 8;
  const hdr = rb16(buf, p);
  if (rb16(buf, p + 2) > 1) throw new Error('unsupported ProRes version');
  const width = rb16(buf, p + 8), height = rb16(buf, p + 10);
  const frameType = (buf[p + 12] >> 2) & 3;
  const chroma444 = (buf[p + 12] & 0xc0) === 0xc0;
  const alpha = buf[p + 17] & 0xf;
  const flags = buf[p + 19];
  let q = p + 20;
  const qmatLuma = new Uint8Array(64).fill(4);
  if (flags & 2) { qmatLuma.set(buf.subarray(q, q + 64)); q += 64; }
  const qmatChroma = flags & 1 ? buf.slice(q, q + 64) : qmatLuma.slice();
  const f: Omit<ProResFrame, 'mbWidth' | 'mbHeight' | 'slices' | 'sliceCount'> = {
    width, height, chroma444, frameType, bits, alpha,
    primaries: buf[p + 14], transfer: buf[p + 15], matrix: buf[p + 16], qmatLuma, qmatChroma,
  };
  p += hdr;

  const mbWidth = (width + 15) >> 4;
  const mbHeight = frameType ? (height + 31) >> 5 : (height + 15) >> 4;
  const rows: number[] = [];
  const fields = frameType ? 2 : 1;
  for (let field = 0; field < fields && p < buf.length; field++) {
    const phdr = buf[p] >> 3;
    const picSize = rb32(buf, p + 1);
    const log2W = buf[p + 7] >> 4;
    if (phdr < 8 || log2W > 3 || (buf[p + 7] & 0xf)) throw new Error('unsupported ProRes slice layout');
    const sliceMb = 1 << log2W;
    // the written slice count is not trusted (QuickTime ignores it too)
    const perRow = (mbWidth >> log2W) + popcount(mbWidth & (sliceMb - 1));
    const count = mbHeight * perRow;
    let index = p + phdr, data = index + count * 2;
    let mbX = 0, mbY = 0, n = sliceMb;
    for (let i = 0; i < count; i++) {
      const size = rb16(buf, index + i * 2);
      while (mbWidth - mbX < n) n >>= 1;
      const sh = buf[data] >> 3;
      let qs = Math.min(224, Math.max(1, buf[data + 1]));
      qs = qs > 128 ? (qs - 96) << 2 : qs;
      const y = rb16(buf, data + 2), u = rb16(buf, data + 4);
      const v = sh > 7 ? rb16(buf, data + 6) : size - y - u - sh;
      if (size < 6 || y + u + v + sh > size || data + size > buf.length) throw new Error('damaged ProRes slice');
      rows.push(data + sh, y, u, v, mbX, mbY, n, qs | (field << 16));
      data += size;
      mbX += n;
      if (mbX === mbWidth) { mbX = 0; mbY++; n = sliceMb; }
    }
    p += picSize;
  }
  return { ...f, mbWidth, mbHeight, slices: Uint32Array.from(rows), sliceCount: rows.length / SLICE_WORDS };
}

function popcount(x: number) { let c = 0; while (x) { c += x & 1; x >>= 1; } return c; }

/** Scan order (scan position → natural index): progressive, interlaced. */
export const PROGRESSIVE_SCAN = [
  0, 1, 8, 9, 2, 3, 10, 11, 16, 17, 24, 25, 18, 19, 26, 27, 4, 5, 12, 20, 13, 6, 7, 14, 21, 28, 29, 22, 15, 23, 30, 31,
  32, 33, 40, 48, 41, 34, 35, 42, 49, 56, 57, 50, 43, 36, 37, 44, 51, 58, 59, 52, 45, 38, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];
export const INTERLACED_SCAN = [
  0, 8, 1, 9, 16, 24, 17, 25, 2, 10, 3, 11, 18, 26, 19, 27, 32, 40, 33, 34, 41, 48, 56, 49, 42, 35, 43, 50, 57, 58, 51, 59,
  4, 12, 5, 6, 13, 20, 28, 21, 14, 7, 15, 22, 29, 36, 44, 37, 30, 23, 31, 38, 45, 52, 60, 53, 46, 39, 47, 54, 61, 62, 55, 63,
];
