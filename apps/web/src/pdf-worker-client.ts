/// Type-safe Comlink client for the PDF module worker.
/// Documents are loaded once via loadDocument(), then referenced by handle.

import * as Comlink from "comlink";
import type { WorkerApi } from "./worker";

const worker = new Worker(new URL("./worker.ts", import.meta.url), {
  type: "module",
});

const api = Comlink.wrap<WorkerApi>(worker);

export const ping = api.ping;
export const loadDocument = api.loadDocument;
export const unloadDocument = api.unloadDocument;
export const getDocumentBytes = api.getDocumentBytes;
export const getPageCount = api.getPageCount;
export const renderPage = api.renderPage;
export const renderPages = api.renderPages;
export const getPageDimensions = api.getPageDimensions;
export const mergePdfs = api.mergePdfs;
export const mergeAndLoad = api.mergeAndLoad;
export const splitPdf = api.splitPdf;
export const reorderPages = api.reorderPages;
export const rotatePage = api.rotatePage;
export const rotatePages = api.rotatePages;
export const cropPage = api.cropPage;
export const scalePage = api.scalePage;
export const analyzePdf = api.analyzePdf;
export const compressPdf = api.compressPdf;
export const getMetadata = api.getMetadata;
export const setMetadata = api.setMetadata;
export const compressBegin = api.compressBegin;
export const processImageTask = api.processImageTask;
export const compressTargetStep = api.compressTargetStep;
export const compressFinish = api.compressFinish;
