import { folderDest, memoryDest, outName, runExport, type Dest, type ImgFormat, type ExportResult } from '../exporter';
import { canPickDir, trimPreviews } from '../media';
import { isTrimmed } from '../model';
import { S, curItem, lutById, paramsFor, saveExport } from '../state';
import { FMAP } from '../looks';
import { $, fmtT, h, toast } from './dom';

const scrim = $('#exportScrim');
const sheet = $('#exportSheet');
let outDir: FileSystemDirectoryHandle | null = null;
let ctrl: AbortController | null = null;

const close = () => { if (!ctrl) scrim.hidden = true; };
scrim.addEventListener('click', (e) => { if (e.target === scrim) close(); });

function field(label: string, ...kids: Node[]) { return h('div', { class: 'field' }, h('span', {}, label), ...kids); }
/** A row of pills instead of a native <select> (Android shows those full-screen). */
function select(id: string, opts: [string, string][], value: string, onchange: (v: string) => void) {
  const row = h('div', { class: 'segpills', id, role: 'radiogroup' });
  for (const [v, t] of opts) {
    const b = h('button', { class: 'pill' + (v === value ? ' on' : ''), role: 'radio', 'aria-checked': String(v === value), onclick: () => {
      row.querySelectorAll('button').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', String(x === b)); });
      onchange(v);
    } }, t);
    row.append(b);
  }
  return row;
}

export function openExport() {
  const items = S.items.filter((i) => i.status === 'ready');
  if (!items.length) { toast('Nothing to export yet'); return; }
  scrim.hidden = false;
  form();
}

function form() {
  const es = S.exportSettings;
  const items = S.items.filter((i) => i.status === 'ready');
  const nv = items.filter((i) => i.kind === 'video');
  const summary = h('div', { class: 'summary' });
  const go = h('button', { class: 'btn primary', id: 'exGo' }) as HTMLButtonElement;
  const upd = () => {
    saveExport();
    const trimmed = nv.filter(isTrimmed);
    const overrides = items.filter((i) => Object.keys(i.override).length).length;
    summary.replaceChildren(
      h('b', {}, `${items.length - nv.length} photo${items.length - nv.length === 1 ? '' : 's'}`), ' and ', h('b', {}, `${nv.length} video${nv.length === 1 ? '' : 's'}`), ` with the look “${FMAP[S.G.filter.id]?.name ?? 'None'}”.`, h('br'),
      `${overrides} with own adjustments · ${trimmed.length} trimmed` + (nv.length ? ` (${fmtT(nv.reduce((a, x) => a + x.duration, 0), 0)} → ${fmtT(nv.reduce((a, x) => a + (x.trim ? x.trim.out - x.trim.in : x.duration), 0), 0)})` : '') + '.', h('br'),
      'Example: ', h('code', {}, outName(items[0], es)),
      ...(nv.length && es.vQuality === 'custom'
        ? [h('br'), `Video ≈ ${Math.round((nv.reduce((a, x) => a + (x.trim ? x.trim.out - x.trim.in : x.duration), 0) * es.vBitrate) / 8)} MB in total.`]
        : []),
    );
    go.textContent = `Export ${items.length} ${items.length === 1 ? 'file' : 'files'}`;
  };

  const destPath = h('code', {}, outDir ? outDir.name : 'No folder chosen');
  const dest = canPickDir
    ? h('div', { class: 'dest' }, destPath, h('button', { class: 'btn small', onclick: async () => {
        try {
          outDir = await (window as any).showDirectoryPicker({ id: 'filmlab-out', mode: 'readwrite', startIn: S.importDir ?? 'pictures' });
          destPath.textContent = outDir!.name;
          destPath.classList.remove('warn');
        } catch { /* cancelled */ }
      } }, 'Choose folder…'))
    : h('p', { class: 'hint' }, 'The files are made on this device. Afterwards you save them with the Share button, for example to Photos or Files.');

  const q = h('input', { type: 'range', id: 'exQ', min: 50, max: 100, value: es.quality }) as HTMLInputElement;
  const qv = h('b', { class: 'mono' }, String(es.quality));
  q.value = String(es.quality);
  q.oninput = () => { es.quality = +q.value; qv.textContent = q.value; saveExport(); };
  const name = h('input', { type: 'text', id: 'exName', value: es.name }) as HTMLInputElement;
  name.oninput = () => { es.name = name.value; upd(); };

  sheet.replaceChildren(
    h('h2', {}, 'Export'),
    h('div', { class: 'field' }, h('span', {}, 'Save to'), dest),
    h('div', { class: 'two' },
      field('Photo format', select('exFmt', [['jpeg', 'JPEG'], ['webp', 'WebP'], ['png', 'PNG']], es.format, (v) => { es.format = v as ImgFormat; upd(); })),
      h('div', { class: 'field' }, h('span', {}, 'Photo quality ', qv), q)),
    field('Photos: long side (px)', select('exSize', [['0', 'Original'], ['4096', '4096'], ['2048', '2048'], ['1080', '1080']], String(es.size), (v) => { es.size = +v; upd(); })),
    field('File name ({name} = original name)', name),
    advanced(upd, nv.length > 0),
    summary,
    h('div', { class: 'actions' }, h('button', { class: 'btn ghost', onclick: close }, 'Cancel'), go),
  );
  go.onclick = () => {
    if (canPickDir && !outDir) { destPath.textContent = 'Choose a folder first'; destPath.classList.add('warn'); return; }
    run(outDir ? folderDest(outDir) : null);
  };
  upd();
}

let advOpen = false;
function advanced(upd: () => void, hasVideo: boolean) {
  const es = S.exportSettings;
  const rate = h('input', { type: 'range', id: 'exRate', min: 2, max: 100, step: 1, value: es.vBitrate }) as HTMLInputElement;
  rate.value = String(es.vBitrate);
  const rv = h('b', { class: 'mono' }, `${es.vBitrate} Mbit/s`);
  rate.oninput = () => { es.vBitrate = +rate.value; rv.textContent = `${rate.value} Mbit/s`; upd(); };
  const rateRow = h('div', { class: 'field' }, h('span', {}, 'Bitrate ', rv), rate);
  rateRow.hidden = es.vQuality !== 'custom';
  const box = h('div', { class: 'adv' },
    !hasVideo && h('p', { class: 'hint' }, 'These settings apply to video. There are no videos in this export.'),
    h('div', { class: 'two' },
      field('Video codec', select('exVid', [['avc', 'H.264'], ['hevc', 'HEVC'], ['av1', 'AV1']], es.codec, (v) => { es.codec = v as typeof es.codec; upd(); })),
      field('Max resolution', select('exVRes', [['0', 'Original'], ['2160', '4K'], ['1080', '1080p'], ['720', '720p']], String(es.vRes), (v) => { es.vRes = +v; upd(); }))),
    field('Video quality', select('exVQ', [['medium', 'Medium'], ['high', 'High'], ['very_high', 'Very high'], ['custom', 'Custom bitrate']], es.vQuality, (v) => {
      es.vQuality = v as typeof es.vQuality; rateRow.hidden = v !== 'custom'; upd();
    })),
    rateRow,
    h('div', { class: 'two' },
      field('Frame rate', select('exFps', [['0', 'Original'], ['24', '24'], ['30', '30'], ['60', '60']], String(es.fps), (v) => { es.fps = +v; upd(); })),
      field('Audio', select('exAudio', [['1', 'With audio'], ['0', 'No audio']], es.audio ? '1' : '0', (v) => { es.audio = v === '1'; upd(); }))),
  );
  box.hidden = !advOpen;
  const toggle = h('button', { class: 'disclose' + (advOpen ? ' open' : '') }, advOpen ? 'Hide advanced' : 'Advanced (video)') as HTMLButtonElement;
  toggle.onclick = () => { advOpen = !advOpen; box.hidden = !advOpen; toggle.textContent = advOpen ? 'Hide advanced' : 'Advanced (video)'; };
  return h('div', { class: 'field' }, toggle, box);
}

async function run(folder: Dest | null) {
  const items = S.items.filter((i) => i.status === 'ready');
  const files: File[] = [];
  const dest = folder ?? memoryDest(files);
  ctrl = new AbortController();
  trimPreviews(curItem());
  const bar = h('i');
  const label = h('p', { class: 'hint' }, 'Starting…');
  sheet.replaceChildren(
    h('h2', {}, 'Exporting'),
    h('div', { class: 'prog' }, bar),
    label,
    h('p', { class: 'hint' }, 'Keep the app open until the export is done.'),
    h('div', { class: 'actions' }, h('button', { class: 'btn ghost', onclick: () => ctrl?.abort() }, 'Cancel')),
  );
  let lock: WakeLockSentinel | null = null;
  try { lock = await navigator.wakeLock?.request('screen'); } catch { /* not available */ }
  let res: ExportResult;
  try {
    res = await runExport({
      items, settings: S.exportSettings, dest, signal: ctrl.signal,
      params: paramsFor, lut: lutById,
      onProgress: (i, f) => {
        bar.style.width = (((i + f) / items.length) * 100).toFixed(1) + '%';
        label.textContent = `${i + 1} of ${items.length} · ${items[i].name}${items[i].kind === 'video' ? ` · ${Math.round(f * 100)} %` : ''}`;
      },
    });
  } catch (e) {
    res = { done: 0, failed: [{ name: 'Export', reason: (e as Error).message }], notes: [] };
  }
  lock?.release().catch(() => {});
  const aborted = ctrl.signal.aborted;
  ctrl = null;
  done(res, aborted, folder, files);
}

function done(res: ExportResult, aborted: boolean, folder: Dest | null, files: File[]) {
  const actions = h('div', { class: 'actions' });
  const list = h('div', { class: 'results' });
  for (const f of res.failed) list.append(h('p', { class: 'fail' }, `${f.name}: ${f.reason}`));
  for (const n of res.notes) list.append(h('p', { class: 'hint' }, n));
  const title = aborted ? 'Export cancelled' : res.failed.length ? 'Done, with errors' : 'Done';
  const text = folder ? `${res.done} ${res.done === 1 ? 'file' : 'files'} saved to “${folder.label}”.` : `${res.done} ${res.done === 1 ? 'file is' : 'files are'} ready.`;
  actions.append(h('button', { class: 'btn ghost', onclick: close }, 'Close'));
  if (!folder && files.length) {
    const share = async (batch: File[]) => {
      try { await navigator.share({ files: batch }); } catch (e) { if ((e as Error).name !== 'AbortError') toast('Sharing failed. Try Download.'); }
    };
    if (navigator.canShare?.({ files })) actions.append(h('button', { class: 'btn primary', onclick: () => share(files) }, 'Save / share'));
    actions.append(h('button', { class: 'btn' + (navigator.canShare?.({ files }) ? '' : ' primary'), onclick: () => download(files) }, 'Download'));
  }
  sheet.replaceChildren(h('h2', {}, title), h('p', {}, text), list, actions);
}

async function download(files: File[]) {
  for (const f of files) {
    const a = h('a', { href: URL.createObjectURL(f), download: f.name }) as HTMLAnchorElement;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    await new Promise((r) => setTimeout(r, 350));
  }
}
