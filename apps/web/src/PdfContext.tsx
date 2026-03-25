import { createContext, useContext, createSignal, onCleanup, type ParentComponent } from "solid-js";
import * as pdfWorker from "./pdf-worker-client";
import { getRenderPool } from "./render-pool";
import { clearThumbnailCache } from "./hooks/useThumbnails";
import { clearRenderCache } from "./components/ui/DocumentViewer";

export interface SharedPdf {
  handle: string;
  fileName: string;
  pageCount: number;
  fileSize: number;
}

interface PdfContextValue {
  sharedPdf: () => SharedPdf | null;
  /** Load a PDF from a File object into shared state. */
  loadFile: (file: File) => Promise<void>;
  /** Load a PDF from raw bytes (e.g. compression result) into shared state. */
  loadFromBytes: (bytes: ArrayBuffer, name: string) => Promise<void>;
  /** Clear shared PDF and unload from worker. */
  clear: () => void;
  /** Download the current working PDF. */
  download: () => Promise<void>;
}

const PdfContext = createContext<PdfContextValue>();

export const PdfProvider: ParentComponent = (props) => {
  const [sharedPdf, setSharedPdf] = createSignal<SharedPdf | null>(null);

  function unloadCurrent() {
    const current = sharedPdf();
    if (current) {
      pdfWorker.unloadDocument(current.handle);
      getRenderPool().unload(current.handle);
      clearThumbnailCache(current.handle);
      clearRenderCache(current.handle);
    }
    setSharedPdf(null);
  }

  async function loadFile(file: File) {
    unloadCurrent();
    const data = await file.arrayBuffer();
    const result = await pdfWorker.loadDocument(data);
    setSharedPdf({
      handle: result.handle,
      fileName: file.name,
      pageCount: result.pageCount,
      fileSize: data.byteLength,
    });
  }

  async function loadFromBytes(bytes: ArrayBuffer, name: string) {
    unloadCurrent();
    const result = await pdfWorker.loadDocument(bytes);
    setSharedPdf({
      handle: result.handle,
      fileName: name,
      pageCount: result.pageCount,
      fileSize: bytes.byteLength,
    });
  }

  function clear() {
    unloadCurrent();
  }

  async function download() {
    const current = sharedPdf();
    if (!current) return;
    const bytes = await pdfWorker.getDocumentBytes(current.handle);
    const blob = new Blob([bytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = current.fileName;
    a.click();
    URL.revokeObjectURL(url);
  }

  onCleanup(() => {
    unloadCurrent();
  });

  const value: PdfContextValue = {
    sharedPdf,
    loadFile,
    loadFromBytes,
    clear,
    download,
  };

  return (
    <PdfContext.Provider value={value}>
      {props.children}
    </PdfContext.Provider>
  );
};

export function useSharedPdf(): PdfContextValue {
  const ctx = useContext(PdfContext);
  if (!ctx) throw new Error("useSharedPdf must be used within PdfProvider");
  return ctx;
}
