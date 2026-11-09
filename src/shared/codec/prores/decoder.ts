// ProRes decoding on the GPU. The CPU only parses the frame (bitstream.ts);
// one compute workgroup per slice and component then reads its bits, and the
// same workgroup dequantises and inverse-DCTs the blocks and writes the
// pixels. A 4K frame has ~4000 slices, so ~12000 workgroups run side by side.
//
// Output: Y, Cb and Cr planes as r32float textures holding code values
// (0…1023 for 10-bit, 0…4095 for 12-bit), at the frame's chroma size.
import { parseFrame, SLICE_WORDS, PROGRESSIVE_SCAN, INTERLACED_SCAN, type ProResFrame } from './bitstream';

export interface Planes { y: GPUTexture; u: GPUTexture; v: GPUTexture; frame: ProResFrame }

const WGSL = /* wgsl */`
struct P { a: vec4u, b: vec4u };   // width, height, chroma444, frameType | bits, sliceCount
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var<storage, read> bits: array<u32>;
@group(0) @binding(2) var<storage, read> slices: array<u32>;
@group(0) @binding(3) var<storage, read> tabs: array<u32>;   // qmat luma | qmat chroma | scan
@group(0) @binding(4) var outY: texture_storage_2d<r32float, write>;
@group(0) @binding(5) var outU: texture_storage_2d<r32float, write>;
@group(0) @binding(6) var outV: texture_storage_2d<r32float, write>;

var<workgroup> blk: array<i32, 2048>;   // up to 32 blocks of 8×8 (8 macroblocks of luma or 4:4:4 chroma)
var<workgroup> ok: u32;

fn bswap(x: u32) -> u32 { return (x << 24u) | ((x & 0xff00u) << 8u) | ((x >> 8u) & 0xff00u) | (x >> 24u); }
// the next 32 bits of the big-endian stream from bit p
fn peek(p: u32) -> u32 {
  let w = p >> 5u; let s = p & 31u;
  let a = bswap(bits[w]);
  if (s == 0u) { return a; }
  return (a << s) | (bswap(bits[w + 1u]) >> (32u - s));
}

// one Rice / exp-Golomb codeword (DECODE_CODEWORD in FFmpeg); 0xffffffff = damaged
fn codeword(p: ptr<function, u32>, cb: u32) -> u32 {
  let buf = peek(*p);
  let sw = cb & 3u; let rice = cb >> 5u; let expo = (cb >> 2u) & 7u;
  let q = countLeadingZeros(buf);
  if (q > sw) {
    let n = expo - sw + (q << 1u);
    if (n > 31u) { return 0xffffffffu; }
    let v = (buf >> (32u - n)) - (1u << expo) + ((sw + 1u) << rice);
    *p = *p + n;
    return v;
  }
  if (rice > 0u) {
    let v = (q << rice) + ((buf << (q + 1u)) >> (32u - rice));
    *p = *p + q + 1u + rice;
    return v;
  }
  *p = *p + q + 1u;
  return q;
}

const DC_CB = array<u32, 7>(0x04u, 0x28u, 0x28u, 0x4Du, 0x4Du, 0x70u, 0x70u);
const RUN_CB = array<u32, 16>(0x06u, 0x06u, 0x05u, 0x05u, 0x04u, 0x29u, 0x29u, 0x29u, 0x29u, 0x28u, 0x28u, 0x28u, 0x28u, 0x28u, 0x28u, 0x4Cu);
const LEV_CB = array<u32, 10>(0x04u, 0x0Au, 0x05u, 0x06u, 0x04u, 0x28u, 0x28u, 0x28u, 0x28u, 0x4Cu);

fn entropy(start: u32, size: u32, nb: u32, log2nb: u32) -> bool {
  var p = start * 8u;
  let end = p + size * 8u;
  // DC: the first value, then differences with an adaptive codebook
  var code = codeword(&p, 0xB8u);
  if (code == 0xffffffffu) { return false; }
  var prev = i32(code >> 1u) ^ -i32(code & 1u);
  blk[0] = prev;
  code = 5u;
  var sgn = 0i;
  for (var i = 1u; i < nb; i++) {
    code = codeword(&p, DC_CB[min(code, 6u)]);
    if (code == 0xffffffffu) { return false; }
    if (code != 0u) { sgn = sgn ^ -i32(code & 1u); } else { sgn = 0i; }
    prev = prev + ((i32((code + 1u) >> 1u) ^ sgn) - sgn);
    blk[i * 64u] = prev;
  }
  // AC: run/level pairs, interleaved across the blocks of the slice
  var run = 4u; var lev = 2u;
  let mask = nb - 1u;
  let maxc = 64u << log2nb;
  var pos = mask;
  loop {
    if (p >= end) { break; }
    let left = end - p;
    if (left < 32u && (peek(p) >> (32u - left)) == 0u) { break; }
    run = codeword(&p, RUN_CB[min(run, 15u)]);
    if (run == 0xffffffffu) { return false; }
    pos = pos + run + 1u;
    if (pos >= maxc) { return false; }
    lev = codeword(&p, LEV_CB[min(lev, 9u)]);
    if (lev == 0xffffffffu) { return false; }
    lev = lev + 1u;
    let neg = (peek(p) >> 31u) == 1u;
    p = p + 1u;
    let at = ((pos & mask) << 6u) + tabs[128u + (pos >> log2nb)];
    blk[at] = select(i32(lev), -i32(lev), neg);
  }
  return true;
}

// 1-D orthonormal IDCT: f(x) = ½ Σ c(u)·F(u)·cos((2x+1)uπ/16)
const K = array<f32, 8>(0.35355339, 0.49039264, 0.46193977, 0.41573481, 0.35355339, 0.27778512, 0.19134172, 0.09754516);
fn idct8(i: array<f32, 8>) -> array<f32, 8> {
  var o: array<f32, 8>;
  for (var x = 0u; x < 8u; x++) {
    var s = 0.0;
    for (var u = 0u; u < 8u; u++) {
      // cos((2x+1)uπ/16) via the table: fold the angle into 0…π/2 and track the sign
      var a = ((2u * x + 1u) * u) % 32u;
      var sg = 1.0;
      if (a > 16u) { a = 32u - a; }
      if (a > 8u) { a = 16u - a; sg = -1.0; }
      var c: f32;
      if (u == 0u) { c = K[0]; } else if (a == 8u) { c = 0.0; } else { c = K[a] * sg; }
      s = s + c * i[u];
    }
    o[x] = s;
  }
  return o;
}

@compute @workgroup_size(64)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) li: u32) {
  let si = wg.x + wg.y * 65535u;
  let comp = wg.z;
  if (si >= prm.b.y) { return; }
  let s = si * ${SLICE_WORDS}u;
  let mbX = slices[s + 4u]; let mbY = slices[s + 5u]; let nmb = slices[s + 6u];
  let qs = slices[s + 7u] & 0xffffu; let field = slices[s + 7u] >> 16u;
  let c444 = prm.a.z == 1u;
  // blocks per macroblock: 4 luma; chroma 2 (4:2:2) or 4 (4:4:4)
  let bpm = select(select(2u, 4u, c444), 4u, comp == 0u);
  let nb = nmb * bpm;
  let log2nb = firstTrailingBit(nb);
  var start = slices[s];
  var size = slices[s + 1u];
  if (comp >= 1u) { start = start + slices[s + 1u]; size = slices[s + 2u]; }
  if (comp == 2u) { start = start + slices[s + 2u]; size = slices[s + 3u]; }

  for (var i = li; i < nb * 64u; i += 64u) { blk[i] = 0i; }
  workgroupBarrier();
  if (li == 0u) { ok = 1u; if (size > 0u && !entropy(start, size, nb, log2nb)) { ok = 0u; } }
  workgroupBarrier();

  // rows: dequantise and transform in place (results stored as f32 bits)
  let qbase = select(64u, 0u, comp == 0u);
  for (var k = li; k < nb * 8u; k += 64u) {
    let o = (k >> 3u) * 64u + (k & 7u) * 8u;
    var r: array<f32, 8>;
    for (var u = 0u; u < 8u; u++) { r[u] = f32(blk[o + u]) * f32(tabs[qbase + (k & 7u) * 8u + u] * qs); }
    let t = idct8(r);
    for (var x = 0u; x < 8u; x++) { blk[o + x] = bitcast<i32>(t[x]); }
  }
  workgroupBarrier();

  // columns, then the pixels: 10-bit = 512 + f/4, 12-bit = 2048 + f, clipped as FFmpeg does
  let b12 = prm.b.x == 12u;
  let hi = select(1019.0, 4091.0, b12);
  let parity = field ^ select(0u, 1u, prm.a.w == 2u);
  let step = select(1u, 2u, prm.a.w != 0u);
  let pw = select(select((prm.a.x + 1u) / 2u, prm.a.x, c444), prm.a.x, comp == 0u);
  for (var k = li; k < nb * 8u; k += 64u) {
    let b = k >> 3u; let x = k & 7u;
    var c: array<f32, 8>;
    for (var v = 0u; v < 8u; v++) { c[v] = bitcast<f32>(blk[b * 64u + v * 8u + x]); }
    let t = idct8(c);
    var px: u32; var py: u32;
    if (comp == 0u) {
      let mb = b >> 2u; let sub = b & 3u;
      px = (mbX + mb) * 16u + (sub & 1u) * 8u; py = mbY * 16u + (sub >> 1u) * 8u;
    } else if (c444) {
      let mb = b >> 2u; let sub = b & 3u;
      px = (mbX + mb) * 16u + (sub >> 1u) * 8u; py = mbY * 16u + (sub & 1u) * 8u;
    } else {
      let mb = b >> 1u; let sub = b & 1u;
      px = (mbX + mb) * 8u; py = mbY * 16u + sub * 8u;
    }
    let X = px + x;
    if (X >= pw) { continue; }
    for (var y = 0u; y < 8u; y++) {
      let Y = (py + y) * step + select(0u, parity, step == 2u);
      if (Y >= prm.a.y) { break; }
      var val = select(t[y] * 0.25 + 512.0, t[y] + 2048.0, b12);
      val = clamp(round(val), 4.0, hi);
      if (ok == 0u) { val = select(512.0, 2048.0, b12); }
      if (comp == 0u) { textureStore(outY, vec2u(X, Y), vec4f(val)); }
      else if (comp == 1u) { textureStore(outU, vec2u(X, Y), vec4f(val)); }
      else { textureStore(outV, vec2u(X, Y), vec4f(val)); }
    }
  }
}`;

export class ProResDecoder {
  private pipe: GPUComputePipeline;
  private params: GPUBuffer;
  private tabs: GPUBuffer;
  private bits: GPUBuffer | null = null;
  private slices: GPUBuffer | null = null;
  private planes: Omit<Planes, 'frame'> | null = null;

  constructor(readonly device: GPUDevice) {
    this.pipe = device.createComputePipeline({
      label: 'prores', layout: 'auto',
      compute: { module: device.createShaderModule({ label: 'prores', code: WGSL }), entryPoint: 'main' },
    });
    this.params = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.tabs = device.createBuffer({ size: 192 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  }

  private buffer(old: GPUBuffer | null, bytes: number): GPUBuffer {
    if (old && old.size >= bytes) return old;
    old?.destroy();
    return this.device.createBuffer({ size: Math.ceil((bytes * 1.25) / 4) * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  }

  private plane(old: GPUTexture | undefined, w: number, h: number): GPUTexture {
    if (old && old.width === w && old.height === h) return old;
    old?.destroy();
    return this.device.createTexture({
      size: [w, h], format: 'r32float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    });
  }

  /** Decodes one frame (a whole ProRes sample) into the planes, recorded on `enc`. */
  decode(enc: GPUCommandEncoder, sample: Uint8Array, bits: 10 | 12): Planes {
    const { device } = this;
    const f = parseFrame(sample, bits);
    // the bitstream, padded so the shader can always read one word past the end
    const padded = Math.ceil(sample.length / 4) * 4 + 8;
    this.bits = this.buffer(this.bits, padded);
    const words = new Uint8Array(padded);
    words.set(sample);
    device.queue.writeBuffer(this.bits, 0, words);
    this.slices = this.buffer(this.slices, f.slices.byteLength);
    device.queue.writeBuffer(this.slices, 0, f.slices);
    const tabs = new Uint32Array(192);
    tabs.set(f.qmatLuma, 0); tabs.set(f.qmatChroma, 64);
    tabs.set(f.frameType ? INTERLACED_SCAN : PROGRESSIVE_SCAN, 128);
    device.queue.writeBuffer(this.tabs, 0, tabs);
    device.queue.writeBuffer(this.params, 0, new Uint32Array([f.width, f.height, f.chroma444 ? 1 : 0, f.frameType, f.bits, f.sliceCount, 0, 0]));

    const cw = f.chroma444 ? f.width : (f.width + 1) >> 1;
    const p = this.planes;
    this.planes = { y: this.plane(p?.y, f.width, f.height), u: this.plane(p?.u, cw, f.height), v: this.plane(p?.v, cw, f.height) };

    const bg = device.createBindGroup({
      layout: this.pipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.params } },
        { binding: 1, resource: { buffer: this.bits } },
        { binding: 2, resource: { buffer: this.slices } },
        { binding: 3, resource: { buffer: this.tabs } },
        { binding: 4, resource: this.planes.y.createView() },
        { binding: 5, resource: this.planes.u.createView() },
        { binding: 6, resource: this.planes.v.createView() },
      ],
    });
    const pass = enc.beginComputePass({ label: 'prores' });
    pass.setPipeline(this.pipe);
    pass.setBindGroup(0, bg);
    const gx = Math.min(f.sliceCount, 65535), gy = Math.ceil(f.sliceCount / 65535);
    pass.dispatchWorkgroups(gx, gy, 3);
    pass.end();
    return { ...this.planes, frame: f };
  }

  destroy() {
    this.bits?.destroy(); this.slices?.destroy(); this.params.destroy(); this.tabs.destroy();
    this.planes?.y.destroy(); this.planes?.u.destroy(); this.planes?.v.destroy();
  }
}
