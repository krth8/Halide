import { Renderer } from '../gl/renderer';
import { loadPreview } from '../media';
import { S, changed, curItem, curMask, emit, lutById, on, outDims, paramsFor, remember, select, setV } from '../state';
import { corrAt } from '../stab';
import { geometry } from '../geo';
import { $, fmtT, h, toast } from './dom';
import type { Item } from '../model';

const view = $<HTMLCanvasElement>('#view');
const stage = $('#stage');
export const R = new Renderer(view);

let srcFor: Item | null = null;      // whose pixels are currently on the GPU
let srcIsPreview = false;
let video: HTMLVideoElement | null = null;
let videoFor: Item | null = null;
let raf = 0;
let seed = 0;

/* ---------- sizing ---------- */
function displaySize(it: Item): [number, number] {
  const r = stage.getBoundingClientRect();
  const pad = 16;
  const aw = Math.max(50, r.width - pad * 2), ah = Math.max(50, r.height - pad * 2 - (it.kind === 'video' ? 44 : 0));
  const [gw, gh] = outDims(it);
  const k = Math.min(aw / gw, ah / gh);
  const cw = Math.round(gw * k), ch = Math.round(gh * k);
  view.style.width = cw + 'px';
  view.style.height = ch + 'px';
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  // When zoomed in, render more pixels so the enlarged view stays sharp (bounded by the source).
  let pw = cw * dpr * renderZ, ph = ch * dpr * renderZ;
  const cap = Math.min(1, (renderZ > 1 ? 4096 : 2048) / Math.max(pw, ph), gw / pw);
  pw *= cap; ph *= cap;
  return [pw, ph];
}

/* ---------- drawing ---------- */
export function draw() {
  if (!raf) raf = requestAnimationFrame(paint);
}
function paint() {
  raf = 0;
  const it = curItem();
  updateChips();
  if (!it || it.status !== 'ready') { view.hidden = true; return; }
  view.hidden = false;
  const [w, hh] = displaySize(it);
  if (it.kind === 'video') {
    if (!video || videoFor !== it || video.readyState < 2) return;
    R.setSource(video, video.videoWidth, video.videoHeight);
  } else if (srcFor !== it) {
    if (!it.thumb) return;
    R.setCachedSource(it.thumb, it.thumb, it.thumb.width, it.thumb.height);
  }
  const P = paramsFor(it);
  const corr = it.kind === 'video' && video && P.stabilize > 0 ? corrAt(it, video.currentTime, P.stabilize) : null;
  placeGrid();
  placeMaskOverlay();
  R.render(P, w, hh, { bypass: S.showBefore, lut: lutById(P.lut.id), seed: it.kind === 'video' && video && !video.paused ? ++seed : it.id, masks: it.masks, corr });
}

async function ensureImage(it: Item) {
  if (srcFor === it && srcIsPreview) return;
  srcFor = null;
  draw();
  try {
    const bm = await loadPreview(it);
    if (curItem() !== it) return;
    R.setSource(bm, bm.width, bm.height);
    srcFor = it;
    srcIsPreview = true;
    draw();
  } catch {
    it.status = 'error';
    it.error = 'Could not read the image';
    emit('items');
  }
}

/* ---------- video ---------- */
const bar = $('#stagebar');
const playBtn = $<HTMLButtonElement>('#playBtn');
const muteBtn = $<HTMLButtonElement>('#muteBtn');
const ICON = {
  play: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor" stroke="none"/></svg>',
  muted: '<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor" stroke="none"/><path d="M16.5 9.5l5 5M21.5 9.5l-5 5"/></svg>',
  sound: '<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor" stroke="none"/><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12"/></svg>',
};
function syncButtons() {
  const playing = !!video && !video.paused;
  playBtn.innerHTML = playing ? ICON.pause : ICON.play;
  playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  const muted = !video || video.muted;
  muteBtn.innerHTML = muted ? ICON.muted : ICON.sound;
  muteBtn.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
}
syncButtons();
const tc = $('#stageTc');

function dropVideo() {
  if (!video) return;
  video.pause();
  URL.revokeObjectURL(video.src);
  video.removeAttribute('src');
  video.load();
  video = null;
  videoFor = null;
}

function setupVideo(it: Item) {
  if (videoFor === it) return;
  dropVideo();
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto'; v.loop = true;
  v.setAttribute('playsinline', '');
  v.src = URL.createObjectURL(it.file);
  video = v; videoFor = it;
  syncButtons();
  v.addEventListener('loadeddata', () => { v.currentTime = it.trim?.in ?? 0; });
  v.addEventListener('seeked', () => { draw(); updateTc(); });
  v.addEventListener('play', () => { syncButtons(); tick(); });
  v.addEventListener('pause', syncButtons);
  v.addEventListener('volumechange', syncButtons);
  v.addEventListener('error', () => { it.status = 'error'; it.error = 'This video cannot be played in this browser'; emit('items'); });
}

function tick() {
  if (!video || video.paused) return;
  const it = videoFor!;
  if (it.trim && (video.currentTime >= it.trim.out - 0.03 || video.currentTime < it.trim.in - 0.1)) video.currentTime = it.trim.in;
  draw();
  updateTc();
  if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(() => tick());
  else requestAnimationFrame(tick);
}

function updateTc() {
  const it = curItem();
  if (!it || it.kind !== 'video' || !video) { tc.textContent = ''; return; }
  tc.textContent = `${fmtT(video.currentTime)} / ${fmtT(it.duration)}`;
  emit('trim');
}

export const currentTime = () => video?.currentTime ?? 0;
export function seek(t: number) {
  if (!video) return;
  video.currentTime = t;
}
export function togglePlay() {
  if (!video) return;
  const it = videoFor!;
  if (video.paused) {
    if (it.trim && (video.currentTime < it.trim.in || video.currentTime >= it.trim.out - 0.05)) video.currentTime = it.trim.in;
    video.play().catch(() => {});
  } else video.pause();
}
playBtn.onclick = togglePlay;
muteBtn.onclick = () => {
  if (!video) return;
  video.muted = !video.muted;
};

/* ---------- chips / errors ---------- */
const chips = $('#chips');
const msg = $('#stageMsg');
function updateChips() {
  const it = curItem();
  chips.replaceChildren();
  msg.hidden = true;
  if (!it) return;
  if (S.showBefore) chips.append(h('span', { class: 'chip' }, 'Original'));
  else if (Object.keys(it.override).length) chips.append(h('span', { class: 'chip o' }, 'Own adjustments'));
  if (it.status === 'error') { msg.hidden = false; msg.textContent = it.error || 'Could not read the file'; }
  else if (it.status === 'loading') { msg.hidden = false; msg.textContent = 'Loading…'; }
}

/* ---------- gestures: hold for original, swipe to navigate, pipette ---------- */
type Pick = (rgb: [number, number, number]) => void;
let picker: Pick | null = null;
export function pick(fn: Pick | null) {
  picker = fn;
  stage.classList.toggle('picking', !!fn);
}

/** Where a tap on the preview lands in the source image (through crop, rotation and flip). */
function srcPoint(e: PointerEvent): [number, number] {
  const it = curItem()!, r = view.getBoundingClientRect();
  return geometry(it.width, it.height, paramsFor(it)).map((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
}

function sampleVideo(e: PointerEvent): [number, number, number] | null {
  if (!video) return null;
  const [fx, fy] = srcPoint(e);
  const c = new OffscreenCanvas(1, 1), x = c.getContext('2d')!;
  x.drawImage(video, fx * video.videoWidth - 2, fy * video.videoHeight - 2, 5, 5, 0, 0, 1, 1);
  const d = x.getImageData(0, 0, 1, 1).data;
  return [d[0] / 255, d[1] / 255, d[2] / 255];
}
// Previews are not kept as readable pixels, so sample from a small copy of the preview bitmap.
let pickSrc: { it: Item; c: OffscreenCanvas } | null = null;
async function sampleImage(e: PointerEvent): Promise<[number, number, number] | null> {
  const it = curItem();
  if (!it || it.kind === 'video') return sampleVideo(e);
  if (!pickSrc || pickSrc.it !== it) {
    const bm = await loadPreview(it);
    const k = Math.min(1, 1024 / Math.max(bm.width, bm.height));
    const c = new OffscreenCanvas(Math.round(bm.width * k), Math.round(bm.height * k));
    c.getContext('2d')!.drawImage(bm, 0, 0, c.width, c.height);
    pickSrc = { it, c };
  }
  const c = pickSrc.c;
  const [u, v] = srcPoint(e);
  const x = Math.round(u * c.width), y = Math.round(v * c.height);
  const d = c.getContext('2d')!.getImageData(Math.max(0, x - 2), Math.max(0, y - 2), 5, 5).data;
  const acc = [0, 0, 0];
  for (let i = 0; i < d.length; i += 4) { acc[0] += d[i]; acc[1] += d[i + 1]; acc[2] += d[i + 2]; }
  const n = d.length / 4;
  return [acc[0] / n / 255, acc[1] / n / 255, acc[2] / n / 255];
}

const before = (v: boolean) => { if (S.showBefore === v) return; S.showBefore = v; draw(); };

/* ---------- zoom & pan ---------- */
let z = 1, tx = 0, ty = 0, renderZ = 1, zoomTimer = 0;
const MAX_Z = 8;

function applyZoom() {
  const r = stage.getBoundingClientRect();
  const w = view.offsetWidth * z, hh = view.offsetHeight * z;
  // Never pan past the image edge; an image smaller than the stage stays centred.
  const limX = Math.max(0, (w - r.width) / 2), limY = Math.max(0, (hh - r.height) / 2);
  if (z <= 1) { z = 1; tx = ty = 0; }
  tx = Math.max(-limX, Math.min(limX, tx));
  ty = Math.max(-limY, Math.min(limY, ty));
  view.style.transform = z === 1 ? '' : `translate(${tx}px, ${ty}px) scale(${z})`;
  stage.classList.toggle('zoomed', z > 1);
  clearTimeout(zoomTimer);
  zoomTimer = window.setTimeout(() => {
    const want = z === 1 ? 1 : Math.min(z, 4);
    if (Math.abs(want - renderZ) > 0.15) { renderZ = want; draw(); }
  }, 160);
}
export function resetZoom() { z = 1; tx = ty = 0; applyZoom(); }

/** Zoom to `nz` keeping the stage point (clientX, clientY) fixed under the finger/cursor. */
function zoomAt(nz: number, cx: number, cy: number) {
  const r = stage.getBoundingClientRect();
  const mx = cx - (r.left + r.width / 2), my = cy - (r.top + r.height / 2);
  const ux = (mx - tx) / z, uy = (my - ty) / z;
  z = Math.max(1, Math.min(MAX_Z, nz));
  tx = mx - z * ux; ty = my - z * uy;
  applyZoom();
}

{
  const pts = new Map<number, { x: number; y: number }>();
  let x0 = 0, y0 = 0, lx = 0, ly = 0, moved = false, hold = 0, lastTap = 0, pinching = false;
  let pDist = 0, pMid = { x: 0, y: 0 };
  const two = () => { const [a, b] = [...pts.values()]; return { d: Math.hypot(a.x - b.x, a.y - b.y), m: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } }; };

  stage.addEventListener('pointerdown', async (e) => {
    if ((e.target as Element).closest('button, .empty, .mh')) return;
    const it = curItem();
    if (!it || it.status !== 'ready') return;
    if (picker) {
      if (e.target !== view) return;
      const fn = picker;
      pick(null);
      const rgb = await sampleImage(e);
      if (rgb) fn(rgb);
      return;
    }
    stage.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) {
      x0 = lx = e.clientX; y0 = ly = e.clientY; moved = false;
      if (e.target === view) hold = window.setTimeout(() => { if (!moved) before(true); }, 220);
    } else if (pts.size === 2) {
      clearTimeout(hold); before(false);
      pinching = true; moved = true;
      ({ d: pDist, m: pMid } = two());
    }
  });
  stage.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinching && pts.size >= 2) {
      const { d, m } = two();
      tx += m.x - pMid.x; ty += m.y - pMid.y;          // two-finger pan
      zoomAt(z * (d / Math.max(1, pDist)), m.x, m.y);    // pinch around the midpoint
      pDist = d; pMid = m;
      return;
    }
    if (Math.hypot(e.clientX - x0, e.clientY - y0) > 10) { moved = true; clearTimeout(hold); }
    if (moved && z > 1) { tx += e.clientX - lx; ty += e.clientY - ly; applyZoom(); }
    else if (moved && S.tab === 'crop') panCrop(e.clientX - lx, e.clientY - ly);
    lx = e.clientX; ly = e.clientY;
  });
  const end = (e: PointerEvent) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    clearTimeout(hold);
    if (pinching) {
      if (pts.size < 2) pinching = false;
      if (pts.size === 1) { const p = [...pts.values()][0]; lx = p.x; ly = p.y; }
      if (z < 1.15) resetZoom();
      return;
    }
    if (pts.size) return;
    if (S.showBefore) { before(false); return; }
    const dx = e.clientX - x0, dy = e.clientY - y0;
    if (!moved) {
      const now = Date.now();
      if (now - lastTap < 300) { if (z > 1) resetZoom(); else zoomAt(2.5, e.clientX, e.clientY); lastTap = 0; }
      else lastTap = now;
    } else if (z === 1 && S.tab !== 'crop' && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) select(S.cur + (dx < 0 ? 1 : -1));
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  stage.addEventListener('wheel', (e) => {
    if (!curItem() || curItem()!.status !== 'ready') return;
    e.preventDefault();
    zoomAt(z * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)), e.clientX, e.clientY);
  }, { passive: false });
  view.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('keydown', (e) => {
    if ((e.target as Element).matches('input,select,textarea')) return;
    if (e.key === 'ArrowRight') select(S.cur + 1);
    else if (e.key === 'ArrowLeft') select(S.cur - 1);
    else if ((e.key === 'b' || e.key === 'B') && !e.repeat) before(true);
    else if (e.key === ' ' && curItem()?.kind === 'video') { e.preventDefault(); togglePlay(); }
  });
  document.addEventListener('keyup', (e) => { if (e.key === 'b' || e.key === 'B') before(false); });
}

/* ---------- crop: drag to reframe, thirds grid ---------- */
/** Moving the image by (dx, dy) screen pixels moves the crop the other way. */
function panCrop(dx: number, dy: number) {
  const it = curItem();
  if (!it) return;
  const P = paramsFor(it);
  const g = geometry(it.width, it.height, P);
  const r = view.getBoundingClientRect();
  const fx = g.fx - (dx * g.w) / r.width / g.Wr, fy = g.fy - (dy * g.h) / r.height / g.Hr;
  const c = geometry(it.width, it.height, { ...P, frame: { ...P.frame, x: fx, y: fy } });
  setV('frame', { ...P.frame, x: c.fx, y: c.fy });
}
const grid = $('#cropGrid');
function placeGrid() {
  grid.hidden = S.tab !== 'crop' || view.hidden;
  if (grid.hidden) return;
  grid.style.left = view.offsetLeft + 'px';
  grid.style.top = view.offsetTop + 'px';
  grid.style.width = view.offsetWidth + 'px';
  grid.style.height = view.offsetHeight + 'px';
  grid.style.transform = view.style.transform;
}
on('ui', draw);

/* ---------- mask handles ---------- */
const ov = $<SVGSVGElement>('#maskOverlay');
const SVGNS = 'http://www.w3.org/2000/svg';
function el(tag: string, attrs: Record<string, string | number>) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}
function placeMaskOverlay() {
  const m = curMask();
  const show = !!m && !view.hidden && !S.showBefore;
  ov.toggleAttribute('hidden', !show);
  if (!show || !m) return;
  const W = view.offsetWidth, H = view.offsetHeight;
  Object.assign(ov.style, { left: view.offsetLeft + 'px', top: view.offsetTop + 'px', width: W + 'px', height: H + 'px', transform: view.style.transform });
  ov.setAttribute('viewBox', `0 0 ${W} ${H}`);
  ov.replaceChildren();
  const r = 10 / z, sw = 1.5 / z;
  const handle = (x: number, y: number, id: string) => ov.append(el('circle', { cx: x, cy: y, r, class: 'mh', 'data-h': id, 'stroke-width': sw * 1.5 }));
  const ax = m.a[0] * W, ay = m.a[1] * H, bx = m.b[0] * W, by = m.b[1] * H;
  if (m.type === 'linear') {
    const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1, nx = (-dy / L) * (W + H), ny = (dx / L) * (W + H);
    ov.append(el('line', { x1: ax - nx, y1: ay - ny, x2: ax + nx, y2: ay + ny, class: 'mline', 'stroke-width': sw }));
    ov.append(el('line', { x1: bx - nx, y1: by - ny, x2: bx + nx, y2: by + ny, class: 'mline dim', 'stroke-width': sw }));
    ov.append(el('line', { x1: ax, y1: ay, x2: bx, y2: by, class: 'mline dash', 'stroke-width': sw }));
    handle(ax, ay, 'a'); handle(bx, by, 'b'); handle((ax + bx) / 2, (ay + by) / 2, 'mid');
  } else {
    ov.append(el('ellipse', { cx: ax, cy: ay, rx: Math.abs(bx), ry: Math.abs(by), class: 'mline', 'stroke-width': sw }));
    ov.append(el('ellipse', { cx: ax, cy: ay, rx: Math.abs(bx) * (1 - m.feather / 100), ry: Math.abs(by) * (1 - m.feather / 100), class: 'mline dim', 'stroke-width': sw }));
    handle(ax, ay, 'a'); handle(ax + bx, ay, 'rx'); handle(ax, ay + by, 'ry');
  }
}
{
  let drag: string | null = null, last: [number, number] = [0, 0];
  const uv = (e: PointerEvent): [number, number] => {
    const r = view.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  };
  ov.addEventListener('pointerdown', (e) => {
    const t = (e.target as Element).closest('.mh');
    if (!t) return;
    e.stopPropagation();
    drag = t.getAttribute('data-h');
    last = uv(e);
    ov.setPointerCapture(e.pointerId);
  });
  ov.addEventListener('pointermove', (e) => {
    const m = curMask(), it = curItem();
    if (!drag || !m || !it) return;
    const [u, v] = uv(e), du = u - last[0], dv = v - last[1];
    last = [u, v];
    if (drag === 'a') m.a = m.type === 'linear' ? [u, v] : [m.a[0] + du, m.a[1] + dv];
    else if (drag === 'b') m.b = [u, v];
    else if (drag === 'mid') { m.a = [m.a[0] + du, m.a[1] + dv]; m.b = [m.b[0] + du, m.b[1] + dv]; }
    else if (drag === 'rx') m.b = [Math.max(0.02, Math.abs(u - m.a[0])), m.b[1]];
    else if (drag === 'ry') m.b = [m.b[0], Math.max(0.02, Math.abs(v - m.a[1]))];
    remember(it);
    changed();
  });
  const end = () => { drag = null; };
  ov.addEventListener('pointerup', end);
  ov.addEventListener('pointercancel', end);
}

/* ---------- previous / next ---------- */
const prevBtn = $<HTMLButtonElement>('#prevBtn'), nextBtn = $<HTMLButtonElement>('#nextBtn');
prevBtn.onclick = () => select(S.cur - 1);
nextBtn.onclick = () => select(S.cur + 1);

/* ---------- wiring ---------- */
function onSelect() {
  const it = curItem();
  resetZoom();
  prevBtn.hidden = nextBtn.hidden = S.items.length < 2;
  bar.hidden = !it || it.kind !== 'video';
  pick(null);
  if (!it) { dropVideo(); draw(); return; }
  if (it.kind === 'video') { srcFor = null; if (it.status === 'ready') setupVideo(it); }
  else { dropVideo(); if (it.status === 'ready') ensureImage(it); }
  draw();
}
on('select', onSelect);
on('items', onSelect);
on('params', draw);
new ResizeObserver(draw).observe(stage);
view.addEventListener('webglcontextlost', () => toast('Graphics memory was lost. Reload the page.'));

/** Called by the trim panel when handles move. */
export function trimChanged(it: Item, edge: 'in' | 'out') {
  remember(it);
  if (video && videoFor === it && it.trim) { video.pause(); video.currentTime = it.trim[edge]; }
}
