// Stills on the timeline: photos (JPEG, PNG, WebP, HEIC…) and camera RAW
// (through the shared LibRaw module, src/shared/media/raw.ts). A still has no
// clock of its own — it plays for as long as its clip lasts — so the media's
// "source length" is generous and a new clip starts at STILL_SECONDS.
import { isRaw, rawDecode, rawThumb, RAW_EXTENSIONS } from '../../shared/media/raw.ts';

export const STILL_SECONDS = 5;      // default length of a dropped still
export const STILL_SOURCE = 3600;    // how far a still clip can be stretched
export const STILL_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif', '.bmp', '.tif', '.tiff', '.heic', '.heif', ...RAW_EXTENSIONS];
const IMG_RE = /\.(jpe?g|png|webp|avif|gif|bmp|tiff?|heic|heif)$/i;
export const isStillFile = (f) => !!f && (String(f.type || '').startsWith('image/') || IMG_RE.test(f.name || '') || isRaw(f));

const fit = (w, h, max) => { const k = Math.min(1, max / Math.max(w, h)); return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))]; };

/** Size and a 640 px thumbnail (data URL) — from the camera's embedded preview for RAW. */
export async function probeStill(file) {
  let bm, width, height;
  if (isRaw(file)) {
    const r = await rawThumb(file);
    bm = r.thumb; width = r.width; height = r.height;
  } else {
    bm = await createImageBitmap(file);
    width = bm.width; height = bm.height;
  }
  const [tw, th] = fit(bm.width, bm.height, 640);
  const c = document.createElement('canvas'); c.width = tw; c.height = th;
  c.getContext('2d').drawImage(bm, 0, 0, tw, th);
  bm.close();
  return { width, height, thumb: c.toDataURL('image/jpeg', 0.8) };
}

/** The still as a bitmap no larger than `maxSide` (RAW: a half-size develop when that is enough). */
export async function decodeStill(file, maxSide) {
  let bm;
  if (isRaw(file)) bm = await rawDecode(file, { half: maxSide <= 3000 });
  else bm = await createImageBitmap(file);
  if (Math.max(bm.width, bm.height) <= maxSide) return bm;
  const [w, h] = fit(bm.width, bm.height, maxSide);
  const out = await createImageBitmap(bm, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
  bm.close();
  return out;
}

// decoded stills, per media and size; the engine asks every frame, so the
// accessor is synchronous and fills in the background
const cache = new Map();   // `${mediaId}@${maxSide}` -> { bmp, p }
export function stillBitmap(m, maxSide, onReady) {
  if (!m?.file) return null;
  const key = m.id + '@' + maxSide;
  let e = cache.get(key);
  if (!e) {
    e = { bmp: null, p: null };
    cache.set(key, e);
    e.p = decodeStill(m.file, maxSide)
      .then((b) => { e.bmp = b; onReady?.(); return b; })
      .catch((err) => { console.warn('[still] decode failed', m.name, err); cache.delete(key); return null; });
  }
  return e.bmp;
}
/** Awaitable variant (export). */
export function stillBitmapAsync(m, maxSide) {
  stillBitmap(m, maxSide);
  return cache.get(m.id + '@' + maxSide)?.p ?? Promise.resolve(null);
}
/** Drop every cached size of a media (removed from the project). */
export function forgetStill(mediaId) {
  for (const [k, e] of cache) if (k.startsWith(mediaId + '@')) { e.bmp?.close?.(); cache.delete(k); }
}
