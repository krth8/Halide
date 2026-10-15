type Attrs = Record<string, unknown> & { class?: string; style?: string };
type Child = Node | string | null | undefined | false;

/** Minimal element helper: h('button', {class:'btn', onclick}, 'Tekst') */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) (el as any)[k] = v;
    else if (k === 'class') el.className = String(v);
    else if (k === 'html') el.innerHTML = String(v);
    else if (k in el && typeof v !== 'string') (el as any)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids) if (c != null && c !== false) el.append(c);
  return el;
}

export const $ = <T extends Element = HTMLElement>(s: string, root: ParentNode = document) => root.querySelector(s) as T;

let toastTimer = 0;
export function toast(msg: string, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), ms);
}

export const fmtT = (s: number, dec = 1) => {
  s = Math.max(0, s);
  const m = Math.floor(s / 60), r = s - m * 60;
  return m + ':' + (dec ? r.toFixed(dec).padStart(dec + 3, '0') : String(Math.round(r)).padStart(2, '0'));
};

export const isPhone = () => matchMedia('(max-width: 860px)').matches;
