import { createSignal, Show } from "solid-js";
import PdfViewer from "./components/PdfViewer";
import PdfMerge from "./components/PdfMerge";
import PdfSplit from "./components/PdfSplit";

type Tab = "view" | "merge" | "split";

export default function App() {
  const [tab, setTab] = createSignal<Tab>("view");
  const [pdfData, setPdfData] = createSignal<ArrayBuffer | null>(null);
  const [fileName, setFileName] = createSignal<string>("");
  const [error, setError] = createSignal<string>("");

  async function handleFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    setError("");
    setFileName(file.name);

    try {
      const data = await file.arrayBuffer();
      setPdfData(data);
    } catch (err: any) {
      setError(err.message || "Failed to read file");
    }
  }

  const tabClass = (t: Tab) =>
    `px-4 py-2 text-sm font-medium rounded-t ${
      tab() === t
        ? "bg-white text-blue-700 border border-b-0 border-gray-300"
        : "bg-gray-200 text-gray-600 hover:bg-gray-300"
    }`;

  return (
    <div class="min-h-screen bg-gray-100 p-8">
      <div class="max-w-4xl mx-auto">
        <h1 class="text-2xl font-bold mb-6">pdf-rs spike</h1>

        <div class="flex gap-1 mb-0">
          <button class={tabClass("view")} onClick={() => setTab("view")}>
            View
          </button>
          <button class={tabClass("merge")} onClick={() => setTab("merge")}>
            Merge
          </button>
          <button class={tabClass("split")} onClick={() => setTab("split")}>
            Split
          </button>
        </div>

        <div class="bg-white rounded-b-lg rounded-tr-lg shadow p-6">
          <Show when={tab() === "view"}>
            <div class="mb-4">
              <label class="block text-sm font-medium mb-2">
                Open a PDF file
              </label>
              <input
                type="file"
                accept=".pdf"
                onChange={handleFile}
                class="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
              />
            </div>

            <Show when={error()}>
              <div class="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
                {error()}
              </div>
            </Show>

            <Show when={pdfData()}>
              <p class="text-sm text-gray-500 mb-3">{fileName()}</p>
              <PdfViewer pdfData={pdfData()!} />
            </Show>
          </Show>

          <Show when={tab() === "merge"}>
            <PdfMerge />
          </Show>

          <Show when={tab() === "split"}>
            <PdfSplit />
          </Show>
        </div>
      </div>
    </div>
  );
}
