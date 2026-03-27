import { createSignal, createEffect, Show, on } from "solid-js";
import DropZone from "./ui/DropZone";
import DocumentViewer from "./ui/DocumentViewer";
import { useSharedPdf } from "../PdfContext";

interface Props {
  /** Called when active page changes (for external status bars). */
  onActivePageChange?: (page: number) => void;
  /** Called when active page dimensions change (for external status bars). */
  onActivePageDimsChange?: (dims: [number, number]) => void;
  /** Dark theme — used for overlay/preview contexts. */
  dark?: boolean;
  /** Initial page to scroll to (default 0). */
  initialPage?: number;
}

export default function PdfViewer(props: Props) {
  const { sharedPdf, loadFile } = useSharedPdf();
  const [handle, setHandle] = createSignal<string | null>(null);
  const [pageCount, setPageCount] = createSignal(0);
  const [error, setError] = createSignal("");
  const [activePage, setActivePage] = createSignal(props.initialPage ?? 0);

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

  function handleActivePage(page: number) {
    setActivePage(page);
    props.onActivePageChange?.(page);
  }

  function handleDims(dims: [number, number]) {
    props.onActivePageDimsChange?.(dims);
  }

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
    <div class="h-full flex flex-col">
      <Show when={!handle()}>
        <div class="p-6">
          <DropZone onFiles={handleFiles} accept=".pdf">
            <p class="text-sm text-gray-500">
              <span class="font-medium">Drop PDF files here</span> or click to browse
            </p>
          </DropZone>
        </div>
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
          initialPage={props.initialPage}
          onActivePageChange={handleActivePage}
          onActivePageDimsChange={handleDims}
          theme={props.dark ? "dark" : "light"}
        />
      </Show>
    </div>
  );
}
