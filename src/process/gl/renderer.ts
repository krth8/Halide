import * as S from './shaders';
import { finalLUT } from '../curves';
import { FMAP } from '../looks';
import { maskParams, wbGains, type Mask, type Params } from '../model';
import { geometry, type Corr } from '../geo';
import type { CubeLut } from '../cube';

interface Prog { p: WebGLProgram; u: Map<string, WebGLUniformLocation | null> }
interface Target { tex: WebGLTexture; fb: WebGLFramebuffer; w: number; h: number }
interface Src { tex: WebGLTexture; w: number; h: number; mip: boolean }

export interface RenderOpts { bypass?: boolean; seed?: number; lut?: CubeLut | null; masks?: Mask[]; corr?: Corr | null }

const hue2rgb = (h: number): [number, number, number] => {
  h = (((h % 360) + 360) % 360) / 60;
  const x = 1 - Math.abs((h % 2) - 1);
  return h < 1 ? [1, x, 0] : h < 2 ? [x, 1, 0] : h < 3 ? [0, 1, x] : h < 4 ? [0, x, 1] : h < 5 ? [x, 0, 1] : [1, 0, x];
};
const BAND_H = new Float32Array([0, 30, 58, 115, 180, 222, 270, 318]);

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  readonly maxTex: number;
  private progs: Record<string, Prog> = {};
  private vao: WebGLVertexArrayObject;
  private src: Src | null = null;
  private own: WebGLTexture;                       // texture used by setSource()
  private cache = new WeakMap<object, Src>();       // per-item textures (thumbnails)
  private curveTex: WebGLTexture;
  private curveKey = '';
  private lutTex: WebGLTexture;
  private lutId: string | null = null;
  private lutSize = 2;
  private dummy: WebGLTexture;
  private tmp: Record<string, Target | null> = {};
  private down: Target[] = [];
  private up: Target[] = [];
  private hdr: boolean;

  constructor(readonly canvas: HTMLCanvasElement, preserve = false) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: preserve });
    if (!gl) throw new Error('This browser does not support WebGL2');
    this.gl = gl;
    this.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.hdr = !!gl.getExtension('EXT_color_buffer_float');
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    for (const [k, fs] of Object.entries({ mask: S.FS_MASK, minch: S.FS_MINCH, local: S.FS_LOCAL, grade: S.FS_GRADE, bright: S.FS_BRIGHT, down: S.FS_DOWN, up: S.FS_UP, gauss: S.FS_GAUSS, finish: S.FS_FINISH, copy: S.FS_COPY })) {
      this.progs[k] = this.program(fs);
    }
    this.own = this.tex2d();
    this.curveTex = this.tex2d();
    this.dummy = this.tex2d();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    this.lutTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, this.lutTex);
    for (const [p, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_3D, p, v);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, 1, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
  }

  private program(fs: string): Prog {
    const gl = this.gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('Shader: ' + gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, S.VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, 'a_pos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Program: ' + gl.getProgramInfoLog(p));
    return { p, u: new Map() };
  }

  private tex2d(): WebGLTexture {
    const gl = this.gl, t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  private target(old: Target | null, w: number, h: number, hdr = false): Target {
    if (old && old.w === w && old.h === h) return old;
    const gl = this.gl;
    if (old) { gl.deleteTexture(old.tex); gl.deleteFramebuffer(old.fb); }
    const tex = this.tex2d();
    if (hdr && this.hdr) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex, fb, w, h };
  }

  private upload(tex: WebGLTexture, img: TexImageSource) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
  }

  /** Upload a new source frame (image bitmap, video element, VideoFrame…). */
  setSource(img: TexImageSource, w: number, h: number) {
    this.upload(this.own, img);
    this.src = { tex: this.own, w, h, mip: false };
  }

  /** Use a cached texture for `key` (uploaded once), e.g. a thumbnail bitmap. */
  setCachedSource(key: object, img: TexImageSource, w: number, h: number) {
    let s = this.cache.get(key);
    if (!s) {
      const tex = this.tex2d();
      this.upload(tex, img);
      s = { tex, w, h, mip: false };
      this.cache.set(key, s);
    }
    this.src = s;
  }

  private use(name: string): Prog {
    const pr = this.progs[name];
    this.gl.useProgram(pr.p);
    return pr;
  }
  private loc(pr: Prog, n: string) {
    if (!pr.u.has(n)) pr.u.set(n, this.gl.getUniformLocation(pr.p, n));
    return pr.u.get(n)!;
  }
  private f(pr: Prog, n: string, ...v: number[]) {
    const l = this.loc(pr, n), gl = this.gl;
    if (v.length === 1) gl.uniform1f(l, v[0]); else if (v.length === 2) gl.uniform2f(l, v[0], v[1]); else gl.uniform3f(l, v[0], v[1], v[2]);
  }
  private i(pr: Prog, n: string, v: number) { this.gl.uniform1i(this.loc(pr, n), v); }
  private bind(unit: number, tex: WebGLTexture, pr: Prog, name: string) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    this.i(pr, name, unit);
  }
  private draw(t: Target | null, w: number, h: number, pr: Prog, flip = 0) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fb : null);
    gl.viewport(0, 0, w, h);
    this.f(pr, 'u_flip', flip);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  render(P: Params, W: number, H: number, opts: RenderOpts = {}) {
    const gl = this.gl, src = this.src;
    if (!src) return;
    W = Math.max(1, Math.round(W)); H = Math.max(1, Math.round(H));
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
    gl.bindVertexArray(this.vao);

    if (!src.mip && src.w > W * 1.6) {
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      src.mip = true;
    }

    const geo = geometry(src.w, src.h, P, opts.corr).m;
    if (opts.bypass) {
      const pr = this.use('copy');
      this.bind(0, src.tex, pr, 'u_src');
      this.gl.uniformMatrix3fv(this.loc(pr, 'u_geo'), false, geo);
      this.draw(null, W, H, pr, 1);
      return;
    }

    // 1. grade (+ presence), then each mask's own grade blended over it
    let base = this.gradePass(P, W, H, opts, 'b', geo);
    let mixes = 0;
    for (const m of opts.masks ?? []) {
      if (!m.on || !m.amount) continue;
      const graded = this.gradePass(maskParams(P, m), W, H, opts, 'm', geo);
      const out = this.slot('mix' + (mixes++ % 2), W, H);
      const pm = this.use('mask');
      this.bind(0, base.tex, pm, 'u_a');
      this.bind(1, graded.tex, pm, 'u_b');
      this.i(pm, 'u_type', m.type === 'linear' ? 0 : 1);
      this.i(pm, 'u_inv', m.invert ? 1 : 0);
      this.f(pm, 'u_p0', m.a[0], m.a[1]);
      this.f(pm, 'u_p1', m.b[0], m.b[1]);
      this.f(pm, 'u_feather', m.feather / 100);
      this.f(pm, 'u_amount', m.amount / 100);
      this.f(pm, 'u_aspect', W / H);
      this.draw(out, W, H, pm);
      base = out;
    }
    let pr: Prog;

    // 3. blur
    const blurOn = P.blur > 0;
    let blurTex = this.dummy;
    if (blurOn) blurTex = this.gaussian(base, (P.blur / 100) * W * 0.012, 'blur').tex;

    // 3. multi-step bloom: bright pass, dual-filter down chain, weighted up chain
    const glowOn = P.bloom > 0 || P.halation > 0;
    let bloomTex = this.dummy, halTex = this.dummy, norm = 1;
    if (glowOn) {
      let w = Math.ceil(W / 2), h = Math.ceil(H / 2);
      const n = Math.max(2, Math.min(10, Math.floor(Math.log2(Math.min(w, h))) - 2));
      for (let k = 0; k < n; k++) {
        this.down[k] = this.target(this.down[k] ?? null, w, h, true);
        this.up[k] = this.target(this.up[k] ?? null, w, h, true);
        w = Math.max(1, Math.ceil(w / 2)); h = Math.max(1, Math.ceil(h / 2));
      }
      pr = this.use('bright');
      this.bind(0, base.tex, pr, 'u_src');
      this.f(pr, 'u_thr', P.bloomThr / 100);
      this.draw(this.down[0], this.down[0].w, this.down[0].h, pr);
      pr = this.use('down');
      for (let k = 1; k < n; k++) {
        const s = this.down[k - 1];
        this.bind(0, s.tex, pr, 'u_src');
        this.f(pr, 'u_texel', 1 / s.w, 1 / s.h);
        this.draw(this.down[k], this.down[k].w, this.down[k].h, pr);
      }
      const wgt = 0.4 + (P.bloomRadius / 100) * 0.6;
      pr = this.use('up');
      let coarse = this.down[n - 1];
      for (let k = n - 2; k >= 0; k--) {
        this.bind(0, coarse.tex, pr, 'u_src');
        this.bind(1, this.down[k].tex, pr, 'u_cur');
        this.f(pr, 'u_texel', 1 / coarse.w, 1 / coarse.h);
        this.f(pr, 'u_w', wgt);
        this.draw(this.up[k], this.up[k].w, this.up[k].h, pr);
        coarse = this.up[k];
      }
      for (let k = 0; k < n; k++) norm += Math.pow(wgt, k + 1);
      bloomTex = this.up[0].tex;
      halTex = this.down[Math.min(2, n - 1)].tex;
    }

    // 4. finish to canvas
    pr = this.use('finish');
    this.bind(0, base.tex, pr, 'u_a');
    this.bind(1, blurTex, pr, 'u_blur');
    this.bind(2, bloomTex, pr, 'u_bloom');
    this.bind(3, halTex, pr, 'u_hal');
    this.i(pr, 'u_blurOn', blurOn ? 1 : 0);
    this.i(pr, 'u_blurMode', P.blurMode === 'tilt' ? 0 : P.blurMode === 'radial' ? 1 : 2);
    this.f(pr, 'u_bloomK', P.bloom > 0 ? ((P.bloom / 100) * 2.2) / norm : 0);
    this.f(pr, 'u_halK', (P.halation / 100) * 1.6);
    this.f(pr, 'u_vig', P.vignette / 100);
    this.f(pr, 'u_vigIn', 0.78 - (P.vigSize / 100) * 0.6);
    // Width of the fall-off: 0 = hard edge, 100 = very gradual. 50 matches the original look.
    this.f(pr, 'u_vigW', 0.06 + ((P.vigFeather ?? 50) / 100) * 1.02);
    this.f(pr, 'u_grain', (P.grain / 100) * 0.16);
    // Grain size is defined relative to the image (a 2000 px long side is the reference).
    this.f(pr, 'u_grainSize', (P.grainSize * Math.max(W, H)) / 2000);
    this.f(pr, 'u_seed', (opts.seed ?? 0) % 997);
    this.f(pr, 'u_aspect', W / H);
    this.draw(null, W, H, pr, 1);
  }

  /** Separable gaussian of `src` with the given sigma in pixels. The 13-tap kernel has sigma ≈ 2.5 taps:
   *  large radii read from a smaller mip level, small radii shrink the tap spacing below one pixel, so a
   *  blur defined as a fraction of the image looks the same at any render size. */
  private gaussian(src: Target, sigma: number, key: string): Target {
    const gl = this.gl, W = src.w, H = src.h;
    const step = Math.max(1e-3, sigma / 2.5), f = Math.max(1, step), lod = Math.log2(f);
    const bw = Math.max(1, Math.ceil(W / f)), bh = Math.max(1, Math.ceil(H / f));
    const t1 = (this.tmp[key + '1'] = this.target(this.tmp[key + '1'] ?? null, bw, bh));
    const t2 = (this.tmp[key + '2'] = this.target(this.tmp[key + '2'] ?? null, bw, bh));
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    if (lod > 0) { gl.generateMipmap(gl.TEXTURE_2D); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); }
    const pr = this.use('gauss');
    this.bind(0, src.tex, pr, 'u_src');
    this.f(pr, 'u_lod', lod);
    this.f(pr, 'u_dir', step / W, 0);
    this.draw(t1, bw, bh, pr);
    this.bind(0, t1.tex, pr, 'u_src');
    this.f(pr, 'u_lod', 0);
    this.f(pr, 'u_dir', 0, step / f / bh);
    this.draw(t2, bw, bh, pr);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    return t2;
  }

  /** Colour grade into a target (`slot` keeps the base and mask passes apart), plus presence if used. */
  private gradePass(P: Params, W: number, H: number, opts: RenderOpts, slot: string, geo: Float32Array): Target {
    const gl = this.gl, src = this.src!;
    const A = this.slot(slot + 'A', W, H);
    let pr = this.use('grade');
    gl.uniformMatrix3fv(this.loc(pr, 'u_geo'), false, geo);
    this.bind(0, src.tex, pr, 'u_src');
    this.updateCurve(P);
    this.bind(1, this.curveTex, pr, 'u_curve');
    const ev = Math.pow(2, P.exposure), [wr, wg, wb] = wbGains(P.temp, P.tint);
    this.f(pr, 'u_wb', ev * wr, ev * wg, ev * wb);
    this.f(pr, 'u_con', Math.max(0.15, 1 + P.contrast / 100));
    this.f(pr, 'u_hi', P.highlights / 100);
    this.f(pr, 'u_sh', P.shadows / 100);
    this.f(pr, 'u_sat', 1 + P.saturation / 100);
    this.f(pr, 'u_vib', P.vibrance / 100);
    const fd = FMAP[P.filter.id] ?? FMAP.none;
    const fOn = !!fd.v && P.filter.k > 0;
    this.i(pr, 'u_fOn', fOn ? 1 : 0);
    if (fd.v) {
      const F = { ...fd.v, ...(P.filter.v || {}) };
      this.i(pr, 'u_fMono', fd.mono ? 1 : 0);
      this.f(pr, 'u_fk', P.filter.k / 100);
      this.f(pr, 'u_fWarm', F.warm / 100);
      this.f(pr, 'u_fCon', F.con / 100);
      this.f(pr, 'u_fSat', F.sat / 100);
      this.f(pr, 'u_fSplit', F.split / 100);
      this.f(pr, 'u_fFade', F.fade / 100);
      this.f(pr, 'u_fS', ...hue2rgb(F.sh));
      this.f(pr, 'u_fH', ...hue2rgb(F.hh));
    }
    const lut = opts.lut && P.lut.id === opts.lut.id ? opts.lut : null;
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_3D, this.lutTex);
    if (lut && lut.id !== this.lutId) {
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, lut.size, lut.size, lut.size, 0, gl.RGBA, gl.FLOAT, lut.data);
      this.lutId = lut.id;
      this.lutSize = lut.size;
    }
    this.i(pr, 'u_lut', 2);
    this.i(pr, 'u_lutOn', lut && P.lut.k > 0 ? 1 : 0);
    this.f(pr, 'u_lutK', P.lut.k / 100);
    this.f(pr, 'u_lutSize', this.lutSize);
    const hslOn = P.hsl.some((b) => b.h || b.s || b.l);
    this.i(pr, 'u_hslOn', hslOn ? 1 : 0);
    if (hslOn) {
      gl.uniform3fv(this.loc(pr, 'u_hsl'), new Float32Array(P.hsl.flatMap((b) => [b.h, b.s, b.l])));
      gl.uniform1fv(this.loc(pr, 'u_bandH'), BAND_H);
    }
    this.draw(A, W, H, pr);
    let base = A;

    // presence: dehaze, clarity, texture
    if (P.dehaze || P.clarity || P.texture) {
      const long = Math.max(W, H);
      let dark = this.dummy, cla = this.dummy, tex = this.dummy;
      if (P.dehaze) {
        const D = this.slot(slot + 'D', W, H);
        pr = this.use('minch');
        this.bind(0, base.tex, pr, 'u_src');
        this.draw(D, W, H, pr);
        dark = this.gaussian(D, long * 0.02, slot + 'dark').tex;
      }
      if (P.clarity) cla = this.gaussian(base, long * 0.015, slot + 'cla').tex;
      if (P.texture) tex = this.gaussian(base, long * 0.0025, slot + 'tex').tex;
      const A2 = this.slot(slot + 'A2', W, H);
      pr = this.use('local');
      this.bind(0, base.tex, pr, 'u_a');
      this.bind(1, dark, pr, 'u_dark');
      this.bind(2, cla, pr, 'u_cla');
      this.bind(3, tex, pr, 'u_tex');
      this.f(pr, 'u_dehaze', P.dehaze / 100);
      this.f(pr, 'u_clarity', P.clarity / 100);
      this.f(pr, 'u_texture', P.texture / 100);
      this.draw(A2, W, H, pr);
      base = A2;
    }

    return base;
  }

  private slot(name: string, w: number, h: number): Target {
    return (this.tmp[name] = this.target(this.tmp[name] ?? null, w, h));
  }

  private updateCurve(P: Params) {
    const key = JSON.stringify([P.curves, P.whites, P.blacks, P.fade]);
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.curveTex);
    if (key === this.curveKey) return;
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, finalLUT(P));
    this.curveKey = key;
  }

  /** Free the textures cached for one key. */
  forget(key: object) {
    const s = this.cache.get(key);
    if (s) { this.gl.deleteTexture(s.tex); this.cache.delete(key); }
  }
}

