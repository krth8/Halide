// In-app toast and confirm, in the Halide look — instead of the browser's
// alert/confirm/prompt boxes. Styles live in theme.css (.hl-toast, .hl-dialog).

let toastEl: HTMLDivElement | null = null;
let toastTimer = 0;

export interface ToastAction { label: string; run: () => void }

/** Short message at the bottom of the screen, optionally with one action (e.g. Undo). */
export function toast(text: string, { action, ms = 3200 }: { action?: ToastAction; ms?: number } = {}): void {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'hl-toast';
    toastEl.setAttribute('role', 'status');
    document.body.appendChild(toastEl);
  }
  const el = toastEl;
  clearTimeout(toastTimer);
  el.replaceChildren();
  const span = document.createElement('span');
  span.textContent = text;
  el.appendChild(span);
  if (action) {
    const b = document.createElement('button');
    b.textContent = action.label;
    b.onclick = () => { hide(); action.run(); };
    el.appendChild(b);
  }
  el.classList.add('show');
  const hide = () => { clearTimeout(toastTimer); el.classList.remove('show'); };
  toastTimer = window.setTimeout(hide, ms);
}

/** Modal yes/no in the Halide look. Resolves true on confirm; Esc, the scrim
 *  and Cancel resolve false. */
export function confirmDialog({ title, body = '', ok = 'OK', danger = false }: { title: string; body?: string; ok?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    const scrim = document.createElement('div');
    scrim.className = 'hl-scrim';
    const box = document.createElement('div');
    box.className = 'hl-dialog';
    box.setAttribute('role', 'alertdialog');
    box.setAttribute('aria-modal', 'true');
    const h = document.createElement('h2'); h.textContent = title;
    box.appendChild(h);
    if (body) { const p = document.createElement('p'); p.textContent = body; box.appendChild(p); }
    const row = document.createElement('div'); row.className = 'hl-dialog-actions';
    const cancel = document.createElement('button'); cancel.textContent = 'Cancel';
    const yes = document.createElement('button'); yes.textContent = ok; yes.className = danger ? 'danger' : 'primary';
    row.append(cancel, yes);
    box.appendChild(row);
    scrim.appendChild(box);
    document.body.appendChild(scrim);
    requestAnimationFrame(() => scrim.classList.add('show'));
    const done = (v: boolean) => {
      removeEventListener('keydown', key, true);
      scrim.classList.remove('show');
      setTimeout(() => scrim.remove(), 180);
      resolve(v);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); done(false); }
      else if (e.key === 'Enter') { e.preventDefault(); done(true); }
    };
    addEventListener('keydown', key, true);
    cancel.onclick = () => done(false);
    yes.onclick = () => done(true);
    scrim.onclick = (e) => { if (e.target === scrim) done(false); };
    yes.focus();
  });
}
