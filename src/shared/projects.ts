// Project registry shared by Process and Edit. One IndexedDB database holds
// every project of both workspaces: a small metadata record per project (what
// the launcher lists) and the workspace's own payload (opaque here).
//
// Payloads hold references to media, never the media itself — folder and file
// handles (structured-clonable, a few bytes each) plus thumbnails — so a
// library of thousands of photos costs kilobytes, not gigabytes.

export type Workspace = 'process' | 'edit';

export interface ProjectMeta {
  id: string;
  ws: Workspace;
  name: string;
  created: number;
  modified: number;
  /** items (Process) or clips (Edit) — shown on the launcher card */
  count: number;
  /** small JPEG data URL */
  thumb: string | null;
}

const DB = 'halide';
let dbp: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('meta', { keyPath: 'id' });
      r.result.createObjectStore('data');
      // per-project side records written once and read lazily (thumbnails):
      // keyed "<projectId>/<name>", so the payload autosave stays small
      r.result.createObjectStore('assets');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}

function run<T>(stores: string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => IDBRequest<T> | void): Promise<T> {
  return db().then((d) => new Promise<T>((res, rej) => {
    const t = d.transaction(stores, mode);
    const r = fn(t);
    t.oncomplete = () => res((r ? r.result : undefined) as T);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  }));
}

const newId = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

export async function listProjects(ws?: Workspace): Promise<ProjectMeta[]> {
  const all = await run<ProjectMeta[]>(['meta'], 'readonly', (t) => t.objectStore('meta').getAll());
  return (all || []).filter((p) => !ws || p.ws === ws).sort((a, b) => b.modified - a.modified);
}

export const getMeta = (id: string) => run<ProjectMeta | undefined>(['meta'], 'readonly', (t) => t.objectStore('meta').get(id));
export const loadProject = <T = unknown>(id: string) => run<T | undefined>(['data'], 'readonly', (t) => t.objectStore('data').get(id));

export async function createProject(ws: Workspace, name = 'Untitled', payload: unknown = null): Promise<string> {
  const id = newId(), now = Date.now();
  const meta: ProjectMeta = { id, ws, name, created: now, modified: now, count: 0, thumb: null };
  await run(['meta', 'data'], 'readwrite', (t) => { t.objectStore('meta').put(meta); t.objectStore('data').put(payload, id); });
  return id;
}

/** Writes a project's payload and refreshes its card. A payload that can't be
 *  cloned (a browser without clonable file handles) throws — callers strip the
 *  handles and retry. */
export async function saveProject(id: string, payload: unknown, card: Partial<Pick<ProjectMeta, 'count' | 'thumb' | 'name'>> = {}): Promise<void> {
  const meta = await getMeta(id);
  if (!meta) throw new Error('project not found');
  Object.assign(meta, card, { modified: Date.now() });
  await run(['meta', 'data'], 'readwrite', (t) => { t.objectStore('meta').put(meta); t.objectStore('data').put(payload, id); });
}

export async function renameProject(id: string, name: string): Promise<void> {
  const meta = await getMeta(id); if (!meta) return;
  meta.name = name; meta.modified = Date.now();
  await run(['meta'], 'readwrite', (t) => { t.objectStore('meta').put(meta); });
}

export async function duplicateProject(id: string): Promise<string | null> {
  const [meta, data] = await Promise.all([getMeta(id), loadProject(id)]);
  if (!meta) return null;
  const nid = newId(), now = Date.now();
  const range = assetRange(id);
  const [keys, vals] = await Promise.all([
    run<IDBValidKey[]>(['assets'], 'readonly', (t) => t.objectStore('assets').getAllKeys(range)),
    run<unknown[]>(['assets'], 'readonly', (t) => t.objectStore('assets').getAll(range)),
  ]);
  await run(['meta', 'data', 'assets'], 'readwrite', (t) => {
    t.objectStore('meta').put({ ...meta, id: nid, name: meta.name + ' copy', created: now, modified: now });
    t.objectStore('data').put(data ?? null, nid);
    keys.forEach((k, i) => t.objectStore('assets').put(vals[i], nid + String(k).slice(id.length)));
  });
  return nid;
}

export const deleteProject = (id: string) =>
  run(['meta', 'data', 'assets'], 'readwrite', (t) => {
    t.objectStore('meta').delete(id); t.objectStore('data').delete(id); t.objectStore('assets').delete(assetRange(id));
  });

/* ---------- assets: per-project side records (thumbnails) ---------- */
const assetRange = (id: string) => IDBKeyRange.bound(id + '/', id + '/￿');
export const putAsset = (id: string, name: string, val: unknown) =>
  run(['assets'], 'readwrite', (t) => { t.objectStore('assets').put(val, `${id}/${name}`); });
export const getAsset = <T = unknown>(id: string, name: string) =>
  run<T | undefined>(['assets'], 'readonly', (t) => t.objectStore('assets').get(`${id}/${name}`));
/** Drops a project's assets whose names aren't in `keep`. */
export async function pruneAssets(id: string, keep: Set<string>): Promise<void> {
  const keys = await run<IDBValidKey[]>(['assets'], 'readonly', (t) => t.objectStore('assets').getAllKeys(assetRange(id)));
  const gone = keys.filter((k) => !keep.has(String(k).slice(id.length + 1)));
  if (gone.length) await run(['assets'], 'readwrite', (t) => { for (const k of gone) t.objectStore('assets').delete(k); });
}

/** URL of a workspace page, optionally opening a project. */
export function workspaceUrl(base: string, ws: Workspace, id?: string): string {
  return `${base}${ws}/${id ? `?p=${encodeURIComponent(id)}` : ''}`;
}

/** The project id a workspace page was opened with (?p=…), if any. */
export const projectFromUrl = (): string | null => new URLSearchParams(location.search).get('p');

/** Records the open project in the URL, so a reload reopens it. */
export function setUrlProject(id: string | null): void {
  const u = new URL(location.href);
  if (id) u.searchParams.set('p', id); else u.searchParams.delete('p');
  history.replaceState(history.state, '', u);
}
