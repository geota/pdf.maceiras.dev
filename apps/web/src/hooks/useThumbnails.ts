import { createSignal, onCleanup } from "solid-js";
import * as pdfWorker from "../pdf-worker-client";
import { getRenderPool } from "../render-pool";

const THUMBNAIL_WIDTH = 120;
// Pages per batch — each batch parses the PDF once in WASM.
// Small enough for progressive feedback, large enough to amortize parse cost.
const BATCH_SIZE = 4;

export function useThumbnails(handle: () => string | null, pageCount: () => number) {
  const [thumbnails, setThumbnails] = createSignal<Map<number, ImageData>>(new Map());
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
    setThumbnails(new Map());

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
          setThumbnails((prev) => {
            const next = new Map(prev);
            for (let j = 0; j < indices.length; j++) {
              const img = results[j];
              if (img) next.set(indices[j], img);
            }
            return next;
          });
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
