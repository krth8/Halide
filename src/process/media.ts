import type { Item, Kind } from './model';

const IMG = /\.(jpe?g|png|webp|avif|heic|heif|gif|bmp|tiff?)$/i;
const VID = /\.(mov|mp4|m4v|webm|mkv|3gp)$/i;

export function kindOf(f: File): Kind | null {
  if (f.type.startsWith('image/') || IMG.test(f.name)) return 'image';
  if (f.type.startsWith('video/') || VID.test(f.name)) return 'video';
  return null;
}
export const fileKey = (f: File) => `${f.name}|${f.size}|${f.lastModified}`;
export const byName = (a: File, b: File) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

export const THUMB = 240;
export const PREVIEW = 2048;

const fit = (w: number, h: number, max: number) => {
  const s = Math.min(1, max / Math.max(w, h));
  return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
};

function meanLuma(img: CanvasImageSource): number {
  const c = new OffscreenCanvas(32, 32), x = c.getContext('2d')!;
  x.drawImage(img, 0, 0, 32, 32);
  const d = x.getImageData(0, 0, 32, 32).data;
  let s = 0;
  for (let i = 0; i < d.length; i += 4) s += (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
  return s / 1024;
}

function decodeError(it: Item, e: unknown): string {
  if (/\.(heic|heif)$/i.test(it.name)) return 'HEIC cannot be read in this browser. Use Safari, or export as JPEG from Photos.';
  return (e as Error)?.message || 'Could not read the file';
}

/** Reads dimensions, a thumbnail and (for video) duration. Full-size decoding is done lazily. */
export async function loadItem(it: Item): Promise<void> {
  try {
    if (it.kind === 'image') {
      const full = await createImageBitmap(it.file);
      it.width = full.width; it.height = full.height;
      const [tw, th] = fit(full.width, full.height, THUMB);
      it.thumb = await createImageBitmap(full, { resizeWidth: tw, resizeHeight: th, resizeQuality: 'high' });
      full.close();
    } else {
      const { ALL_FORMATS, BlobSource, CanvasSink, Input } = await import('mediabunny');
      const input = new Input({ source: new BlobSource(it.file), formats: ALL_FORMATS });
      try {
        const track = await input.getPrimaryVideoTrack();
        if (!track) throw new Error('No video track found');
        if (!(await track.canDecode())) throw new Error('This video format cannot be played in this browser');
        it.duration = await input.computeDuration();
        it.width = track.displayWidth; it.height = track.displayHeight;
        it.trim ??= { in: 0, out: it.duration };
        it.trim.out = Math.min(it.trim.out, it.duration);
        const [tw, th] = fit(it.width, it.height, THUMB);
        const sink = new CanvasSink(track, { width: tw, height: th, fit: 'fill' });
        const t0 = await track.getFirstTimestamp();
        const wc = await sink.getCanvas(t0 + Math.min(1, it.duration * 0.1));
        if (!wc) throw new Error('No frames found in the video');
        it.thumb = await createImageBitmap(wc.canvas);
      } finally {
        input.dispose();
      }
    }
    it.lum = meanLuma(it.thumb!);
    it.status = 'ready';
  } catch (e) {
    it.status = 'error';
    it.error = decodeError(it, e);
  }
}

/* ---------- full-resolution decoding (export) ---------- */

/** File handles from folder imports, so a stale File can be re-read from disk. */
const handles = new WeakMap<File, FileSystemFileHandle>();
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function viaImg(blob: Blob): Promise<ImageBitmap> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return await createImageBitmap(img);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Decodes the full image, trying progressively more forgiving routes. Phones can fail a decode under
 *  memory pressure, and files picked on Android can become unreadable after a while. */
export async function decodeFull(it: Item): Promise<ImageBitmap> {
  const fresh = async () => {
    const h = handles.get(it.file);
    if (!h) throw new Error('no folder access');
    const f = await h.getFile();
    handles.set(f, h);
    it.file = f;
    return f;
  };
  const tries: (() => Promise<ImageBitmap>)[] = [
    () => createImageBitmap(it.file),
    async () => createImageBitmap(new Blob([await it.file.arrayBuffer()], { type: it.file.type })),
    async () => createImageBitmap(await fresh()),
    () => viaImg(it.file),
  ];
  let last: unknown;
  for (const t of tries) {
    try { return await t(); } catch (e) { last = e; await pause(250); }
  }
  const e = last as Error;
  if (e?.name === 'NotReadableError' || e?.name === 'NotFoundError') throw new Error('The file can no longer be read. Open the photos again and export again.');
  throw new Error(`Could not decode the image (${e?.name || 'error'}). The device may have run out of memory. Try a smaller export size.`);
}

/* Full previews (≤ 2048 px) are kept for a handful of items only. */
const previews = new Map<Item, Promise<ImageBitmap>>();
export function loadPreview(it: Item): Promise<ImageBitmap> {
  let p = previews.get(it);
  if (p) { previews.delete(it); previews.set(it, p); return p; }
  p = (async () => {
    const full = await createImageBitmap(it.file);
    const [w, h] = fit(full.width, full.height, PREVIEW);
    if (w === full.width) return full;
    const bm = await createImageBitmap(full, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
    full.close();
    return bm;
  })();
  previews.set(it, p);
  p.catch(() => previews.delete(it));
  while (previews.size > 6) {
    const [k, v] = previews.entries().next().value!;
    previews.delete(k);
    v.then((b) => b.close()).catch(() => {});
  }
  return p;
}

/** Frees cached previews except the one on screen (called before a memory-heavy export). */
export function trimPreviews(keep?: Item) {
  for (const [k, v] of previews) {
    if (k === keep) continue;
    previews.delete(k);
    v.then((b) => b.close()).catch(() => {});
  }
}

/** Evenly spaced frames for the trim timeline. */
export async function videoStrip(it: Item, n: number, h: number): Promise<ImageBitmap[]> {
  const { ALL_FORMATS, BlobSource, CanvasSink, Input } = await import('mediabunny');
  const input = new Input({ source: new BlobSource(it.file), formats: ALL_FORMATS });
  try {
    const track = (await input.getPrimaryVideoTrack())!;
    const w = Math.round((h * it.width) / it.height);
    const sink = new CanvasSink(track, { width: w, height: h, fit: 'fill' });
    const t0 = await track.getFirstTimestamp();
    const ts = Array.from({ length: n }, (_, i) => t0 + ((i + 0.5) / n) * it.duration);
    const out: ImageBitmap[] = [];
    for await (const wc of sink.canvasesAtTimestamps(ts)) if (wc) out.push(await createImageBitmap(wc.canvas));
    return out;
  } finally {
    input.dispose();
  }
}

/* ---------- picking files ---------- */

export const canPickDir = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

export interface Picked { files: File[]; dir: FileSystemDirectoryHandle | null; name: string }

/** Which picked folder a file came from, so the session can re-open it after a restart. */
const origins = new WeakMap<File, { dir: FileSystemDirectoryHandle; path: string }>();
export const originOf = (f: File) => origins.get(f);

async function walk(dir: FileSystemDirectoryHandle, out: File[], depth = 0, root = dir, prefix = '') {
  for await (const h of (dir as any).values() as AsyncIterable<FileSystemHandle>) {
    if (h.kind === 'file') {
      const f = await (h as FileSystemFileHandle).getFile();
      if (kindOf(f)) { out.push(f); handles.set(f, h as FileSystemFileHandle); origins.set(f, { dir: root, path: prefix + h.name }); }
    } else if (depth < 3 && !h.name.startsWith('.')) await walk(h as FileSystemDirectoryHandle, out, depth + 1, root, prefix + h.name + '/');
  }
}

/** Re-opens a file inside a previously picked folder. */
export async function openInDir(root: FileSystemDirectoryHandle, path: string): Promise<File> {
  const parts = path.split('/');
  let d = root;
  for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p);
  const h = await d.getFileHandle(parts[parts.length - 1]);
  const f = await h.getFile();
  handles.set(f, h);
  origins.set(f, { dir: root, path });
  return f;
}

export async function pickDirectory(): Promise<Picked | null> {
  try {
    const dir: FileSystemDirectoryHandle = await (window as any).showDirectoryPicker({ id: 'filmlab-in', mode: 'read' });
    const files: File[] = [];
    await walk(dir, files);
    return { files: files.sort(byName), dir, name: dir.name };
  } catch (e) {
    if ((e as Error).name === 'AbortError') return null;
    throw e;
  }
}

export function pickFiles(folder = false): Promise<Picked | null> {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.multiple = true;
    inp.accept = 'image/*,video/*,.heic,.heif,.mov';
    if (folder) (inp as any).webkitdirectory = true;
    inp.onchange = () => {
      const files = [...(inp.files || [])].filter(kindOf).sort(byName);
      const rel = (files[0] as any)?.webkitRelativePath as string | undefined;
      resolve(files.length ? { files, dir: null, name: rel ? rel.split('/')[0] : files.length === 1 ? files[0].name : `${files.length} files` } : null);
    };
    inp.addEventListener('cancel', () => resolve(null));
    inp.click();
  });
}

/** Files and folders dropped onto the window. */
export async function fromDrop(dt: DataTransfer): Promise<Picked | null> {
  const files: File[] = [];
  let name = '';
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean) as FileSystemEntry[];
  const read = (e: FileSystemEntry, depth: number): Promise<void> =>
    new Promise((res) => {
      if (e.isFile) (e as FileSystemFileEntry).file((f) => { if (kindOf(f)) files.push(f); res(); }, () => res());
      else if (depth < 3) {
        const r = (e as FileSystemDirectoryEntry).createReader();
        const all: FileSystemEntry[] = [];
        const next = () => r.readEntries(async (batch) => {
          if (batch.length) { all.push(...batch); next(); return; }
          for (const c of all) await read(c, depth + 1);
          res();
        }, () => res());
        next();
      } else res();
    });
  if (entries.length) {
    if (entries.length === 1 && entries[0].isDirectory) name = entries[0].name;
    for (const e of entries) await read(e, 0);
  } else files.push(...[...dt.files].filter(kindOf));
  files.sort(byName);
  return files.length ? { files, dir: null, name: name || `${files.length} files` } : null;
}
