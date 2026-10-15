/** Tiny IndexedDB key/value store. Everything is best-effort: the app works without it. */
let dbp: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open('halide-process', 2);
    r.onupgradeneeded = () => {
      const names = r.result.objectStoreNames;
      if (!names.contains('kv')) r.result.createObjectStore('kv');
      if (!names.contains('files')) r.result.createObjectStore('files');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}

export async function get<T>(key: string): Promise<T | undefined> {
  try {
    const d = await db();
    return await new Promise((res, rej) => {
      const r = d.transaction('kv').objectStore('kv').get(key);
      r.onsuccess = () => res(r.result as T);
      r.onerror = () => rej(r.error);
    });
  } catch { return undefined; }
}

export async function set(key: string, val: unknown): Promise<void> {
  try {
    const d = await db();
    await new Promise<void>((res, rej) => {
      const t = d.transaction('kv', 'readwrite');
      t.objectStore('kv').put(val, key);
      t.oncomplete = () => res();
      t.onerror = () => rej(t.error);
    });
  } catch { /* storage unavailable */ }
}

const timers: Record<string, number> = {};
const pending: Record<string, () => unknown> = {};
export function setLater(key: string, val: () => unknown, ms = 400) {
  clearTimeout(timers[key]);
  pending[key] = val;
  timers[key] = window.setTimeout(() => { delete pending[key]; set(key, val()); }, ms);
}
/** Writes everything still waiting in setLater right away (app going to background or closing). */
export function flush() {
  for (const [k, fn] of Object.entries(pending)) { clearTimeout(timers[k]); delete pending[k]; set(k, fn()); }
}

/* ---------- media copies (files picked without folder access) ---------- */
async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction('files', mode);
    const r = fn(t.objectStore('files'));
    t.oncomplete = () => res(r ? r.result : undefined);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}
export const putFile = (key: string, f: File) => tx('readwrite', (s) => { s.put(f, key); });
export const getFile = (key: string) => tx<File>('readonly', (s) => s.get(key)).catch(() => undefined);
export const fileKeys = () => tx<IDBValidKey[]>('readonly', (s) => s.getAllKeys()).then((k) => (k ?? []).map(String)).catch(() => [] as string[]);
export const deleteFiles = (keys: string[]) => tx('readwrite', (s) => { for (const k of keys) s.delete(k); }).catch(() => {});
