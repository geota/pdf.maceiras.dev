/// PDF Module Worker — loads PDFium + Rust WASM modules via ESM imports.
/// Exposes API via Comlink.

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

const workerApi = {
  async ping(): Promise<string> {
    await initialize();
    return "pong";
  },

  async getPageCount(data: ArrayBuffer): Promise<number> {
    await initialize();
    return api!.getPageCount(new Uint8Array(data));
  },

  async renderPage(
    data: ArrayBuffer,
    pageIndex: number,
    width: number
  ): Promise<ImageData> {
    await initialize();
    return api!.renderPage(new Uint8Array(data), pageIndex, width);
  },

  async getPageDimensions(
    data: ArrayBuffer,
    pageIndex: number
  ): Promise<[number, number]> {
    await initialize();
    return api!.getPageDimensions(new Uint8Array(data), pageIndex);
  },

  async mergePdfs(pdfs: ArrayBuffer[]): Promise<ArrayBuffer> {
    await initialize();
    const arrays = pdfs.map((buf) => new Uint8Array(buf));
    const merged: Uint8Array = api!.mergePdfs(arrays);
    const buf = merged.buffer as ArrayBuffer;
    return Comlink.transfer(buf, [buf]);
  },

  async splitPdf(
    data: ArrayBuffer,
    ranges: { start: number; end: number }[]
  ): Promise<ArrayBuffer[]> {
    await initialize();
    const parts: Uint8Array[] = api!.splitPdf(new Uint8Array(data), ranges);
    const buffers = parts.map((p: Uint8Array) => p.buffer as ArrayBuffer);
    return Comlink.transfer(buffers, buffers);
  },
};

export type WorkerApi = typeof workerApi;

Comlink.expose(workerApi);
