// Release notes for Halide as a whole, newest first. Each line says which
// workspace it is about; the launcher shows that as a badge. Bump the version
// in package.json with every public release and write the notes for users.

export type Tag = 'all' | 'process' | 'edit';
export interface Release { v: string; date: string; title: string; items: { ws: Tag; text: string }[] }

export const RELEASES: Release[] = [
  {
    v: '0.6.0', date: '2026-11-09', title: 'ProRes without a proxy',
    items: [
      { ws: 'edit', text: 'ProRes plays straight from the original, decoded on the graphics card: no proxy to wait for, instant scrubbing, and full 10/12-bit colour into the grade and the export. Works for Proxy, LT, 422, HQ, 4444 and XQ.' },
      { ws: 'edit', text: 'Sound from ProRes files plays in sync, and audio that is still loading when you press play joins in time instead of starting late.' },
    ],
  },
  {
    v: '0.5.0', date: '2026-11-06', title: 'RAW with highlight headroom',
    items: [
      { ws: 'process', text: 'RAW photos are developed in 16-bit float. Highlights that used to clip can be brought back with Exposure or Highlights, and gradients are smoother.' },
      { ws: 'all', text: 'Reconnect a project’s missing files in one tap: pick them all at once and Halide matches each to its clip or photo.' },
      { ws: 'all', text: 'Allow a folder once and files picked from it come back by themselves next time — useful on Android, which forgets file access between sessions.' },
      { ws: 'all', text: 'iPhone: the launcher shows how to add Halide to the Home Screen.' },
      { ws: 'edit', text: 'Phone portrait: the header sits on one row with the tabs below, clear of the camera cutout. Import buttons on the empty Media tab, and a Reconnect button for clips without their original.' },
      { ws: 'process', text: 'With media loaded the picture itself fills the view, with the video bar right under it.' },
    ],
  },
  {
    v: '0.4.1', date: '2026-10-15', title: 'Fixes',
    items: [
      { ws: 'edit', text: 'A clip added under the playhead shows in the viewer straight away, instead of after the first scrub.' },
    ],
  },
  {
    v: '0.4.0', date: '2026-10-15', title: 'One engine for both workspaces',
    items: [
      { ws: 'all', text: 'Process and Edit now share one WebGPU engine: the same colour maths, effects and scopes in both.' },
      { ws: 'edit', text: 'New effects from Process: Grain, Halation, Blur (tilt-shift, radial or whole frame), Clarity, Texture and Dehaze. Glow uses the smoother multi-step bloom.' },
      { ws: 'edit', text: 'Put photos on the timeline — JPEG, PNG, HEIC and camera RAW (CR3, NEF, ARW, DNG…). A photo plays for 5 seconds and can be stretched to any length.' },
      { ws: 'process', text: 'Scopes: histogram, waveform, RGB parade and vectorscope, from the button in the header.' },
      { ws: 'process', text: 'Rendering moved to WebGPU — the same look, now on the engine Edit uses.' },
    ],
  },
  {
    v: '0.3.2', date: '2026-10-15', title: 'Fixes',
    items: [
      { ws: 'process', text: 'Slider rails are visible again — only the coloured part showed.' },
    ],
  },
  {
    v: '0.3.1', date: '2026-10-15', title: 'Smoother project management',
    items: [
      { ws: 'all', text: 'Rename projects right on their card, and undo a delete from the message that follows.' },
      { ws: 'edit', text: 'Clearing the proxy cache asks in Halide’s own dialog.' },
    ],
  },
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
