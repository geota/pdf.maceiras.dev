/// Type-safe Comlink client for the PDF module worker.

import * as Comlink from "comlink";
import type { WorkerApi } from "./worker";

const worker = new Worker(new URL("./worker.ts", import.meta.url), {
  type: "module",
});

const api = Comlink.wrap<WorkerApi>(worker);

export const ping = api.ping;
export const getPageCount = api.getPageCount;
export const renderPage = api.renderPage;
export const getPageDimensions = api.getPageDimensions;
export const mergePdfs = api.mergePdfs;
export const splitPdf = api.splitPdf;
