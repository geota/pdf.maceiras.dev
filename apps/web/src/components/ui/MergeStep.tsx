import { createSignal, For, Show, onCleanup } from "solid-js";
import {
  DragDropProvider,
  DragDropSensors,
  SortableProvider,
  createSortable,
  closestCenter,
  type DragEvent as DndDragEvent,
} from "@thisbeyond/solid-dnd";
import * as pdfWorker from "../../pdf-worker-client";
import { getRenderPool } from "../../render-pool";

interface LoadedPdf {
  id: string;
  name: string;
  handle: string;
  pageCount: number;
  thumbnail: ImageData | null;
}

let nextId = 0;

interface MergeStepProps {
  /** The files to merge — passed in from the parent */
  files: File[];
  /** Called after merge completes with the merged document handle */
  onMerged: (handle: string, pageCount: number, fileName: string) => void;
  /** Called when user wants to start over */
  onStartOver: () => void;
}

export default function MergeStep(props: MergeStepProps) {
  const [items, setItems] = createSignal<LoadedPdf[]>([]);
  const [merging, setMerging] = createSignal(false);
  const [error, setError] = createSignal("");
  const [loaded, setLoaded] = createSignal(false);

  onCleanup(() => {
    // Only clean up if we haven't handed off to the parent
    if (!merging()) {
      for (const f of items()) {
        pdfWorker.unloadDocument(f.handle);
      }
    }
  });

  // Load all files on mount
  async function loadFiles() {
    setError("");
    const loaded: LoadedPdf[] = [];
    for (const file of props.files) {
      try {
        const data = await file.arrayBuffer();
        const { handle, pageCount } = await pdfWorker.loadDocument(data);

        let thumbnail: ImageData | null = null;
        try {
          thumbnail = await pdfWorker.renderPage(handle, 0, 120);
        } catch {
          // non-critical
        }

        loaded.push({
          id: `ms_${nextId++}`,
          name: file.name,
          handle,
          pageCount,
          thumbnail,
        });
      } catch (err: any) {
        setError(err.message || `Failed to load ${file.name}`);
      }
    }
    setItems(loaded);
    setLoaded(true);

    // Pre-warm render pool while user reorders files — pool initialization
    // runs in parallel so it's ready immediately after merge completes.
    getRenderPool();
  }

  // Kick off loading immediately
  loadFiles();

  function removeFile(id: string) {
    setItems((prev) => {
      const item = prev.find((f) => f.id === id);
      if (item) pdfWorker.unloadDocument(item.handle);
      return prev.filter((f) => f.id !== id);
    });
  }

  function onDragEnd({ draggable, droppable }: DndDragEvent) {
    if (!draggable || !droppable) return;
    const fromId = draggable.id as string;
    const toId = droppable.id as string;
    if (fromId === toId) return;

    setItems((prev) => {
      const list = [...prev];
      const fromIdx = list.findIndex((f) => f.id === fromId);
      const toIdx = list.findIndex((f) => f.id === toId);
      if (fromIdx === -1 || toIdx === -1) return prev;
      const [moved] = list.splice(fromIdx, 1);
      list.splice(toIdx, 0, moved);
      return list;
    });
  }

  async function handleContinue() {
    const list = items();

    // If only 1 file left after removals, skip merge
    if (list.length === 1) {
      props.onMerged(list[0].handle, list[0].pageCount, list[0].name);
      return;
    }

    if (list.length < 2) return;

    setMerging(true);
    setError("");
    try {
      const handles = list.map((f) => f.handle);
      // Merge and store in worker memory in one step — no round trip
      const { handle, pageCount } = await pdfWorker.mergeAndLoad(handles);
      // Unload the individual handles — they're consumed
      for (const f of list) {
        pdfWorker.unloadDocument(f.handle);
      }
      const combinedName = list.map((f) => f.name.replace(/\.pdf$/i, "")).join("_") + ".pdf";
      props.onMerged(handle, pageCount, combinedName);
    } catch (err: any) {
      setError(err.message || "Merge failed");
      setMerging(false);
    }
  }

  return (
    <div class="mt-4">
      <div class="flex items-center justify-between mb-3">
        <p class="text-sm text-gray-600">
          {items().length} files — drag to set merge order, then continue
        </p>
        <button
          onClick={props.onStartOver}
          class="text-xs text-gray-500 hover:underline"
        >
          Start over
        </button>
      </div>

      <Show when={loaded()} fallback={<p class="text-sm text-gray-400">Loading files...</p>}>
        <DragDropProvider onDragEnd={onDragEnd} collisionDetector={closestCenter}>
          <DragDropSensors />
          <SortableProvider ids={items().map((f) => f.id)}>
            <ul class="space-y-2">
              <For each={items()}>
                {(file) => <SortableFileItem file={file} onRemove={removeFile} />}
              </For>
            </ul>
          </SortableProvider>
        </DragDropProvider>

        <div class="mt-4 flex items-center gap-3">
          <button
            onClick={handleContinue}
            disabled={items().length < 1 || merging()}
            class="px-4 py-2 bg-blue-600 text-white rounded disabled:opacity-50 text-sm font-medium"
          >
            {merging() ? "Merging..." : "Continue"}
          </button>
          <span class="text-xs text-gray-400">
            Files will be merged in this order
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

function SortableFileItem(props: {
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
      classList={{ "opacity-50": sortable.isActiveDraggable }}
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
        <p class="text-sm font-medium truncate">{props.file.name}</p>
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
