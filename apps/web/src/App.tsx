import { createSignal, createEffect, on, Show } from "solid-js";
import Sidebar, { type Route } from "./components/ui/Sidebar";
import PdfBottomBar from "./components/ui/PdfBottomBar";
import PdfStatusInfo, { type PageImageStats } from "./components/ui/PdfStatusInfo";
import PdfViewer from "./components/PdfViewer";
import PdfMerge from "./components/PdfMerge";
import PdfSplit from "./components/PdfSplit";
import PdfReorder from "./components/PdfReorder";
import PdfCompress from "./components/PdfCompress";
import PdfMetadata from "./components/PdfMetadata";
import AboutPage from "./components/AboutPage";
import { PdfProvider, useSharedPdf } from "./PdfContext";
import * as pdfWorker from "./pdf-worker-client";

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
  const [pageStats, setPageStats] = createSignal<PageImageStats | null>(null);
  const { sharedPdf, clear, download } = useSharedPdf();

  // Fetch per-page stats when active page changes (View tab only)
  createEffect(on([() => sharedPdf()?.handle, activePage, route] as const, ([h, page, r]) => {
    if (!h || r !== "view") { setPageStats(null); return; }
    pdfWorker.getPageAnalysis(h, page).then((stats) => {
      if (sharedPdf()?.handle === h && activePage() === page && route() === "view") {
        setPageStats(stats ? {
          image_count: stats.image_count,
          max_dpi: stats.max_dpi,
          estimated_jpeg_quality: stats.estimated_jpeg_quality,
          estimated_image_bytes: stats.estimated_image_bytes,
        } : null);
      }
    });
  }));

  return (
    <div class="flex flex-col h-screen bg-gray-100">
      <div class="flex-1 flex min-h-0">
        <Sidebar active={route()} onNavigate={setRoute} />

        <main class="flex-1 overflow-hidden">
          <div class="h-full">
            <Show when={route() === "view"}>
              <PdfViewer onActivePageChange={setActivePage} onActivePageDimsChange={setPageDims} />
            </Show>

            <Show when={route() === "merge"}>
              <PdfMerge />
            </Show>

            <Show when={route() === "split"}>
              <PdfSplit />
            </Show>

            <Show when={route() === "reorder"}>
              <PdfReorder />
            </Show>

            <Show when={route() === "compress"}>
              <PdfCompress />
            </Show>

            <Show when={route() === "metadata"}>
              <PdfMetadata />
            </Show>

            <Show when={route() === "about"}>
              <AboutPage />
            </Show>
          </div>
        </main>
      </div>

      <Show when={sharedPdf()}>
        <PdfBottomBar
          info={
            <PdfStatusInfo
              fileName={sharedPdf()!.fileName}
              pageCount={sharedPdf()!.pageCount}
              activePage={route() === "view" ? activePage() : undefined}
              pageDims={route() === "view" ? pageDims() : null}
              pageStats={route() === "view" ? pageStats() : null}
              fileSize={sharedPdf()!.fileSize}
            />
          }
          onDownload={download}
          onRestart={clear}
        />
      </Show>
    </div>
  );
}
