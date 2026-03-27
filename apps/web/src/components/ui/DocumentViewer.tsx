import { createSignal, createEffect, For, Show, onCleanup } from "solid-js";
import * as pdfWorker from "../../pdf-worker-client";
import { getRenderPool } from "../../render-pool";
import { useThumbnails } from "../../hooks/useThumbnails";
import { usePageActions, PageActionOverlay, PageMenuOverlay, type PageAction } from "./PageActions";
import { useSharedPdf, effectiveRotation, effectiveCrop, effectiveScale, type CropRect, type PageOp } from "../../PdfContext";
import CropOverlay from "./CropOverlay";
import ScaleOverlay from "./ScaleOverlay";
import { getRenderCacheFor, getRenderCacheSnapshot } from "../../render-cache";

const RENDER_WIDTH = 1200;
const PRERENDER_MARGIN = 500;
const LOOKAHEAD_EACH_SIDE = 15;

interface Props {
  handle: string;
  pageCount: number;
  /** Page to scroll to on mount (default 0) */
  initialPage?: number;
  /** Called when active page changes */
  onActivePageChange?: (page: number) => void;
  /** Called when active page dimensions are known/change: [widthPts, heightPts] */
  onActivePageDimsChange?: (dims: [number, number]) => void;
  /** Light theme (default) or dark theme for overlays */
  theme?: "light" | "dark";
}

export default function DocumentViewer(props: Props) {
  const handleAccessor = () => props.handle;
  const pageCountAccessor = () => props.pageCount;
  const dark = () => props.theme === "dark";

  const { cropPage, scalePage, pendingOps } = useSharedPdf();
  const [activePage, setActivePage] = createSignal(props.initialPage ?? 0);
  const [pageDims, setPageDims] = createSignal<[number, number][]>([]);
  const [cropTarget, setCropTarget] = createSignal<number | null>(null);
  const [scaleTarget, setScaleTarget] = createSignal<number | null>(null);

  // Full-size page renders — restore from global cache on mount
  const renderedPages = new Map<number, ImageData>();
  let renderCache = getRenderCacheFor(props.handle);
  {
    const cached = getRenderCacheSnapshot(props.handle);
    if (cached) {
      for (const [page, img] of cached) renderedPages.set(page, img);
    }
  }

  const [renderVersion, setRenderVersion] = createSignal(renderedPages.size > 0 ? 1 : 0);
  const pageImages = () => { renderVersion(); return renderedPages; };

  // Track previous handle so we can detect swaps (e.g. after rotate/crop)
  let currentHandle = props.handle;
  createEffect(() => {
    const newHandle = props.handle;
    if (newHandle === currentHandle) return;
    currentHandle = newHandle;

    // Rebuild local render state from the (possibly migrated) global cache.
    // Unchanged pages are already there; only changed pages are missing.
    renderedPages.clear();
    renderCache = getRenderCacheFor(newHandle);
    const migrated = getRenderCacheSnapshot(newHandle);
    if (migrated) {
      for (const [page, img] of migrated) renderedPages.set(page, img);
    }

    renderQueue = new Set<number>();
    rendering = false;
    setRenderVersion((v) => v + 1);

    // Re-fetch page dimensions
    (async () => {
      try {
        const dim0 = await pdfWorker.getPageDimensions(newHandle, 0);
        setPageDims(Array.from({ length: props.pageCount }, () => dim0));
      } catch { /* use default */ }
    })();

    // Re-render only missing pages (the changed ones)
    loadAll();
    queueVisiblePages();
  });

  // Per-page actions (rotate buttons)
  const pageActions = usePageActions();

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

  // Scroll active thumbnail into view & report dimensions
  createEffect(() => {
    const page = activePage();
    const thumbEl = thumbRefs.get(page);
    thumbEl?.scrollIntoView({ block: "nearest", behavior: "instant" });
    props.onActivePageChange?.(page);
    const dims = pageDims()[page];
    if (dims) props.onActivePageDimsChange?.(dims);
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

            const ops = () => pendingOps().get(pageIdx) ?? [];
            const thumbRot = () => effectiveRotation(ops());
            const thumbCrop = () => effectiveCrop(ops());
            const thumbScale = () => effectiveScale(ops());
            const thumbBaseAspect = () => {
              const s = thumbScale();
              if (s) return s.widthPts / s.heightPts;
              const img = thumbnails().get(pageIdx);
              if (!img || img.height === 0) return 3 / 4;
              return img.width / img.height;
            };
            const thumbCroppedAspect = () => {
              const c = thumbCrop();
              if (!c) return thumbBaseAspect();
              return (c.w / c.h) * thumbBaseAspect();
            };
            const thumbIsSideways = () => {
              const r = ((thumbRot() % 360) + 360) % 360;
              return r === 90 || r === 270;
            };
            const spacerAspect = () => thumbIsSideways() ? 1 / thumbCroppedAspect() : thumbCroppedAspect();
            const cardScale = () => thumbIsSideways() ? thumbCroppedAspect() : 1;
            const cardTransform = () => {
              const r = thumbRot();
              const base = "translate(-50%, -50%)";
              if (!r) return base;
              const s = cardScale();
              return s !== 1
                ? `${base} rotate(${r}deg) scale(${s})`
                : `${base} rotate(${r}deg)`;
            };
            const thumbCanvasStyle = () => {
              const c = thumbCrop();
              if (c) {
                return {
                  position: "absolute" as const,
                  width: `${100 / c.w}%`,
                  height: `${100 / c.h}%`,
                  left: `${(-c.x / c.w) * 100}%`,
                  top: `${(-c.y / c.h) * 100}%`,
                };
              }
              if (thumbScale()) return { width: "100%", height: "100%" };
              return {};
            };

            return (
              <div
                ref={(el) => thumbRefs.set(pageIdx, el)}
                onClick={() => scrollToPage(pageIdx)}
                class={`group relative w-full cursor-pointer rounded border-2 overflow-hidden transition-[aspect-ratio,border-color,box-shadow] duration-200 ${
                  activePage() === pageIdx
                    ? "border-blue-500 ring-2 ring-blue-300"
                    : dark()
                      ? "border-gray-600 hover:border-gray-400"
                      : "border-gray-200 hover:border-gray-400"
                }`}
                style={{ "aspect-ratio": `${spacerAspect()}` }}
              >
                <div
                  class="absolute top-1/2 left-1/2 w-full overflow-hidden transition-[transform] duration-200"
                  style={{
                    "aspect-ratio": `${thumbCroppedAspect()}`,
                    transform: cardTransform(),
                    "transform-origin": "center center",
                  }}
                >
                  <div
                    class={`absolute inset-0 animate-pulse ${dark() ? "bg-gray-700" : "bg-gray-100"}`}
                    classList={{ hidden: thumbnails().has(pageIdx) }}
                  />
                  <canvas ref={canvasRef} class="w-full h-auto" style={thumbCanvasStyle()} />
                </div>
                <PageActionOverlay pageIndex={pageIdx} actions={pageActions} position="thumbnail" />
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
                actions={pageActions}
                pendingOps={pendingOps().get(pageIdx)}
                isCropTarget={cropTarget() === pageIdx}
                isScaleTarget={scaleTarget() === pageIdx}
                onCropRequest={(p) => setCropTarget(p)}
                onCropConfirm={(cropRect) => {
                  setCropTarget(null);
                  cropPage(pageIdx, cropRect);
                }}
                onCropCancel={() => setCropTarget(null)}
                onScaleRequest={(p) => setScaleTarget(p)}
                onScaleConfirm={(w, h) => {
                  setScaleTarget(null);
                  scalePage(pageIdx, w, h);
                }}
                onScaleCancel={() => setScaleTarget(null)}
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
  actions?: PageAction[];
  pendingOps?: PageOp[];
  isCropTarget?: boolean;
  isScaleTarget?: boolean;
  onCropRequest?: (pageIndex: number) => void;
  onCropConfirm?: (crop: CropRect) => void;
  onCropCancel?: () => void;
  onScaleRequest?: (pageIndex: number) => void;
  onScaleConfirm?: (widthPts: number, heightPts: number) => void;
  onScaleCancel?: () => void;
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

  const ops = () => props.pendingOps ?? [];
  const rot = () => effectiveRotation(ops());
  const crop = () => effectiveCrop(ops());
  const scale = () => effectiveScale(ops());

  const baseAspect = () => {
    const s = scale();
    if (s) return s.widthPts / s.heightPts;
    const d = props.dims;
    if (!d || d[0] === 0) return 3 / 4;
    return d[0] / d[1];
  };
  const croppedAspect = () => {
    const c = crop();
    if (!c) return baseAspect();
    return (c.w / c.h) * baseAspect();
  };
  const isSideways = () => {
    const r = ((rot() % 360) + 360) % 360;
    return r === 90 || r === 270;
  };
  const spacerAspect = () => isSideways() ? 1 / croppedAspect() : croppedAspect();
  const cardScale = () => isSideways() ? croppedAspect() : 1;

  const cardTransform = () => {
    const r = rot();
    const base = "translate(-50%, -50%)";
    if (!r) return base;
    const s = cardScale();
    return s !== 1
      ? `${base} rotate(${r}deg) scale(${s})`
      : `${base} rotate(${r}deg)`;
  };

  const canvasStyle = () => {
    const c = crop();
    if (c) {
      return {
        position: "absolute" as const,
        width: `${100 / c.w}%`,
        height: `${100 / c.h}%`,
        left: `${(-c.x / c.w) * 100}%`,
        top: `${(-c.y / c.h) * 100}%`,
      };
    }
    if (scale()) return { "max-width": "100%", width: "100%", height: "100%" };
    return { "max-width": "100%", height: "auto" };
  };

  const displayWidth = () => RENDER_WIDTH;

  return (
    <div
      ref={props.onRef}
      data-page={props.pageIdx}
      class="group relative bg-white shadow-md overflow-hidden transition-[aspect-ratio] duration-200"
      style={{
        "content-visibility": "auto",
        "contain-intrinsic-size": `auto ${displayWidth()}px ${Math.round(displayWidth() / spacerAspect())}px`,
        width: `${displayWidth()}px`,
        "max-width": "100%",
        "aspect-ratio": `${spacerAspect()}`,
      }}
    >
      <div
        class="absolute top-1/2 left-1/2 overflow-hidden transition-[transform] duration-200"
        style={{
          width: `${displayWidth()}px`,
          "max-width": "100%",
          "aspect-ratio": `${croppedAspect()}`,
          transform: cardTransform(),
          "transform-origin": "center center",
        }}
      >
        <Show
          when={props.imageData}
          fallback={
            <div
              class="flex items-center justify-center bg-gray-100 text-gray-400 text-sm w-full"
              style={{ "aspect-ratio": `${croppedAspect()}` }}
            >
              Page {props.pageIdx + 1}
            </div>
          }
        >
          <canvas
            ref={canvasRef}
            style={canvasStyle()}
          />
        </Show>
      </div>
      <Show when={props.actions && !props.isCropTarget && !props.isScaleTarget}>
        <PageActionOverlay pageIndex={props.pageIdx} actions={props.actions!} position="fullpage" />
        <PageMenuOverlay
          pageIndex={props.pageIdx}
          onCrop={(p) => props.onCropRequest?.(p)}
          onScale={(p) => props.onScaleRequest?.(p)}
        />
      </Show>
      <Show when={props.isCropTarget}>
        <CropOverlay
          initialCrop={crop()}
          onConfirm={(cropRect) => props.onCropConfirm?.(cropRect)}
          onCancel={() => props.onCropCancel?.()}
        />
      </Show>
      <Show when={props.isScaleTarget && props.dims}>
        <ScaleOverlay
          pageDims={props.dims!}
          onConfirm={(w, h) => props.onScaleConfirm?.(w, h)}
          onCancel={() => props.onScaleCancel?.()}
        />
      </Show>
    </div>
  );
}
