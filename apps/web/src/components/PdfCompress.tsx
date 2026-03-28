import { createSignal, createEffect, createMemo, Show, For, on } from "solid-js";
import * as pdfWorker from "../pdf-worker-client";
import { getRenderPool } from "../render-pool";
import PdfToolLayout from "./ui/PdfToolLayout";
import ThumbnailGrid from "./ui/ThumbnailGrid";
import { useThumbnails } from "../hooks/useThumbnails";
import { useSharedPdf } from "../PdfContext";
import { usePageActions } from "./ui/PageActions";
import { formatSize } from "../lib/format";
import { PanelButton, PanelInputRow, PanelLabel, PanelFooter, SegmentedControl } from "./ui/PanelControls";

type Preset = "lossless" | "low" | "medium" | "high" | "advanced";
type AdvancedSubMode = "direct" | "target_size";
type EncodingChoice = "none" | "jpeg" | "jp2";

interface PdfAnalysis {
  max_dpi: number | null;
  estimated_jpeg_quality: number | null;
  jpeg_image_count: number;
  non_jpeg_image_count: number;
  total_image_count: number;
}

const PRESET_INFO: Record<Preset, { label: string; description: string }> = {
  lossless: {
    label: "Lossless",
    description: "Prune objects, recompress streams. No quality loss.",
  },
  low: {
    label: "Low",
    description: "DPI 200, JPEG quality 80.",
  },
  medium: {
    label: "Medium",
    description: "DPI 150, JPEG quality 65.",
  },
  high: {
    label: "High",
    description: "DPI 100, JPEG quality 45.",
  },
  advanced: {
    label: "Advanced",
    description: "Custom settings or target file size.",
  },
};

export default function PdfCompress() {
  const { sharedPdf, loadFile, loadFromBytes, adoptHandle, flushOps, pendingOps } = useSharedPdf();
  const [handle, setHandle] = createSignal<string | null>(null);
  const [fileName, setFileName] = createSignal("");
  const [pageCount, setPageCount] = createSignal(0);
  const [fileSize, setFileSize] = createSignal(0);
  const [analysis, setAnalysis] = createSignal<PdfAnalysis | null>(null);
  const [error, setError] = createSignal("");
  const [pendingFiles, setPendingFiles] = createSignal<File[] | null>(null);
  const [previewPage, setPreviewPage] = createSignal<number | null>(null);

  // Page selection — all selected by default
  const [selectedPages, setSelectedPages] = createSignal<Set<number>>(new Set());

  const pageActions = usePageActions();
  const { thumbnails, loading: thumbsLoading, loadAll, updateVisiblePages } = useThumbnails(handle, pageCount);

  // Preset
  const [preset, setPreset] = createSignal<Preset>("lossless");

  // Whole-document options
  const [stripMetadata, setStripMetadata] = createSignal(false);

  // Per-page options
  type GrayscaleMode = "off" | "vector" | "rasterize";
  const [grayscaleMode, setGrayscaleMode] = createSignal<GrayscaleMode>("off");

  // Advanced sub-mode
  const [advancedSubMode, setAdvancedSubMode] = createSignal<AdvancedSubMode>("direct");

  // Advanced > Direct
  const [dpiEnabled, setDpiEnabled] = createSignal(false);
  const [dpi, setDpi] = createSignal("150");
  const [encodingChoice, setEncodingChoice] = createSignal<EncodingChoice>("none");
  const [jpegQuality, setJpegQuality] = createSignal("65");

  // Advanced > Target Size
  const [targetSizeMB, setTargetSizeMB] = createSignal("5");
  const [minDpi, setMinDpi] = createSignal("72");
  const [minJpegQuality, setMinJpegQuality] = createSignal("45");
  const [jp2InTargetMode, setJp2InTargetMode] = createSignal(false);

  // Compression state + progress
  const [compressing, setCompressing] = createSignal(false);
  const [progressLabel, setProgressLabel] = createSignal("");
  const [progressPct, setProgressPct] = createSignal(0);
  const [result, setResult] = createSignal<{
    original_size: number;
    compressed_size: number;
    techniques_applied: string[];
    target_met: boolean;
  } | null>(null);
  const [compressedData, setCompressedData] = createSignal<ArrayBuffer | null>(null);

  // Sync from shared PDF
  createEffect(on(sharedPdf, (pdf) => {
    if (pdf) {
      setHandle(pdf.handle);
      setFileName(pdf.fileName);
      setPageCount(pdf.pageCount);
      setFileSize(pdf.fileSize);
      setError("");
      setResult(null);
      setCompressedData(null);
      setAnalysis(null);
      // Select all pages by default
      setSelectedPages(new Set<number>(Array.from({ length: pdf.pageCount }, (_, i) => i)));
      loadAll();
      // Fetch analysis in background
      pdfWorker.analyzePdf(pdf.handle).then((a) => {
        setAnalysis(a);
        if (a.max_dpi != null) setDpi(String(Math.round(a.max_dpi)));
        if (a.estimated_jpeg_quality != null)
          setJpegQuality(String(a.estimated_jpeg_quality));
      });
    } else {
      resetState();
    }
  }));

  function resetState() {
    setHandle(null);
    setFileName("");
    setPageCount(0);
    setFileSize(0);
    setAnalysis(null);
    setResult(null);
    setCompressedData(null);
    setSelectedPages(new Set<number>());
    setError("");
    setPendingFiles(null);
  }

  async function handleFiles(files: File[]) {
    const file = files[0];
    if (!file) return;
    resetState();
    setError("");
    try {
      await loadFile(file);
    } catch (err: any) {
      setError(err.message || "Failed to load PDF");
    }
  }

  function handleMerged(mergedHandle: string, mergedPageCount: number, mergedFileName: string) {
    setPendingFiles(null);
    adoptHandle(mergedHandle, mergedPageCount, mergedFileName);
  }

  function handlePageClick(pageIndex: number, _e: MouseEvent) {
    setSelectedPages((prev) => {
      const next = new Set(prev);
      if (next.has(pageIndex)) next.delete(pageIndex);
      else next.add(pageIndex);
      return next;
    });
  }

  function selectAll() {
    setSelectedPages(new Set<number>(Array.from({ length: pageCount() }, (_, i) => i)));
  }

  function selectNone() {
    setSelectedPages(new Set<number>());
  }

  const selectedCount = createMemo(() => selectedPages().size);
  const allSelected = createMemo(() => selectedCount() === pageCount());

  function buildOptions() {
    const p = preset();
    const base: Record<string, unknown> = {
      preset: p,
      strip_metadata: stripMetadata(),
      grayscale_mode: grayscaleMode(),
      // Pass selected pages so per-page ops only apply to these
      selected_pages: [...selectedPages()],
    };

    if (p !== "advanced") return base;

    if (advancedSubMode() === "target_size") {
      base.advanced = {
        mode: "target_size",
        target_bytes: Math.round(parseFloat(targetSizeMB()) * 1024 * 1024),
        min_dpi: parseFloat(minDpi()) || 72,
        min_jpeg_quality: parseInt(minJpegQuality()) || 45,
        jp2: jp2InTargetMode(),
      };
    } else {
      const enc = encodingChoice();
      base.advanced = {
        mode: "direct",
        dpi: dpiEnabled() ? parseFloat(dpi()) || undefined : undefined,
        jpeg_quality:
          enc === "jpeg" ? parseInt(jpegQuality()) || undefined : undefined,
        jp2: enc === "jp2",
      };
    }

    return base;
  }

  async function compress() {
    const h = handle();
    if (!h) return;

    setCompressing(true);
    setError("");
    setResult(null);
    setCompressedData(null);
    setProgressLabel("Preparing...");
    setProgressPct(0);

    try {
      await flushOps();
      const options = buildOptions();

      // Rasterize mode: render selected pages in parallel, replace in original, then compress
      if (grayscaleMode() === "rasterize") {
        const pool = getRenderPool();
        const selected = [...selectedPages()].sort((a, b) => a - b);
        await pool.ensureLoaded(h, () => pdfWorker.getDocumentBytes(h));

        setProgressLabel(`Rasterizing ${selected.length} pages...`);
        const rendered = await pool.rasterizeGrayscalePages(h, selected, 300, (done, total) => {
          setProgressPct(Math.round((done / total) * 100));
          setProgressLabel(`Rasterizing pages: ${done}/${total}`);
        });

        setProgressLabel("Replacing pages...");
        const replaced = await pdfWorker.replacePagesWithImages(h, rendered);

        // Load result and compress it
        const { handle: rHandle } = await pdfWorker.loadDocument(replaced);
        const rOptions = { ...options, grayscale_mode: "off" };
        const res = await compressWithParallel(rHandle, rOptions);
        await pdfWorker.unloadDocument(rHandle);
        setResult(res.result);
        setCompressedData(res.data);
      } else {
        const res = await compressWithParallel(h, options);
        setResult(res.result);
        setCompressedData(res.data);
      }
    } catch (err: any) {
      setError(err.message || "Compression failed");
    } finally {
      setCompressing(false);
    }
  }

  async function compressWithParallel(
    h: string,
    options: Record<string, unknown>
  ): Promise<{
    data: ArrayBuffer;
    result: {
      original_size: number;
      compressed_size: number;
      techniques_applied: string[];
      target_met: boolean;
    };
  }> {
    const onImageProgress = (done: number, total: number) => {
      setProgressPct(Math.round((done / total) * 100));
      setProgressLabel(`Processing images: ${done}/${total}`);
    };

    try {
      setProgressLabel("Optimizing structure...");
      setProgressPct(0);
      const phase1 = await pdfWorker.compressBegin(h, options);

      if (!phase1.complete && phase1.imageTasks && phase1.imageTasks.length > 0) {
        const pool = getRenderPool();

        const isTargetSize = options.advanced && (options.advanced as any).mode === "target_size";
        if (isTargetSize) {
          let step = 1;
          setProgressLabel(`Step ${step}: Processing ${phase1.imageTasks.length} images...`);
          let results = await pool.processImageTasks(phase1.imageTasks, onImageProgress);

          let stepResult = await pdfWorker.compressTargetStep(results);
          while (!stepResult.complete && stepResult.imageTasks && stepResult.imageTasks.length > 0) {
            step++;
            setProgressPct(0);
            setProgressLabel(`Step ${step}: Processing ${stepResult.imageTasks.length} images...`);
            const stepResults = await pool.processImageTasks(stepResult.imageTasks, onImageProgress);
            stepResult = await pdfWorker.compressTargetStep(stepResults);
          }

          setProgressLabel("Finalizing...");
          setProgressPct(100);
          return pdfWorker.compressFinish([]);
        }

        setProgressLabel(`Processing ${phase1.imageTasks.length} images...`);
        const results = await pool.processImageTasks(phase1.imageTasks, onImageProgress);

        setProgressLabel("Finalizing...");
        setProgressPct(100);
        return pdfWorker.compressFinish(results);
      }

      setProgressLabel("Finalizing...");
      setProgressPct(100);
      return pdfWorker.compressFinish([]);
    } catch (e) {
      console.warn("[compress] parallel failed, falling back to sequential:", e);
      setProgressLabel("Compressing (sequential fallback)...");
      return pdfWorker.compressPdf(h, options as any);
    }
  }

  async function useCompressedResult() {
    const data = compressedData();
    if (!data) return;
    const name = fileName().replace(/\.pdf$/i, "") + "_compressed.pdf";
    await loadFromBytes(data, name);
  }

  const hasImages = () => (analysis()?.total_image_count ?? 0) > 0;
  const hasJpegs = () => (analysis()?.jpeg_image_count ?? 0) > 0;

  return (
    <PdfToolLayout
      handle={handle}
      error={error}
      pendingFiles={pendingFiles}
      previewPage={previewPage}
      onFiles={handleFiles}
      onMerged={handleMerged}
      onResetFiles={resetState}
      onClosePreview={() => setPreviewPage(null)}
      panelTitle="Compress"
      panel={
        <div class="flex flex-col flex-1 min-h-0">
          <div class="flex-1 overflow-y-auto p-4 space-y-5">
            {/* Analysis */}
            <Show when={analysis()}>
              {(a) => {
                const info = a();
                return (
                  <div class="bg-blue-50 border border-blue-200 rounded p-2.5 text-xs text-blue-800 space-y-0.5">
                    <p>{info.total_image_count} images ({info.jpeg_image_count} JPEG, {info.non_jpeg_image_count} PNG)</p>
                    <Show when={info.max_dpi != null}><p>Max DPI ~{Math.round(info.max_dpi!)}</p></Show>
                    <Show when={info.estimated_jpeg_quality != null}><p>JPEG quality ~{info.estimated_jpeg_quality}</p></Show>
                  </div>
                );
              }}
            </Show>

            {/* Level */}
            <div class="space-y-1.5">
              <PanelLabel>Level</PanelLabel>
              <div class="space-y-1.5">
                <For each={Object.keys(PRESET_INFO) as Preset[]}>
                  {(p) => (
                    <PanelButton
                      active={preset() === p}
                      label={PRESET_INFO[p].label}
                      description={PRESET_INFO[p].description}
                      onClick={() => setPreset(p)}
                    />
                  )}
                </For>
              </div>
            </div>

            {/* Advanced options — inline below level buttons */}
            <Show when={preset() === "advanced"}>
              <SegmentedControl
                options={["Direct", "Target Size"]}
                active={advancedSubMode() === "direct" ? 0 : 1}
                onChange={(i) => setAdvancedSubMode(i === 0 ? "direct" : "target_size")}
              />

              <Show when={advancedSubMode() === "direct"}>
                <div class="space-y-1.5">
                  <PanelInputRow
                    label="Downsample"
                    suffix="DPI"
                    value={dpi()}
                    onInput={setDpi}
                    active={dpiEnabled()}
                    onToggle={() => setDpiEnabled(!dpiEnabled())}
                    min="72" max="600" step="10"
                    disabled={!hasImages()}
                  />

                  <PanelLabel>Encoding</PanelLabel>
                  <PanelInputRow
                    label="JPEG Quality"
                    value={jpegQuality()}
                    onInput={setJpegQuality}
                    active={encodingChoice() === "jpeg"}
                    onToggle={() => setEncodingChoice(encodingChoice() === "jpeg" ? "none" : "jpeg")}
                    min="10" max="95" step="5"
                    disabled={!hasJpegs()}
                  />
                  <PanelButton
                    active={encodingChoice() === "jp2"}
                    label="JPEG 2000"
                    badge="limited support"
                    onClick={() => { if (hasImages()) setEncodingChoice(encodingChoice() === "jp2" ? "none" : "jp2"); }}
                    disabled={!hasImages()}
                  />
                </div>
              </Show>

              <Show when={advancedSubMode() === "target_size"}>
                <div class="space-y-1.5">
                  <PanelInputRow
                    label="Target Size"
                    suffix="MB"
                    value={targetSizeMB()}
                    onInput={setTargetSizeMB}
                    min="0.1" step="0.1"
                  />
                  <PanelInputRow
                    label="Min DPI"
                    value={minDpi()}
                    onInput={setMinDpi}
                    min="72" max="600" step="10"
                  />
                  <PanelInputRow
                    label="Min JPEG Quality"
                    value={minJpegQuality()}
                    onInput={setMinJpegQuality}
                    min="10" max="95" step="5"
                    disabled={jp2InTargetMode()}
                  />
                  <PanelButton
                    active={jp2InTargetMode()}
                    label="JPEG 2000"
                    badge="limited support"
                    onClick={() => setJp2InTargetMode(!jp2InTargetMode())}
                  />
                </div>
              </Show>
            </Show>

            {/* Options */}
            <div class="space-y-1.5">
              <PanelLabel>Options</PanelLabel>
              <div class="space-y-1.5">
                <PanelButton
                  active={stripMetadata()}
                  label="Strip metadata"
                  description="Remove title, author, and document metadata"
                  onClick={() => setStripMetadata(!stripMetadata())}
                />
                <PanelButton
                  active={grayscaleMode() === "rasterize"}
                  label="Grayscale (rasterize)"
                  description="Render pages as grayscale images"
                  onClick={() => setGrayscaleMode(grayscaleMode() === "rasterize" ? "off" : "rasterize")}
                />
              </div>
            </div>
          </div>

          <PanelFooter
            statusText={`${selectedCount()}/${pageCount()} pages`}
            saving={compressing()}
            onSave={compress}
            onSelectAll={selectAll}
            onClearSelection={selectNone}
            allSelected={allSelected()}
          >
            {/* Progress */}
            <Show when={compressing()}>
              <div class="space-y-1">
                <div class="flex justify-between text-xs text-gray-500">
                  <span>{progressLabel()}</span>
                  <span>{progressPct()}%</span>
                </div>
                <div class="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
                  <div class="bg-blue-600 h-full rounded-full transition-all duration-150" style={{ width: `${progressPct()}%` }} />
                </div>
              </div>
            </Show>

            {/* Results */}
            <Show when={result()}>
              {(r) => {
                const res = r();
                const savings = res.original_size - res.compressed_size;
                const pct = ((savings / res.original_size) * 100).toFixed(1);
                return (
                  <div class="bg-green-50 border border-green-200 rounded p-3 space-y-1.5">
                    <div class="flex justify-between text-xs">
                      <span class="text-gray-600">{formatSize(res.original_size)}</span>
                      <span class="text-gray-400">{"→"}</span>
                      <span class="font-medium">{formatSize(res.compressed_size)}</span>
                    </div>
                    <p class="text-xs font-medium text-green-600">-{formatSize(savings)} ({pct}%)</p>
                    <Show when={preset() === "advanced" && advancedSubMode() === "target_size"}>
                      <p class="text-xs" classList={{ "text-green-600": res.target_met, "text-amber-600": !res.target_met }}>
                        {res.target_met ? "Target met" : "Target not met (best effort)"}
                      </p>
                    </Show>
                    <button onClick={useCompressedResult} class="w-full py-1.5 bg-green-600 text-white rounded text-xs font-medium mt-1">
                      Apply result
                    </button>
                  </div>
                );
              }}
            </Show>
          </PanelFooter>
        </div>
      }
    >
      <ThumbnailGrid
        pageCount={pageCount()}
        thumbnails={thumbnails()}
        selectedPages={selectedPages()}
        pageActions={pageActions}
        pendingOps={pendingOps()}
        onPageClick={handlePageClick}
        onPageDblClick={(pageIndex) => setPreviewPage(pageIndex)}
        onVisiblePagesChange={updateVisiblePages}
      />
    </PdfToolLayout>
  );
}
