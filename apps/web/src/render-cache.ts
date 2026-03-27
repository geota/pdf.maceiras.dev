/** Global full-size render cache — survives component mount/unmount cycles.
 *  Keyed by document handle → page index → ImageData. */
const globalRenderCache = new Map<string, Map<number, ImageData>>();

export function getRenderCacheFor(handle: string): Map<number, ImageData> {
  let cache = globalRenderCache.get(handle);
  if (!cache) {
    cache = new Map();
    globalRenderCache.set(handle, cache);
  }
  return cache;
}

export function getRenderCacheSnapshot(handle: string): Map<number, ImageData> | undefined {
  return globalRenderCache.get(handle);
}

export function clearRenderCache(handle: string) {
  globalRenderCache.delete(handle);
}

/** Move all cached renders from one handle to another, skipping specific pages. */
export function migrateRenderCache(from: string, to: string, skipPages?: Set<number>) {
  const old = globalRenderCache.get(from);
  if (!old) return;
  const target = getRenderCacheFor(to);
  for (const [page, img] of old) {
    if (!skipPages?.has(page)) target.set(page, img);
  }
  globalRenderCache.delete(from);
}
