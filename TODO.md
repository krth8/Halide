# TODO

## Engine

- [ ] **16-bit float all the way for RAW — the rest.** Process now develops RAW linear in 16-bit
      (highlights blended, white from LibRaw's auto-bright, up to ~2 stops kept above it), uploads it
      as `rgba16float`, and grades in float; Exposure and negative Highlights pull the headroom back.
      Left: Edit still gets 8-bit RAW stills; the look/LUT step and presence/blur helpers still clamp
      or run in 8-bit; check memory of float exports on phones.
- [ ] **Glow in Edit: check the look.** Glow now runs the shared multi-step bloom from Process instead
      of the old single-pass approximation — smoother, but it looks different. Compare on real footage
      and tune the defaults (amount, threshold, radius) if needed.
- [ ] **One grading model, or two on purpose?** The maths is shared, but the controls still differ:
      Process has tone sliders (highlights/shadows/whites/blacks) and 8-band selective colour; Edit has
      lift/gamma/gain wheels, HSL curves and log input transforms. Decide whether the two UIs should
      converge (e.g. Process tone sliders in Edit's Adjust, HSL curves in Process) or stay separate.

- [ ] **ProRes on the GPU — next steps.** Done: decoder (all 422/4444 profiles, interlaced; checked
      against FFmpeg, at most 1 code value off), MOV reader with PCM audio, and Edit plays ProRes from
      the original with no proxy (import, playback, scrubbing, export, audio). Left: test playback
      speed and 4K I/O on real hardware; alpha (4444); hover filmstrip and waveform for ProRes clips;
      DNxHR on the same base. Not for HEVC: CABAC and inter prediction don't parallelise on a GPU;
      HEVC 4:2:2 10-bit (Canon C-Log) is fast only through hardware decode via WebCodecs.
- [ ] **Newer ffmpeg.wasm (FFmpeg 8.1).** Has wasm SIMD for HEVC (IDCT, SAO); the core today is
      FFmpeg 5.1. Sources and Emscripten 7 download fine (checksums match Ubuntu's), but running their
      build scripts needs the user's permission in the session. Measured gap today: native FFmpeg
      decodes Canon-style HEVC 4:2:2 10-bit ~2.5x faster than our wasm core.

## Process

- [ ] **Copy / paste settings to selected items.** Multi-select in the film strip (Ctrl/Shift-click on
      desktop, a "Select" mode on touch), copy from the current item with a group chooser (Look, Light,
      Color, Curves, Effects, Crop, Masks — all but Crop and Masks by default), paste onto the
      selection. Paste must give the target the same *final* values, not copy the per-item offsets.
- [ ] **Test Reconnect with real permission prompts.** Automated tests used always-permitted handles;
      check Chrome's prompt flow when a reopened project has many single-file handles.

## Both

- [ ] **Input-based density.** Compact layout for mouse/trackpad (tighter rows, shortcuts, right-click
      menus, hover actions), comfortable for touch — set from the input type via
      `data-density="compact|comfortable"` on the root, with a manual override in settings.
