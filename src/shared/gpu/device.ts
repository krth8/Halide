// The page's one WebGPU device, shared by every renderer on it (preview,
// thumbnails, export). Acquired once; null where WebGPU is unavailable.
let pending: Promise<GPUDevice | null> | null = null;

export function gpuDevice(): Promise<GPUDevice | null> {
  pending ??= (async () => {
    if (!('gpu' in navigator) || !navigator.gpu) return null;
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }).catch(() => null);
    if (!adapter) return null;
    // the adapter's own texture limit: exports and RAW previews are large
    const device = await adapter.requestDevice({
      requiredLimits: { maxTextureDimension2D: adapter.limits.maxTextureDimension2D },
    }).catch(() => adapter.requestDevice().catch(() => null));
    if (!device) return null;
    device.lost.then((info) => console.warn('[gpu] device lost:', info.reason, info.message));
    return device;
  })();
  return pending;
}
