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
