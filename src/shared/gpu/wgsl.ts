// Shared WGSL: the full-screen vertex stage every image pass uses, and the
// colour maths both workspaces build their shaders from. Texture space has
// (0,0) at the image's top-left in every target and on the canvas.

export const FULLSCREEN_VS = /* wgsl */`
struct VSOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VSOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VSOut;
  o.pos = vec4f(p[i], 0.0, 1.0);
  o.uv = vec2f((p[i].x + 1.0) * 0.5, 1.0 - (p[i].y + 1.0) * 0.5);
  return o;
}
`;

/** Colour helpers. */
export const COLOR = /* wgsl */`
fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }
// display gamma 2.2 (Process's working encode)
fn toLin(c: vec3f) -> vec3f { return pow(max(c, vec3f(0.0)), vec3f(2.2)); }
fn toGam(c: vec3f) -> vec3f { return pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.2)); }
// exact sRGB transfer (Edit's working encode)
fn srgbToLin(c: vec3f) -> vec3f { return select(c / 12.92, pow((c + 0.055) / 1.055, vec3f(2.4)), c > vec3f(0.04045)); }
fn linToSrgb(c: vec3f) -> vec3f {
  let cc = clamp(c, vec3f(0.0), vec3f(1.0));
  return select(cc * 12.92, 1.055 * pow(cc, vec3f(1.0 / 2.4)) - 0.055, cc > vec3f(0.0031308));
}
/** Contrast as an S-curve around mid grey: g is the midtone slope (1 = unchanged); black and white stay
 *  fixed and the ends roll off instead of clipping. g < 1 flattens (inverse S). */
fn sCurve(x: vec3f, g: f32) -> vec3f {
  let c = clamp(x, vec3f(0.0), vec3f(1.0));
  let lo = 0.5 * pow(2.0 * c, vec3f(g));
  let hi = 1.0 - 0.5 * pow(2.0 * (1.0 - c), vec3f(g));
  return select(lo, hi, c >= vec3f(0.5));
}
fn hsl2rgb(h: vec3f) -> vec3f {
  let rgb = clamp(abs(((h.x * 6.0 + vec3f(0.0, 4.0, 2.0)) % 6.0) - 3.0) - 1.0, vec3f(0.0), vec3f(1.0));
  return h.z + h.y * (rgb - 0.5) * (1.0 - abs(2.0 * h.z - 1.0));
}
// HSV -> RGB (h wraps; s, v may exceed 1 for linear-light values)
fn hsv2rgb(h: f32, s: f32, v: f32) -> vec3f {
  let p = abs(fract(vec3f(h) + vec3f(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - vec3f(3.0));
  return v * mix(vec3f(1.0), clamp(p - vec3f(1.0), vec3f(0.0), vec3f(1.0)), s);
}
// ACES filmic tone map (Narkowicz)
fn acesFilm(x: vec3f) -> vec3f {
  return clamp((x * (2.51 * x + vec3f(0.03))) / (x * (2.43 * x + vec3f(0.59)) + vec3f(0.14)), vec3f(0.0), vec3f(1.0));
}
// GLSL-style mod (sign of the divisor), for hue wrapping
fn modf1(x: f32, y: f32) -> f32 { return x - y * floor(x / y); }
`;

/** Per-channel 1D curve lookup in a 256×1 texture (r, g, b tables). */
export const CURVE = /* wgsl */`
fn curveLookup(t: texture_2d<f32>, s: sampler, c: vec3f) -> vec3f {
  let x = clamp(c, vec3f(0.0), vec3f(1.0)) * (255.0 / 256.0) + 0.5 / 256.0;
  return vec3f(textureSample(t, s, vec2f(x.r, 0.5)).r, textureSample(t, s, vec2f(x.g, 0.5)).g, textureSample(t, s, vec2f(x.b, 0.5)).b);
}
`;

/** 3D LUT lookup with texel-centre mapping. */
export const LUT3D = /* wgsl */`
fn lutLookup(t: texture_3d<f32>, s: sampler, c: vec3f, size: f32) -> vec3f {
  let coord = clamp(c, vec3f(0.0), vec3f(1.0)) * ((size - 1.0) / size) + 0.5 / size;
  return textureSample(t, s, coord).rgb;
}
`;

/** Radial vignette: amount > 0 darkens the corners, < 0 lightens them. */
export const VIGNETTE = /* wgsl */`
fn vignette(c: vec3f, uv: vec2f, amount: f32, inner: f32, width: f32) -> vec3f {
  let n = (uv - 0.5) * 2.0;
  var f = clamp((length(n) / 1.4142 - inner) / max(width, 1e-4), 0.0, 1.0);
  f = f * f * (3.0 - 2.0 * f);
  if (amount > 0.0) { return c * (1.0 - amount * f); }
  return c + (1.0 - c) * (-amount) * f;
}
`;

/** Film grain: luminance-weighted noise in cells of `cellPx` output pixels;
 *  `seed` is its own hash dimension so every video frame gets new grain. */
export const GRAIN = /* wgsl */`
fn hash3(q: vec3f) -> f32 { var p = fract(q * vec3f(0.1031, 0.1030, 0.0973)); p = p + dot(p, p.yxz + 33.33); return fract((p.x + p.y) * p.z); }
fn grain(c: vec3f, fragXY: vec2f, amount: f32, size: f32, seed: f32) -> vec3f {
  let cellPx = max(size, 1.0);
  let cell = vec3f(floor(fragXY / cellPx), seed);
  var n = (hash3(cell) + hash3(cell + vec3f(17.31, 5.17, 3.1)) + hash3(cell + vec3f(41.7, 23.9, 7.3)) - 1.5) * 1.2;
  n = n * min(size, 1.0);                                    // sub-pixel grain averages out
  let lm = luma(c);
  let w = 0.35 + (1.0 - abs(lm - 0.5) * 2.0) * 0.65;          // strongest in the midtones
  return c + n * amount * w;
}
`;
