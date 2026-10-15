// Media library: folders the user gave Halide access to once (DCIM, Movies,
// a folder import). A file picked on its own that lives inside one is saved
// as folder + path, so reopening a project takes one grant per folder rather
// than one per file — Android asks again every session, since it keeps no
// file permissions yet, and a page may only prompt once per tap. Nothing is
// copied: the folders are only read.
import { getShared, putShared } from '../projects';
import { confirmDialog } from '../dialog';

export interface LibRef { lib: string; path: string }
interface Root { id: string; dir: FileSystemDirectoryHandle }

export const hasLibrary = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

let roots: Root[] = [];
const ready: Promise<void> = hasLibrary
  ? getShared<Root[]>('libraryRoots').then((r) => { roots = r ?? []; }).catch(() => {})
  : Promise.resolve();
const store = () => putShared('libraryRoots', roots).catch(() => {});

/** Adds a folder the user picked (once — the same folder isn't added twice). */
export async function addRoot(dir: FileSystemDirectoryHandle): Promise<Root> {
  await ready;
  for (const r of roots) if (await r.dir.isSameEntry(dir).catch(() => false)) return r;
  const r = { id: 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), dir };
  roots.push(r);
  await store();
  return r;
}

async function granted(r: Root, ask: boolean): Promise<boolean> {
  try {
    let p = await (r.dir as any).queryPermission({ mode: 'read' });
    if (p !== 'granted' && ask) p = await (r.dir as any).requestPermission({ mode: 'read' });
    return p === 'granted';
  } catch { return false; }
}

/* file names per folder, so a file picked without a usable handle can still be found */
const index = new Map<string, { at: number; names: Promise<Map<string, string[]>> }>();
async function walk(dir: FileSystemDirectoryHandle, prefix: string, out: Map<string, string[]>, depth: number) {
  for await (const [name, h] of (dir as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
    if (name.startsWith('.')) continue;
    if (h.kind === 'file') { const a = out.get(name); if (a) a.push(prefix + name); else out.set(name, [prefix + name]); }
    else if (depth < 4) await walk(h as FileSystemDirectoryHandle, prefix + name + '/', out, depth + 1);
  }
}
function names(r: Root, fresh: boolean): Promise<Map<string, string[]>> {
  const hit = index.get(r.id);
  if (hit && !(fresh && Date.now() - hit.at > 10_000)) return hit.names;
  const p = (async () => { const m = new Map<string, string[]>(); await walk(r.dir, '', m, 0); return m; })();
  index.set(r.id, { at: Date.now(), names: p });
  p.catch(() => index.delete(r.id));
  return p;
}

async function open(r: Root, path: string): Promise<File> {
  const parts = path.split('/');
  let d = r.dir;
  for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p);
  return (await d.getFileHandle(parts[parts.length - 1])).getFile();
}

/** Where `file` lives inside a library folder this session can read, or null. */
export async function place(file: File, handle?: FileSystemFileHandle | null): Promise<LibRef | null> {
  await ready;
  for (const r of roots) {
    if (!(await granted(r, false))) continue;
    if (handle) {
      try { const parts = await r.dir.resolve(handle); if (parts?.length) return { lib: r.id, path: parts.join('/') }; } catch { /* other provider */ }
    }
    // no handle, or one the folder can't resolve (Android hands out different
    // URIs for the same file): find it by name, confirmed by size
    for (const fresh of [false, true]) {
      try {
        for (const path of (await names(r, fresh)).get(file.name) ?? []) {
          if ((await open(r, path)).size === file.size) return { lib: r.id, path };
        }
      } catch { /* unreadable folder */ }
    }
  }
  return null;
}

/** Makes the folders these refs live in readable; returns the ids that are.
 *  With `ask` (inside a tap) it prompts — one Allow per folder. */
export async function grantFor(refs: LibRef[], ask: boolean): Promise<Set<string>> {
  await ready;
  const ok = new Set<string>();
  for (const id of new Set(refs.map((x) => x.lib))) {
    const r = roots.find((x) => x.id === id);
    if (r && await granted(r, ask)) ok.add(id);
  }
  return ok;
}

export async function openRef(ref: LibRef): Promise<File | null> {
  await ready;
  const r = roots.find((x) => x.id === ref.lib);
  if (!r) return null;
  try { return await open(r, ref.path); } catch { return null; }
}

/** Offers to add a library folder after an import whose files aren't in one.
 *  Touch devices only (desktop Chrome restores file permissions itself), and
 *  once per session. Resolves true when a folder was added. */
let offered = false;
export async function offerLibrary(): Promise<boolean> {
  if (!hasLibrary || offered || !matchMedia('(pointer: coarse)').matches) return false;
  offered = true;
  const yes = await confirmDialog({
    title: 'Reopen projects with one tap?',
    body: 'Give Halide access to the folder your photos and videos are in (for example DCIM or Movies). Projects then reconnect with a single Allow instead of one per file. Nothing is copied or uploaded.',
    ok: 'Choose folder',
  });
  if (!yes) return false;
  try {
    const dir = await (window as any).showDirectoryPicker({ id: 'halide-lib', mode: 'read', startIn: 'pictures' });
    await addRoot(dir);
    return true;
  } catch { return false; }
}
