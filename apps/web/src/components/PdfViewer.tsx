import { createSignal, createEffect, Show, on } from "solid-js";
import DropZone from "./ui/DropZone";
import DocumentViewer from "./ui/DocumentViewer";
import { useSharedPdf } from "../PdfContext";

export default function PdfViewer(props: { onActivePageChange?: (page: number) => void }) {
  const { sharedPdf, loadFile } = useSharedPdf();
  const [handle, setHandle] = createSignal<string | null>(null);
  const [pageCount, setPageCount] = createSignal(0);
  const [error, setError] = createSignal("");

  // Sync from shared PDF when it changes
  createEffect(on(sharedPdf, (pdf) => {
    if (pdf) {
      setHandle(pdf.handle);
      setPageCount(pdf.pageCount);
      setError("");
    } else {
      setHandle(null);
      setPageCount(0);
    }
  }));

  async function handleFiles(files: File[]) {
    if (!files.length) return;
    setError("");
    try {
      await loadFile(files[0]);
    } catch (err: any) {
      setError(err.message || "Failed to load PDF");
    }
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
          onActivePageChange={props.onActivePageChange}
        />
      </Show>
    </div>
  );
}
