import { createSignal, createEffect, Show, on } from "solid-js";
import PdfToolLayout from "./ui/PdfToolLayout";
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
  const { sharedPdf, loadFile, adoptHandle } = useSharedPdf();
  const [handle, setHandle] = createSignal<string | null>(null);
  const [pageCount, setPageCount] = createSignal(0);
  const [error, setError] = createSignal("");
  const [activePage, setActivePage] = createSignal(props.initialPage ?? 0);
  const [pendingFiles, setPendingFiles] = createSignal<File[] | null>(null);

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

    if (files.length > 1) {
      setPendingFiles(files);
      return;
    }

    try {
      await loadFile(files[0]);
    } catch (err: any) {
      setError(err.message || "Failed to load PDF");
    }
  }

  function handleMerged(mergedHandle: string, mergedPageCount: number, mergedFileName: string) {
    setPendingFiles(null);
    adoptHandle(mergedHandle, mergedPageCount, mergedFileName);
  }

  function resetState() {
    setPendingFiles(null);
    setError("");
  }

  return (
    <PdfToolLayout
      handle={handle}
      error={error}
      pendingFiles={pendingFiles}
      previewPage={() => null}
      onFiles={handleFiles}
      onMerged={handleMerged}
      onResetFiles={resetState}
      onClosePreview={() => {}}
      noPadding
    >
      <DocumentViewer
        handle={handle()!}
        pageCount={pageCount()}
        initialPage={props.initialPage}
        onActivePageChange={handleActivePage}
        onActivePageDimsChange={handleDims}
        theme={props.dark ? "dark" : "light"}
      />
    </PdfToolLayout>
  );
}
