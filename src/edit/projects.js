// Projects: the launcher (root page) lists, creates and manages projects;
// this page opens the one named in its URL. The Projects button goes back to
// the launcher — the editor autosaves, so nothing is lost on the way.
import { el } from './util.js';
import { bus } from './state.js';
import { loadCurrentProject, setRestoring } from './store.js';
import { resetForNewProject, restore as restoreMedia } from './tabs/media.js';
import { BASE } from '../shared/paths.ts';

let onSwitch = null; // callback(proj) to re-seed engine/history after a load

export function initProjects(afterLoad) {
  onSwitch = afterLoad;
  const b = el('projBtn');
  if (b) { b.onclick = () => { location.href = BASE; }; b.title = 'All projects'; }
}

/** Opens the project in the URL (?p=<id>); without one the editor starts empty. */
export async function bootProject() {
  setRestoring(true);
  try {
    const proj = await loadCurrentProject();
    if (!proj) return;
    resetForNewProject();
    await restoreMedia(proj);
    onSwitch?.(proj);
    bus.emit('projects:switched');
  } finally { setRestoring(false); }
}
