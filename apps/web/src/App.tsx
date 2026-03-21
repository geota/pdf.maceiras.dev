import { createSignal, Show } from "solid-js";
import Sidebar, { type Route } from "./components/ui/Sidebar";
import PdfViewer from "./components/PdfViewer";
import PdfMerge from "./components/PdfMerge";
import PdfSplit from "./components/PdfSplit";
import PdfReorder from "./components/PdfReorder";
import PdfMetadata from "./components/PdfMetadata";
import DropZone from "./components/ui/DropZone";

export default function App() {
  const [route, setRoute] = createSignal<Route>("view");
  const [pdfData, setPdfData] = createSignal<ArrayBuffer | null>(null);
  const [fileName, setFileName] = createSignal("");
  const [error, setError] = createSignal("");

  async function handleFiles(files: File[]) {
    const file = files[0];
    if (!file) return;
    setError("");
    setFileName(file.name);
    try {
      setPdfData(await file.arrayBuffer());
    } catch (err: any) {
      setError(err.message || "Failed to read file");
    }
  }

  return (
    <div class="flex h-screen bg-gray-100">
      <Sidebar active={route()} onNavigate={setRoute} />

      <main class="flex-1 overflow-auto p-6">
        <div class="max-w-5xl mx-auto">
          <Show when={route() === "view"}>
            <h2 class="text-xl font-semibold mb-4">View PDF</h2>
            <DropZone onFiles={handleFiles} accept=".pdf">
              <p class="text-sm text-gray-500">
                <span class="font-medium">Drop a PDF here</span> or click to
                browse
              </p>
            </DropZone>

            <Show when={error()}>
              <div class="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mt-4">
                {error()}
              </div>
            </Show>

            <Show when={pdfData()} keyed>
              {(data) => (
                <div class="mt-4 bg-white rounded-lg shadow p-4">
                  <p class="text-sm text-gray-500 mb-3">{fileName()}</p>
                  <PdfViewer pdfData={data} />
                </div>
              )}
            </Show>
          </Show>

          <Show when={route() === "merge"}>
            <h2 class="text-xl font-semibold mb-4">Merge PDFs</h2>
            <PdfMerge />
          </Show>

          <Show when={route() === "split"}>
            <h2 class="text-xl font-semibold mb-4">Split PDF</h2>
            <PdfSplit />
          </Show>

          <Show when={route() === "reorder"}>
            <h2 class="text-xl font-semibold mb-4">Reorder Pages</h2>
            <PdfReorder />
          </Show>

          <Show when={route() === "metadata"}>
            <h2 class="text-xl font-semibold mb-4">Edit Metadata</h2>
            <PdfMetadata />
          </Show>
        </div>
      </main>
    </div>
  );
}
