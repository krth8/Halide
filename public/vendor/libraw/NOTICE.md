# LibRaw-Wasm

`libraw-wasm` 1.6.0 (https://github.com/ybouane/LibRaw-Wasm), the `dist/` build, unmodified.

- Wrapper and build scripts: ISC license, © ybouane and contributors.
- LibRaw (https://www.libraw.org): dual-licensed LGPL-2.1 or CDDL-1.0 — Halide
  uses it under CDDL-1.0. The library is loaded as a separate WebAssembly
  module and can be replaced by swapping the files in this folder.
- Little CMS (lcms2), linked into the build: MIT license.

Loaded on demand by `src/process/raw.ts`; runs in its own worker and needs
cross-origin isolation (shared WebAssembly memory for its threads).
