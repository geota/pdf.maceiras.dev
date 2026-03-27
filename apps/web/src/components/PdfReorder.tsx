import { createSignal, createEffect, For, Show, onCleanup, onMount, on } from "solid-js";
import {
  DragDropProvider,
  DragDropSensors,
  SortableProvider,
  createSortable,
  closestCenter,
  type DragEvent as DndDragEvent,
} from "@thisbeyond/solid-dnd";
import * as pdfWorker from "../pdf-worker-client";
import PdfToolLayout from "./ui/PdfToolLayout";
import Thumbnail from "./ui/Thumbnail";
import { useThumbnails } from "../hooks/useThumbnails";
import { parseGroupSegment, groupToText } from "../lib/page-ranges";
import { useSharedPdf, type PageOp } from "../PdfContext";
import { usePageActions, type PageAction } from "./ui/PageActions";

interface PageItem {
  uid: string;
  pageIdx: number;
}

let uidCounter = 0;
function makeUid() {
  return `ri_${uidCounter++}`;
}

export default function PdfReorder() {
  const { sharedPdf, loadFile, loadFromBytes, flushOps, pendingOps } = useSharedPdf();
  const [handle, setHandle] = createSignal<string | null>(null);
  const [fileName, setFileName] = createSignal("");
  const [pageCount, setPageCount] = createSignal(0);
  const [items, setItems] = createSignal<PageItem[]>([]);
  const [selectedUids, setSelectedUids] = createSignal<Set<string>>(new Set());
  const [orderText, setOrderText] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal("");
  const [pendingFiles, setPendingFiles] = createSignal<File[] | null>(null);
  const [previewPage, setPreviewPage] = createSignal<number | null>(null);
  let lastClickedUid: string | null = null;

  const pageActions = usePageActions();
  const { thumbnails, loading: thumbsLoading, loadAll, updateVisiblePages } = useThumbnails(handle, pageCount);

  // IntersectionObserver for viewport-aware thumbnail priority
  const elementToPage = new Map<Element, number>();
  const visibleSet = new Set<number>();
  let observer: IntersectionObserver | undefined;

  onMount(() => {
    observer = new IntersectionObserver(
      (entries) => {
        let changed = false;
        for (const entry of entries) {
          const pageIdx = elementToPage.get(entry.target);
          if (pageIdx == null) continue;
          if (entry.isIntersecting && !visibleSet.has(pageIdx)) {
            visibleSet.add(pageIdx);
            changed = true;
          } else if (!entry.isIntersecting && visibleSet.has(pageIdx)) {
            visibleSet.delete(pageIdx);
            changed = true;
          }
        }
        if (changed) updateVisiblePages(new Set(visibleSet));
      },
      { root: null, rootMargin: "200px 0px", threshold: 0 }
    );
  });

  function observeElement(el: Element, pageIdx: number) {
    elementToPage.set(el, pageIdx);
    observer?.observe(el);
  }

  function unobserveElement(el: Element) {
    elementToPage.delete(el);
    observer?.unobserve(el);
  }

  onCleanup(() => {
    observer?.disconnect();
  });

  // Sync from shared PDF
  createEffect(on(sharedPdf, (pdf) => {
    if (pdf) {
      initFromDocument(pdf.handle, pdf.pageCount, pdf.fileName);
    } else {
      resetState();
    }
  }));

  function resetState() {
    setHandle(null);
    setFileName("");
    setPageCount(0);
    setItems([]);
    setSelectedUids(new Set<string>());
    setOrderText("");
    setError("");
    setPendingFiles(null);
    lastClickedUid = null;
  }

  function initFromDocument(h: string, pc: number, name: string) {
    setHandle(h);
    setPageCount(pc);
    setFileName(name);
    const initialItems = Array.from({ length: pc }, (_, i) => ({
      uid: makeUid(),
      pageIdx: i,
    }));
    setItems(initialItems);
    setOrderText(groupToText(initialItems.map((it) => it.pageIdx)));
    loadAll();
  }

  async function handleFiles(files: File[]) {
    if (!files.length) return;
    resetState();

    if (files.length > 1) {
      setPendingFiles(files);
      return;
    }

    const file = files[0];
    setError("");
    try {
      await loadFile(file);
    } catch (err: any) {
      setError(err.message || "Failed to load PDF");
    }
  }

  function handleMerged(mergedHandle: string, mergedPageCount: number, mergedFileName: string) {
    setPendingFiles(null);
    initFromDocument(mergedHandle, mergedPageCount, mergedFileName);
  }

  function handleItemClick(uid: string, e: MouseEvent) {
    const isMeta = e.metaKey || e.ctrlKey;
    const isShift = e.shiftKey;

    setSelectedUids((prev) => {
      const next = new Set(prev);
      if (isShift && lastClickedUid) {
        const list = items();
        const lastIdx = list.findIndex((it) => it.uid === lastClickedUid);
        const curIdx = list.findIndex((it) => it.uid === uid);
        if (lastIdx !== -1 && curIdx !== -1) {
          const start = Math.min(lastIdx, curIdx);
          const end = Math.max(lastIdx, curIdx);
          for (let i = start; i <= end; i++) next.add(list[i].uid);
        }
      } else if (isMeta) {
        if (next.has(uid)) next.delete(uid);
        else next.add(uid);
      } else {
        next.clear();
        next.add(uid);
      }
      return next;
    });
    lastClickedUid = uid;
  }

  function onDragEnd({ draggable, droppable }: DndDragEvent) {
    if (!draggable || !droppable) return;
    const fromUid = String(draggable.id);
    const toUid = String(droppable.id);
    if (fromUid === toUid) return;

    const sel = selectedUids();
    const list = items();
    const fromIdx = list.findIndex((it) => it.uid === fromUid);
    const toIdx = list.findIndex((it) => it.uid === toUid);
    if (fromIdx === -1 || toIdx === -1) return;

    if (sel.size > 1 && sel.has(fromUid)) {
      // Multi-drag
      const moved: PageItem[] = [];
      const remaining: PageItem[] = [];
      for (const item of list) {
        if (sel.has(item.uid)) moved.push(item);
        else remaining.push(item);
      }
      // Insert at drop target's position in remaining
      let insertIdx = remaining.findIndex((it) => it.uid === toUid);
      if (insertIdx === -1) insertIdx = remaining.length;
      else if (toIdx > fromIdx) insertIdx++;
      remaining.splice(insertIdx, 0, ...moved);
      setItems(remaining);
    } else {
      // Single drag
      const newList = [...list];
      const [moved] = newList.splice(fromIdx, 1);
      newList.splice(toIdx, 0, moved);
      setItems(newList);
    }
    syncOrderText();
  }

  function deleteSelected() {
    const sel = selectedUids();
    if (sel.size === 0) return;
    setItems((prev) => prev.filter((it) => !sel.has(it.uid)));
    setSelectedUids(new Set<string>());
    lastClickedUid = null;
    syncOrderText();
  }

  function clearSelection() {
    setSelectedUids(new Set<string>());
    lastClickedUid = null;
  }

  function syncOrderText() {
    setOrderText(groupToText(items().map((it) => it.pageIdx)));
  }

  function applyOrderText() {
    const text = orderText().trim();
    if (!text) {
      setError("Expression cannot be empty");
      return;
    }
    const pages = parseGroupSegment(text, pageCount());
    if (!pages || pages.length === 0) {
      setError("Invalid expression. Use e.g. ::-1, 1-5+10, ::2+2::2");
      return;
    }
    setError("");
    setItems(pages.map((pageIdx) => ({ uid: makeUid(), pageIdx })));
    clearSelection();
  }

  function resetOrder() {
    setItems(
      Array.from({ length: pageCount() }, (_, i) => ({
        uid: makeUid(),
        pageIdx: i,
      }))
    );
    clearSelection();
    setOrderText(groupToText(Array.from({ length: pageCount() }, (_, i) => i)));
  }

  async function save() {
    await flushOps();
    const h = handle();
    if (!h) return;

    setSaving(true);
    setError("");
    try {
      const order = items().map((it) => it.pageIdx);
      const result = await pdfWorker.reorderPages(h, order);
      const baseName = fileName().replace(/\.pdf$/i, "");
      await loadFromBytes(result, `${baseName}_reordered.pdf`);
    } catch (err: any) {
      setError(err.message || "Reorder failed");
    } finally {
      setSaving(false);
    }
  }

  const isModified = () => {
    const list = items();
    const count = pageCount();
    if (list.length !== count) return true;
    return list.some((it, i) => it.pageIdx !== i);
  };

  return (
    <PdfToolLayout
      handle={handle}
      error={error}
      pendingFiles={pendingFiles}
      previewPage={previewPage}
      onFiles={handleFiles}
      onMerged={handleMerged}
      onResetFiles={resetState}
      onClosePreview={() => setPreviewPage(null)}
    >
      <div class="mt-4">
        <div class="flex items-center justify-between mb-3">
          <p class="text-sm text-gray-600">
            {fileName()} — {items().length}/{pageCount()} pages
            {thumbsLoading() ? " (loading thumbnails...)" : ""}
          </p>
          <div class="flex gap-2">
            <Show when={selectedUids().size > 0}>
              <button
                onClick={deleteSelected}
                class="text-xs text-red-500 hover:underline"
              >
                Delete selected ({selectedUids().size})
              </button>
              <button
                onClick={clearSelection}
                class="text-xs text-gray-500 hover:underline"
              >
                Clear selection
              </button>
            </Show>
            <Show when={isModified()}>
              <button
                onClick={resetOrder}
                class="text-xs text-gray-500 hover:underline"
              >
                Reset
              </button>
            </Show>
          </div>
        </div>

        <p class="text-xs text-gray-400 mb-2">
          Drag pages to reorder, or type an expression below. Shift/Cmd+click to multi-select.
        </p>

        <div class="flex items-center gap-2 mb-3">
          <input
            type="text"
            value={orderText()}
            onInput={(e) => setOrderText(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") applyOrderText();
            }}
            placeholder="e.g. ::-1 (reverse), ::2+2::2 (odd then even), 5:1:-1+6-10"
            class="border border-gray-300 rounded px-2 py-1 text-sm flex-1 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            onClick={applyOrderText}
            class="text-xs text-blue-600 hover:underline shrink-0"
          >
            Apply
          </button>
        </div>

        <DragDropProvider onDragEnd={onDragEnd} collisionDetector={closestCenter}>
          <DragDropSensors />
          <SortableProvider ids={items().map((it) => it.uid)}>
            <div class="grid grid-cols-4 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-8 gap-3">
              <For each={items()}>
                {(item) => (
                  <SortableThumbnail
                    uid={item.uid}
                    pageIndex={item.pageIdx}
                    thumbnails={thumbnails()}
                    isSelected={selectedUids().has(item.uid)}
                    actions={pageActions}
                    pendingOps={pendingOps().get(item.pageIdx)}
                    onClick={(e) => handleItemClick(item.uid, e)}
                    onDblClick={() => setPreviewPage(item.pageIdx)}
                    onObserve={observeElement}
                    onUnobserve={unobserveElement}
                  />
                )}
              </For>
            </div>
          </SortableProvider>
        </DragDropProvider>

        <Show when={isModified()}>
          <div class="mt-4">
            <button
              onClick={save}
              disabled={saving()}
              class="px-4 py-2 bg-blue-600 text-white rounded disabled:opacity-50 text-sm font-medium"
            >
              {saving() ? "Saving..." : "Apply reorder"}
            </button>
          </div>
        </Show>
      </div>
    </PdfToolLayout>
  );
}

function SortableThumbnail(props: {
  uid: string;
  pageIndex: number;
  thumbnails: Map<number, ImageData>;
  isSelected: boolean;
  actions?: PageAction[];
  pendingOps?: PageOp[];
  onClick: (e: MouseEvent) => void;
  onDblClick?: () => void;
  onObserve?: (el: Element, pageIdx: number) => void;
  onUnobserve?: (el: Element) => void;
}) {
  const sortable = createSortable(props.uid);
  let wrapperRef: HTMLDivElement | undefined;

  onCleanup(() => {
    if (wrapperRef) props.onUnobserve?.(wrapperRef);
  });

  return (
    <Thumbnail
      ref={(el) => {
        wrapperRef = el;
        sortable(el);
        props.onObserve?.(el, props.pageIndex);
      }}
      imageData={props.thumbnails.get(props.pageIndex)}
      pageIndex={props.pageIndex}
      selected={props.isSelected}
      draggable
      dragging={sortable.isActiveDraggable}
      actions={props.actions}
      pendingOps={props.pendingOps}
      onClick={props.onClick}
      onDblClick={() => props.onDblClick?.()}
    />
  );
}
