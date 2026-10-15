import { DEF, clone, type Key, type Params } from './model';

/** User presets save the whole setup. Applying one replaces everything except exposure, which belongs
 *  to each scene; per-item corrections stay on top as usual. The look can be changed afterwards. */
const KEEP: Key[] = ['exposure'];

export function applyPresetTo(base: Params, preset: Params): Params {
  const out = { ...base } as Record<string, unknown>;
  for (const k of Object.keys(DEF) as Key[]) if (!KEEP.includes(k)) out[k] = clone(preset[k] ?? DEF[k]);
  return out as unknown as Params;
}
