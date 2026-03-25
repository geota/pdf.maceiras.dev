import { createSignal, createEffect, For, Show, onCleanup } from "solid-js";
import * as pdfWorker from "../../pdf-worker-client";
import { getRenderPool } from "../../render-pool";
import { useThumbnails } from "../../hooks/useThumbnails";

const RENDER_WIDTH = 1200;
const PRERENDER_MARGIN = 500;
const LOOKAHEAD_EACH_SIDE = 15;

// Global full-size render cache — survives component mount/unmount cycles.
// Keyed by document handle → page index → ImageData.
const globalRenderCache = new Map<string, Map<number, ImageData>>();

/** Clear cached renders for a handle (call when unloading a document). */
export function clearRenderCache(handle: string) {
  globalRenderCache.delete(handle);
}

interface Props {
  handle: string;
  pageCount: number;
  /** Page to scroll to on mount (default 0) */
  initialPage?: number;
  /** Called when active page changes */
  onActivePageChange?: (page: number) => void;
  /** Light theme (default) or dark theme for overlays */
  theme?: "light" | "dark";
}

export default function DocumentViewer(props: Props) {
  const handleAccessor = () => props.handle;
  const pageCountAccessor = () => props.pageCount;
  const dark = () => props.theme === "dark";

  const [activePage, setActivePage] = createSignal(props.initialPage ?? 0);
  const [pageDims, setPageDims] = createSignal<[number, number][]>([]);

  // Full-size page renders — restore from global cache on mount
  const renderedPages = new Map<number, ImageData>();
  const cached = globalRenderCache.get(props.handle);
  if (cached) {
    for (const [page, img] of cached) renderedPages.set(page, img);
  }
  // Ensure global cache entry exists for this handle
  if (!globalRenderCache.has(props.handle)) {
    globalRenderCache.set(props.handle, new Map());
  }
  const renderCache = globalRenderCache.get(props.handle)!;

  const [renderVersion, setRenderVersion] = createSignal(cached ? 1 : 0);
  const pageImages = () => { renderVersion(); return renderedPages; };

  // Sidebar thumbnails
  const { thumbnails, loading: thumbsLoading, loadAll } = useThumbnails(handleAccessor, pageCountAccessor);

  // Track which pages are near the viewport
  const visibleFullPages = new Set<number>();
  let renderQueue = new Set<number>();
  let rendering = false;
  let priorityRequested = false;
  let cancelled = false;

  const pageRefs = new Map<number, HTMLDivElement>();
  const thumbRefs = new Map<number, HTMLDivElement>();
  let sidebarRef: HTMLDivElement | undefined;
  let fullPageObserver: IntersectionObserver | undefined;

  onCleanup(() => {
    cancelled = true;
    fullPageObserver?.disconnect();
  });

  // Start thumbnail loading first — cache restore is synchronous so
  // cached thumbnails are available on the first reactive flush.
  loadAll();

  // Fetch page dimensions (independent, doesn't block thumbnails)
  (async () => {
    try {
      const dim0 = await pdfWorker.getPageDimensions(props.handle, 0);
      setPageDims(Array.from({ length: props.pageCount }, () => dim0));
    } catch { /* use default aspect ratio */ }
  })();

  // Scroll active thumbnail into view
  createEffect(() => {
    const thumbEl = thumbRefs.get(activePage());
    thumbEl?.scrollIntoView({ block: "nearest", behavior: "instant" });
    props.onActivePageChange?.(activePage());
  });

  function initObserver(root: HTMLDivElement) {
    fullPageObserver?.disconnect();
    fullPageObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const pageIdx = parseInt(entry.target.getAttribute("data-page") ?? "-1", 10);
          if (pageIdx < 0) continue;
          if (entry.isIntersecting) visibleFullPages.add(pageIdx);
          else visibleFullPages.delete(pageIdx);
        }

        if (visibleFullPages.size > 0) {
          let best = Infinity;
          let bestPage = activePage();
          for (const p of visibleFullPages) {
            const el = pageRefs.get(p);
            if (el) {
              const rect = el.getBoundingClientRect();
              if (rect.top < best && rect.bottom > 0) {
                best = rect.top;
                bestPage = p;
              }
            }
          }
          setActivePage(bestPage);
        }

        queueVisiblePages();
      },
      { root, rootMargin: `${PRERENDER_MARGIN}px 0px`, threshold: 0 }
    );

    for (const [, el] of pageRefs) fullPageObserver.observe(el);
  }

  function queueVisiblePages() {
    for (const p of visibleFullPages) {
      if (!renderedPages.has(p)) {
        renderQueue.add(p);
        priorityRequested = true;
      }
    }
    processRenderQueue();
  }

  async function processRenderQueue() {
    if (rendering || cancelled) return;
    rendering = true;

    const pool = getRenderPool();
    await pool.ensureLoaded(props.handle, () => pdfWorker.getDocumentBytes(props.handle));

    // Phase 1: priority (observer-reported)
    priorityRequested = false;
    while (renderQueue.size > 0 && !cancelled) {
      const batch: number[] = [];
      const sorted = [...renderQueue].sort((a, b) =>
        Math.abs(a - activePage()) - Math.abs(b - activePage())
      );
      for (const p of sorted) {
        batch.push(p);
        renderQueue.delete(p);
        if (batch.length >= 2) break;
      }
      if (batch.length === 0) break;
      try {
        const results = await pool.renderPages(props.handle, batch, RENDER_WIDTH);
        if (cancelled) break;
        for (let j = 0; j < batch.length; j++) {
          const img = results[j];
          if (img) {
            renderedPages.set(batch[j], img);
            renderCache.set(batch[j], img);
          }
        }
        setRenderVersion((v) => v + 1);
      } catch { /* skip */ }
    }

    // Phase 2: lookahead
    if (!cancelled) {
      const current = activePage();
      const total = props.pageCount;
      const start = Math.max(0, current - LOOKAHEAD_EACH_SIDE);
      const end = Math.min(total, current + LOOKAHEAD_EACH_SIDE + 1);
      for (let p = start; p < end; p++) {
        if (!renderedPages.has(p)) renderQueue.add(p);
      }

      while (renderQueue.size > 0 && !cancelled && !priorityRequested) {
        const batch: number[] = [];
        for (const p of renderQueue) {
          batch.push(p);
          renderQueue.delete(p);
          if (batch.length >= 2) break;
        }
        if (batch.length === 0) break;
        try {
          const results = await pool.renderPages(props.handle, batch, RENDER_WIDTH);
          if (cancelled) break;
          for (let j = 0; j < batch.length; j++) {
            const img = results[j];
            if (img) {
              renderedPages.set(batch[j], img);
              renderCache.set(batch[j], img);
            }
          }
          setRenderVersion((v) => v + 1);
        } catch { /* skip */ }
      }
    }

    rendering = false;
    if (priorityRequested) processRenderQueue();
  }

  function scrollToPage(pageIdx: number) {
    pageRefs.get(pageIdx)?.scrollIntoView({ behavior: "instant", block: "start" });
  }

  // Scroll to initial page once elements are mounted
  let didInitialScroll = false;
  function maybeInitialScroll() {
    if (didInitialScroll || (props.initialPage ?? 0) === 0) return;
    const el = pageRefs.get(props.initialPage!);
    if (el) {
      didInitialScroll = true;
      requestAnimationFrame(() =>
        el.scrollIntoView({ behavior: "instant", block: "start" })
      );
    }
  }

  return (
    <div class="flex flex-1 min-h-0">
      {/* Thumbnail sidebar */}
      <div
        ref={sidebarRef}
        class={`w-28 shrink-0 overflow-y-auto border-r p-2 space-y-2 ${
          dark()
            ? "border-gray-700 bg-gray-900/90"
            : "border-gray-200 bg-gray-50"
        }`}
      >
        <For each={Array.from({ length: props.pageCount }, (_, i) => i)}>
          {(pageIdx) => {
            let canvasRef: HTMLCanvasElement | undefined;

            createEffect(() => {
              const img = thumbnails().get(pageIdx);
              if (!canvasRef || !img) return;
              canvasRef.width = img.width;
              canvasRef.height = img.height;
              canvasRef.getContext("2d")!.putImageData(img, 0, 0);
            });

            return (
              <div
                ref={(el) => thumbRefs.set(pageIdx, el)}
                onClick={() => scrollToPage(pageIdx)}
                class={`relative cursor-pointer rounded border-2 overflow-hidden transition-colors ${
                  activePage() === pageIdx
                    ? "border-blue-500 ring-2 ring-blue-300"
                    : dark()
                      ? "border-gray-600 hover:border-gray-400"
                      : "border-gray-200 hover:border-gray-400"
                }`}
              >
                <div class="relative w-full aspect-[3/4]">
                  <div
                    class={`absolute inset-0 animate-pulse ${dark() ? "bg-gray-700" : "bg-gray-100"}`}
                    classList={{ hidden: thumbnails().has(pageIdx) }}
                  />
                  <canvas ref={canvasRef} class="w-full h-auto" />
                </div>
                <div class="absolute bottom-0 left-0 right-0 bg-black/50 text-white text-[10px] text-center py-0.5">
                  {pageIdx + 1}
                </div>
              </div>
            );
          }}
        </For>
      </div>

      {/* Main scrollable page area */}
      <div
        ref={(el) => initObserver(el)}
        class={`flex-1 overflow-y-auto p-4 ${dark() ? "bg-black/40" : "bg-gray-300"}`}
      >
        <div class="flex flex-col items-center gap-4">
          <For each={Array.from({ length: props.pageCount }, (_, i) => i)}>
            {(pageIdx) => (
              <PageCanvas
                pageIdx={pageIdx}
                imageData={pageImages().get(pageIdx)}
                dims={pageDims()[pageIdx]}
                onRef={(el) => {
                  pageRefs.set(pageIdx, el);
                  fullPageObserver?.observe(el);
                  maybeInitialScroll();
                }}
              />
            )}
          </For>
        </div>
      </div>
    </div>
  );
}

export function ActivePageInfo(props: { activePage: number; pageCount: number; loading?: boolean }) {
  return (
    <span class="text-xs">
      Page {props.activePage + 1} of {props.pageCount}
      {props.loading ? " (loading thumbnails...)" : ""}
    </span>
  );
}

function PageCanvas(props: {
  pageIdx: number;
  imageData: ImageData | undefined;
  dims?: [number, number];
  onRef: (el: HTMLDivElement) => void;
}) {
  let canvasRef: HTMLCanvasElement | undefined;

  createEffect(() => {
    const img = props.imageData;
    if (!canvasRef || !img) return;
    canvasRef.width = img.width;
    canvasRef.height = img.height;
    canvasRef.getContext("2d")!.putImageData(img, 0, 0);
  });

  const displayWidth = () => RENDER_WIDTH;
  const aspectRatio = () => {
    const d = props.dims;
    if (!d || d[0] === 0) return 3 / 4;
    return d[0] / d[1];
  };
  const displayHeight = () => Math.round(displayWidth() / aspectRatio());

  return (
    <div
      ref={props.onRef}
      data-page={props.pageIdx}
      class="bg-white shadow-md"
      style={{
        "content-visibility": "auto",
        "contain-intrinsic-size": `auto ${displayWidth()}px ${displayHeight()}px`,
        width: `${displayWidth()}px`,
        "max-width": "100%",
      }}
    >
      <Show
        when={props.imageData}
        fallback={
          <div
            class="flex items-center justify-center bg-gray-100 text-gray-400 text-sm"
            style={{
              width: `${displayWidth()}px`,
              "max-width": "100%",
              "aspect-ratio": `${aspectRatio()}`,
            }}
          >
            Page {props.pageIdx + 1}
          </div>
        }
      >
        <canvas ref={canvasRef} style="max-width: 100%; height: auto;" />
      </Show>
    </div>
  );
}
