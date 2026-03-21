import { createSignal, createMemo, onCleanup, Show } from "solid-js";
import * as pdfWorker from "../pdf-worker-client";
import DropZone from "./ui/DropZone";
import ThumbnailGrid from "./ui/ThumbnailGrid";
import { useThumbnails } from "../hooks/useThumbnails";
import { useSelection } from "../hooks/useSelection";

export default function PdfSplit() {
  const [handle, setHandle] = createSignal<string | null>(null);
  const [fileName, setFileName] = createSignal("");
  const [pageCount, setPageCount] = createSignal(0);
  const [splitting, setSplitting] = createSignal(false);
  const [error, setError] = createSignal("");

  const { thumbnails, loading: thumbsLoading, loadAll } = useThumbnails(handle, pageCount);
  const { selected, handleSelect, selectAll, clearSelection } = useSelection();

  onCleanup(() => {
    const h = handle();
    if (h) pdfWorker.unloadDocument(h);
  });

  async function handleFiles(files: File[]) {
    const file = files[0];
    if (!file) return;

    const prev = handle();
    if (prev) pdfWorker.unloadDocument(prev);

    setError("");
    setFileName(file.name);
    clearSelection();

    try {
      const data = await file.arrayBuffer();
      const result = await pdfWorker.loadDocument(data);
      setHandle(result.handle);
      setPageCount(result.pageCount);
      loadAll();
    } catch (err: any) {
      setError(err.message || "Failed to load PDF");
    }
  }

  const selectedRanges = createMemo(() => {
    const pages = [...selected()].sort((a, b) => a - b);
    if (pages.length === 0) return [];

    const ranges: { start: number; end: number }[] = [];
    let start = pages[0];
    let end = pages[0];

    for (let i = 1; i < pages.length; i++) {
      if (pages[i] === end + 1) {
        end = pages[i];
      } else {
        ranges.push({ start, end: end + 1 });
        start = pages[i];
        end = pages[i];
      }
    }
    ranges.push({ start, end: end + 1 });
    return ranges;
  });

  const rangeLabel = createMemo(() =>
    selectedRanges()
      .map((r) =>
        r.end - r.start === 1 ? `${r.start + 1}` : `${r.start + 1}-${r.end}`
      )
      .join(", ")
  );

  async function splitSelected() {
    const h = handle();
    const ranges = selectedRanges();
    if (!h || ranges.length === 0) return;

    setSplitting(true);
    setError("");
    try {
      // Single range containing all selected pages
      const allPages = [...selected()].sort((a, b) => a - b);
      const singleRange = [{ start: allPages[0], end: allPages[allPages.length - 1] + 1 }];
      const parts = await pdfWorker.splitPdf(h, singleRange);
      const baseName = fileName().replace(/\.pdf$/i, "");
      const blob = new Blob([parts[0]], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${baseName}_extract.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      setError(err.message || "Split failed");
    } finally {
      setSplitting(false);
    }
  }

  async function splitByRanges() {
    const h = handle();
    const ranges = selectedRanges();
    if (!h || ranges.length === 0) return;

    setSplitting(true);
    setError("");
    try {
      const parts = await pdfWorker.splitPdf(h, ranges);
      const baseName = fileName().replace(/\.pdf$/i, "");
      parts.forEach((part: ArrayBuffer, i: number) => {
        const blob = new Blob([part], { type: "application/pdf" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${baseName}_part${i + 1}.pdf`;
        a.click();
        URL.revokeObjectURL(url);
      });
    } catch (err: any) {
      setError(err.message || "Split failed");
    } finally {
      setSplitting(false);
    }
  }

  return (
    <div>
      <DropZone onFiles={handleFiles} accept=".pdf">
        <p class="text-sm text-gray-500">
          <span class="font-medium">Drop a PDF here</span> or click to browse
        </p>
      </DropZone>

      <Show when={handle()}>
        <div class="mt-4">
          <div class="flex items-center justify-between mb-3">
            <p class="text-sm text-gray-600">
              {fileName()} — {pageCount()} pages
              {thumbsLoading() ? " (loading thumbnails...)" : ""}
            </p>
            <div class="flex gap-2">
              <button
                onClick={() => selectAll(pageCount())}
                class="text-xs text-blue-600 hover:underline"
              >
                Select all
              </button>
              <button
                onClick={clearSelection}
                class="text-xs text-gray-500 hover:underline"
              >
                Clear
              </button>
            </div>
          </div>

          <p class="text-xs text-gray-400 mb-3">
            Click to select pages. Shift+click for range. Cmd/Ctrl+click to toggle.
          </p>

          <ThumbnailGrid
            pageCount={pageCount()}
            thumbnails={thumbnails()}
            selectedPages={selected()}
            onPageClick={handleSelect}
          />

          <Show when={selected().size > 0}>
            <div class="mt-4 p-3 bg-gray-50 rounded-lg border">
              <p class="text-sm mb-2">
                Selected: <span class="font-medium">{rangeLabel()}</span>{" "}
                ({selected().size} page{selected().size !== 1 ? "s" : ""})
              </p>
              <div class="flex gap-2">
                <button
                  onClick={splitSelected}
                  disabled={splitting()}
                  class="px-4 py-2 bg-green-600 text-white rounded disabled:opacity-50 text-sm font-medium"
                >
                  {splitting() ? "Splitting..." : "Extract as one PDF"}
                </button>
                <Show when={selectedRanges().length > 1}>
                  <button
                    onClick={splitByRanges}
                    disabled={splitting()}
                    class="px-4 py-2 bg-green-600 text-white rounded disabled:opacity-50 text-sm font-medium"
                  >
                    Split into {selectedRanges().length} PDFs
                  </button>
                </Show>
              </div>
            </div>
          </Show>
        </div>
      </Show>

      <Show when={error()}>
        <div class="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mt-4 text-sm">
          {error()}
        </div>
      </Show>
    </div>
  );
}
