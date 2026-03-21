/// Type-safe client for the PDF module worker.

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<
  number,
  { resolve: (v: any) => void; reject: (e: Error) => void }
>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (e: MessageEvent) => {
      const { id, result, error } = e.data;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (error) {
        p.reject(new Error(error));
      } else {
        p.resolve(result);
      }
    };
    worker.onerror = (e) => {
      console.error("[pdf-worker] Error:", e);
    };
  }
  return worker;
}

function call(method: string, args: any[]): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, method, args });
  });
}

export async function ping(): Promise<string> {
  return call("ping", []);
}

export async function getPageCount(pdfData: ArrayBuffer): Promise<number> {
  return call("getPageCount", [pdfData]);
}

export async function renderPage(
  pdfData: ArrayBuffer,
  pageIndex: number,
  width: number
): Promise<ImageData> {
  return call("renderPage", [pdfData, pageIndex, width]);
}

export async function getPageDimensions(
  pdfData: ArrayBuffer,
  pageIndex: number
): Promise<[number, number]> {
  return call("getPageDimensions", [pdfData, pageIndex]);
}

export async function mergePdfs(pdfs: ArrayBuffer[]): Promise<ArrayBuffer> {
  return call("mergePdfs", [pdfs]);
}

export async function splitPdf(
  pdfData: ArrayBuffer,
  ranges: { start: number; end: number }[]
): Promise<ArrayBuffer[]> {
  return call("splitPdf", [pdfData, ranges]);
}
