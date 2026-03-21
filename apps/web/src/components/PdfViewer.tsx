import { createSignal, createEffect, onMount, Show, on } from "solid-js";
import * as pdfWorker from "../pdf-worker-client";

interface Props {
  pdfData: ArrayBuffer;
}

export default function PdfViewer(props: Props) {
  const [pageCount, setPageCount] = createSignal(0);
  const [currentPage, setCurrentPage] = createSignal(0);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal("");
  let canvasRef: HTMLCanvasElement | undefined;

  onMount(async () => {
    try {
      setLoading(true);
      const count = await pdfWorker.getPageCount(props.pdfData);
      setPageCount(count);
      // Render first page
      await renderPage(0);
    } catch (err: any) {
      setError(err.message || "Failed to load PDF");
      setLoading(false);
    }
  });

  // Explicit dependency tracking with `on()` — re-render when currentPage changes.
  // Skips the initial run (defer: true) since onMount handles page 0.
  createEffect(
    on(currentPage, async (page) => {
      if (pageCount() === 0) return;
      await renderPage(page);
    }, { defer: true })
  );

  async function renderPage(page: number) {
    if (!canvasRef) return;
    try {
      setLoading(true);
      setError("");
      const renderWidth = 1200;
      const imageData = await pdfWorker.renderPage(
        props.pdfData,
        page,
        renderWidth
      );

      canvasRef.width = imageData.width;
      canvasRef.height = imageData.height;
      const ctx = canvasRef.getContext("2d")!;
      ctx.putImageData(imageData, 0, 0);
      setLoading(false);
    } catch (err: any) {
      setError(`Render error: ${err.message}`);
      setLoading(false);
    }
  }

  function prevPage() {
    setCurrentPage((p) => Math.max(0, p - 1));
  }

  function nextPage() {
    setCurrentPage((p) => Math.min(pageCount() - 1, p + 1));
  }

  return (
    <div>
      <Show when={error()}>
        <div class="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
          {error()}
        </div>
      </Show>

      <div class="flex items-center gap-4 mb-4">
        <button
          onClick={prevPage}
          disabled={currentPage() === 0}
          class="px-3 py-1 bg-gray-200 rounded disabled:opacity-50"
        >
          Prev
        </button>
        <span class="text-sm">
          Page {currentPage() + 1} of {pageCount()}
        </span>
        <button
          onClick={nextPage}
          disabled={currentPage() >= pageCount() - 1}
          class="px-3 py-1 bg-gray-200 rounded disabled:opacity-50"
        >
          Next
        </button>
        <Show when={loading()}>
          <span class="text-sm text-gray-400">Loading...</span>
        </Show>
      </div>

      <canvas
        ref={canvasRef}
        style="max-width: 100%; height: auto; border: 1px solid #e5e7eb;"
      />
    </div>
  );
}
