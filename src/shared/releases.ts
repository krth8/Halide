// Release notes for Halide as a whole, newest first. Each line says which
// workspace it is about; the launcher shows that as a badge. Bump the version
// in package.json with every public release and write the notes for users.

export type Tag = 'all' | 'process' | 'edit';
export interface Release { v: string; date: string; title: string; items: { ws: Tag; text: string }[] }

export const RELEASES: Release[] = [
  {
    v: '0.3.0', date: '2026-10-15', title: 'RAW photos',
    items: [
      { ws: 'process', text: 'Open RAW photos straight from the camera — CR3, CR2, NEF, ARW, DNG, RAF, ORF, RW2 and many more. Thumbnails appear at once, and RAW files are developed with the camera’s white balance and colour.' },
      { ws: 'process', text: 'Exports from RAW use the full sensor resolution.' },
    ],
  },
  {
    v: '0.2.0', date: '2026-10-15', title: 'Projects in both workspaces',
    items: [
      { ws: 'all', text: 'Your projects live on the start page: open, rename, duplicate or delete them from one place, and see what’s new.' },
      { ws: 'process', text: 'Process saves projects too. It remembers where your photos and videos are instead of copying them, so even large libraries reopen instantly.' },
      { ws: 'process', text: 'Reopened projects reconnect their files with one tap; files that moved can be found again with Locate….' },
      { ws: 'process', text: 'Fixed photos that showed “Could not read the image”.' },
    ],
  },
  {
    v: '0.1.0', date: '2026-10-15', title: 'Halide',
    items: [
      { ws: 'all', text: 'Process and Edit in one app: develop photos and video in Process, cut films in Edit.' },
      { ws: 'all', text: 'A new look across both workspaces.' },
    ],
  },
];

export function semverGt(a: string, b: string | null): boolean {
  if (!b) return false;
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) { const x = pa[i] || 0, y = pb[i] || 0; if (x !== y) return x > y; }
  return false;
}
