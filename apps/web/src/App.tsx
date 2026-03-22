import { createSignal, Show } from "solid-js";
import Sidebar, { type Route } from "./components/ui/Sidebar";
import PdfViewer from "./components/PdfViewer";
import PdfMerge from "./components/PdfMerge";
import PdfSplit from "./components/PdfSplit";
import PdfReorder from "./components/PdfReorder";
import PdfMetadata from "./components/PdfMetadata";

export default function App() {
  const [route, setRoute] = createSignal<Route>("view");

  return (
    <div class="flex h-screen bg-gray-100">
      <Sidebar active={route()} onNavigate={setRoute} />

      <main class="flex-1 overflow-auto p-6" classList={{ "!overflow-hidden !p-0": route() === "view" }}>
        <div class="max-w-5xl mx-auto" classList={{ "!max-w-none h-full": route() === "view" }}>
          <Show when={route() === "view"}>
            <PdfViewer />
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
