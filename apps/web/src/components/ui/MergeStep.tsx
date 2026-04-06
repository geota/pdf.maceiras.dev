import { createSignal, For, Show, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
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
import DropZone from "./DropZone";
import { PanelLabel } from "./PanelControls";

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

  async function addMoreFiles(newFiles: File[]) {
    for (const file of newFiles) {
      try {
        const data = await file.arrayBuffer();
        const { handle, pageCount } = await pdfWorker.loadDocument(data);
        let thumbnail: ImageData | null = null;
        try { thumbnail = await pdfWorker.renderPage(handle, 0, 120); } catch {}
        const id = `ms_${nextId++}`;
        setItems((prev) => [...prev, { id, name: file.name, handle, pageCount, thumbnail }]);
      } catch (err: any) {
        setError(err.message || `Failed to load ${file.name}`);
      }
    }
  }

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

  const footerMount = document.getElementById("merge-step-footer");

  return (
    <>
      <div class="flex-1 flex min-h-0">
        {/* Center: empty placeholder */}
        <div class="flex-1 overflow-y-auto p-4">
          <Show when={error()}>
            <div class="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded text-sm">
              {error()}
            </div>
          </Show>
        </div>

        {/* Right panel — matches PdfMerge layout */}
        <aside class="w-80 shrink-0 border-l border-gray-200 bg-white flex flex-col">
          <div class="px-4 py-3 border-b border-gray-100 shrink-0">
            <h3 class="text-sm font-medium text-gray-900">Merge</h3>
          </div>
          <div class="flex flex-col flex-1 min-h-0">
            <div class="flex-1 overflow-y-auto p-4 space-y-4">
              <Show when={loaded()} fallback={<p class="text-sm text-gray-400">Loading files...</p>}>
                <Show when={items().length > 0}>
                  <div class="space-y-1.5">
                    <PanelLabel>Documents</PanelLabel>
                    <DragDropProvider onDragEnd={onDragEnd} collisionDetector={closestCenter}>
                      <DragDropSensors />
                      <SortableProvider ids={items().map((f) => f.id)}>
                        <ul class="space-y-1.5">
                          <For each={items()}>
                            {(file) => <SortableItem file={file} onRemove={removeFile} />}
                          </For>
                        </ul>
                      </SortableProvider>
                    </DragDropProvider>
                  </div>
                </Show>

                <DropZone onFiles={addMoreFiles} accept=".pdf,application/pdf" multiple>
                  <p class="text-xs text-gray-500">
                    <span class="font-medium">+ Add PDFs</span>
                  </p>
                </DropZone>
              </Show>
            </div>

            {/* Panel footer — matches PanelFooter style */}
            <div class="p-4 border-t border-gray-100 space-y-3">
              <div class="flex items-center justify-between text-xs text-gray-400">
                <span>
                  <Show when={loaded()} fallback={`Loading ${props.files.length} files...`}>
                    {items().length} {items().length === 1 ? "document" : "documents"}
                  </Show>
                </span>
              </div>
              <button
                onClick={handleContinue}
                disabled={!loaded() || items().length < 1 || merging()}
                class="w-full py-2 bg-blue-600 text-white rounded text-sm font-medium disabled:opacity-40"
              >
                {merging() ? "Merging..." : "Continue"}
              </button>
            </div>
          </div>
        </aside>
      </div>

      <Show when={footerMount}>
        <Portal mount={footerMount!}>
          <div class="flex items-center justify-between px-3 py-1 border-t shrink-0 border-gray-200 bg-gray-50">
            <p class="text-xs text-gray-500">
              <Show when={loaded()} fallback={`Loading ${props.files.length} files...`}>
                {items().length} {items().length === 1 ? "file" : "files"}
              </Show>
            </p>
            <div class="flex items-center gap-3">
              <button
                onClick={props.onStartOver}
                class="text-xs font-medium hover:underline text-red-500 hover:text-red-700"
              >
                Restart
              </button>
            </div>
          </div>
        </Portal>
      </Show>
    </>
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
      class="flex items-center gap-2 bg-white border border-gray-200 rounded p-2 cursor-grab active:cursor-grabbing"
      classList={{ "opacity-50": sortable.isActiveDraggable }}
    >
      <Show
        when={props.file.thumbnail}
        fallback={<div class="w-8 h-10 bg-gray-100 rounded shrink-0" />}
      >
        <canvas
          ref={(el) => {
            canvasRef = el;
            requestAnimationFrame(renderThumb);
          }}
          class="w-8 h-auto rounded shrink-0"
        />
      </Show>
      <div class="flex-1 min-w-0">
        <p class="text-xs font-medium truncate">{props.file.name}</p>
        <p class="text-[10px] text-gray-400">
          {props.file.pageCount} page{props.file.pageCount !== 1 ? "s" : ""}
        </p>
      </div>
      <button
        onClick={() => props.onRemove(props.file.id)}
        class="text-red-400 hover:text-red-600 text-xs shrink-0"
      >
        x
      </button>
    </li>
  );
}
