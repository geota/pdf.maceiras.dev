import { createSignal, For, Show, onCleanup } from "solid-js";
import {
  DragDropProvider,
  DragDropSensors,
  SortableProvider,
  createSortable,
  closestCenter,
  type DragEvent as DndDragEvent,
} from "@thisbeyond/solid-dnd";
import * as pdfWorker from "../pdf-worker-client";
import DropZone from "./ui/DropZone";
import { useThumbnails } from "../hooks/useThumbnails";
import { useSelection } from "../hooks/useSelection";

export default function PdfReorder() {
  const [handle, setHandle] = createSignal<string | null>(null);
  const [fileName, setFileName] = createSignal("");
  const [pageCount, setPageCount] = createSignal(0);
  const [pageOrder, setPageOrder] = createSignal<number[]>([]);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal("");

  const { thumbnails, loading: thumbsLoading, loadAll } = useThumbnails(handle, pageCount);
  const { selected, handleSelect, clearSelection } = useSelection();

  onCleanup(() => {
    const h = handle();
    if (h) pdfWorker.unloadDocument(h);
  });

  async function handleFiles(files: File[]) {
    const file = files[0];
    if (!file) return;

    const prev = handle();
    if (prev) pdfWorker.unloadDocument(prev);

    setError("");
    setFileName(file.name);
    clearSelection();

    try {
      const data = await file.arrayBuffer();
      const result = await pdfWorker.loadDocument(data);
      setHandle(result.handle);
      setPageCount(result.pageCount);
      setPageOrder(Array.from({ length: result.pageCount }, (_, i) => i));
      loadAll();
    } catch (err: any) {
      setError(err.message || "Failed to load PDF");
    }
  }

  function onDragEnd({ draggable, droppable }: DndDragEvent) {
    if (!draggable || !droppable) return;
    const fromId = String(draggable.id);
    const toId = String(droppable.id);
    if (fromId === toId) return;

    const sel = selected();
    const order = pageOrder();

    // If dragging a selected item, move all selected items
    const fromIdx = order.findIndex((_, i) => `page_${i}` === fromId);
    const toIdx = order.findIndex((_, i) => `page_${i}` === toId);
    if (fromIdx === -1 || toIdx === -1) return;

    if (sel.size > 1 && sel.has(order[fromIdx])) {
      // Multi-drag: extract selected items, insert at drop position
      const selectedPages = new Set(sel);
      const remaining: number[] = [];
      const moved: number[] = [];

      for (const p of order) {
        if (selectedPages.has(p)) {
          moved.push(p);
        } else {
          remaining.push(p);
        }
      }

      // Find insert position in remaining array
      const dropPage = order[toIdx];
      let insertIdx = remaining.indexOf(dropPage);
      if (insertIdx === -1) insertIdx = remaining.length;
      if (toIdx > fromIdx) insertIdx++;

      remaining.splice(insertIdx, 0, ...moved);
      setPageOrder(remaining);
    } else {
      // Single drag
      const newOrder = [...order];
      const [moved] = newOrder.splice(fromIdx, 1);
      newOrder.splice(toIdx, 0, moved);
      setPageOrder(newOrder);
    }
  }

  function deleteSelected() {
    const sel = selected();
    if (sel.size === 0) return;
    setPageOrder((prev) => prev.filter((p) => !sel.has(p)));
    clearSelection();
  }

  function resetOrder() {
    setPageOrder(Array.from({ length: pageCount() }, (_, i) => i));
    clearSelection();
  }

  async function save() {
    const h = handle();
    if (!h) return;

    setSaving(true);
    setError("");
    try {
      const result = await pdfWorker.reorderPages(h, pageOrder());
      const blob = new Blob([result], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const baseName = fileName().replace(/\.pdf$/i, "");
      a.download = `${baseName}_reordered.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      setError(err.message || "Reorder failed");
    } finally {
      setSaving(false);
    }
  }

  const isModified = () => {
    const order = pageOrder();
    const count = pageCount();
    if (order.length !== count) return true;
    return order.some((p, i) => p !== i);
  };

  return (
    <div>
      <DropZone onFiles={handleFiles} accept=".pdf">
        <p class="text-sm text-gray-500">
          <span class="font-medium">Drop a PDF here</span> or click to browse
        </p>
      </DropZone>

      <Show when={handle()}>
        <div class="mt-4">
          <div class="flex items-center justify-between mb-3">
            <p class="text-sm text-gray-600">
              {fileName()} — {pageOrder().length}/{pageCount()} pages
              {thumbsLoading() ? " (loading thumbnails...)" : ""}
            </p>
            <div class="flex gap-2">
              <Show when={selected().size > 0}>
                <button
                  onClick={deleteSelected}
                  class="text-xs text-red-500 hover:underline"
                >
                  Delete selected ({selected().size})
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

          <p class="text-xs text-gray-400 mb-3">
            Drag pages to reorder. Select multiple with Shift/Cmd+click, then
            drag to move as a group.
          </p>

          <DragDropProvider onDragEnd={onDragEnd} collisionDetector={closestCenter}>
            <DragDropSensors />
            <SortableProvider ids={pageOrder().map((_, i) => `page_${i}`)}>
              <div class="grid grid-cols-4 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-8 gap-3">
                <For each={pageOrder()}>
                  {(pageIdx, i) => (
                    <SortableThumbnail
                      sortId={`page_${i()}`}
                      pageIndex={pageIdx}
                      imageData={thumbnails().get(pageIdx)}
                      selected={selected().has(pageIdx)}
                      onClick={(e) => handleSelect(pageIdx, e)}
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
                {saving() ? "Saving..." : "Save reordered PDF"}
              </button>
            </div>
          </Show>
        </div>
      </Show>

      <Show when={error()}>
        <div class="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mt-4 text-sm">
          {error()}
        </div>
      </Show>
    </div>
  );
}

function SortableThumbnail(props: {
  sortId: string;
  pageIndex: number;
  imageData: ImageData | undefined;
  selected: boolean;
  onClick: (e: MouseEvent) => void;
}) {
  const sortable = createSortable(props.sortId);
  let canvasRef: HTMLCanvasElement | undefined;

  function render() {
    const img = props.imageData;
    if (!canvasRef || !img) return;
    canvasRef.width = img.width;
    canvasRef.height = img.height;
    canvasRef.getContext("2d")!.putImageData(img, 0, 0);
  }

  return (
    <div
      ref={(el) => {
        sortable(el);
        requestAnimationFrame(render);
      }}
      onClick={props.onClick}
      class={`relative cursor-grab active:cursor-grabbing rounded border-2 overflow-hidden transition-all ${
        props.selected
          ? "border-blue-500 ring-2 ring-blue-300"
          : "border-gray-200 hover:border-gray-400"
      }`}
      classList={{ "opacity-50": sortable.isActiveDraggable }}
    >
      <Show
        when={props.imageData}
        fallback={<div class="w-full aspect-[3/4] bg-gray-100 animate-pulse" />}
      >
        <canvas
          ref={(el) => {
            canvasRef = el;
            requestAnimationFrame(render);
          }}
          class="w-full h-auto"
        />
      </Show>
      <div class="absolute bottom-0 left-0 right-0 bg-black/50 text-white text-xs text-center py-0.5">
        {props.pageIndex + 1}
      </div>
    </div>
  );
}
