import '../shared/theme.css';
import './styles.css';
import './halide.css';
import { boot } from '../shared/boot';
import { homeLink } from '../shared/brand';
import { I } from './ui/icons';
import { clone, type Item } from './model';
import { canPickDir, fileKey, fromDrop, kindOf, loadItem, pickDirectory, pickFiles, type Picked } from './media';
import { S, emit, on, restore, select } from './state';
import * as store from './store';
import { connect, locate, offlineCount, openProject, pruneThumbs, saveNow, saveSoon } from './project';
import { $, h, isPhone, toast } from './ui/dom';
import { buildReel, refresh, setAddHandler, setRemoveHandler } from './ui/reel';
import { build } from './ui/panel';
import { draw } from './ui/stage';
import { openExport } from './ui/exportSheet';

let nextId = 1;

function makeItem(key: string, name: string, kind: Item['kind'], file: File): Item {
  const saved = S.edits[key];
  return {
    id: nextId++, key, name, file, kind,
    override: saved ? clone(saved.override) : {}, trim: saved?.trim ? { ...saved.trim } : null,
    masks: saved?.masks ? clone(saved.masks) : [], motion: saved?.motion ?? null,
    duration: 0, width: 0, height: 0, preview: null, thumb: null, lum: 0, status: 'loading',
  };
}

/** Reads thumbnails a few at a time (the current item first). */
async function loadAll(items: Item[]) {
  const queue = [...items];
  const cur = S.items[S.cur];
  if (queue.includes(cur)) queue.unshift(...queue.splice(queue.indexOf(cur), 1));
  const worker = async () => {
    for (let it = queue.shift(); it; it = queue.shift()) {
      if (it.status === 'loading') await loadItem(it);
      refresh(it);
      if (it === S.items[S.cur]) emit('items');
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  emit('items');
  updateTop();
  saveSoon();   // stores the new thumbnails with the project
}

async function addFiles(p: Picked) {
  const known = new Set(S.items.map((i) => i.key));
  const fresh: Item[] = [];
  for (const f of p.files) {
    const kind = kindOf(f), key = fileKey(f);
    if (!kind || known.has(key)) continue;
    known.add(key);
    fresh.push(makeItem(key, f.name, kind, f));
  }
  if (!fresh.length) { toast('No new photos or videos found'); return; }
  const first = !S.items.length;
  S.items.push(...fresh);
  if (first) { S.folderName = p.name; S.importDir = p.dir; S.cur = 0; }
  else if (!S.folderName.endsWith('+')) S.folderName += ' +';
  updateTop();
  buildReel();
  select(first ? 0 : S.items.length - fresh.length);
  saveSoon();
  toast(`Added ${fresh.length} ${fresh.length === 1 ? 'file' : 'files'}`);
  await loadAll(fresh);
  const bad = fresh.filter((i) => i.status === 'error').length;
  if (bad) toast(`${bad} ${bad === 1 ? 'file' : 'files'} could not be read`);
}

/* ---------- reconnecting a restored project ---------- */
const relinkBar = $('#relinkBar');
function syncRelink() {
  const n = offlineCount();
  relinkBar.hidden = !n;
  if (n) $('#relinkText').textContent = `${n} ${n === 1 ? 'file is' : 'files are'} not connected`;
}
async function cameOnline(back: Item[]) {
  syncRelink();
  if (!back.length) return;
  back.forEach(refresh);
  emit('items');
  saveSoon();
  await loadAll(back.filter((i) => i.status === 'loading'));
}
$('#relinkBtn').onclick = async () => {
  const back = await connect(true);
  await cameOnline(back);
  if (offlineCount()) toast('Some files could not be reopened — use Locate… to point at their folder');
};
$('#locateBtn').onclick = async () => {
  try {
    const p = canPickDir ? await pickDirectory() : await pickFiles(true);
    if (!p) return;
    const back = locate(p);
    toast(back.length ? `Reconnected ${back.length} ${back.length === 1 ? 'file' : 'files'}` : 'None of the missing files were found there');
    await cameOnline(back);
  } catch (e) { toast((e as Error).message); }
};

function updateTop() {
  const nv = S.items.filter((i) => i.kind === 'video').length;
  $('#folderName').textContent = S.folderName;
  $('#folderMeta').textContent = S.items.length ? `${S.items.length} items · ${nv} videos` : '';
  $('#empty').hidden = S.items.length > 0;
  document.body.classList.toggle('has-items', S.items.length > 0);
}

/* ---------- open menu ---------- */
const canFolderInput = 'webkitdirectory' in document.createElement('input') && !isPhone();
async function openFolder() {
  try {
    const p = canPickDir ? await pickDirectory() : await pickFiles(true);
    if (p) await addFiles(p);
  } catch (e) { toast((e as Error).message); }
}
async function openFiles() {
  const p = await pickFiles();
  if (p) await addFiles(p);
}
function clearAll() {
  S.items = [];
  saveSoon();
  pruneThumbs();
  S.cur = 0;
  S.folderName = '';
  S.importDir = null;
  buildReel();
  updateTop();
  emit('select');
}

const menu = $('#openMenu');
function showMenu(anchor: HTMLElement) {
  menu.replaceChildren();
  if (canPickDir || canFolderInput) menu.append(h('button', { onclick: () => { hideMenu(); openFolder(); } }, 'Open folder…'));
  menu.append(h('button', { onclick: () => { hideMenu(); openFiles(); } }, 'Choose photos and videos…'));
  if (S.items.length) menu.append(h('button', { class: 'danger', onclick: () => { hideMenu(); clearAll(); } }, 'Close all'));
  const r = anchor.getBoundingClientRect();
  menu.style.top = r.bottom + 6 + 'px';
  menu.style.right = Math.max(16, innerWidth - r.right) + 'px';
  menu.hidden = false;
}
const hideMenu = () => (menu.hidden = true);
document.addEventListener('pointerdown', (e) => { if (!menu.hidden && !menu.contains(e.target as Node) && !(e.target as Element).closest('#openBtn')) hideMenu(); });
$('#openBtn').innerHTML = I.open;
$('#exportBtn').innerHTML = I.export;
$('#openBtn').onclick = (e) => showMenu(e.currentTarget as HTMLElement);
$('#exportBtn').onclick = openExport;
setAddHandler(() => showMenu($('#openBtn')));
setRemoveHandler((it) => {
  const i = S.items.indexOf(it);
  if (i < 0) return;
  if (S.items.length === 1) { clearAll(); toast(`Removed ${it.name}`); return; }
  S.items.splice(i, 1);
  it.thumb?.close();
  buildReel();
  select(Math.min(i, S.items.length - 1));
  updateTop();
  saveSoon();
  pruneThumbs();
  toast(`Removed ${it.name} from the selection`);
});

$('#emptyFolder').hidden = !(canPickDir || canFolderInput);
$('#emptyFolder').onclick = openFolder;
$('#emptyFiles').onclick = openFiles;

/* ---------- drag & drop ---------- */
let dragDepth = 0;
addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files')) { dragDepth++; document.body.classList.add('dragging'); } });
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  if (!e.dataTransfer) return;
  const p = await fromDrop(e.dataTransfer);
  if (p) addFiles(p);
});

/* ---------- boot ---------- */
on('select', updateTop);
for (const ev of ['select', 'ui', 'items', 'params'] as const) on(ev, () => saveSoon());
document.addEventListener('click', (e) => { if ((e.target as Element).closest('.seg, .tabs, .toolbar')) saveSoon(); });
// Write pending edits and the project immediately when the app is hidden or closed.
addEventListener('pagehide', () => { saveNow(); store.flush(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { saveNow(); store.flush(); } });

await restore();
updateTop();
build();
draw();

// ?p=<id>: reopen that project — thumbnails first, then every file whose
// access is still granted; the rest wait for Reconnect / Locate…
if (await openProject(makeItem)) {
  updateTop();
  buildReel();
  select(S.cur);
  await cameOnline(await connect(false));
}

boot();
document.getElementById('hlHome')?.replaceWith(homeLink('Process'));
// Fetch the video module once so the service worker has it for offline use.
if (import.meta.env.PROD) setTimeout(() => import('mediabunny').catch(() => {}), 4000);
