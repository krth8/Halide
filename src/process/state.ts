import { DEF, MASK_KEYS, NUM, clone, effective, type Item, type Key, type Mask, type Override, type Params } from './model';
import { geometry } from './geo';
import type { CubeLut } from './cube';
import { DEFAULT_EXPORT, type ExportSettings } from './exporter';
import * as store from './store';

export type Tab = 'looks' | 'light' | 'color' | 'curves' | 'fx' | 'crop' | 'trim';
export interface UserLook { id: string; name: string; params: Params }
interface Saved { override: Override; trim: Item['trim']; masks?: Item['masks']; motion?: Item['motion'] }

export const S = {
  items: [] as Item[],
  cur: 0,
  G: clone(DEF) as Params,
  scope: 'all' as 'all' | 'item',
  tab: 'looks' as Tab,
  luts: [] as CubeLut[],
  looks: [] as UserLook[],
  edits: {} as Record<string, Saved>,
  exportSettings: { ...DEFAULT_EXPORT } as ExportSettings,
  folderName: '',
  importDir: null as FileSystemDirectoryHandle | null,
  showBefore: false,
  sheetOpen: false,
  /** Masks UI: whether the mask bar is open, and which mask the tools edit (null = the item itself). */
  masksOpen: false,
  maskId: null as string | null,
};

/* ---------- events ---------- */
type Ev = 'params' | 'select' | 'items' | 'ui' | 'trim';
const L: Record<Ev, Set<() => void>> = { params: new Set(), select: new Set(), items: new Set(), ui: new Set(), trim: new Set() };
export const on = (e: Ev, fn: () => void) => L[e].add(fn);
export const emit = (e: Ev) => L[e].forEach((f) => f());

/* ---------- params ---------- */
export const curItem = (): Item | undefined => S.items[S.cur];
export const paramsFor = (it: Item): Params => effective(S.G, it.override);

/** Value shown in the panel: the global value in "all" scope, the item's effective value otherwise. */
/** The mask the tools are editing, if any. */
export function curMask(): Mask | null {
  const it = curItem();
  return S.scope === 'item' && S.masksOpen && S.maskId && it ? it.masks.find((m) => m.id === S.maskId) ?? null : null;
}
export const maskKey = (k: Key) => MASK_KEYS.includes(k);

export function getV<K extends Key>(k: K): Params[K] {
  const it = curItem();
  const m = curMask();
  if (m && maskKey(k)) return (m.adj[k] ?? 0) as Params[K];
  return S.scope === 'item' && it ? paramsFor(it)[k] : S.G[k];
}

export function setV<K extends Key>(k: K, v: Params[K]) {
  const it = curItem();
  const m = curMask();
  if (m && it && maskKey(k)) {
    if (v) m.adj[k] = v as number; else delete m.adj[k];
    remember(it);
  } else if (S.scope === 'item' && it) {
    if (NUM[k]) {
      const d = +((v as number) - (S.G[k] as number)).toFixed(3);
      if (d) it.override[k] = d; else delete it.override[k];
    } else it.override[k] = clone(v);
    remember(it);
  } else S.G[k] = clone(v);
  changed();
}

export function resetKey(k: Key) {
  const it = curItem();
  const m = curMask();
  if (m && it && maskKey(k)) { delete m.adj[k]; remember(it); }
  else if (S.scope === 'item' && it) { delete it.override[k]; remember(it); } else S.G[k] = clone(DEF[k]) as never;
  changed();
}

export function overrideCount(k: Key) { return S.items.filter((it) => k in it.override).length; }

export function changed() {
  emit('params');
  store.setLater('global', () => S.G);
}

export function remember(it: Item) {
  S.edits[it.key] = { override: it.override, trim: it.trim, masks: it.masks, motion: it.motion };
  store.setLater('edits', () => S.edits);
}

export const lutById = (id: string | null) => (id ? S.luts.find((l) => l.id === id) ?? null : null);

/* ---------- selection ---------- */
export function select(i: number) {
  if (!S.items.length) return;
  S.cur = (i + S.items.length) % S.items.length;
  S.showBefore = false;
  S.maskId = null;
  emit('select');
}

/* ---------- persistence ---------- */
export async function restore() {
  const [g, edits, looks, luts, ex] = await Promise.all([
    store.get<Params>('global'), store.get<Record<string, Saved>>('edits'), store.get<UserLook[]>('looks'),
    store.get<CubeLut[]>('luts'), store.get<ExportSettings>('export'),
  ]);
  if (g) S.G = { ...clone(DEF), ...g };
  if (edits) S.edits = edits;
  if (looks) S.looks = looks.map((l) => ({ ...l, params: { ...clone(DEF), ...l.params } }));
  if (luts) S.luts = luts;
  if (ex) S.exportSettings = { ...DEFAULT_EXPORT, ...ex, name: (ex.name ?? DEFAULT_EXPORT.name).replace(/\{navn\}/g, '{name}') };
}
export const saveLooks = () => store.set('looks', S.looks);
export const saveLuts = () => store.set('luts', S.luts);
export const saveExport = () => store.set('export', S.exportSettings);

/** Output size (in source pixels) after crop and rotation. */
export function outDims(it: Item, P: Params = paramsFor(it)): [number, number] {
  const g = geometry(it.width || 1, it.height || 1, P);
  return [g.w, g.h];
}
