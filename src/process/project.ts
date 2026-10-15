// Process projects. A project stores where its media lives — never the media:
// a folder handle + relative path for folder imports, a file handle for files
// picked or dropped one by one (File System Access), or just the name/size
// where the browser gives no handle (Safari, Firefox). Each item's thumbnail
// is written once as a project asset, so a large library reopens instantly,
// before any file is read; files reconnect when access is (re)granted.
import { DEF, clone, type Item, type Kind, type Params } from './model';
import { adoptHandle, fileKey, handleOf, openInDir, originOf, type Picked } from './media';
import { S, type Saved, type Tab } from './state';
import * as P from '../shared/projects';

type Ref = { t: 'dir'; d: number; path: string } | { t: 'file'; h: FileSystemFileHandle } | { t: 'none' };
interface SavedItem { key: string; name: string; kind: Kind; ref: Ref; w: number; h: number; dur: number; lum: number }
interface Payload {
  v: 1; items: SavedItem[]; dirs: FileSystemDirectoryHandle[];
  G: Params; edits: Record<string, Saved>;
  cur: number; scope: 'all' | 'item'; tab: Tab; folderName: string;
}

let projectId: string | null = P.projectFromUrl();
let restoring = false;
/** where each restored-but-offline item can be reopened from */
const pending = new Map<Item, Ref>();
let pendingDirs: FileSystemDirectoryHandle[] = [];
/** items whose thumbnail is already stored as a project asset */
const thumbSaved = new WeakSet<Item>();

const blobToDataURL = (b: Blob) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result as string); r.onerror = () => rej(r.error); r.readAsDataURL(b); });
async function jpeg(bm: ImageBitmap, q = 0.75): Promise<Blob> {
  const c = new OffscreenCanvas(bm.width, bm.height);
  c.getContext('2d')!.drawImage(bm, 0, 0);
  return c.convertToBlob({ type: 'image/jpeg', quality: q });
}

function refOf(it: Item, dirs: FileSystemDirectoryHandle[]): Ref {
  const p = pending.get(it);
  if (p) return p.t === 'dir' ? { ...p, d: dirs.indexOf(pendingDirs[p.d]) } : p;   // not reconnected yet: keep its old ref
  const o = originOf(it.file);
  if (o) { let d = dirs.indexOf(o.dir); if (d < 0) d = dirs.push(o.dir) - 1; return { t: 'dir', d, path: o.path }; }
  const h = handleOf(it.file);
  return h ? { t: 'file', h } : { t: 'none' };
}

function snapshot(): Payload {
  const dirs: FileSystemDirectoryHandle[] = [];
  for (const it of pending.keys()) { const p = pending.get(it)!; if (p.t === 'dir' && !dirs.includes(pendingDirs[p.d])) dirs.push(pendingDirs[p.d]); }
  const items = S.items.map((it) => ({
    key: it.key, name: it.name, kind: it.kind, ref: refOf(it, dirs),
    w: it.width, h: it.height, dur: it.duration, lum: it.lum,
  }));
  return { v: 1, items, dirs, G: S.G, edits: S.edits, cur: S.cur, scope: S.scope, tab: S.tab, folderName: S.folderName };
}

/* ---------- saving ---------- */
let timer = 0;
let saving: Promise<void> | null = null, again = false;

export function saveSoon(ms = 600): void {
  clearTimeout(timer);
  timer = window.setTimeout(() => { saveNow(); }, ms);
}

export async function saveNow(): Promise<void> {
  clearTimeout(timer);
  if (restoring) return;
  if (!projectId && !S.items.length) return;          // an empty new session isn't a project yet
  if (saving) { again = true; return saving; }
  saving = (async () => {
    if (!projectId) { projectId = await P.createProject('process', S.folderName || 'Untitled'); P.setUrlProject(projectId); }
    const id = projectId;
    // thumbnails: once per item, as project assets
    for (const it of S.items) {
      if (thumbSaved.has(it) || !it.thumb) continue;
      try { await P.putAsset(id, 'thumb:' + it.key, await jpeg(it.thumb)); thumbSaved.add(it); } catch { /* best effort */ }
    }
    const payload = snapshot();
    const first = S.items.find((i) => i.thumb);
    const card = { count: S.items.length, thumb: first?.thumb ? await blobToDataURL(await jpeg(first.thumb, 0.6)) : null };
    try { await P.saveProject(id, payload, card); }
    catch {
      // a browser that can't store handles still keeps the project (name/size refs)
      payload.items.forEach((x) => { x.ref = { t: 'none' }; });
      payload.dirs = [];
      await P.saveProject(id, payload, card).catch(() => {});
    }
  })().finally(() => { saving = null; if (again) { again = false; saveSoon(); } });
  return saving;
}

/** Thumbnails of removed items go with them. */
export function pruneThumbs(): void {
  if (projectId) P.pruneAssets(projectId, new Set(S.items.map((i) => 'thumb:' + i.key))).catch(() => {});
}

/* ---------- opening ---------- */
export const hasProject = () => projectId != null;

/** Loads the project in the URL. Items come back 'offline' with their saved
 *  thumbnails; call connect() to reopen the files. */
export async function openProject(makeItem: (key: string, name: string, kind: Kind, file: File) => Item): Promise<boolean> {
  if (!projectId) return false;
  const data = await P.loadProject<Payload>(projectId).catch(() => undefined);
  if (!data) { projectId = null; P.setUrlProject(null); return false; }
  restoring = true;
  try {
    S.G = { ...clone(DEF), ...data.G };
    S.edits = data.edits ?? {};
    S.folderName = data.folderName ?? '';
    S.scope = data.scope ?? 'all';
    S.tab = data.tab ?? 'looks';
    pendingDirs = data.dirs ?? [];
    pending.clear();
    S.items = await Promise.all(data.items.map(async (x) => {
      const it = makeItem(x.key, x.name, x.kind, new File([], x.name));
      it.width = x.w; it.height = x.h; it.duration = x.dur; it.lum = x.lum;
      const blob = await P.getAsset<Blob>(projectId!, 'thumb:' + x.key).catch(() => undefined);
      if (blob) { try { it.thumb = await createImageBitmap(blob); thumbSaved.add(it); } catch { /* re-made on connect */ } }
      it.status = 'offline';
      pending.set(it, x.ref);
      return it;
    }));
    S.cur = Math.min(Math.max(0, data.cur ?? 0), Math.max(0, S.items.length - 1));
  } finally { restoring = false; }
  return true;
}

export const offlineCount = () => pending.size;
/** Whether any offline item has a stored handle — without one (phones,
 *  Safari, Firefox) the only way back is picking the files again. */
export const canConnect = () => [...pending.values()].some((r) => r.t !== 'none');

async function permitted(h: FileSystemHandle, ask: boolean): Promise<boolean> {
  try {
    let p = await (h as any).queryPermission({ mode: 'read' });
    if (p !== 'granted' && ask) p = await (h as any).requestPermission({ mode: 'read' });
    return p === 'granted';
  } catch { return false; }
}

function attach(it: Item, f: File): void {
  pending.delete(it);
  it.file = f;
  // thumbnail and size already known: ready at once, no decode; otherwise load it
  it.status = it.thumb && it.width ? 'ready' : 'loading';
  it.error = undefined;
}

/** Reopens offline items whose access is granted. `ask` (needs a user
 *  gesture) prompts for folders/files that aren't — folders first, since one
 *  folder grant covers all its files. Returns the items that came online. */
export async function connect(ask: boolean): Promise<Item[]> {
  const back: Item[] = [];
  const dirOk = await Promise.all(pendingDirs.map((d) => permitted(d, false)));
  if (ask) for (let i = 0; i < pendingDirs.length; i++) if (!dirOk[i]) dirOk[i] = await permitted(pendingDirs[i], true);
  for (const [it, ref] of [...pending]) {
    try {
      if (ref.t === 'dir' && dirOk[ref.d]) { attach(it, await openInDir(pendingDirs[ref.d], ref.path)); back.push(it); }
      else if (ref.t === 'file' && await permitted(ref.h, ask)) {
        const f = await ref.h.getFile(); adoptHandle(f, ref.h); attach(it, f); back.push(it);
      }
    } catch { /* moved or deleted: stays offline until located */ }
  }
  return back;
}

/** Matches offline items against freshly picked files (a folder or a
 *  selection): same name and size first, then same name, then the same name
 *  without extension (a phone picker may hand a photo back converted). */
export function locate(p: Picked): Item[] {
  const stem = (n: string) => n.replace(/\.[^.]+$/, '').toLowerCase();
  const byKey = new Map(p.files.map((f) => [fileKey(f), f]));
  const byNameSize = new Map(p.files.map((f) => [f.name + '|' + f.size, f]));
  const byNameOnly = new Map(p.files.map((f) => [f.name, f]));
  const byStem = new Map(p.files.map((f) => [stem(f.name), f]));
  const used = new Set<File>();
  const back: Item[] = [];
  for (const it of [...pending.keys()]) {
    const size = it.key.split('|')[1];
    const f = [byKey.get(it.key), byNameSize.get(it.name + '|' + size), byNameOnly.get(it.name), byStem.get(stem(it.name))].find((x) => x && !used.has(x));
    if (f) { used.add(f); attach(it, f); back.push(it); }
  }
  return back;
}

