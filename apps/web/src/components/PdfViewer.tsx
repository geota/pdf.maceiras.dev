import { createSignal, Show, onCleanup } from "solid-js";
import * as pdfWorker from "../pdf-worker-client";
import { getRenderPool } from "../render-pool";
import DropZone from "./ui/DropZone";
import DocumentViewer from "./ui/DocumentViewer";

export default function PdfViewer() {
  const [handle, setHandle] = createSignal<string | null>(null);
  const [fileName, setFileName] = createSignal("");
  const [pageCount, setPageCount] = createSignal(0);
  const [error, setError] = createSignal("");
  const [activePage, setActivePage] = createSignal(0);

  onCleanup(() => {
    const h = handle();
    if (h) {
      pdfWorker.unloadDocument(h);
      getRenderPool().unload(h);
    }
  });

  async function handleFiles(files: File[]) {
    if (!files.length) return;
    const prevHandle = handle();
    if (prevHandle) {
      pdfWorker.unloadDocument(prevHandle);
      getRenderPool().unload(prevHandle);
    }
    setHandle(null);
    setPageCount(0);
    setActivePage(0);
    setError("");

    const file = files[0];
    setFileName(file.name);
    try {
      const data = await file.arrayBuffer();
      const result = await pdfWorker.loadDocument(data);
      setHandle(result.handle);
      setPageCount(result.pageCount);
    } catch (err: any) {
      setError(err.message || "Failed to load PDF");
    }
  }

  function closeDocument() {
    const h = handle();
    if (h) {
      pdfWorker.unloadDocument(h);
      getRenderPool().unload(h);
    }
    setHandle(null);
    setPageCount(0);
    setFileName("");
    setActivePage(0);
    setError("");
  }

  return (
    <div class={handle() ? "h-full flex flex-col" : "p-6 max-w-5xl mx-auto"}>
      <Show when={!handle()}>
        <h2 class="text-xl font-semibold mb-4">View PDF</h2>
        <DropZone onFiles={handleFiles} accept=".pdf">
          <p class="text-sm text-gray-500">
            <span class="font-medium">Drop a PDF here</span> or click to browse
          </p>
        </DropZone>
      </Show>

      <Show when={error()}>
        <div class="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mt-4 text-sm">
          {error()}
        </div>
      </Show>

      <Show when={handle()}>
        <DocumentViewer
          handle={handle()!}
          pageCount={pageCount()}
          onActivePageChange={setActivePage}
        />

        <div class="flex items-center justify-between px-3 py-1 border-t border-gray-200 bg-gray-50 shrink-0">
          <p class="text-xs text-gray-500">
            {fileName()} — Page {activePage() + 1} of {pageCount()}
          </p>
          <button onClick={closeDocument} class="text-xs text-gray-500 hover:underline">
            Close
          </button>
        </div>
      </Show>
    </div>
  );
}
