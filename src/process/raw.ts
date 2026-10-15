// RAW photos — CR3, CR2, NEF, ARW, DNG, RAF, ORF, RW2 and ~1000 cameras more —
// through LibRaw compiled to WebAssembly (public/vendor/libraw). It loads on the
// first RAW file and decodes in its own worker, off the main thread.
//
// Three costs, three uses: the embedded camera JPEG for thumbnails (no RAW
// decode at all), a half-size decode for the on-screen preview, and the full
// decode only at export.
import { asset } from '../shared/paths';

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
const DEVELOP = { useCameraWb: true, useCameraMatrix: 1, outputColor: 1, outputBps: 8, highlight: 0, halfSize: false, userQual: 3 };

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
