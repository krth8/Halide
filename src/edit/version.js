// App version + release notes. Bump APP_VERSION on every public release and
// write a user-facing note — the projects overview surfaces "What's new" and
// auto-expands when the running build is newer than the one last seen in this
// browser. Newest entry first. 0.x = public beta, 1.0.0 = first stable.

export const APP_VERSION = __APP_VERSION__;

export const RELEASE_NOTES = [
  {
    v: '0.1.0', date: '2026-10-15', title: 'Halide',
    items: [
      'Process and Edit in one app: develop photos and video in Process, cut them into films in Edit.',
      'A new look across both workspaces.',
    ],
  },
];

export function semverGt(a, b) {
  if (!b) return false;
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { const x = pa[i] || 0, y = pb[i] || 0; if (x !== y) return x > y; }
  return false;
}
