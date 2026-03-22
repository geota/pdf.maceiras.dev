import { createSignal, onCleanup } from "solid-js";
import * as pdfWorker from "../pdf-worker-client";
import { getRenderPool } from "../render-pool";

const THUMBNAIL_WIDTH = 120;
// Pages per batch — each batch parses the PDF once in WASM.
// Small enough for progressive feedback, large enough to amortize parse cost.
const BATCH_SIZE = 4;

export function useThumbnails(handle: () => string | null, pageCount: () => number) {
  // Mutable map + version counter to trigger reactivity without copying.
  // Avoids O(n^2) from creating new Map(prev) on every batch.
  const thumbMap = new Map<number, ImageData>();
  const [version, setVersion] = createSignal(0);
  const thumbnails = () => { version(); return thumbMap; };

  const [loading, setLoading] = createSignal(false);
  let cancelled = false;

  onCleanup(() => {
    cancelled = true;
    const h = handle();
    if (h) getRenderPool().unload(h);
  });

  async function loadAll() {
    const h = handle();
    const count = pageCount();
    if (!h || count === 0) return;

    cancelled = false;
    setLoading(true);
    thumbMap.clear();
    setVersion(0);

    const pool = getRenderPool();

    // Load document bytes into all pool workers (fetched once from primary worker)
    await pool.ensureLoaded(h, () => pdfWorker.getDocumentBytes(h));

    if (cancelled) return;

    // Build batch queue
    const batches: number[][] = [];
    for (let i = 0; i < count; i += BATCH_SIZE) {
      batches.push(
        Array.from({ length: Math.min(BATCH_SIZE, count - i) }, (_, j) => i + j)
      );
    }

    // Work queue: each worker pulls the next batch when it finishes the current one.
    // This gives progressive rendering — results stream in as each batch completes.
    let nextBatch = 0;

    async function workerLoop() {
      while (!cancelled) {
        const batchIdx = nextBatch++;
        if (batchIdx >= batches.length) break;
        const indices = batches[batchIdx];
        try {
          const results = await pool.renderPages(h!, indices, THUMBNAIL_WIDTH);
          if (cancelled) break;
          // Mutate in place — O(batch_size) instead of O(total_loaded)
          for (let j = 0; j < indices.length; j++) {
            const img = results[j];
            if (img) thumbMap.set(indices[j], img);
          }
          setVersion((v) => v + 1); // trigger reactivity
        } catch {
          // skip failed batch
        }
      }
    }

    // Start one loop per pool worker — they'll pull from the shared queue
    const workerCount = pool.size;
    await Promise.all(Array.from({ length: workerCount }, () => workerLoop()));

    if (!cancelled) setLoading(false);
  }

  return { thumbnails, loading, loadAll };
}
