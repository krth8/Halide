// Scopes shared by Process and Edit: waveform, RGB parade, vectorscope and
// histogram, sampled on the CPU from the finished picture. Call drawScopes()
// in the same task as the WebGPU submit — the only moment a WebGPU canvas
// reads back reliably. Collapsed scopes (no offsetParent) are skipped.

export interface ScopeCanvases {
  wave?: HTMLCanvasElement | null;
  parade?: HTMLCanvasElement | null;
  vector?: HTMLCanvasElement | null;
  hist?: HTMLCanvasElement | null;
}

const tmp = document.createElement('canvas');
// size a canvas only when it changed — reassigning width reallocates the backing store
const sizeC = (c: HTMLCanvasElement, w: number, h: number) => { if (c.width !== w || c.height !== h) { c.width = w; c.height = h; } };
const visible = (c?: HTMLCanvasElement | null): c is HTMLCanvasElement => !!c && c.offsetParent !== null;

export function drawScopes(src: CanvasImageSource, out: ScopeCanvases): void {
  const sw = 200, sh = 112;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  sizeC(tmp, sw, sh);
  const cx = tmp.getContext('2d', { willReadFrequently: true })!;
  cx.drawImage(src, 0, 0, sw, sh);
  const data = cx.getImageData(0, 0, sw, sh).data;

  // waveform: luma per column, accumulated into an ImageData and blitted once
  if (visible(out.wave)) {
    const W2 = 180, H2 = 70;
    sizeC(out.wave, W2, H2);
    const wc = out.wave.getContext('2d')!;
    const img = wc.createImageData(W2, H2), d8 = img.data;
    for (let p = 0; p < d8.length; p += 4) { d8[p] = 10; d8[p + 1] = 10; d8[p + 2] = 12; d8[p + 3] = 255; }
    for (let x = 0; x < sw; x++) {
      const px = ((x / sw) * W2) | 0;
      for (let y = 0; y < sh; y += 2) {
        const i = (y * sw + x) * 4;
        const l = (data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722) / 255;
        const p = ((((1 - l) * (H2 - 1)) | 0) * W2 + px) * 4;
        d8[p] = Math.min(255, d8[p] + 60); d8[p + 1] = Math.min(255, d8[p + 1] + 115); d8[p + 2] = Math.min(255, d8[p + 2] + 85);
      }
    }
    wc.putImageData(img, 0, 0);
  }

  // RGB parade: R, G, B waveforms side by side
  if (visible(out.parade)) {
    const W2 = 180, H2 = 70, seg = W2 / 3;
    sizeC(out.parade, W2, H2);
    const pc = out.parade.getContext('2d')!;
    const img = pc.createImageData(W2, H2), d8 = img.data;
    for (let p = 0; p < d8.length; p += 4) { d8[p] = 10; d8[p + 1] = 10; d8[p + 2] = 12; d8[p + 3] = 255; }
    const add = [[128, 40, 40], [45, 115, 60], [55, 75, 128]];
    for (let ch = 0; ch < 3; ch++) {
      const a = add[ch], x0 = ch * seg;
      for (let x = 0; x < sw; x++) {
        const px = (x0 + (x / sw) * seg) | 0;
        for (let y = 0; y < sh; y += 2) {
          const i = (y * sw + x) * 4;
          const p = ((((1 - data[i + ch] / 255) * (H2 - 1)) | 0) * W2 + px) * 4;
          d8[p] = Math.min(255, d8[p] + a[0]); d8[p + 1] = Math.min(255, d8[p + 1] + a[1]); d8[p + 2] = Math.min(255, d8[p + 2] + a[2]);
        }
      }
    }
    pc.putImageData(img, 0, 0);
  }

  // vectorscope: chroma on the U/V plane (colour balance and saturation)
  if (visible(out.vector)) {
    const S = Math.round(80 * dpr);
    sizeC(out.vector, S, S);
    const vc = out.vector.getContext('2d', { willReadFrequently: true })!;
    vc.fillStyle = '#0a0a0c'; vc.fillRect(0, 0, S, S);
    vc.strokeStyle = 'rgba(255,255,255,.08)';
    vc.beginPath(); vc.arc(S / 2, S / 2, S / 2 - 2, 0, 7); vc.stroke();
    vc.beginPath(); vc.moveTo(S / 2, 4); vc.lineTo(S / 2, S - 4); vc.moveTo(4, S / 2); vc.lineTo(S - 4, S / 2); vc.stroke();
    const img = vc.getImageData(0, 0, S, S), px = img.data;
    for (let i = 0; i < data.length; i += 8) {
      const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
      const u = -0.169 * r - 0.331 * g + 0.5 * b;
      const v = 0.5 * r - 0.419 * g - 0.081 * b;
      const x = Math.round(S / 2 + u * (S - 6)), y = Math.round(S / 2 - v * (S - 6));
      if (x < 0 || y < 0 || x >= S || y >= S) continue;
      const p = (y * S + x) * 4;
      px[p] = Math.min(255, px[p] + 60); px[p + 1] = Math.min(255, px[p + 1] + 200); px[p + 2] = Math.min(255, px[p + 2] + 90); px[p + 3] = 255;
    }
    vc.putImageData(img, 0, 0);
  }

  // histogram: R, G, B, added together
  if (visible(out.hist)) {
    sizeC(out.hist, 180 * dpr, 70 * dpr);
    const hc = out.hist.getContext('2d')!;
    hc.setTransform(1, 0, 0, 1, 0, 0); hc.scale(dpr, dpr);
    hc.fillStyle = '#0a0a0c'; hc.fillRect(0, 0, 180, 70);
    const bins = [new Uint32Array(64), new Uint32Array(64), new Uint32Array(64)];
    for (let i = 0; i < data.length; i += 4) { bins[0][data[i] >> 2]++; bins[1][data[i + 1] >> 2]++; bins[2][data[i + 2] >> 2]++; }
    let max = 1;
    for (const b of bins) for (const v of b) if (v > max) max = v;
    const cols = ['rgba(255,90,90,.6)', 'rgba(120,230,120,.6)', 'rgba(120,150,255,.6)'];
    hc.globalCompositeOperation = 'lighter';
    bins.forEach((b, ci) => { hc.fillStyle = cols[ci]; for (let i = 0; i < 64; i++) { const hh = (b[i] / max) * 70; hc.fillRect((i / 64) * 180, 70 - hh, 180 / 64, hh); } });
    hc.globalCompositeOperation = 'source-over';
  }
}
