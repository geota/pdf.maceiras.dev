import { createSignal, createEffect, Show, on } from "solid-js";
import DropZone from "./ui/DropZone";
import DocumentViewer from "./ui/DocumentViewer";
import PdfBottomBar from "./ui/PdfBottomBar";
import PdfStatusInfo from "./ui/PdfStatusInfo";
import { useSharedPdf } from "../PdfContext";

interface Props {
  /** Called when active page changes (for external status bars). */
  onActivePageChange?: (page: number) => void;
  /** Called when active page dimensions change (for external status bars). */
  onActivePageDimsChange?: (dims: [number, number]) => void;
  /** Dark theme — used for overlay/preview contexts. */
  dark?: boolean;
  /** Render an integrated bottom bar with page info, download, and close. */
  bottomBar?: boolean;
  /** Initial page to scroll to (default 0). */
  initialPage?: number;
  /** Close handler — required when bottomBar is true. */
  onClose?: () => void;
}

export default function PdfViewer(props: Props) {
  const { sharedPdf, loadFile, download } = useSharedPdf();
  const [handle, setHandle] = createSignal<string | null>(null);
  const [pageCount, setPageCount] = createSignal(0);
  const [error, setError] = createSignal("");
  const [activePage, setActivePage] = createSignal(props.initialPage ?? 0);
  const [pageDims, setPageDims] = createSignal<[number, number] | null>(null);

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
    setPageDims(dims);
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
          initialPage={props.initialPage}
          onActivePageChange={handleActivePage}
          onActivePageDimsChange={handleDims}
          theme={props.dark ? "dark" : "light"}
        />
      </Show>

      <Show when={props.bottomBar && handle()}>
        <PdfBottomBar
          dark={props.dark}
          info={
            <PdfStatusInfo
              fileName={sharedPdf()?.fileName ?? ""}
              pageCount={pageCount()}
              activePage={activePage()}
              pageDims={pageDims()}
              fileSize={sharedPdf()?.fileSize}
            />
          }
          onDownload={download}
          onClose={props.onClose!}
        />
      </Show>
    </div>
  );
}
