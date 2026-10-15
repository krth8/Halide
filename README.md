# Halide

**Develop photos and video, and cut them into films — entirely in your browser.**

Halide has two workspaces:

- **Process** — develop photos and video one series at a time: film looks, light and colour, curves, HSL, grain, bloom, halation, masks, crop and stabilisation, then batch export.
- **Edit** — cut video on a multi-track timeline with Resolve-style grading, titles, effects, proxies and full-quality H.264 export.

Nothing is uploaded: decoding, grading and export all run on your device (WebGPU, WebCodecs, ffmpeg.wasm as a fallback). Requires a browser with WebGPU (Chrome/Edge 113+, Safari 26+).

## Development

```sh
npm install
npm run dev        # http://localhost:5173
npm run build      # typecheck + production build into dist/
```

Pages: `/` is the launcher, `/process/` and `/edit/` the workspaces. Shared code (theme, brand, boot, paths) lives in `src/shared`.

Licensed under the [Elastic License 2.0](LICENSE). Bundled third-party components (ffmpeg.wasm core, mp4box.js, mp4-muxer, Mediabunny) keep their own licenses.
