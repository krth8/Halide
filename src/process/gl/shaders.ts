export const VS = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
uniform float u_flip;
void main(){
  v_uv = a_pos * 0.5 + 0.5;
  if (u_flip > 0.5) v_uv.y = 1.0 - v_uv.y;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const COMMON = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 v_uv;
out vec4 o;
float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`;

/** Colour grade, in layers: exposure + white balance (linear light) → look and LUT → the user's tone and
 *  saturation → selective colour → curves. Later layers always win over the look. */
export const FS_GRADE = COMMON + `
uniform sampler2D u_src;
uniform sampler2D u_curve;
uniform sampler3D u_lut;
uniform mat3 u_geo;           // output uv -> source uv (crop, straighten, rotate, flip, stabilise)
uniform vec3 u_wb;            // exposure * white balance multipliers (linear)
uniform float u_con, u_hi, u_sh, u_sat, u_vib;
uniform int u_fOn, u_fMono;
uniform float u_fk, u_fWarm, u_fCon, u_fSat, u_fSplit, u_fFade;
uniform vec3 u_fS, u_fH;
uniform int u_lutOn;
uniform float u_lutK, u_lutSize;
uniform int u_hslOn;
uniform vec3 u_hsl[8];
uniform float u_bandH[8];

vec3 toLin(vec3 c){ return pow(max(c, 0.0), vec3(2.2)); }
vec3 toGam(vec3 c){ return pow(max(c, 0.0), vec3(1.0/2.2)); }
/** Contrast as an S-curve around mid grey: g is the slope in the midtones (1 = unchanged), while black
 *  and white stay fixed and the ends roll off smoothly instead of clipping. g < 1 flattens (inverse S). */
vec3 sCurve(vec3 c, float g){
  c = clamp(c, 0.0, 1.0);
  vec3 lo = 0.5 * pow(2.0 * c, vec3(g));
  vec3 hi = 1.0 - 0.5 * pow(2.0 * (1.0 - c), vec3(g));
  return mix(lo, hi, step(0.5, c));
}
vec3 hsl2rgb(vec3 h){
  vec3 rgb = clamp(abs(mod(h.x*6.0 + vec3(0.0,4.0,2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  return h.z + h.y * (rgb - 0.5) * (1.0 - abs(2.0*h.z - 1.0));
}

void main(){
  vec2 suv = (u_geo * vec3(v_uv, 1.0)).xy;
  vec3 c = texture(u_src, suv).rgb;
  if (any(lessThan(suv, vec2(-0.002))) || any(greaterThan(suv, vec2(1.002)))) c = vec3(0.0);
  c = toGam(toLin(c) * u_wb);
  float l = luma(c);

  if (u_fOn == 1) {
    vec3 c0 = c;
    c.r *= 1.0 + u_fWarm * 0.16; c.b *= 1.0 - u_fWarm * 0.16;
    c = sCurve(c, max(0.15, 1.0 + u_fCon * 0.7));
    l = luma(c);
    if (u_fMono == 1) { l = dot(c, vec3(0.3, 0.59, 0.11)); c = vec3(l); }
    else c = l + (c - l) * (1.0 + u_fSat);
    if (u_fSplit > 0.0) {
      float lc = clamp(l, 0.0, 1.0), ws = (1.0-lc)*(1.0-lc), wh = lc*lc;
      c += u_fSplit * 0.32 * (ws * (u_fS - 0.5) + wh * (u_fH - 0.5));
    }
    float fa = u_fFade * 0.25; c = fa + c * (1.0 - fa);
    c = mix(c0, c, u_fk);
  }
  c = clamp(c, 0.0, 1.0);

  if (u_lutOn == 1) {
    vec3 coord = c * ((u_lutSize - 1.0) / u_lutSize) + 0.5 / u_lutSize;
    c = mix(c, texture(u_lut, coord).rgb, u_lutK);
  }

  // Tone and saturation sit on top of the look, so e.g. saturation -100 always gives black and white.
  l = luma(c);
  if (u_sh != 0.0) { float q = 1.0 - min(1.0, l); c *= 1.0 + u_sh * 1.3 * q*q*q; }
  if (u_hi != 0.0) {
    float lc = min(1.0, l), k = lc*lc;
    if (u_hi < 0.0) c *= 1.0 + u_hi * 0.55 * k; else c += u_hi * 0.45 * k * (1.0 - c);
  }
  if (u_con != 1.0) c = sCurve(c, u_con);
  l = luma(c);
  float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b));
  c = l + (c - l) * (u_sat * (1.0 + u_vib * (1.0 - clamp(mx - mn, 0.0, 1.0)) * 1.2));
  c = clamp(c, 0.0, 1.0);

  if (u_hslOn == 1) {
    float M = max(c.r, max(c.g, c.b)), m = min(c.r, min(c.g, c.b)), d = M - m;
    if (d > 0.01) {
      float L = (M + m) * 0.5;
      float S = L > 0.5 ? d / (2.0 - M - m) : d / (M + m);
      float H = M == c.r ? (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0) : M == c.g ? (c.b - c.r) / d + 2.0 : (c.r - c.g) / d + 4.0;
      H *= 60.0;
      vec3 acc = vec3(0.0);
      for (int k = 0; k < 8; k++) {
        float df = abs(H - u_bandH[k]); if (df > 180.0) df = 360.0 - df;
        acc += u_hsl[k] * max(0.0, 1.0 - df / 42.0);
      }
      if (acc != vec3(0.0)) {
        float nS = clamp(S * (1.0 + acc.y / 100.0), 0.0, 1.0);
        float nL = clamp(L + acc.z / 100.0 * 0.3 * S, 0.0, 1.0);
        c = hsl2rgb(vec3(mod(H + acc.x, 360.0) / 360.0, nS, nL));
      }
    }
  }

  vec3 t = c * (255.0/256.0) + 0.5/256.0;
  c = vec3(texture(u_curve, vec2(t.r, 0.5)).r, texture(u_curve, vec2(t.g, 0.5)).g, texture(u_curve, vec2(t.b, 0.5)).b);
  o = vec4(c, 1.0);
}`;

/** Soft-knee bright pass for bloom/halation, rendered at half resolution. */
export const FS_BRIGHT = COMMON + `
uniform sampler2D u_src;
uniform float u_thr;
void main(){
  vec3 c = texture(u_src, v_uv).rgb;
  float k = max(0.0, (luma(c) - u_thr) / (1.0 - u_thr));
  o = vec4(c * k * k, 1.0);
}`;

/** Dual-filter (Kawase) downsample. */
export const FS_DOWN = COMMON + `
uniform sampler2D u_src;
uniform vec2 u_texel;
void main(){
  vec2 h = u_texel * 0.5;
  vec3 s = texture(u_src, v_uv).rgb * 4.0;
  s += texture(u_src, v_uv - h).rgb + texture(u_src, v_uv + h).rgb;
  s += texture(u_src, v_uv + vec2(h.x, -h.y)).rgb + texture(u_src, v_uv - vec2(h.x, -h.y)).rgb;
  o = vec4(s / 8.0, 1.0);
}`;

/** Dual-filter upsample of the coarser level, added onto the current level. */
export const FS_UP = COMMON + `
uniform sampler2D u_src;   // coarser, already accumulated
uniform sampler2D u_cur;   // this level's downsample
uniform vec2 u_texel;      // texel of u_src
uniform float u_w;
void main(){
  vec2 h = u_texel * 0.5;
  vec3 s = texture(u_src, v_uv + vec2(-h.x*2.0, 0.0)).rgb;
  s += texture(u_src, v_uv + vec2(-h.x, h.y)).rgb * 2.0;
  s += texture(u_src, v_uv + vec2(0.0, h.y*2.0)).rgb;
  s += texture(u_src, v_uv + vec2(h.x, h.y)).rgb * 2.0;
  s += texture(u_src, v_uv + vec2(h.x*2.0, 0.0)).rgb;
  s += texture(u_src, v_uv + vec2(h.x, -h.y)).rgb * 2.0;
  s += texture(u_src, v_uv + vec2(0.0, -h.y*2.0)).rgb;
  s += texture(u_src, v_uv + vec2(-h.x, -h.y)).rgb * 2.0;
  o = vec4(texture(u_cur, v_uv).rgb + s / 12.0 * u_w, 1.0);
}`;

/** Separable gaussian, reading the source at a mip level so large radii stay cheap. */
export const FS_GAUSS = COMMON + `
uniform sampler2D u_src;
uniform vec2 u_dir;     // texel step in uv
uniform float u_lod;
void main(){
  // 13-tap gaussian using linear-filtering offsets
  float w[4] = float[](0.1964825501511404, 0.2969069646728344, 0.09447039785044732, 0.010381362401148057);
  float off[4] = float[](0.0, 1.411764705882353, 3.2941176470588234, 5.176470588235294);
  vec3 s = textureLod(u_src, v_uv, u_lod).rgb * w[0];
  for (int i = 1; i < 4; i++) {
    s += textureLod(u_src, v_uv + u_dir * off[i], u_lod).rgb * w[i];
    s += textureLod(u_src, v_uv - u_dir * off[i], u_lod).rgb * w[i];
  }
  o = vec4(s, 1.0);
}`;

/** Composite: blur mask, bloom (screen), halation, vignette and grain. */
export const FS_FINISH = COMMON + `
uniform sampler2D u_a, u_blur, u_bloom, u_hal;
uniform int u_blurOn, u_blurMode;
uniform float u_bloomK, u_halK, u_vig, u_vigIn, u_vigW, u_grain, u_grainSize, u_seed, u_aspect;
// 3D hash: the frame seed is its own dimension, so every video frame gets an independent grain pattern.
float hash(vec3 p){ p = fract(p * vec3(0.1031, 0.1030, 0.0973)); p += dot(p, p.yxz + 33.33); return fract((p.x + p.y) * p.z); }
void main(){
  vec3 c = texture(u_a, v_uv).rgb;
  if (u_blurOn == 1) {
    float m = 1.0;
    if (u_blurMode == 0) { float d = abs(v_uv.y - 0.47); m = smoothstep(0.12, 0.42, d); }
    else if (u_blurMode == 1) { vec2 p = (v_uv - 0.5) * vec2(u_aspect, 1.0); m = smoothstep(0.18, 0.62, length(p) / max(u_aspect, 1.0) * 1.3); }
    c = mix(c, texture(u_blur, v_uv).rgb, m);
  }
  if (u_bloomK > 0.0) { vec3 b = clamp(texture(u_bloom, v_uv).rgb * u_bloomK, 0.0, 1.0); c = 1.0 - (1.0 - c) * (1.0 - b); }
  if (u_halK > 0.0) { float h = luma(texture(u_hal, v_uv).rgb); c += vec3(1.0, 0.27, 0.11) * h * u_halK; }
  if (u_vig != 0.0) {
    vec2 n = (v_uv - 0.5) * 2.0;
    float f = clamp((length(n) / 1.4142 - u_vigIn) / u_vigW, 0.0, 1.0);
    f = f * f * (3.0 - 2.0 * f);
    if (u_vig > 0.0) c *= 1.0 - u_vig * f; else c += (1.0 - c) * (-u_vig) * f;
  }
  if (u_grain > 0.0) {
    // u_grainSize is the grain cell size in output pixels, proportional to the image size. When cells are
    // smaller than a pixel, a pixel averages several of them, so the visible amplitude drops accordingly.
    // This keeps grain looking the same at any zoom level and export size.
    float cellPx = max(u_grainSize, 1.0);
    vec3 cell = vec3(floor(gl_FragCoord.xy / cellPx), u_seed);
    float n = (hash(cell) + hash(cell + vec3(17.31, 5.17, 3.1)) + hash(cell + vec3(41.7, 23.9, 7.3)) - 1.5) * 1.2;
    n *= min(u_grainSize, 1.0);
    float lm = luma(c), w = 0.35 + (1.0 - abs(lm - 0.5) * 2.0) * 0.65;
    c += n * u_grain * w;
  }
  o = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

/** Plain copy through the geometry, used for "show original" (same framing as the edit). */
export const FS_COPY = COMMON + `
uniform sampler2D u_src;
uniform mat3 u_geo;
void main(){ o = vec4(texture(u_src, (u_geo * vec3(v_uv, 1.0)).xy).rgb, 1.0); }`;

/** Blends a mask's graded image over the base. Linear: full effect at p0 fading to none at p1.
 *  Radial: ellipse centred at p0 with radii p1, soft edge set by feather. */
export const FS_MASK = COMMON + `
uniform sampler2D u_a, u_b;
uniform int u_type, u_inv;
uniform vec2 u_p0, u_p1;
uniform float u_feather, u_amount, u_aspect;
void main(){
  vec3 a = texture(u_a, v_uv).rgb, b = texture(u_b, v_uv).rgb;
  float m;
  if (u_type == 0) {
    vec2 d = (u_p1 - u_p0) * vec2(u_aspect, 1.0), q = (v_uv - u_p0) * vec2(u_aspect, 1.0);
    float t = dot(q, d) / max(dot(d, d), 1e-6);
    m = 1.0 - smoothstep(0.0, 1.0, t);
  } else {
    float r = length((v_uv - u_p0) / max(u_p1, vec2(1e-4)));
    float f = clamp(u_feather, 0.01, 1.0);
    m = 1.0 - smoothstep(1.0 - f, 1.0, r);
  }
  if (u_inv == 1) m = 1.0 - m;
  o = vec4(mix(a, b, m * u_amount), 1.0);
}`;

/** Darkest colour channel, the input for the dehaze haze estimate ("dark channel"). */
export const FS_MINCH = COMMON + `
uniform sampler2D u_src;
void main(){ vec3 c = texture(u_src, v_uv).rgb; o = vec4(vec3(min(c.r, min(c.g, c.b))), 1.0); }`;

/** Presence: dehaze, clarity (large-radius midtone contrast) and texture (fine detail). Each works on
 *  a blurred copy of the image whose radius is a fixed fraction of the image, so the result does not
 *  depend on render size. */
export const FS_LOCAL = COMMON + `
uniform sampler2D u_a, u_dark, u_cla, u_tex;
uniform float u_dehaze, u_clarity, u_texture;
void main(){
  vec3 c = texture(u_a, v_uv).rgb;
  if (u_dehaze != 0.0) {
    const float A = 0.94;                                   // atmospheric light (haze colour)
    // Blend the blurred dark channel with the pixel's own, so the estimate follows edges (fewer halos).
    float dark = mix(texture(u_dark, v_uv).r, min(c.r, min(c.g, c.b)), 0.5);
    if (u_dehaze > 0.0) {
      float t = max(1.0 - 0.6 * u_dehaze * dark / A, 0.3);   // transmission
      vec3 j = (c - A) / t + A;
      c = j + (luma(c) - luma(j)) * 0.35 * u_dehaze;         // keep some of the original brightness
    } else {
      c = mix(c, vec3(A * 0.92), -u_dehaze * 0.55 * (0.35 + 0.65 * (1.0 - dark)));
    }
    c = clamp(c, 0.0, 1.0);
  }
  if (u_clarity != 0.0) {
    float L = luma(c), Lb = luma(texture(u_cla, v_uv).rgb);
    if (u_clarity > 0.0) {
      float m = clamp(1.0 - pow(2.0 * L - 1.0, 2.0), 0.0, 1.0);          // strongest in the midtones
      float d = clamp(L - Lb, -0.12, 0.12);                               // limit halos on hard edges
      c += u_clarity * 1.4 * d * (0.25 + 0.75 * m);
    } else {
      c = mix(c, c + (Lb - L), -u_clarity * 0.6);                        // soften local contrast
    }
  }
  if (u_texture != 0.0) {
    vec3 b = texture(u_tex, v_uv).rgb;
    if (u_texture > 0.0) c += u_texture * 1.6 * clamp(luma(c) - luma(b), -0.12, 0.12);
    else c = mix(c, b, -u_texture * 0.75);                                // smooth fine detail (e.g. skin)
  }
  o = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;
