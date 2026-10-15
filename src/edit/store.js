// Persistence: projects in the shared Halide registry, workspace settings in
// this page's IndexedDB, proxy blobs in OPFS.
// Survives reload and works on Android (no File System Access needed) — the
// project reopens fully playable/gradeable/exportable from cached proxies;
// originals are only needed to re-link for full-res export. Originals picked
// without a file handle (phones, Safari) are kept as copies in OPFS too.

import * as P from '../shared/projects.ts';
import { keepOriginal } from '../shared/media/originals.ts';

const DB_NAME = 'halide-edit';
const STORE = 'kv';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, val) {
  const db = await openDB();
  return new Promise((res, rej) => { const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).put(val, key); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
}
async function idbGet(key) {
  const db = await openDB();
  return new Promise((res, rej) => { const tx = db.transaction(STORE, 'readonly'); const r = tx.objectStore(STORE).get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}

// ---- projects ----
// The registry is shared with Process (src/shared/projects.ts): the launcher
// lists, opens, renames and deletes projects; this page edits the one in its
// URL (?p=<id>). Without one it is a fresh session that becomes an "Untitled"
// project on its first real change.
let currentId = P.projectFromUrl();
let restoring = false;
export function setRestoring(v) { restoring = v; }

function serialize(state) {
  const media = state.media.map((m) => ({
    id: m.id, name: m.name, size: m.file?.size || m.size || 0, path: m.path || '',
    width: m.width, height: m.height, duration: m.duration, thumb: m.thumb,
    strip: m.strip || null,
    kind: m.kind || 'video',   // 'audio' = music import: no picture, no proxy
    rawIso: m.rawIso || 0, rawShutter: m.rawShutter || 0,
    inputTransform: m.inputTransform || null,
    proxyKey: m.proxyKey || null, proxyW: m.proxyW, proxyH: m.proxyH,
    // FileSystemFileHandle is structured-clonable → survives in IndexedDB, so
    // restarts can re-acquire the original and resume proxy builds
    handle: m.handle || null,
    original: m.original || null,   // kept copy (no handle to reopen it with)
  }));
  const grades = {};
  for (const [k, g] of Object.entries(state.grades)) grades[k] = { ...g, lut: null };
  const originals = media.flatMap((x) => (x.original ? [x.original] : []));
  return { v: 2, media, originals, tracks: state.tracks, grades, fps: state.fps, markers: state.markers || [], masterVolume: state.masterVolume ?? 1, project: state.project || { format: '16:9', height: 1080 }, saved: true };
}

function clipCount(state) {
  let n = 0; for (const tr of [...(state.tracks?.video || []), ...(state.tracks?.audio || [])]) n += tr.clips.length;
  return n;
}

/** The project this page was opened with, or null (missing → fresh session). */
export async function loadCurrentProject() {
  if (!currentId) return null;
  const data = await P.loadProject(currentId).catch(() => undefined);
  if (!data) { currentId = null; P.setUrlProject(null); return null; }
  return data;
}

export async function saveProject(state) {
  if (restoring) return;   // never write a half-restored project back
  if (!currentId) {
    if (!state.media.length && !clipCount(state)) return;   // nothing to keep yet
    currentId = await P.createProject('edit', 'Untitled');
    P.setUrlProject(currentId);
  }
  keepCopies(state);
  const payload = serialize(state);
  const card = { count: clipCount(state), thumb: state.media.find((m) => m.thumb)?.thumb || null };
  try { await P.saveProject(currentId, payload, card); }
  catch {
    // a browser that can't clone handles must still save the project
    for (const m of payload.media) m.handle = null;
    await P.saveProject(currentId, payload, card);
  }
}

// no handle to reopen an original with: keep a copy, then save again
const copying = new WeakSet();
function keepCopies(state) {
  for (const m of state.media) {
    const f = m.file;
    if (!f || !f.size || m.handle || m.original || copying.has(f)) continue;
    copying.add(f);
    keepOriginal(f).then((k) => { if (k && m.file === f) { m.original = k; saveProject(state).catch(() => {}); } });
  }
}

// generic kv access for app-level persistence (user LUTs, grade presets, …)
export const kvGet = (k) => idbGet(k);
export const kvSet = (k, v) => idbSet(k, v);

// ---- OPFS proxy cache ----
// Bumped when the proxy FORMAT changes so old cached files must not be reused.
// g2 added the audio track: before it every proxy was silent, and since playback
// prefers the proxy over the source, so was the timeline. Stale generations are
// simply never looked up again — Media ▸ clear cache reclaims the space.
export const PROXY_GEN = 'g2';
export function proxyKey(file, proxyH) { return `${(file?.name || 'clip').replace(/[^\w.-]/g, '_')}__${file?.size || 0}__${proxyH}${PROXY_GEN}.mp4`; }
export const isCurrentProxyKey = (k) => typeof k === 'string' && k.endsWith(`${PROXY_GEN}.mp4`);

async function opfsDir() {
  if (!navigator.storage?.getDirectory) return null;
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('proxies', { create: true });
}
export async function saveProxy(key, blob) {
  try {
    const dir = await opfsDir(); if (!dir) return false;
    const fh = await dir.getFileHandle(key, { create: true });
    const w = await fh.createWritable(); await w.write(blob); await w.close();
    return true;
  } catch { return false; }
}
export async function loadProxy(key) {
  try {
    const dir = await opfsDir(); if (!dir) return null;
    const fh = await dir.getFileHandle(key, { create: false });
    return await fh.getFile();
  } catch { return null; }
}
export async function proxyBytes() {
  try {
    const dir = await opfsDir(); if (!dir) return 0;
    let n = 0; for await (const [, h] of dir.entries()) { const f = await h.getFile(); n += f.size; }
    return n;
  } catch { return 0; }
}
// wipe the OPFS proxy cache (loaded proxies keep working this session;
// anything else re-transcodes on demand)
export async function clearProxies() {
  try {
    if (!navigator.storage?.getDirectory) return false;
    const root = await navigator.storage.getDirectory();
    await root.removeEntry('proxies', { recursive: true });
    return true;
  } catch { return false; }
}
