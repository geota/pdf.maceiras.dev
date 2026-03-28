import { createContext, useContext, createSignal, onCleanup, type ParentComponent } from "solid-js";
import * as pdfWorker from "./pdf-worker-client";
import { getRenderPool } from "./render-pool";
import { clearThumbnailCache } from "./hooks/useThumbnails";
import { clearRenderCache } from "./render-cache";

export interface SharedPdf {
  handle: string;
  fileName: string;
  pageCount: number;
  fileSize: number;
}

/** Fractional crop rectangle: (x, y) is top-left, all values 0..1 */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Target page dimensions in PDF points. */
export interface ScaleDims {
  widthPts: number;
  heightPts: number;
}

/** A single deferred page operation. */
export type PageOp =
  | { type: "rotate"; angle: number }
  | { type: "crop"; crop: CropRect }
  | { type: "scale"; dims: ScaleDims };
  // Future: | { type: "grayscale" }

/** Derive the cumulative rotation from an ordered ops list (for CSS preview). */
export function effectiveRotation(ops: PageOp[]): number {
  return ops.reduce((sum, op) => op.type === "rotate" ? sum + op.angle : sum, 0);
}

/** Derive the last crop from an ordered ops list (for CSS preview). */
export function effectiveCrop(ops: PageOp[]): CropRect | undefined {
  for (let i = ops.length - 1; i >= 0; i--) {
    if (ops[i].type === "crop") return (ops[i] as { type: "crop"; crop: CropRect }).crop;
  }
  return undefined;
}

/** Derive the last scale from an ordered ops list (for CSS preview). */
export function effectiveScale(ops: PageOp[]): ScaleDims | undefined {
  for (let i = ops.length - 1; i >= 0; i--) {
    if (ops[i].type === "scale") return (ops[i] as { type: "scale"; dims: ScaleDims }).dims;
  }
  return undefined;
}

interface PdfContextValue {
  sharedPdf: () => SharedPdf | null;
  /** Pending per-page operations (ordered list per page). */
  pendingOps: () => Map<number, PageOp[]>;
  /** Whether a full-screen page preview overlay is open. */
  previewOpen: () => boolean;
  setPreviewOpen: (open: boolean) => void;
  /** Load a PDF from a File object into shared state. */
  loadFile: (file: File) => Promise<void>;
  /** Load a PDF from raw bytes (e.g. compression result) into shared state. */
  loadFromBytes: (bytes: ArrayBuffer, name: string) => Promise<void>;
  /** Adopt a document handle already loaded in worker memory into shared state. */
  adoptHandle: (handle: string, pageCount: number, fileName: string) => void;
  /** Clear shared PDF and unload from worker. */
  clear: () => void;
  /** Download the current working PDF (flushes pending ops first). */
  download: () => Promise<void>;
  /** Append an op. Consecutive same-type ops merge (rotations sum, crops/scales replace). */
  setPageOp: (pageIndex: number, partial: Partial<{ rotate: number; crop: CropRect; scale: ScaleDims }>) => void;
  /** Remove all pending ops for a page. */
  clearPageOp: (pageIndex: number) => void;
  /** Flush all pending ops to the actual PDF in order. Returns true if anything was flushed. */
  flushOps: () => Promise<boolean>;
  /** Queue a page rotation (CSS-only, instant). */
  rotatePage: (pageIndex: number, angle: number) => void;
  /** Queue a crop (CSS-only, instant). */
  cropPage: (pageIndex: number, crop: CropRect) => void;
  /** Queue a scale (CSS-only, instant). */
  scalePage: (pageIndex: number, widthPts: number, heightPts: number) => void;
}

const PdfContext = createContext<PdfContextValue>();

export const PdfProvider: ParentComponent = (props) => {
  const [sharedPdf, setSharedPdf] = createSignal<SharedPdf | null>(null);
  const [pendingOps, setPendingOps] = createSignal<Map<number, PageOp[]>>(new Map());
  const [previewOpen, setPreviewOpen] = createSignal(false);

  function unloadCurrent() {
    const current = sharedPdf();
    if (current) {
      pdfWorker.unloadDocument(current.handle);
      getRenderPool().unload(current.handle);
      clearThumbnailCache(current.handle);
      clearRenderCache(current.handle);
    }
    setSharedPdf(null);
    setPendingOps(new Map());
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

  function adoptHandle(handle: string, pageCount: number, fileName: string) {
    unloadCurrent();
    setSharedPdf({ handle, fileName, pageCount, fileSize: 0 });
  }

  function clear() {
    unloadCurrent();
  }

  // --- Pending operations ---

  function setPageOp(pageIndex: number, partial: Partial<{ rotate: number; crop: CropRect; scale: ScaleDims }>) {
    setPendingOps((prev) => {
      const next = new Map(prev);
      const list = [...(next.get(pageIndex) ?? [])];

      if (partial.rotate !== undefined) {
        const last = list[list.length - 1];
        if (last?.type === "rotate") {
          const summed = last.angle + partial.rotate;
          if (summed === 0) list.pop();
          else list[list.length - 1] = { type: "rotate", angle: summed };
        } else {
          list.push({ type: "rotate", angle: partial.rotate });
        }
      }

      if (partial.crop !== undefined) {
        const last = list[list.length - 1];
        if (last?.type === "crop") {
          list[list.length - 1] = { type: "crop", crop: partial.crop };
        } else {
          list.push({ type: "crop", crop: partial.crop });
        }
      }

      if (partial.scale !== undefined) {
        const last = list[list.length - 1];
        if (last?.type === "scale") {
          list[list.length - 1] = { type: "scale", dims: partial.scale };
        } else {
          list.push({ type: "scale", dims: partial.scale });
        }
      }

      if (list.length === 0) {
        next.delete(pageIndex);
      } else {
        next.set(pageIndex, list);
      }
      return next;
    });
  }

  function clearPageOp(pageIndex: number) {
    setPendingOps((prev) => {
      if (!prev.has(pageIndex)) return prev;
      const next = new Map(prev);
      next.delete(pageIndex);
      return next;
    });
  }

  function rotatePage(pageIndex: number, angle: number) {
    setPageOp(pageIndex, { rotate: angle });
  }

  function cropPage(pageIndex: number, crop: CropRect) {
    setPageOp(pageIndex, { crop });
  }

  function scalePage(pageIndex: number, widthPts: number, heightPts: number) {
    setPageOp(pageIndex, { scale: { widthPts, heightPts } });
  }

  function swapDocument(result: { handle: string; pageCount: number; fileSize: number }) {
    const prev = sharedPdf();
    setSharedPdf({
      handle: result.handle,
      fileName: prev?.fileName ?? "document.pdf",
      pageCount: result.pageCount,
      fileSize: result.fileSize,
    });
    if (prev) {
      pdfWorker.unloadDocument(prev.handle);
      getRenderPool().unload(prev.handle);
      clearThumbnailCache(prev.handle);
      clearRenderCache(prev.handle);
    }
  }

  async function flushOps(): Promise<boolean> {
    const ops = pendingOps();
    const current = sharedPdf();
    if (ops.size === 0 || !current) return false;

    let anyFlushed = false;

    // Process ops in rounds to preserve per-page ordering.
    // Round k processes the k-th op from each page's list.
    // Within each round, crops go first (reverse page order for index stability),
    // then rotations are batched.
    const maxLen = Math.max(...[...ops.values()].map((list) => list.length));

    for (let round = 0; round < maxLen; round++) {
      const crops: [number, CropRect][] = [];
      const scales: [number, ScaleDims][] = [];
      const rotations: [number, number][] = [];

      for (const [page, list] of ops) {
        if (round >= list.length) continue;
        const op = list[round];
        if (op.type === "crop") {
          crops.push([page, op.crop]);
        } else if (op.type === "scale") {
          scales.push([page, op.dims]);
        } else if (op.type === "rotate") {
          const angle = ((op.angle % 360) + 360) % 360;
          if (angle !== 0) rotations.push([page, angle]);
        }
      }

      // Apply crops first (reverse page order so indices stay valid)
      crops.sort(([a], [b]) => b - a);
      for (const [page, crop] of crops) {
        const cur = sharedPdf();
        if (!cur) continue;
        const dims = await pdfWorker.getPageDimensions(cur.handle, page);
        const [pdfW, pdfH] = dims;
        const cropBox: [number, number, number, number] = [
          crop.x * pdfW,
          (1 - crop.y - crop.h) * pdfH,
          (crop.x + crop.w) * pdfW,
          (1 - crop.y) * pdfH,
        ];
        const result = await pdfWorker.cropPage(cur.handle, page, cropBox);
        swapDocument(result);
        anyFlushed = true;
      }

      // Apply scales (reverse page order)
      scales.sort(([a], [b]) => b - a);
      for (const [page, dims] of scales) {
        const cur = sharedPdf();
        if (!cur) continue;
        const result = await pdfWorker.scalePage(cur.handle, page, dims.widthPts, dims.heightPts);
        swapDocument(result);
        anyFlushed = true;
      }

      // Apply rotations (batch)
      if (rotations.length > 0) {
        const cur = sharedPdf();
        if (cur) {
          const result = await pdfWorker.rotatePages(cur.handle, rotations);
          swapDocument(result);
          anyFlushed = true;
        }
      }
    }

    if (anyFlushed) {
      setPendingOps(new Map());
    }

    return anyFlushed;
  }

  // --- Download ---

  async function download() {
    await flushOps();
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
    pendingOps,
    previewOpen,
    setPreviewOpen,
    loadFile,
    loadFromBytes,
    adoptHandle,
    clear,
    download,
    setPageOp,
    clearPageOp,
    flushOps,
    rotatePage,
    cropPage,
    scalePage,
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
