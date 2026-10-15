import { h } from './dom';

/** Line icons on a 24×24 grid (stroke = currentColor). */
const P = (d: string) => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
export const I = {
  open: P('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 10v6M9 13h6"/>'),
  export: P('<path d="M12 15V3M7 8l5-5 5 5"/><path d="M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"/>'),
  reset: P('<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v5h5"/>'),
  resetAll: P('<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v5h5"/><circle cx="12" cy="12" r="2.2" fill="currentColor"/>'),
  masks: P('<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/>'),
  base: P('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 16l5-5 4 4 3-3 6 6"/>'),
  gradient: P('<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 9h16M4 13h16M4 17h16" opacity=".55"/>'),
  radial: P('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4" opacity=".55"/>'),
  addGradient: P('<rect x="3" y="6" width="12" height="12" rx="2"/><path d="M3 10h12M3 14h12" opacity=".55"/><path d="M19 9v6M16 12h6"/>'),
  addRadial: P('<circle cx="9" cy="12" r="6"/><circle cx="9" cy="12" r="2.5" opacity=".55"/><path d="M19 9v6M16 12h6"/>'),
  invert: P('<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 0 0 16z" fill="currentColor"/>'),
  eye: P('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  eyeOff: P('<path d="M3 3l18 18M10.6 5.1A9.7 9.7 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.1 4M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7a9.6 9.6 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>'),
  trash: P('<path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13M10 11v6M14 11v6"/>'),
  rotL: P('<path d="M3 4v5h5"/><path d="M3.5 9A8.5 8.5 0 1 1 6 16"/><rect x="9" y="9" width="7" height="7" rx="1" opacity=".55"/>'),
  rotR: P('<path d="M21 4v5h-5"/><path d="M20.5 9A8.5 8.5 0 1 0 18 16"/><rect x="8" y="9" width="7" height="7" rx="1" opacity=".55"/>'),
  flip: P('<path d="M12 3v18"/><path d="M8 7L3 17h5zM16 7l5 10h-5z"/>'),
  markIn: P('<path d="M9 4H6v16h3"/><path d="M13 12h8M17 8l4 4-4 4"/>'),
  markOut: P('<path d="M15 4h3v16h-3"/><path d="M11 12H3M7 8l-4 4 4 4"/>'),
  pipette: P('<path d="M14.5 4.5l5 5M3 21l2-1 9.5-9.5-3-3L2 17l1 4z"/><path d="M13 6l1.8-1.8a2.5 2.5 0 0 1 3.5 0l1.5 1.5a2.5 2.5 0 0 1 0 3.5L18 11"/>'),
  save: P('<path d="M6 3h12v18l-6-4-6 4z"/><path d="M12 7v6M9 10h6"/>'),
  importFile: P('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M12 12v6M9 15l3 3 3-3"/>'),
  grip: P('<path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01" stroke-width="3"/>'),
  wand: P('<path d="M4 20L16 8M14 6l4 4"/><path d="M18 2v3M20.5 4.5h-3M7 3v2M8 4H6M20 13v2M21 14h-2"/>'),
};

/** Icon button. `text` adds a short label next to the icon (for actions that need one). */
export function ib(icon: string, label: string, onclick: (e: MouseEvent) => void, o: { cls?: string; text?: string; disabled?: boolean; id?: string } = {}) {
  const b = h('button', { class: 'ib' + (o.text ? ' wide' : '') + (o.cls ? ' ' + o.cls : ''), title: label, 'aria-label': label, onclick, disabled: !!o.disabled, id: o.id }) as HTMLButtonElement;
  b.innerHTML = icon;
  if (o.text) b.append(h('span', {}, o.text));
  return b;
}
