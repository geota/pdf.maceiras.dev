import { createSignal, For, Show } from "solid-js";
import * as pdfWorker from "../pdf-worker-client";

export default function PdfMerge() {
  const [files, setFiles] = createSignal<{ name: string; data: ArrayBuffer }[]>(
    []
  );
  const [merging, setMerging] = createSignal(false);
  const [error, setError] = createSignal("");

  async function handleFiles(e: Event) {
    const input = e.target as HTMLInputElement;
    if (!input.files) return;

    const newFiles: { name: string; data: ArrayBuffer }[] = [];
    for (const file of Array.from(input.files)) {
      newFiles.push({ name: file.name, data: await file.arrayBuffer() });
    }
    setFiles((prev) => [...prev, ...newFiles]);
    input.value = "";
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  async function merge() {
    if (files().length < 2) return;
    setMerging(true);
    setError("");

    const handles: string[] = [];
    try {
      // Load all documents into worker
      for (const f of files()) {
        const { handle } = await pdfWorker.loadDocument(f.data);
        handles.push(handle);
      }

      const merged = await pdfWorker.mergePdfs(handles);

      const blob = new Blob([merged], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "merged.pdf";
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      setError(err.message || "Merge failed");
    } finally {
      // Unload all documents
      for (const h of handles) {
        await pdfWorker.unloadDocument(h);
      }
      setMerging(false);
    }
  }

  return (
    <div>
      <h2 class="text-lg font-semibold mb-3">Merge PDFs</h2>

      <input
        type="file"
        accept=".pdf"
        multiple
        onChange={handleFiles}
        class="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100 mb-3"
      />

      <Show when={files().length > 0}>
        <ul class="mb-3 space-y-1">
          <For each={files()}>
            {(file, i) => (
              <li class="flex items-center gap-2 text-sm">
                <span>
                  {i() + 1}. {file.name}
                </span>
                <button
                  onClick={() => removeFile(i())}
                  class="text-red-500 hover:text-red-700 text-xs"
                >
                  remove
                </button>
              </li>
            )}
          </For>
        </ul>

        <button
          onClick={merge}
          disabled={files().length < 2 || merging()}
          class="px-4 py-2 bg-blue-600 text-white rounded disabled:opacity-50 text-sm"
        >
          {merging() ? "Merging..." : `Merge ${files().length} PDFs`}
        </button>
      </Show>

      <Show when={error()}>
        <div class="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mt-3 text-sm">
          {error()}
        </div>
      </Show>
    </div>
  );
}
