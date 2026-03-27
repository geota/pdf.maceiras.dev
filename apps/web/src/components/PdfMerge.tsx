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
import PdfToolLayout from "./ui/PdfToolLayout";
import ThumbnailGrid from "./ui/ThumbnailGrid";
import { useThumbnails, getThumbnailFromCache } from "../hooks/useThumbnails";
import { useSharedPdf } from "../PdfContext";
import { usePageActions } from "./ui/PageActions";
import { PanelLabel, PanelFooter } from "./ui/PanelControls";

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
  const { sharedPdf, loadFile, loadFromBytes, flushOps } = useSharedPdf();
  const [handle, setHandle] = createSignal<string | null>(null);
  const [fileName, setFileName] = createSignal("");
  const [pageCount, setPageCount] = createSignal(0);
  const [files, setFiles] = createSignal<LoadedPdf[]>([]);
  const [merging, setMerging] = createSignal(false);
  const [error, setError] = createSignal("");
  const [pendingFiles, setPendingFiles] = createSignal<File[] | null>(null);
  const [previewPage, setPreviewPage] = createSignal<number | null>(null);

  const pageActions = usePageActions();
  const { thumbnails, loadAll, updateVisiblePages } = useThumbnails(handle, pageCount);

  // Sync from shared PDF — add as first file and show thumbnails
  createEffect(on(sharedPdf, (pdf) => {
    setFiles((prev) => prev.filter((f) => !f.isShared));

    if (pdf) {
      setHandle(pdf.handle);
      setFileName(pdf.fileName);
      setPageCount(pdf.pageCount);
      loadAll();

      const id = `merge_${nextId++}`;
      const cached = getThumbnailFromCache(pdf.handle, 0);
      if (cached) {
        setFiles((prev) => [{
          id, name: pdf.fileName, handle: pdf.handle,
          pageCount: pdf.pageCount, thumbnail: cached, isShared: true,
        }, ...prev]);
      } else {
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
    } else {
      setHandle(null);
      setFileName("");
      setPageCount(0);
    }
  }));

  /** Handle initial drop — load first file as shared doc, add all to file list. */
  async function handleInitialFiles(dropped: File[]) {
    if (!dropped.length) return;
    setError("");
    try {
      // Load first file via shared context (sets handle, triggers thumbnails)
      await loadFile(dropped[0]);
    } catch (err: any) {
      setError(err.message || "Failed to load PDF");
      return;
    }
    // Add remaining files to the merge list
    for (let i = 1; i < dropped.length; i++) {
      await addExternalFile(dropped[i]);
    }
  }

  /** Add a file that isn't the shared doc. */
  async function addExternalFile(file: File) {
    try {
      const data = await file.arrayBuffer();
      const { handle, pageCount } = await pdfWorker.loadDocument(data);
      let thumbnail: ImageData | null = null;
      try { thumbnail = await pdfWorker.renderPage(handle, 0, 120); } catch {}
      const id = `merge_${nextId++}`;
      setFiles((prev) => [...prev, { id, name: file.name, handle, pageCount, thumbnail, isShared: false }]);
    } catch (err: any) {
      setError(err.message || `Failed to load ${file.name}`);
    }
  }

  function addMoreFiles(newFiles: File[]) {
    setError("");
    for (const file of newFiles) {
      addExternalFile(file);
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
      await flushOps();
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

  function resetState() {
    setError("");
    setFiles((prev) => {
      for (const f of prev) {
        if (!f.isShared) pdfWorker.unloadDocument(f.handle);
      }
      return [];
    });
    setHandle(null);
    setFileName("");
    setPageCount(0);
    setPendingFiles(null);
  }

  return (
    <PdfToolLayout
      handle={handle}
      error={error}
      pendingFiles={pendingFiles}
      previewPage={previewPage}
      onFiles={handleInitialFiles}
      onMerged={() => {}}
      onResetFiles={resetState}
      onClosePreview={() => setPreviewPage(null)}
      panelTitle="Merge"
      panel={
        <div class="flex flex-col flex-1 min-h-0">
          <div class="flex-1 overflow-y-auto p-4 space-y-4">
            {/* File list */}
            <Show when={files().length > 0}>
              <div class="space-y-1.5">
                <PanelLabel>Documents</PanelLabel>
                <DragDropProvider onDragEnd={onDragEnd} collisionDetector={closestCenter}>
                  <DragDropSensors />
                  <SortableProvider ids={files().map((f) => f.id)}>
                    <ul class="space-y-1.5">
                      <For each={files()}>
                        {(file) => <SortableItem file={file} onRemove={removeFile} />}
                      </For>
                    </ul>
                  </SortableProvider>
                </DragDropProvider>
              </div>
            </Show>

            {/* Add more */}
            <DropZone onFiles={addMoreFiles} accept=".pdf" multiple>
              <p class="text-xs text-gray-500">
                <span class="font-medium">+ Add PDFs</span>
              </p>
            </DropZone>
          </div>

          <PanelFooter
            statusText={`${files().length} ${files().length === 1 ? "document" : "documents"}`}
            saving={merging()}
            disabled={files().length < 2}
            onSave={merge}
          />
        </div>
      }
    >
      <ThumbnailGrid
        pageCount={pageCount()}
        thumbnails={thumbnails()}
        pageActions={pageActions}
        onPageDblClick={(pageIndex) => setPreviewPage(pageIndex)}
        onVisiblePagesChange={updateVisiblePages}
      />
    </PdfToolLayout>
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
      classList={{
        "opacity-50": sortable.isActiveDraggable,
        "border-blue-300 bg-blue-50/30": props.file.isShared,
      }}
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
        <p class="text-xs font-medium truncate">
          {props.file.name}
          <Show when={props.file.isShared}>
            <span class="ml-1 text-[10px] text-blue-500">(current)</span>
          </Show>
        </p>
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
