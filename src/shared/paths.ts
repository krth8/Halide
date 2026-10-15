// Absolute URLs for files in public/ (vendor cores, workers, icons). Pages
// live at different depths (/, /process/, /edit/) and Pages serves the app
// under /Halide/, so neither page-relative nor import.meta.url-relative paths
// hold — the configured base does.
export const BASE = import.meta.env.BASE_URL;
export const asset = (p: string): string => new URL(BASE + p.replace(/^\//, ''), location.origin).href;
