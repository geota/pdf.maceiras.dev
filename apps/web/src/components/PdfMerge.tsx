import { createSignal, createEffect, For, Show, on } from "solid-js";
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
import { useSharedPdf } from "../PdfContext";
import { getThumbnailFromCache } from "../hooks/useThumbnails";

interface LoadedPdf {
  id: string;
  name: string;
  handle: string;
  pageCount: number;
  thumbnail: ImageData | null;
  isShared: boolean;
}

let nextId = 0;

export default function PdfMerge() {
  const { sharedPdf, loadFromBytes } = useSharedPdf();
  const [files, setFiles] = createSignal<LoadedPdf[]>([]);
  const [merging, setMerging] = createSignal(false);
  const [error, setError] = createSignal("");

  // When shared PDF is available, add it as the first file
  createEffect(on(sharedPdf, (pdf) => {
    // Remove any previously-added shared file
    setFiles((prev) => {
      const sharedFiles = prev.filter((f) => f.isShared);
      for (const f of sharedFiles) {
        // Don't unload the shared handle — context owns it
      }
      return prev.filter((f) => !f.isShared);
    });

    if (pdf) {
      const id = `merge_${nextId++}`;
      const cached = getThumbnailFromCache(pdf.handle, 0);
      if (cached) {
        setFiles((prev) => [{
          id, name: pdf.fileName, handle: pdf.handle,
          pageCount: pdf.pageCount, thumbnail: cached, isShared: true,
        }, ...prev]);
      } else {
        // Cache miss — render and add async
        pdfWorker.renderPage(pdf.handle, 0, 120).then((thumbnail) => {
          setFiles((prev) => [{
            id, name: pdf.fileName, handle: pdf.handle,
            pageCount: pdf.pageCount, thumbnail, isShared: true,
          }, ...prev]);
        }).catch(() => {
          setFiles((prev) => [{
            id, name: pdf.fileName, handle: pdf.handle,
            pageCount: pdf.pageCount, thumbnail: null, isShared: true,
          }, ...prev]);
        });
      }
    }
  }));

  async function handleFiles(newFiles: File[]) {
    setError("");
    for (const file of newFiles) {
      try {
        const data = await file.arrayBuffer();
        const { handle, pageCount } = await pdfWorker.loadDocument(data);

        let thumbnail: ImageData | null = null;
        try {
          thumbnail = await pdfWorker.renderPage(handle, 0, 120);
        } catch {
          // thumbnail rendering is non-critical
        }

        const id = `merge_${nextId++}`;
        setFiles((prev) => [...prev, { id, name: file.name, handle, pageCount, thumbnail, isShared: false }]);
      } catch (err: any) {
        setError(err.message || `Failed to load ${file.name}`);
      }
    }
  }

  function removeFile(id: string) {
    setFiles((prev) => {
      const item = prev.find((f) => f.id === id);
      if (item && !item.isShared) pdfWorker.unloadDocument(item.handle);
      return prev.filter((f) => f.id !== id);
    });
  }

  function onDragEnd({ draggable, droppable }: DndDragEvent) {
    if (!draggable || !droppable) return;
    const fromId = draggable.id as string;
    const toId = droppable.id as string;
    if (fromId === toId) return;

    setFiles((prev) => {
      const items = [...prev];
      const fromIdx = items.findIndex((f) => f.id === fromId);
      const toIdx = items.findIndex((f) => f.id === toId);
      if (fromIdx === -1 || toIdx === -1) return prev;
      const [moved] = items.splice(fromIdx, 1);
      items.splice(toIdx, 0, moved);
      return items;
    });
  }

  async function merge() {
    const list = files();
    if (list.length < 2) return;
    setMerging(true);
    setError("");
    try {
      const merged = await pdfWorker.mergePdfs(list.map((f) => f.handle));
      for (const f of list) {
        if (!f.isShared) pdfWorker.unloadDocument(f.handle);
      }
      setFiles([]);
      await loadFromBytes(merged, "merged.pdf");
    } catch (err: any) {
      setError(err.message || "Merge failed");
    } finally {
      setMerging(false);
    }
  }

  return (
    <div>
      <DropZone onFiles={handleFiles} accept=".pdf" multiple>
        <p class="text-sm text-gray-500">
          <span class="font-medium">Drop PDF files here</span> or click to
          browse
          <Show when={sharedPdf()}>
            <span class="block text-xs text-blue-500 mt-1">
              Your current PDF is already included below. Add more to merge.
            </span>
          </Show>
        </p>
      </DropZone>

      <Show when={files().length > 0}>
        <DragDropProvider onDragEnd={onDragEnd} collisionDetector={closestCenter}>
          <DragDropSensors />
          <SortableProvider ids={files().map((f) => f.id)}>
            <ul class="mt-4 space-y-2">
              <For each={files()}>
                {(file) => <SortableItem file={file} onRemove={removeFile} />}
              </For>
            </ul>
          </SortableProvider>
        </DragDropProvider>

        <div class="mt-4 flex items-center gap-3">
          <button
            onClick={merge}
            disabled={files().length < 2 || merging()}
            class="px-4 py-2 bg-blue-600 text-white rounded disabled:opacity-50 text-sm font-medium"
          >
            {merging() ? "Merging..." : `Merge ${files().length} PDFs`}
          </button>
          <span class="text-xs text-gray-400">
            Drag to reorder before merging
          </span>
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

function SortableItem(props: {
  file: LoadedPdf;
  onRemove: (id: string) => void;
}) {
  const sortable = createSortable(props.file.id);
  let canvasRef: HTMLCanvasElement | undefined;

  function renderThumb() {
    const img = props.file.thumbnail;
    if (!canvasRef || !img) return;
    canvasRef.width = img.width;
    canvasRef.height = img.height;
    canvasRef.getContext("2d")!.putImageData(img, 0, 0);
  }

  return (
    <li
      ref={(el) => {
        sortable(el);
        requestAnimationFrame(renderThumb);
      }}
      class="flex items-center gap-3 bg-white border border-gray-200 rounded-lg p-3 shadow-sm cursor-grab active:cursor-grabbing"
      classList={{
        "opacity-50": sortable.isActiveDraggable,
        "border-blue-300 bg-blue-50/30": props.file.isShared,
      }}
    >
      <Show
        when={props.file.thumbnail}
        fallback={<div class="w-10 h-14 bg-gray-100 rounded shrink-0" />}
      >
        <canvas
          ref={(el) => {
            canvasRef = el;
            requestAnimationFrame(renderThumb);
          }}
          class="w-10 h-auto rounded shrink-0"
        />
      </Show>
      <div class="flex-1 min-w-0">
        <p class="text-sm font-medium truncate">
          {props.file.name}
          <Show when={props.file.isShared}>
            <span class="ml-1 text-xs text-blue-500">(current)</span>
          </Show>
        </p>
        <p class="text-xs text-gray-400">
          {props.file.pageCount} page{props.file.pageCount !== 1 ? "s" : ""}
        </p>
      </div>
      <button
        onClick={() => props.onRemove(props.file.id)}
        class="text-red-400 hover:text-red-600 text-sm shrink-0"
      >
        Remove
      </button>
    </li>
  );
}
