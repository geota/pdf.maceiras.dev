import { createSignal, onCleanup, Show } from "solid-js";
import * as pdfWorker from "../pdf-worker-client";

export default function PdfSplit() {
  const [file, setFile] = createSignal<{
    name: string;
    handle: string;
    pageCount: number;
  } | null>(null);
  const [rangeInput, setRangeInput] = createSignal("1-1");
  const [splitting, setSplitting] = createSignal(false);
  const [error, setError] = createSignal("");
  const [loading, setLoading] = createSignal(false);

  onCleanup(() => {
    const f = file();
    if (f) pdfWorker.unloadDocument(f.handle);
  });

  async function handleFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0];
    if (!f) return;

    // Unload previous document
    const prev = file();
    if (prev) await pdfWorker.unloadDocument(prev.handle);

    setError("");
    setLoading(true);
    try {
      const data = await f.arrayBuffer();
      const { handle, pageCount } = await pdfWorker.loadDocument(data);
      setFile({ name: f.name, handle, pageCount });
      setRangeInput(`1-${pageCount}`);
    } catch (err: any) {
      setError(err.message || "Failed to load PDF");
    } finally {
      setLoading(false);
    }
  }

  function parseRanges(
    input: string,
    maxPage: number
  ): { start: number; end: number }[] | null {
    const ranges: { start: number; end: number }[] = [];
    for (const part of input.split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const match = trimmed.match(/^(\d+)(?:-(\d+))?$/);
      if (!match) return null;
      const start = parseInt(match[1], 10);
      const end = match[2] ? parseInt(match[2], 10) : start;
      if (start < 1 || end < start || end > maxPage) return null;
      // Convert to 0-indexed, exclusive end
      ranges.push({ start: start - 1, end });
    }
    return ranges.length > 0 ? ranges : null;
  }

  async function split() {
    const f = file();
    if (!f) return;

    const ranges = parseRanges(rangeInput(), f.pageCount);
    if (!ranges) {
      setError("Invalid range format. Use e.g. 1-3,5,7-10");
      return;
    }

    setSplitting(true);
    setError("");
    try {
      const parts = await pdfWorker.splitPdf(f.handle, ranges);
      parts.forEach((part: ArrayBuffer, i: number) => {
        const blob = new Blob([part], { type: "application/pdf" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        const baseName = f.name.replace(/\.pdf$/i, "");
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
      <h2 class="text-lg font-semibold mb-3">Split PDF</h2>

      <input
        type="file"
        accept=".pdf"
        onChange={handleFile}
        class="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100 mb-3"
      />

      <Show when={loading()}>
        <p class="text-sm text-gray-400">Loading PDF...</p>
      </Show>

      <Show when={file()}>
        {(f) => (
          <div>
            <p class="text-sm text-gray-600 mb-2">
              {f().name} — {f().pageCount} page{f().pageCount > 1 ? "s" : ""}
            </p>
            <label class="block text-sm mb-1">
              Page ranges (e.g. 1-3,5,7-10):
            </label>
            <input
              type="text"
              value={rangeInput()}
              onInput={(e) => setRangeInput(e.currentTarget.value)}
              class="border rounded px-3 py-1 text-sm w-64 mb-3"
            />
            <br />
            <button
              onClick={split}
              disabled={splitting()}
              class="px-4 py-2 bg-green-600 text-white rounded disabled:opacity-50 text-sm"
            >
              {splitting() ? "Splitting..." : "Split"}
            </button>
          </div>
        )}
      </Show>

      <Show when={error()}>
        <div class="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mt-3 text-sm">
          {error()}
        </div>
      </Show>
    </div>
  );
}
