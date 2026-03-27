/// PDF Module Worker — loads PDFium + Rust WASM modules via ESM imports.
/// Documents are loaded once into worker memory via handles to avoid
/// re-transferring bytes on every operation.

import * as Comlink from "comlink";

let initialized = false;
let api: typeof import("../../../packages/pdf-wasm-pkg/pdf_wasm") | null =
  null;

async function initialize() {
  if (initialized) return;

  console.log("[pdf-worker] Loading PDFium...");
  const { default: PDFiumFactory } = await import("./lib/pdfium.js");
  const wasmResponse = await fetch("/pdfium.wasm");
  const wasmBinary = await wasmResponse.arrayBuffer();
  const pdfiumModule = await PDFiumFactory({ wasmBinary });
  console.log(
    "[pdf-worker] PDFium loaded. Has ccall:",
    typeof pdfiumModule.ccall === "function"
  );

  console.log("[pdf-worker] Loading Rust WASM module...");
  const wasmModule = await import(
    "../../../packages/pdf-wasm-pkg/pdf_wasm.js"
  );
  const wasmExports = await wasmModule.default();

  const success = wasmModule.initialize_pdfium_render(
    pdfiumModule,
    wasmExports,
    true
  );

  if (!success) {
    throw new Error("Failed to initialize pdfium-render");
  }

  api = wasmModule;
  initialized = true;
  console.log("[pdf-worker] Initialized successfully");
}

// --- Document cache ---
let nextHandle = 0;
const documents = new Map<string, Uint8Array>();

function getDoc(handle: string): Uint8Array {
  const doc = documents.get(handle);
  if (!doc) throw new Error(`Unknown document handle: ${handle}`);
  return doc;
}

// --- Per-page analysis cache ---
export interface PageAnalysis {
  image_count: number;
  max_dpi: number | null;
  estimated_jpeg_quality: number | null;
  estimated_image_bytes: number;
  image_ids: [number, number][];
}

export interface DetailedAnalysis {
  summary: {
    max_dpi: number | null;
    estimated_jpeg_quality: number | null;
    jpeg_image_count: number;
    non_jpeg_image_count: number;
    total_image_count: number;
  };
  pages: PageAnalysis[];
}

const analysisCache = new Map<string, DetailedAnalysis>();

function getCachedAnalysis(handle: string): DetailedAnalysis | undefined {
  return analysisCache.get(handle);
}

/** Remap cached analysis for a reorder operation (no re-analysis needed). */
function remapAnalysisForReorder(oldHandle: string, newHandle: string, pageOrder: number[]) {
  const cached = analysisCache.get(oldHandle);
  if (!cached) return;
  const newPages = pageOrder.map((i) => cached.pages[i]).filter(Boolean);
  if (newPages.length === pageOrder.length) {
    analysisCache.set(newHandle, { summary: cached.summary, pages: newPages });
  }
}

/** Clear analysis cache for a handle. */
function invalidateAnalysis(handle: string) {
  analysisCache.delete(handle);
}

const workerApi = {
  async ping(): Promise<string> {
    await initialize();
    return "pong";
  },

  /** Load PDF bytes into worker memory, return a handle. */
  async loadDocument(data: ArrayBuffer): Promise<{ handle: string; pageCount: number }> {
    await initialize();
    const bytes = new Uint8Array(data);
    const handle = `doc_${nextHandle++}`;
    documents.set(handle, bytes);
    const pageCount = api!.getPageCount(bytes);
    return { handle, pageCount };
  },

  /** Free a loaded document from worker memory. */
  async unloadDocument(handle: string): Promise<void> {
    documents.delete(handle);
    invalidateAnalysis(handle);
  },

  /** Return raw document bytes for a handle (used to distribute to render pool). */
  async getDocumentBytes(handle: string): Promise<ArrayBuffer> {
    const doc = getDoc(handle);
    // Return a copy so the original stays intact
    const copy = new Uint8Array(doc).buffer as ArrayBuffer;
    return Comlink.transfer(copy, [copy]);
  },

  /** Load a document from a SharedArrayBuffer — zero-copy across workers.
   *  All workers share the same underlying memory. */
  async loadDocumentFromShared(
    sab: SharedArrayBuffer,
    byteOffset: number,
    byteLength: number,
    handle: string
  ): Promise<{ pageCount: number }> {
    await initialize();
    // Create a view over the shared memory — no copy
    const bytes = new Uint8Array(sab, byteOffset, byteLength);
    documents.set(handle, bytes);
    const pageCount = api!.getPageCount(bytes);
    return { pageCount };
  },

  async getPageCount(handle: string): Promise<number> {
    await initialize();
    return api!.getPageCount(getDoc(handle));
  },

  async renderPage(
    handle: string,
    pageIndex: number,
    width: number
  ): Promise<ImageData> {
    await initialize();
    return api!.renderPage(getDoc(handle), pageIndex, width);
  },

  /** Render multiple pages in one call — parses the PDF once in WASM. */
  async renderPages(
    handle: string,
    pageIndices: number[],
    width: number
  ): Promise<(ImageData | null)[]> {
    await initialize();
    const doc = getDoc(handle);
    // WASM returns proper ImageData objects directly (with copied pixel data)
    return api!.renderPages(doc, new Uint16Array(pageIndices), width);
  },

  async getPageDimensions(
    handle: string,
    pageIndex: number
  ): Promise<[number, number]> {
    await initialize();
    return api!.getPageDimensions(getDoc(handle), pageIndex);
  },

  /** Merge multiple loaded documents. Returns merged PDF as ArrayBuffer. */
  async mergePdfs(handles: string[]): Promise<ArrayBuffer> {
    await initialize();
    const arrays = handles.map((h) => getDoc(h));
    const merged: Uint8Array = api!.mergePdfs(arrays);
    const buf = merged.buffer as ArrayBuffer;
    return Comlink.transfer(buf, [buf]);
  },

  /** Merge multiple loaded documents and store the result in worker memory.
   *  Avoids transferring the merged bytes back and forth. */
  async mergeAndLoad(handles: string[]): Promise<{ handle: string; pageCount: number }> {
    await initialize();
    const arrays = handles.map((h) => getDoc(h));
    const merged: Uint8Array = api!.mergePdfs(arrays);
    const handle = `doc_${nextHandle++}`;
    documents.set(handle, merged);
    const pageCount = api!.getPageCount(merged);
    return { handle, pageCount };
  },

  /** Split a loaded document by page ranges. Returns ArrayBuffer per range. */
  async splitPdf(
    handle: string,
    ranges: { start: number; end: number }[]
  ): Promise<ArrayBuffer[]> {
    await initialize();
    const parts: Uint8Array[] = api!.splitPdf(getDoc(handle), ranges);
    const buffers = parts.map((p: Uint8Array) => p.buffer as ArrayBuffer);
    return Comlink.transfer(buffers, buffers);
  },

  /** Reorder pages in a loaded document. Returns new PDF as ArrayBuffer. */
  async reorderPages(
    handle: string,
    pageOrder: number[]
  ): Promise<ArrayBuffer> {
    await initialize();
    const result: Uint8Array = api!.reorderPages(
      getDoc(handle),
      new Uint32Array(pageOrder)
    );
    const buf = result.buffer as ArrayBuffer;
    return Comlink.transfer(buf, [buf]);
  },

  /** Reorder pages and store result in worker memory. Remaps analysis cache. */
  async reorderAndLoad(
    handle: string,
    pageOrder: number[]
  ): Promise<{ handle: string; pageCount: number; fileSize: number }> {
    await initialize();
    const result: Uint8Array = api!.reorderPages(
      getDoc(handle),
      new Uint32Array(pageOrder)
    );
    const newHandle = `doc_${nextHandle++}`;
    documents.set(newHandle, result);
    remapAnalysisForReorder(handle, newHandle, pageOrder);
    const pageCount = api!.getPageCount(result);
    return { handle: newHandle, pageCount, fileSize: result.byteLength };
  },

  /** Get metadata from a loaded document. */
  async getMetadata(
    handle: string
  ): Promise<{
    pageCount: number;
    title: string | null;
    author: string | null;
    subject: string | null;
    keywords: string | null;
  }> {
    await initialize();
    return api!.getMetadata(getDoc(handle));
  },

  /** Analyze a loaded document's images. Returns global stats (caches detailed analysis). */
  async analyzePdf(
    handle: string
  ): Promise<{
    max_dpi: number | null;
    estimated_jpeg_quality: number | null;
    jpeg_image_count: number;
    non_jpeg_image_count: number;
    total_image_count: number;
  }> {
    await initialize();
    const cached = getCachedAnalysis(handle);
    if (cached) return cached.summary;
    const detailed: DetailedAnalysis = api!.analyzePdfDetailed(getDoc(handle));
    analysisCache.set(handle, detailed);
    return detailed.summary;
  },

  /** Detailed analysis: global + per-page breakdown. Cached per handle. */
  async analyzePdfDetailed(handle: string): Promise<DetailedAnalysis> {
    await initialize();
    const cached = getCachedAnalysis(handle);
    if (cached) return cached;
    const detailed: DetailedAnalysis = api!.analyzePdfDetailed(getDoc(handle));
    analysisCache.set(handle, detailed);
    return detailed;
  },

  /** Get per-page analysis for a single page (from cache or compute). */
  async getPageAnalysis(handle: string, pageIndex: number): Promise<PageAnalysis | null> {
    await initialize();
    let cached = getCachedAnalysis(handle);
    if (!cached) {
      const detailed: DetailedAnalysis = api!.analyzePdfDetailed(getDoc(handle));
      analysisCache.set(handle, detailed);
      cached = detailed;
    }
    return cached.pages[pageIndex] ?? null;
  },


  /** Compress a loaded document. Returns compressed PDF + compression report. */
  async compressPdf(
    handle: string,
    options?: {
      preset?: "lossless" | "low" | "medium" | "high" | "advanced";
      strip_metadata?: boolean;
      grayscale?: boolean;
      advanced?: {
        mode: "direct" | "target_size";
        dpi?: number;
        jpeg_quality?: number;
        jp2?: boolean;
        target_bytes?: number;
        min_dpi?: number;
        min_jpeg_quality?: number;
      };
    }
  ): Promise<{
    data: ArrayBuffer;
    result: {
      original_size: number;
      compressed_size: number;
      techniques_applied: string[];
      target_met: boolean;
    };
  }> {
    await initialize();
    const doc = getDoc(handle);
    const res = api!.compressPdf(
      doc,
      options ?? null
    );
    const data = (res as any).data as Uint8Array;
    const buf = data.buffer as ArrayBuffer;
    return {
      data: Comlink.transfer(buf, [buf]) as unknown as ArrayBuffer,
      result: (res as any).result,
    };
  },

  // --- Parallel compression ---

  /** Phase 1: structural lossless + extract image tasks. */
  async compressBegin(
    handle: string,
    options?: Record<string, unknown>
  ): Promise<{
    complete: boolean;
    imageTasks?: unknown[];
  }> {
    await initialize();
    return api!.compressBegin(getDoc(handle), options ?? null);
  },

  /** Process a single image task (called by pool workers). */
  async processImageTask(task: unknown): Promise<unknown | null> {
    await initialize();
    return api!.processImageTask(task);
  },

  /** Process an image task with transferred bytes (zero-copy).
   *  Meta contains task fields except image_bytes; bytes is a transferred ArrayBuffer. */
  async processImageTaskWithTransfer(
    meta: unknown,
    bytes: ArrayBuffer
  ): Promise<unknown | null> {
    await initialize();
    // Reconstruct the full task object with the transferred bytes
    const task = { ...(meta as any), image_bytes: new Uint8Array(bytes) };
    return api!.processImageTask(task);
  },

  /** Target-size step: apply results, return next tasks or signal completion. */
  async compressTargetStep(
    results: unknown[]
  ): Promise<{
    complete: boolean;
    imageTasks?: unknown[];
  }> {
    await initialize();
    return api!.compressTargetStep(results);
  },

  /** Phase 3: apply image results and finalize. */
  async compressFinish(
    results: unknown[]
  ): Promise<{
    data: ArrayBuffer;
    result: {
      original_size: number;
      compressed_size: number;
      techniques_applied: string[];
      target_met: boolean;
    };
  }> {
    await initialize();
    const res = api!.compressFinish(results);
    const data = (res as any).data as Uint8Array;
    const buf = data.buffer as ArrayBuffer;
    return {
      data: Comlink.transfer(buf, [buf]) as unknown as ArrayBuffer,
      result: (res as any).result,
    };
  },

  /** Rotate a single page. Stores result in worker memory, returns new handle + pageCount + fileSize. */
  async rotatePage(
    handle: string,
    pageIndex: number,
    angle: number
  ): Promise<{ handle: string; pageCount: number; fileSize: number }> {
    await initialize();
    const result: Uint8Array = api!.rotatePage(
      getDoc(handle),
      pageIndex,
      angle
    );
    const newHandle = `doc_${nextHandle++}`;
    documents.set(newHandle, result);
    const pageCount = api!.getPageCount(result);
    return { handle: newHandle, pageCount, fileSize: result.byteLength };
  },

  /** Apply multiple page rotations in one pass. Each entry is [pageIndex, angle].
   *  Stores result in worker memory, returns new handle. */
  async rotatePages(
    handle: string,
    rotations: [number, number][]
  ): Promise<{ handle: string; pageCount: number; fileSize: number }> {
    await initialize();
    let bytes = getDoc(handle);
    for (const [pageIndex, angle] of rotations) {
      bytes = api!.rotatePage(bytes, pageIndex, angle);
    }
    const newHandle = `doc_${nextHandle++}`;
    documents.set(newHandle, bytes);
    const pageCount = api!.getPageCount(bytes);
    return { handle: newHandle, pageCount, fileSize: bytes.byteLength };
  },

  /** Crop a single page. Stores result in worker memory, returns new handle + pageCount + fileSize. */
  async cropPage(
    handle: string,
    pageIndex: number,
    cropBox: [number, number, number, number]
  ): Promise<{ handle: string; pageCount: number; fileSize: number }> {
    await initialize();
    const result: Uint8Array = api!.cropPage(
      getDoc(handle),
      pageIndex,
      new Float32Array(cropBox)
    );
    const newHandle = `doc_${nextHandle++}`;
    documents.set(newHandle, result);
    const pageCount = api!.getPageCount(result);
    return { handle: newHandle, pageCount, fileSize: result.byteLength };
  },

  /** Scale a single page to new dimensions (PDF points). Stores result, returns new handle. */
  async scalePage(
    handle: string,
    pageIndex: number,
    newWidthPts: number,
    newHeightPts: number
  ): Promise<{ handle: string; pageCount: number; fileSize: number }> {
    await initialize();
    const result: Uint8Array = api!.scalePage(
      getDoc(handle),
      pageIndex,
      newWidthPts,
      newHeightPts
    );
    const newHandle = `doc_${nextHandle++}`;
    documents.set(newHandle, result);
    const pageCount = api!.getPageCount(result);
    return { handle: newHandle, pageCount, fileSize: result.byteLength };
  },

  /** Set metadata on a loaded document. Returns new PDF as ArrayBuffer. */
  async setMetadata(
    handle: string,
    metadata: {
      title?: string | null;
      author?: string | null;
      subject?: string | null;
      keywords?: string | null;
    }
  ): Promise<ArrayBuffer> {
    await initialize();
    const result: Uint8Array = api!.setMetadata(getDoc(handle), metadata);
    const buf = result.buffer as ArrayBuffer;
    return Comlink.transfer(buf, [buf]);
  },
};

export type WorkerApi = typeof workerApi;

Comlink.expose(workerApi);
