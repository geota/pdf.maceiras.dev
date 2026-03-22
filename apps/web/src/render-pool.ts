/// Pool of render workers for parallel thumbnail generation.
/// Each worker gets its own PDFium + WASM instance.
/// Documents are shared across workers via SharedArrayBuffer — zero-copy.

import * as Comlink from "comlink";
import type { WorkerApi } from "./worker";

// One render worker per available core, minus one for the main thread/primary worker.
// Falls back to 2 if hardwareConcurrency is unavailable.
const POOL_SIZE = Math.max((navigator.hardwareConcurrency ?? 3) - 1, 1);

let nextPoolHandle = 0;

class RenderPool {
  private workers: Comlink.Remote<WorkerApi>[] = [];
  private initPromise: Promise<void>;
  // Primary handle → shared handle used across all pool workers
  private handleMap = new Map<string, string>();
  // Keep references to SharedArrayBuffers so they aren't GC'd
  private sharedBuffers = new Map<string, SharedArrayBuffer>();
  private nextIdx = 0;

  constructor() {
    this.initPromise = this.init();
  }

  private async init() {
    const workers: Comlink.Remote<WorkerApi>[] = [];
    const pings: Promise<unknown>[] = [];

    for (let i = 0; i < POOL_SIZE; i++) {
      const w = new Worker(new URL("./worker.ts", import.meta.url), {
        type: "module",
      });
      const api = Comlink.wrap<WorkerApi>(w);
      workers.push(api);
      // Warm up all workers in parallel (triggers PDFium + WASM init)
      pings.push(api.ping());
    }

    await Promise.all(pings);
    this.workers = workers;
    console.log(`[render-pool] ${POOL_SIZE} workers ready`);
  }

  /** Load a document into all pool workers for rendering.
   *  Uses SharedArrayBuffer so all workers read from the same memory. */
  async ensureLoaded(
    primaryHandle: string,
    getBytes: () => Promise<ArrayBuffer>
  ): Promise<void> {
    await this.initPromise;
    if (this.handleMap.has(primaryHandle)) return;

    const bytes = await getBytes();
    const byteLength = bytes.byteLength;

    // Copy into SharedArrayBuffer once — all workers share this memory
    const sab = new SharedArrayBuffer(byteLength);
    new Uint8Array(sab).set(new Uint8Array(bytes));

    const sharedHandle = `pool_${nextPoolHandle++}`;
    this.sharedBuffers.set(sharedHandle, sab);
    this.handleMap.set(primaryHandle, sharedHandle);

    // Load into all workers in parallel — each creates a zero-copy view
    await Promise.all(
      this.workers.map((w) =>
        w.loadDocumentFromShared(sab, 0, byteLength, sharedHandle)
      )
    );
  }

  /** Render a page, distributing across workers round-robin. */
  async renderPage(
    primaryHandle: string,
    pageIndex: number,
    width: number
  ): Promise<ImageData> {
    await this.initPromise;
    const poolHandle = this.handleMap.get(primaryHandle);
    if (!poolHandle) throw new Error("Document not loaded in render pool");

    const idx = this.nextIdx++ % this.workers.length;
    return this.workers[idx].renderPage(poolHandle, pageIndex, width);
  }

  /** Render a batch of pages on a single worker (parses PDF once in WASM). */
  async renderPages(
    primaryHandle: string,
    pageIndices: number[],
    width: number
  ): Promise<(ImageData | null)[]> {
    await this.initPromise;
    const poolHandle = this.handleMap.get(primaryHandle);
    if (!poolHandle) throw new Error("Document not loaded in render pool");

    const idx = this.nextIdx++ % this.workers.length;
    return this.workers[idx].renderPages(poolHandle, pageIndices, width);
  }

  /** Number of workers in the pool. */
  get size(): number {
    return this.workers.length;
  }

  /** Unload a document from all pool workers. */
  async unload(primaryHandle: string): Promise<void> {
    const poolHandle = this.handleMap.get(primaryHandle);
    if (!poolHandle) return;
    this.handleMap.delete(primaryHandle);
    this.sharedBuffers.delete(poolHandle);
    await Promise.all(
      this.workers.map((w) => w.unloadDocument(poolHandle))
    );
  }
}

let pool: RenderPool | null = null;

export function getRenderPool(): RenderPool {
  if (!pool) pool = new RenderPool();
  return pool;
}
