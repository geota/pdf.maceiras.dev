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
import { ExpressionInput, PanelLabel, PanelFooter } from "./ui/PanelControls";

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
  const { thumbnails, loadAll, updateVisiblePages } = useThumbnails(handle, pageCount);

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
      const moved: PageItem[] = [];
      const remaining: PageItem[] = [];
      for (const item of list) {
        if (sel.has(item.uid)) moved.push(item);
        else remaining.push(item);
      }
      let insertIdx = remaining.findIndex((it) => it.uid === toUid);
      if (insertIdx === -1) insertIdx = remaining.length;
      else if (toIdx > fromIdx) insertIdx++;
      remaining.splice(insertIdx, 0, ...moved);
      setItems(remaining);
    } else {
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
      setError("Invalid expression");
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
      panelTitle="Reorder"
      panel={
        <div class="flex flex-col flex-1 min-h-0">
          <div class="flex-1 overflow-y-auto p-4 space-y-5">
            <ExpressionInput
              value={orderText()}
              onInput={setOrderText}
              onApply={applyOrderText}
              placeholder="::-1, ::2+2::2"
              hint="::-1 reverse, ::2+2::2 odd+even"
            />

            {/* Selection actions */}
            <Show when={selectedUids().size > 0}>
              <div class="space-y-1.5">
                <PanelLabel>{selectedUids().size} selected</PanelLabel>
                <div class="flex gap-2">
                  <button onClick={deleteSelected} class="px-3 py-1.5 text-xs text-red-600 border border-red-200 rounded hover:bg-red-50">
                    Delete
                  </button>
                  <button onClick={clearSelection} class="px-3 py-1.5 text-xs text-gray-600 border border-gray-300 rounded hover:bg-gray-50">
                    Clear
                  </button>
                </div>
              </div>
            </Show>

            {/* Reset */}
            <Show when={isModified()}>
              <button onClick={resetOrder} class="text-xs text-gray-500 hover:text-gray-700 hover:underline">
                Reset to original order
              </button>
            </Show>
          </div>

          <PanelFooter
            statusText={`${selectedUids().size}/${items().length} pages`}
            saving={saving()}
            disabled={!isModified()}
            onSave={save}
            onSelectAll={() => setSelectedUids(new Set(items().map((it) => it.uid)))}
            onClearSelection={clearSelection}
            allSelected={selectedUids().size > 0 && selectedUids().size === items().length}
          />
        </div>
      }
    >
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
