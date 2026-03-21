/// PDF Module Worker — loads PDFium + Rust WASM modules via ESM imports.

let initialized = false;
let api: typeof import("../../../packages/pdf-wasm-pkg/pdf_wasm") | null =
  null;

async function initialize() {
  if (initialized) return;

  // Step 1: Load PDFium Emscripten module (paulocoutinhox ESM build)
  console.log("[pdf-worker] Loading PDFium...");

  // Import the ESM build of PDFium from src/lib (not public/).
  // Fetch pdfium.wasm ourselves and pass as wasmBinary to avoid Emscripten's
  // locateFile/fetch which gets confused by Vite's module transforms.
  const { default: PDFiumFactory } = await import("./lib/pdfium.js");
  const wasmResponse = await fetch("/pdfium.wasm");
  const wasmBinary = await wasmResponse.arrayBuffer();
  const pdfiumModule = await PDFiumFactory({
    wasmBinary,
  });
  console.log(
    "[pdf-worker] PDFium loaded. Has ccall:",
    typeof pdfiumModule.ccall === "function"
  );

  // Step 2: Load Rust WASM module (ESM, --target web)
  console.log("[pdf-worker] Loading Rust WASM module...");
  const wasmModule = await import(
    "../../../packages/pdf-wasm-pkg/pdf_wasm.js"
  );
  const wasmExports = await wasmModule.default();

  // Step 3: Initialize pdfium-render binding
  // First arg: Emscripten Module (has _malloc, _free, ccall, HEAPU8, wasmExports)
  // Second arg: wasm-bindgen exports (has __wbindgen_* helpers)
  const success = wasmModule.initialize_pdfium_render(
    pdfiumModule,
    wasmExports,
    true // debug=true for the spike
  );

  if (!success) {
    throw new Error("Failed to initialize pdfium-render");
  }

  api = wasmModule;
  initialized = true;
  console.log("[pdf-worker] Initialized successfully");
}

// Message handler
self.onmessage = async (e: MessageEvent) => {
  const { id, method, args } = e.data;

  try {
    await initialize();
    if (!api) throw new Error("Not initialized");

    let result: any;

    switch (method) {
      case "getPageCount": {
        const data = new Uint8Array(args[0]);
        result = api.getPageCount(data);
        break;
      }
      case "renderPage": {
        const data = new Uint8Array(args[0]);
        const pageIndex = args[1] as number;
        const width = args[2] as number;
        result = api.renderPage(data, pageIndex, width);
        break;
      }
      case "getPageDimensions": {
        const data = new Uint8Array(args[0]);
        const pageIndex = args[1] as number;
        result = api.getPageDimensions(data, pageIndex);
        break;
      }
      case "mergePdfs": {
        const pdfs = (args[0] as ArrayBuffer[]).map(
          (buf) => new Uint8Array(buf)
        );
        const merged: Uint8Array = api.mergePdfs(pdfs);
        result = merged.buffer;
        (self as any).postMessage({ id, result }, [result]);
        return;
      }
      case "splitPdf": {
        const data = new Uint8Array(args[0]);
        const ranges = args[1];
        const parts: Uint8Array[] = api.splitPdf(data, ranges);
        // Convert Uint8Arrays to ArrayBuffers for postMessage transfer
        const buffers = parts.map((p: Uint8Array) => p.buffer);
        (self as any).postMessage({ id, result: buffers }, buffers);
        return;
      }
      case "ping": {
        result = "pong";
        break;
      }
      default:
        throw new Error(`Unknown method: ${method}`);
    }

    (self as any).postMessage({ id, result });
  } catch (err: any) {
    (self as any).postMessage({
      id,
      error: err.message || String(err),
    });
  }
};
