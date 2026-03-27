import { createSignal, onCleanup } from "solid-js";
import * as pdfWorker from "../pdf-worker-client";
import { getRenderPool } from "../render-pool";

const THUMBNAIL_WIDTH = 120;
const BATCH_SIZE = 4;

// Global thumbnail cache — survives component mount/unmount cycles.
// Keyed by document handle → page index → ImageData.
const globalCache = new Map<string, Map<number, ImageData>>();

/** Clear cached thumbnails for a handle (call when unloading a document). */
export function clearThumbnailCache(handle: string) {
  globalCache.delete(handle);
}

/** Read a single page from the thumbnail cache (returns undefined on miss). */
export function getThumbnailFromCache(handle: string, page: number): ImageData | undefined {
  return globalCache.get(handle)?.get(page);
}

/** Move all cached thumbnails from one handle to another, skipping specific pages. */
export function migrateThumbnailCache(from: string, to: string, skipPages?: Set<number>) {
  const old = globalCache.get(from);
  if (!old) return;
  let target = globalCache.get(to);
  if (!target) {
    target = new Map();
    globalCache.set(to, target);
  }
  for (const [page, img] of old) {
    if (!skipPages?.has(page)) target.set(page, img);
  }
  globalCache.delete(from);
}

export function useThumbnails(handle: () => string | null, pageCount: () => number) {
  const thumbMap = new Map<number, ImageData>();
  const [version, setVersion] = createSignal(0);
  const thumbnails = () => { version(); return thumbMap; };

  const [loading, setLoading] = createSignal(false);
  let cancelled = false;

  // Viewport-aware priority: visible pages are rendered before off-screen ones.
  let pendingPages: Set<number> = new Set();
  let visiblePages: Set<number> = new Set();

  onCleanup(() => {
    cancelled = true;
    // Don't unload from render pool — the PdfContext owns the document lifecycle.
  });

  /** Called by the grid's IntersectionObserver when visibility changes. */
  function updateVisiblePages(visible: Set<number>) {
    visiblePages = visible;
  }

  /** Pull the next batch, prioritizing pages currently in the viewport. */
  function pullNextBatch(): number[] | null {
    if (pendingPages.size === 0) return null;

    const batch: number[] = [];

    // Priority: visible pages first
    for (const p of visiblePages) {
      if (pendingPages.has(p)) {
        batch.push(p);
        if (batch.length >= BATCH_SIZE) break;
      }
    }

    // Fill remainder from pending (insertion order = sequential)
    if (batch.length < BATCH_SIZE) {
      for (const p of pendingPages) {
        if (batch.includes(p)) continue;
        batch.push(p);
        if (batch.length >= BATCH_SIZE) break;
      }
    }

    for (const p of batch) pendingPages.delete(p);
    return batch.length > 0 ? batch : null;
  }

  async function loadAll() {
    const h = handle();
    const count = pageCount();
    if (!h || count === 0) return;

    cancelled = false;
    setLoading(true);
    thumbMap.clear();

    // Restore from global cache
    const cached = globalCache.get(h);
    if (cached) {
      for (const [page, img] of cached) {
        thumbMap.set(page, img);
      }
      setVersion((v) => v + 1);
    }

    // Only render pages not already cached
    const needed: number[] = [];
    for (let i = 0; i < count; i++) {
      if (!thumbMap.has(i)) needed.push(i);
    }

    if (needed.length === 0) {
      setLoading(false);
      return;
    }

    pendingPages = new Set(needed);

    const pool = getRenderPool();
    await pool.ensureLoaded(h, () => pdfWorker.getDocumentBytes(h));
    if (cancelled) return;

    // Ensure global cache entry exists
    if (!globalCache.has(h)) {
      globalCache.set(h, new Map());
    }
    const cache = globalCache.get(h)!;

    async function workerLoop() {
      while (!cancelled) {
        const batch = pullNextBatch();
        if (!batch) break;
        try {
          const results = await pool.renderPages(h!, batch, THUMBNAIL_WIDTH);
          if (cancelled) break;
          for (let j = 0; j < batch.length; j++) {
            const img = results[j];
            if (img) {
              thumbMap.set(batch[j], img);
              cache.set(batch[j], img);
            }
          }
          setVersion((v) => v + 1);
        } catch {
          // skip failed batch
        }
      }
    }

    const workerCount = pool.size;
    await Promise.all(Array.from({ length: workerCount }, () => workerLoop()));

    if (!cancelled) setLoading(false);
  }

  return { thumbnails, loading, loadAll, updateVisiblePages };
}
