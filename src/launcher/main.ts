import '../shared/theme.css';
import './launcher.css';
import { boot } from '../shared/boot';
import { BASE } from '../shared/paths';
import { halideMark, PROCESS_GLYPH, EDIT_GLYPH } from '../shared/brand';
import { listProjects, renameProject, duplicateProject, deleteProject, workspaceUrl, type ProjectMeta, type Workspace } from '../shared/projects';
import { RELEASES, semverGt, type Tag } from '../shared/releases';

const $ = (id: string) => document.getElementById(id)!;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
$('mark').innerHTML = halideMark();
$('gProcess').innerHTML = PROCESS_GLYPH;
$('gEdit').innerHTML = EDIT_GLYPH;
$('foot').textContent = `v${__APP_VERSION__} · WebGPU · works offline once loaded`;

const LABEL: Record<Workspace, string> = { process: 'Process', edit: 'Edit' };
const badge = (t: Tag) => t === 'all' ? '' : `<span class="ws ${t}">${LABEL[t]}</span>`;

/* ---------- projects ---------- */
let filter: 'all' | Workspace = 'all';
try { const f = localStorage.getItem('halide.filter'); if (f === 'process' || f === 'edit') filter = f; } catch { /* private mode */ }

function when(t: number): string {
  const d = new Date(t), now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}
const countLabel = (p: ProjectMeta) => p.ws === 'edit'
  ? `${p.count} clip${p.count === 1 ? '' : 's'}`
  : `${p.count} item${p.count === 1 ? '' : 's'}`;

async function renderProjects(): Promise<void> {
  const all = await listProjects().catch(() => [] as ProjectMeta[]);
  $('recent').hidden = !all.length;
  document.querySelectorAll<HTMLButtonElement>('#filter button').forEach((b) => b.classList.toggle('on', b.dataset.f === filter));
  const shown = all.filter((p) => filter === 'all' || p.ws === filter);
  const grid = $('grid');
  grid.replaceChildren();
  if (!shown.length) { grid.innerHTML = `<p class="none">No ${filter === 'all' ? '' : LABEL[filter as Workspace] + ' '}projects yet.</p>`; return; }
  for (const p of shown) {
    const a = document.createElement('a');
    a.className = 'card';
    a.href = workspaceUrl(BASE, p.ws, p.id);
    a.innerHTML = `
      <span class="thumb">${p.thumb ? `<img src="${p.thumb}" alt="" loading="lazy">` : ''}${badge(p.ws)}</span>
      <span class="name" title="${esc(p.name)}">${esc(p.name)}</span>
      <span class="meta">${countLabel(p)} · ${when(p.modified)}</span>
      <span class="acts">
        <button data-a="rename" title="Rename" aria-label="Rename">✎</button>
        <button data-a="dup" title="Duplicate" aria-label="Duplicate">⧉</button>
        <button data-a="del" title="Delete" aria-label="Delete">✕</button>
      </span>`;
    a.querySelector('.acts')!.addEventListener('click', async (e) => {
      e.preventDefault(); e.stopPropagation();
      const act = (e.target as HTMLElement).closest('button')?.dataset.a;
      if (act === 'rename') {
        const name = prompt('Rename project', p.name);
        if (name === null) return;
        await renameProject(p.id, name.trim() || p.name);
      } else if (act === 'dup') await duplicateProject(p.id);
      else if (act === 'del') {
        if (!confirm(`Delete “${p.name}”? Your photos and videos are not touched — only the project.`)) return;
        await deleteProject(p.id);
      } else return;
      renderProjects();
    });
    grid.appendChild(a);
  }
}
document.querySelectorAll<HTMLButtonElement>('#filter button').forEach((b) => b.onclick = () => {
  filter = b.dataset.f as typeof filter;
  try { localStorage.setItem('halide.filter', filter); } catch { /* private mode */ }
  renderProjects();
});
// back from a workspace via the browser's back button: the bfcache page is stale
addEventListener('pageshow', (e) => { if (e.persisted) renderProjects(); });

/* ---------- what's new ---------- */
function renderNews(): void {
  let seen: string | null = null;
  try { seen = localStorage.getItem('halide.version'); localStorage.setItem('halide.version', __APP_VERSION__); } catch { /* private mode */ }
  const updated = semverGt(__APP_VERSION__, seen);
  const fresh = (v: string) => (seen ? semverGt(v, seen) : false);
  const box = $('news');
  box.innerHTML = `
    <details ${updated ? 'open' : ''}>
      <summary><span>What’s new</span>${updated ? '<span class="new">Updated</span>' : ''}</summary>
      ${RELEASES.map((r) => `
        <article>
          <h3><b>v${r.v}</b><span>${esc(r.title)}</span><time>${r.date}</time>${fresh(r.v) ? '<span class="new">New</span>' : ''}</h3>
          <ul>${r.items.map((it) => `<li>${badge(it.ws)}<span>${esc(it.text)}</span></li>`).join('')}</ul>
        </article>`).join('')}
    </details>`;
}

/* ---------- install ---------- */
const isApp = () => matchMedia('(display-mode: standalone), (display-mode: fullscreen), (display-mode: minimal-ui), (display-mode: window-controls-overlay)').matches
  || (navigator as { standalone?: boolean }).standalone === true;
let installEv: (Event & { prompt(): Promise<void>; userChoice: Promise<unknown> }) | null = null;
addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEv = e as typeof installEv;
  if (!isApp()) $('install').hidden = false;
});
addEventListener('appinstalled', () => { $('install').hidden = true; });
$('install').onclick = async () => {
  if (!installEv) return;
  await installEv.prompt();
  try { await installEv.userChoice; } catch { /* dismissed */ }
  installEv = null; $('install').hidden = true;
};

renderProjects();
renderNews();
boot();
