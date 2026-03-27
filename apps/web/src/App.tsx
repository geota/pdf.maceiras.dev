import { createSignal, Show } from "solid-js";
import Sidebar, { type Route } from "./components/ui/Sidebar";
import PdfBottomBar from "./components/ui/PdfBottomBar";
import PdfStatusInfo from "./components/ui/PdfStatusInfo";
import PdfViewer from "./components/PdfViewer";
import PdfMerge from "./components/PdfMerge";
import PdfSplit from "./components/PdfSplit";
import PdfReorder from "./components/PdfReorder";
import PdfCompress from "./components/PdfCompress";
import PdfMetadata from "./components/PdfMetadata";
import { PdfProvider, useSharedPdf } from "./PdfContext";

export default function App() {
  return (
    <PdfProvider>
      <AppInner />
    </PdfProvider>
  );
}

function AppInner() {
  const [route, setRoute] = createSignal<Route>("view");
  const [activePage, setActivePage] = createSignal(0);
  const [pageDims, setPageDims] = createSignal<[number, number] | null>(null);
  const { sharedPdf, clear, download } = useSharedPdf();

  return (
    <div class="flex h-screen bg-gray-100">
      <Sidebar active={route()} onNavigate={setRoute} />

      <main class="flex-1 flex flex-col overflow-hidden">
        <div
          class="flex-1 overflow-auto p-6"
          classList={{ "!overflow-hidden !p-0": route() === "view" }}
        >
          <div class="max-w-5xl mx-auto" classList={{ "!max-w-none h-full": route() === "view" }}>
            <Show when={route() === "view"}>
              <PdfViewer onActivePageChange={setActivePage} onActivePageDimsChange={setPageDims} />
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

            <Show when={route() === "compress"}>
              <h2 class="text-xl font-semibold mb-4">Compress PDF</h2>
              <PdfCompress />
            </Show>

            <Show when={route() === "metadata"}>
              <h2 class="text-xl font-semibold mb-4">Edit Metadata</h2>
              <PdfMetadata />
            </Show>
          </div>
        </div>

        <Show when={sharedPdf()}>
          <PdfBottomBar
            info={
              <PdfStatusInfo
                fileName={sharedPdf()!.fileName}
                pageCount={sharedPdf()!.pageCount}
                activePage={route() === "view" ? activePage() : undefined}
                pageDims={route() === "view" ? pageDims() : null}
                fileSize={sharedPdf()!.fileSize}
              />
            }
            onDownload={download}
            onClose={clear}
          />
        </Show>
      </main>
    </div>
  );
}
