// Kept copies of picked media for browsers that give no file handle (iOS,
// Android, Safari, Firefox). Without a handle a project can't reopen a file
// once the page closes, so the bytes are copied into the origin-private file
// system (OPFS — on the device, never uploaded). Copies are keyed by
// name/size/mtime and shared between projects; prune drops the ones no
// project lists in its payload's `originals`.
import { listProjects, loadProject } from '../projects';

const DIR = 'originals';
const keyOf = (f: File) => `${f.name}__${f.size}__${f.lastModified}`.replace(/[^\w.-]/g, '_');

async function dir(create = true): Promise<FileSystemDirectoryHandle | null> {
  try {
    if (!navigator.storage?.getDirectory) return null;
    return await (await navigator.storage.getDirectory()).getDirectoryHandle(DIR, { create });
  } catch { return null; }
}

const busy = new Map<string, Promise<string | null>>();
let persisted = false;

/** Copies `f` into OPFS; resolves to its key, or null when this browser can't. */
export function keepOriginal(f: File): Promise<string | null> {
  const key = keyOf(f);
  let p = busy.get(key);
  if (!p) {
    p = (async () => {
      const d = await dir(); if (!d) return null;
      try {
        const old = await d.getFileHandle(key).then((h) => h.getFile()).catch(() => null);
        if (old && old.size === f.size) return key;
        const h = await d.getFileHandle(key, { create: true });
        if (!('createWritable' in h)) { await d.removeEntry(key).catch(() => {}); return null; }
        if (!persisted) { persisted = true; navigator.storage.persist?.().catch(() => {}); }
        const w = await h.createWritable();
        try { await w.write(f); await w.close(); }
        catch (e) { await w.abort().catch(() => {}); await d.removeEntry(key).catch(() => {}); throw e; }
        return key;
      } catch { return null; }   // quota full or unsupported: the file just isn't kept
    })().finally(() => busy.delete(key));
    busy.set(key, p);
  }
  return p;
}

/** The kept copy, named like the original, or null. */
export async function loadOriginal(key: string, name: string): Promise<File | null> {
  const d = await dir(false); if (!d) return null;
  try {
    const f = await (await d.getFileHandle(key)).getFile();
    return new File([f], name, { type: f.type || typeFor(name), lastModified: f.lastModified });
  } catch { return null; }
}

const TYPES: Record<string, string> = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic', webp: 'image/webp', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav' };
const typeFor = (name: string) => TYPES[name.split('.').pop()?.toLowerCase() || ''] || '';

/** Deletes copies no project references. Copies younger than a day are kept:
 *  a workspace in another tab may not have saved its project yet. */
export async function pruneOriginals(): Promise<void> {
  const d = await dir(false); if (!d) return;
  try {
    const keep = new Set<string>();
    for (const p of await listProjects()) {
      const data = await loadProject<{ originals?: string[] }>(p.id).catch(() => undefined);
      for (const k of data?.originals ?? []) keep.add(k);
    }
    const old = Date.now() - 86_400_000;
    for await (const [name, h] of (d as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
      if (keep.has(name) || h.kind !== 'file') continue;
      const f = await (h as FileSystemFileHandle).getFile();
      if (f.lastModified < old) await d.removeEntry(name).catch(() => {});
    }
  } catch { /* best effort */ }
}
