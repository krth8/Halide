// Halide marks. The logo is a silver-halide crystal (the cubic grain film is
// made of), drawn as an isometric cube; each workspace has its own glyph.
import { BASE } from './paths';

let n = 0;
const uid = () => `hl${++n}`;

export function halideMark(): string {
  const a = uid(), b = uid(), c = uid();
  return `<svg viewBox="0 0 32 32" aria-hidden="true">
  <defs>
    <linearGradient id="${a}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#efe8ff"/><stop offset="1" stop-color="#c9b6ff"/></linearGradient>
    <linearGradient id="${b}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#a98cff"/><stop offset="1" stop-color="#7b5cf0"/></linearGradient>
    <linearGradient id="${c}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff8fcb"/><stop offset="1" stop-color="#d9559d"/></linearGradient>
  </defs>
  <path d="M16 2.5 28.5 9.6 16 16.8 3.5 9.6z" fill="url(#${a})"/>
  <path d="M3.5 9.6 16 16.8v12.7L3.5 22.3z" fill="url(#${b})"/>
  <path d="M28.5 9.6 16 16.8v12.7l12.5-7.2z" fill="url(#${c})"/>
</svg>`;
}

// Process: an aperture — develop a single image or clip
export const PROCESS_GLYPH = `<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round" aria-hidden="true">
  <circle cx="16" cy="16" r="12.5"/>
  <path d="M16 3.5 21.5 13M28.3 13.6 17.4 13.9M24.9 24.8 19.2 15.4M12.6 28 17.9 18.5M3.9 19.6l10.9.4M6.8 7.6l5.9 9.2"/>
</svg>`;

// Edit: timeline lanes
export const EDIT_GLYPH = `<svg viewBox="0 0 32 32" fill="currentColor" aria-hidden="true">
  <rect x="4" y="7" width="14" height="5" rx="2.5"/>
  <rect x="4" y="13.5" width="24" height="5" rx="2.5"/>
  <rect x="11" y="20" width="13" height="5" rx="2.5"/>
</svg>`;

/** The Halide home link for a workspace header: crystal + "HALIDE" + mode. */
export function homeLink(mode: 'Process' | 'Edit'): HTMLAnchorElement {
  const a = document.createElement('a');
  a.className = 'hl-home';
  a.href = BASE;
  a.title = 'Back to Halide';
  a.innerHTML = `${halideMark()}<b>HALIDE</b><span>${mode}</span>`;
  return a;
}
