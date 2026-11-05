// RAW photos — shared by Process (photos) and Edit (stills on the timeline): CR3, CR2, NEF, ARW, DNG, RAF, ORF, RW2 and ~1000 cameras more —
// through LibRaw compiled to WebAssembly (public/vendor/libraw). It loads on the
// first RAW file and decodes in its own worker, off the main thread.
//
// Three costs, three uses: the embedded camera JPEG for thumbnails (no RAW
// decode at all), a half-size decode for the on-screen preview, and the full
// decode only at export.
import { asset } from '../paths';
import { toHalf } from '../gpu/kit';

const EXT = ['3fr', 'ari', 'arw', 'bay', 'cr2', 'cr3', 'crw', 'dcr', 'dcs', 'dng', 'erf', 'fff', 'gpr', 'iiq', 'k25', 'kdc', 'mef', 'mos',
  'mrw', 'nef', 'nrw', 'orf', 'pef', 'raf', 'raw', 'rw2', 'rwl', 'sr2', 'srf', 'srw', 'x3f'];
export const RAW_EXTENSIONS = EXT.map((e) => '.' + e);
const RAW_EXT = new RegExp(`\\.(${EXT.join('|')})$`, 'i');
export const isRaw = (f: { name: string }) => RAW_EXT.test(f.name);

interface Meta { width: number; height: number; flip: number; camera_make: string; camera_model: string }
interface Pixels { width: number; height: number; colors: number; bits: number; data: Uint8Array | Uint16Array }
interface Thumb { width: number; height: number; format: 'jpeg' | 'bitmap' | 'unknown'; data: Uint8Array }
interface LibRaw {
  open(bytes: Uint8Array, settings?: Record<string, unknown>): Promise<void>;
  metadata(full?: boolean): Promise<Meta | undefined>;
  imageData(): Promise<Pixels | undefined>;
  thumbnailData(): Promise<Thumb | undefined>;
  dispose(): void;
}

let ctor: Promise<new () => LibRaw> | null = null;
const load = () => (ctor ??= import(/* @vite-ignore */ asset('vendor/libraw/index.js')).then((m) => m.default));

// One decoder holds one open file, so jobs run one after another. A failed
// job disposes the instance (LibRaw can be left in a bad state); the next one
// starts a fresh worker.
let inst: LibRaw | null = null;
let chain: Promise<unknown> = Promise.resolve();
function job<T>(fn: (lr: LibRaw) => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const C = await load();
    const lr = (inst ??= new C());
    try { return await fn(lr); }
    catch (e) { try { lr.dispose(); } catch { /* gone */ } inst = null; throw e; }
  });
  chain = run.catch(() => {});
  return run;
}

/** dcraw orientation codes: 3 = 180°, 5 = 90° counter-clockwise, 6 = 90° clockwise. */
const turned = (flip: number) => flip === 5 || flip === 6;

async function orient(bm: ImageBitmap, flip: number): Promise<ImageBitmap> {
  if (flip !== 3 && !turned(flip)) return bm;
  const w = turned(flip) ? bm.height : bm.width, h = turned(flip) ? bm.width : bm.height;
  const c = new OffscreenCanvas(w, h), x = c.getContext('2d')!;
  x.translate(w / 2, h / 2);
  x.rotate(flip === 3 ? Math.PI : flip === 6 ? Math.PI / 2 : -Math.PI / 2);
  x.drawImage(bm, -bm.width / 2, -bm.height / 2);
  bm.close();
  return createImageBitmap(c);
}

/** Packed RGB (8- or 16-bit) from LibRaw → ImageBitmap. */
function toBitmap(p: { width: number; height: number; colors?: number; bits?: number; data: Uint8Array | Uint16Array }): Promise<ImageBitmap> {
  const n = p.width * p.height, ch = p.colors ?? 3, src = p.data, shift = (p.bits ?? 8) > 8 ? 8 : 0;
  const rgba = new Uint8ClampedArray(n * 4);
  for (let i = 0, j = 0; i < n; i++, j += ch) {
    const o = i * 4;
    rgba[o] = src[j] >> shift;
    rgba[o + 1] = src[j + (ch > 1 ? 1 : 0)] >> shift;
    rgba[o + 2] = src[j + (ch > 2 ? 2 : 0)] >> shift;
    rgba[o + 3] = 255;
  }
  return createImageBitmap(new ImageData(rgba, p.width, p.height));
}

const bytes = async (f: File) => new Uint8Array(await f.arrayBuffer());

// develop settings: the camera's white balance and colour matrix into sRGB,
// highlights clipped (mode 0) as most raw converters' defaults. LibRaw keeps
// settings from one open() to the next, so every call states size and quality.
const DEVELOP = {
  useCameraWb: true, useCameraMatrix: 1, outputColor: 1, outputBps: 8, highlight: 0, halfSize: false, userQual: 3,
  gamm: [0.45, 4.5], noAutoBright: false, bright: 1,   // LibRaw's defaults, restated after a linear develop
};
// the linear develop: 16-bit, no gamma, no auto-brightening and white at a quarter
// of the range (2 stops of room above it), highlights blended (mode 2) so a
// channel that clipped still carries detail from the others
const LINEAR = { ...DEVELOP, outputBps: 16, gamm: [1, 1], highlight: 2, noAutoBright: true, bright: 0.25 };

/** A RAW develop in linear light (sRGB primaries): rgba16float texels where 1.0
 *  is the white LibRaw's auto-brightening would pick, and brighter highlights
 *  stay above 1 instead of clipping. */
export interface LinearImage { readonly linear: true; width: number; height: number; data: Uint16Array<ArrayBuffer> }
export const isLinear = (x: unknown): x is LinearImage => !!x && (x as LinearImage).linear === true;

/** Box-filters packed 16-bit pixels down to fit `maxSide`. */
function shrink(p: Pixels, maxSide: number): Pixels {
  const s = Math.max(p.width, p.height) / maxSide;
  if (s <= 1) return p;
  const ch = p.colors, src = p.data, W = p.width;
  const w = Math.max(1, Math.round(p.width / s)), h = Math.max(1, Math.round(p.height / s));
  const out = new Uint16Array(w * h * ch), acc = new Float64Array(ch);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * p.height) / h), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * p.height) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * W) / w), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * W) / w));
      acc.fill(0);
      for (let yy = y0; yy < y1; yy++) for (let xx = x0, j = (yy * W + x0) * ch; xx < x1; xx++) for (let c = 0; c < ch; c++) acc[c] += src[j++];
      const n = (y1 - y0) * (x1 - x0), o = (y * w + x) * ch;
      for (let c = 0; c < ch; c++) out[o + c] = Math.round(acc[c] / n);
    }
  }
  return { ...p, width: w, height: h, data: out };
}

/** 16-bit linear pixels → half floats, scaled so dcraw's auto-bright white (the level
 *  the brightest 1% of the brightest channel reaches) is 1.0. */
function toLinear(p: Pixels): LinearImage {
  const n = p.width * p.height, ch = p.colors, src = p.data, hist = new Uint32Array(65536);
  let white = 1;
  for (let c = 0; c < Math.min(ch, 3); c++) {
    hist.fill(0);
    for (let i = c; i < n * ch; i += ch) hist[src[i]]++;
    for (let v = 65535, acc = 0; v > 0; v--) if ((acc += hist[v]) > n * 0.01) { white = Math.max(white, v); break; }
  }
  const lut = toHalf(Float32Array.from({ length: 65536 }, (_, v) => v / white));
  const data = new Uint16Array(n * 4), g = ch > 1 ? 1 : 0, b = ch > 2 ? 2 : 0;
  for (let i = 0, j = 0, o = 0; i < n; i++, j += ch, o += 4) {
    data[o] = lut[src[j]]; data[o + 1] = lut[src[j + g]]; data[o + 2] = lut[src[j + b]]; data[o + 3] = 0x3c00;
  }
  return { linear: true, width: p.width, height: p.height, data };
}

/** Thumbnail and display size, from the camera's embedded JPEG when there is one. */
export function rawThumb(file: File): Promise<{ thumb: ImageBitmap; width: number; height: number }> {
  return job(async (lr) => {
    await lr.open(await bytes(file), DEVELOP);
    const m = await lr.metadata();
    if (!m) throw new Error('Not a RAW file LibRaw can read');
    const width = turned(m.flip) ? m.height : m.width, height = turned(m.flip) ? m.width : m.height;
    let t: Thumb | undefined;
    try { t = await lr.thumbnailData(); } catch { t = undefined; }
    let bm: ImageBitmap | null = null;
    if (t?.format === 'jpeg') bm = await createImageBitmap(new Blob([t.data as BlobPart], { type: 'image/jpeg' }), { imageOrientation: 'none' }).catch(() => null);
    else if (t?.format === 'bitmap') bm = await toBitmap({ width: t.width, height: t.height, data: t.data }).catch(() => null);
    if (bm) {
      // some cameras store the preview already upright; only turn it when its
      // shape still matches the sensor's
      const sensorLandscape = m.width >= m.height, thumbLandscape = bm.width >= bm.height;
      if (turned(m.flip) && sensorLandscape !== thumbLandscape) return { thumb: bm, width, height };
      return { thumb: await orient(bm, m.flip), width, height };
    }
    // no usable preview: a quick half-size decode
    await lr.open(await bytes(file), { ...DEVELOP, halfSize: true, userQual: 0 });
    const px = await lr.imageData();
    if (!px) throw new Error('Could not decode the RAW file');
    return { thumb: await toBitmap(px), width, height };
  });
}

/** Develops the RAW file. `half` (the on-screen preview) decodes at half size
 *  with fast interpolation; export uses the full sensor and AHD. */
export function rawDecode(file: File, { half = false } = {}): Promise<ImageBitmap> {
  return job(async (lr) => {
    await lr.open(await bytes(file), { ...DEVELOP, halfSize: half, userQual: half ? 0 : 3 });
    const px = await lr.imageData();
    if (!px) throw new Error('Could not decode the RAW file');
    return toBitmap(px);
  });
}

/** Develops the RAW file in linear light with its highlight headroom (see LinearImage),
 *  no larger than `maxSide`. `half` as for rawDecode. */
export function rawDecodeLinear(file: File, { half = false, maxSide = Infinity } = {}): Promise<LinearImage> {
  return job(async (lr) => {
    await lr.open(await bytes(file), { ...LINEAR, halfSize: half, userQual: half ? 0 : 3 });
    const px = await lr.imageData();
    if (!px || px.bits !== 16) throw new Error('Could not decode the RAW file');
    return toLinear(shrink(px, maxSide));
  });
}
