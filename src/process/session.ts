import type { Item, Kind } from './model';
import { openInDir, originOf } from './media';
import { S, type Tab } from './state';
import * as store from './store';

/** What is needed to rebuild the media list after a restart, app update or force close. Files from a
 *  picked folder are re-opened through the folder handle; files picked one by one are copied into
 *  IndexedDB, because the browser forgets them otherwise. */
interface SavedItem { key: string; name: string; kind: Kind; src: { t: 'idb' } | { t: 'dir'; d: number; path: string } }
export interface Session { items: SavedItem[]; dirs: FileSystemDirectoryHandle[]; cur: number; folderName: string; scope: 'all' | 'item'; tab: Tab }

const copied = new Set<string>();
let quotaWarned = false;

function snapshot(): Session {
  const dirs: FileSystemDirectoryHandle[] = [];
  const items: SavedItem[] = S.items.map((it) => {
    const o = originOf(it.file);
    if (o) {
      let d = dirs.indexOf(o.dir);
      if (d < 0) d = dirs.push(o.dir) - 1;
      return { key: it.key, name: it.name, kind: it.kind, src: { t: 'dir', d, path: o.path } };
    }
    return { key: it.key, name: it.name, kind: it.kind, src: { t: 'idb' } };
  });
  return { items, dirs, cur: S.cur, folderName: S.folderName, scope: S.scope, tab: S.tab };
}

export const saveSession = () => store.setLater('session', snapshot, 300);

/** Copies files that have no folder to come back to into IndexedDB (in the background). */
export async function keepFiles(items: Item[], onQuota: () => void) {
  try { await navigator.storage?.persist?.(); } catch { /* not supported */ }
  for (const it of items) {
    if (copied.has(it.key) || originOf(it.file) || it.status === 'error') continue;
    try {
      await store.putFile(it.key, it.file);
      copied.add(it.key);
    } catch {
      if (!quotaWarned) { quotaWarned = true; onQuota(); }
      return;
    }
  }
  saveSession();
}

/** Removes stored copies that are no longer part of the session. */
export async function pruneFiles() {
  const keep = new Set(S.items.map((i) => i.key));
  const gone = (await store.fileKeys()).filter((k) => !keep.has(k));
  if (gone.length) await store.deleteFiles(gone);
  gone.forEach((k) => copied.delete(k));
}

export const loadSession = () => store.get<Session>('session');

/** Folders whose read permission must be re-granted with a tap before the session can be restored. */
export async function lockedDirs(s: Session): Promise<FileSystemDirectoryHandle[]> {
  const out: FileSystemDirectoryHandle[] = [];
  for (const d of s.dirs) {
    try { if ((await (d as any).queryPermission({ mode: 'read' })) !== 'granted') out.push(d); } catch { out.push(d); }
  }
  return out;
}
export async function unlock(dirs: FileSystemDirectoryHandle[]) {
  for (const d of dirs) { try { await (d as any).requestPermission({ mode: 'read' }); } catch { /* denied */ } }
}

/** Re-opens every file of a saved session. Missing files come back as error items. */
export async function reopen(s: Session): Promise<{ key: string; name: string; kind: Kind; file: File | null }[]> {
  return Promise.all(s.items.map(async (x) => {
    let file: File | null = null;
    try {
      if (x.src.t === 'idb') { file = (await store.getFile(x.key)) ?? null; if (file) copied.add(x.key); }
      else file = await openInDir(s.dirs[x.src.d], x.src.path);
    } catch { file = null; }
    return { key: x.key, name: x.name, kind: x.kind, file };
  }));
}
