import { createSignal, onCleanup } from "solid-js";
import * as pdfWorker from "../pdf-worker-client";

const BATCH_SIZE = 4;
const THUMBNAIL_WIDTH = 180;

export function useThumbnails(handle: () => string | null, pageCount: () => number) {
  const [thumbnails, setThumbnails] = createSignal<Map<number, ImageData>>(new Map());
  const [loading, setLoading] = createSignal(false);
  let cancelled = false;

  onCleanup(() => {
    cancelled = true;
  });

  async function loadAll() {
    const h = handle();
    const count = pageCount();
    if (!h || count === 0) return;

    cancelled = false;
    setLoading(true);
    setThumbnails(new Map());

    for (let i = 0; i < count; i += BATCH_SIZE) {
      if (cancelled) break;

      const batch = Array.from(
        { length: Math.min(BATCH_SIZE, count - i) },
        (_, j) => i + j
      );

      const results = await Promise.all(
        batch.map((pageIndex) =>
          pdfWorker.renderPage(h, pageIndex, THUMBNAIL_WIDTH).then(
            (img) => ({ pageIndex, img }),
            () => null
          )
        )
      );

      if (cancelled) break;

      setThumbnails((prev) => {
        const next = new Map(prev);
        for (const r of results) {
          if (r) next.set(r.pageIndex, r.img);
        }
        return next;
      });
    }

    setLoading(false);
  }

  return { thumbnails, loading, loadAll };
}
