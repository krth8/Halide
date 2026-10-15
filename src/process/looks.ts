
export interface FilterVals { warm: number; con: number; fade: number; sat: number; split: number; sh: number; hh: number }
export interface FilterDef { id: string; name: string; g?: string; mono?: boolean; v?: FilterVals }

export const FILTERS: FilterDef[] = [
  { id: 'none', name: 'None' },
  { g: 'Film', id: 'portra', name: 'Portra 400', v: { warm: 15, con: -10, fade: 12, sat: -8, split: 18, sh: 195, hh: 35 } },
  { g: 'Film', id: 'ektar', name: 'Ektar 100', v: { warm: 6, con: 22, fade: 0, sat: 35, split: 8, sh: 220, hh: 30 } },
  { g: 'Film', id: 'gold', name: 'Gold 200', v: { warm: 30, con: 6, fade: 6, sat: 12, split: 22, sh: 210, hh: 45 } },
  { g: 'Film', id: 'velvia', name: 'Velvia 50', v: { warm: -4, con: 30, fade: 0, sat: 55, split: 10, sh: 250, hh: 50 } },
  { g: 'Film', id: 'cine', name: 'Cinestill 800T', v: { warm: -30, con: 10, fade: 8, sat: 8, split: 35, sh: 190, hh: 15 } },
  { g: 'Film', id: 'kchrome', name: 'Kodachrome 64', v: { warm: 10, con: 25, fade: 4, sat: 25, split: 15, sh: 205, hh: 25 } },
  { g: 'Film', id: 'pro400h', name: 'Fuji 400H', v: { warm: -8, con: -12, fade: 14, sat: -10, split: 24, sh: 160, hh: 330 } },
  { g: 'Film', id: 'pola', name: 'Polaroid 600', v: { warm: 14, con: -18, fade: 26, sat: -14, split: 30, sh: 185, hh: 50 } },
  { g: 'Film', id: 'trix', name: 'Tri-X 400', mono: true, v: { warm: 0, con: 30, fade: 4, sat: 0, split: 0, sh: 0, hh: 0 } },
  { g: 'Film', id: 'hp5', name: 'Ilford HP5', mono: true, v: { warm: 0, con: 12, fade: 10, sat: 0, split: 8, sh: 220, hh: 40 } },
  { g: 'Cinema', id: 'teal', name: 'Teal & Orange', v: { warm: 8, con: 18, fade: 2, sat: 15, split: 60, sh: 190, hh: 30 } },
  { g: 'Cinema', id: 'bleach', name: 'Bleach bypass', v: { warm: -4, con: 40, fade: 0, sat: -55, split: 6, sh: 210, hh: 40 } },
  { g: 'Cinema', id: 'dfn', name: 'Day for night', v: { warm: -70, con: 10, fade: 0, sat: -40, split: 40, sh: 225, hh: 220 } },
  { g: 'Cinema', id: 'amber', name: 'Amber haze', v: { warm: 40, con: 10, fade: 10, sat: -10, split: 55, sh: 30, hh: 35 } },
  { g: 'Creative', id: 'xpro', name: 'Cross process', v: { warm: -10, con: 25, fade: 0, sat: 30, split: 50, sh: 170, hh: 60 } },
  { g: 'Creative', id: 'matte', name: 'Faded matte', v: { warm: 6, con: -25, fade: 40, sat: -25, split: 15, sh: 220, hh: 40 } },
  { g: 'Creative', id: 'ir', name: 'Infrared', v: { warm: -20, con: 20, fade: 6, sat: -30, split: 60, sh: 320, hh: 175 } },
  { g: 'Creative', id: 'lofi', name: 'Lo-fi', v: { warm: 10, con: 45, fade: 0, sat: 40, split: 20, sh: 260, hh: 55 } },
  { g: 'Creative', id: 'nordlys', name: 'Aurora', v: { warm: -25, con: 8, fade: 8, sat: 20, split: 40, sh: 160, hh: 140 } },
  { g: 'Film', id: 'portra160', name: 'Portra 160', v: { warm: 10, con: -14, fade: 10, sat: -12, split: 14, sh: 200, hh: 30 } },
  { g: 'Film', id: 'portra800', name: 'Portra 800', v: { warm: 20, con: -4, fade: 14, sat: 0, split: 22, sh: 190, hh: 32 } },
  { g: 'Film', id: 'superia', name: 'Superia 400', v: { warm: -6, con: 10, fade: 6, sat: 10, split: 26, sh: 150, hh: 50 } },
  { g: 'Film', id: 'ektachrome', name: 'Ektachrome E100', v: { warm: -10, con: 22, fade: 0, sat: 25, split: 18, sh: 215, hh: 200 } },
  { g: 'Film', id: 'provia', name: 'Provia 100F', v: { warm: -2, con: 16, fade: 0, sat: 18, split: 6, sh: 210, hh: 40 } },
  { g: 'Film', id: 'agfa', name: 'Agfa Vista 200', v: { warm: 18, con: 14, fade: 6, sat: 22, split: 20, sh: 340, hh: 45 } },
  { g: 'Film', id: 'lomo800', name: 'Lomo 800', v: { warm: 12, con: 30, fade: 4, sat: 35, split: 28, sh: 230, hh: 40 } },
  { g: 'Film', id: 'colorplus', name: 'ColorPlus 200', v: { warm: 26, con: 4, fade: 12, sat: 6, split: 26, sh: 30, hh: 42 } },
  { g: 'Film', id: 'acros', name: 'Acros 100', mono: true, v: { warm: 0, con: 18, fade: 2, sat: 0, split: 0, sh: 0, hh: 0 } },
  { g: 'Film', id: 'tmax', name: 'T-Max 400', mono: true, v: { warm: 0, con: 24, fade: 0, sat: 0, split: 4, sh: 210, hh: 210 } },
  { g: 'Film', id: 'delta3200', name: 'Delta 3200', mono: true, v: { warm: 0, con: 38, fade: 12, sat: 0, split: 6, sh: 30, hh: 30 } },
  { g: 'Cinema', id: 'vision500t', name: 'Vision3 500T', v: { warm: -18, con: 6, fade: 10, sat: -4, split: 40, sh: 195, hh: 25 } },
  { g: 'Cinema', id: 'cine50d', name: 'Cinestill 50D', v: { warm: 6, con: 8, fade: 6, sat: 10, split: 18, sh: 200, hh: 30 } },
  { g: 'Cinema', id: 'eterna', name: 'Eterna', v: { warm: -6, con: -16, fade: 16, sat: -28, split: 22, sh: 185, hh: 40 } },
  { g: 'Cinema', id: 'matrix', name: 'Green code', v: { warm: -20, con: 22, fade: 4, sat: -30, split: 50, sh: 130, hh: 110 } },
  { g: 'Cinema', id: 'noir', name: 'Neo-noir', v: { warm: -30, con: 34, fade: 0, sat: -45, split: 45, sh: 215, hh: 25 } },
  { g: 'Creative', id: 'chrome', name: 'Classic Chrome', v: { warm: -4, con: 14, fade: 4, sat: -30, split: 14, sh: 205, hh: 40 } },
  { g: 'Creative', id: 'pastel', name: 'Pastel', v: { warm: 8, con: -30, fade: 30, sat: -10, split: 36, sh: 300, hh: 50 } },
  { g: 'Creative', id: 'sepia', name: 'Sepia', mono: true, v: { warm: 0, con: 10, fade: 10, sat: 0, split: 70, sh: 25, hh: 40 } },
  { g: 'Creative', id: 'cyanotype', name: 'Cyanotype', mono: true, v: { warm: 0, con: 16, fade: 6, sat: 0, split: 85, sh: 210, hh: 195 } },
];
// Keep groups together in the cycler and the preview strip.
const GROUP_ORDER = ['', 'Film', 'Cinema', 'Creative'];
FILTERS.sort((a, b) => GROUP_ORDER.indexOf(a.g ?? '') - GROUP_ORDER.indexOf(b.g ?? ''));
export const FMAP: Record<string, FilterDef> = Object.fromEntries(FILTERS.map((f) => [f.id, f]));

export const FSLIDERS: [keyof FilterVals, string, number, number][] = [
  ['warm', 'Warmth', -100, 100], ['con', 'Contrast', -100, 100], ['fade', 'Fade', 0, 100], ['sat', 'Saturation', -100, 100],
  ['split', 'Split-toning', 0, 100], ['sh', 'Shadow hue', 0, 360], ['hh', 'Highlight hue', 0, 360],
];

export const BANDS = [
  { n: 'Red', h: 0 }, { n: 'Orange', h: 30 }, { n: 'Yellow', h: 58 }, { n: 'Green', h: 115 },
  { n: 'Cyan', h: 180 }, { n: 'Blue', h: 222 }, { n: 'Purple', h: 270 }, { n: 'Magenta', h: 318 },
];

export const HSL_PRESETS: Record<string, Record<number, { h: number; s: number; l: number }>> = {
  'Protect skin': { 0: { h: 3, s: -8, l: 4 }, 1: { h: 0, s: -12, l: 8 } },
  'Deep sky': { 4: { h: 0, s: 15, l: -10 }, 5: { h: -4, s: 30, l: -22 } },
  'Golden grass': { 2: { h: -12, s: 15, l: 4 }, 3: { h: -30, s: -15, l: 0 } },
  'Teal & orange': { 1: { h: 0, s: 20, l: 5 }, 3: { h: 40, s: -20, l: 0 }, 4: { h: 8, s: 25, l: 0 }, 5: { h: -15, s: 10, l: 0 } },
  'Muted greens': { 3: { h: 0, s: -45, l: -10 }, 2: { h: 0, s: -15, l: 0 } },
  'Neon night': { 6: { h: 0, s: 40, l: 10 }, 7: { h: 0, s: 40, l: 10 }, 4: { h: 0, s: 30, l: 10 } },
};
