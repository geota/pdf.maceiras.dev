import { createSignal, createEffect, Show, For, on } from "solid-js";
import * as pdfWorker from "../pdf-worker-client";
import { getRenderPool } from "../render-pool";
import DropZone from "./ui/DropZone";
import { useSharedPdf } from "../PdfContext";
import { formatSize } from "../lib/format";

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
    description:
      "Prune objects, recompress streams, strip metadata, oxipng. No quality loss.",
  },
  low: {
    label: "Low",
    description: "Light lossy compression. DPI 200, JPEG quality 80.",
  },
  medium: {
    label: "Medium",
    description: "Moderate lossy compression. DPI 150, JPEG quality 65.",
  },
  high: {
    label: "High",
    description: "Aggressive lossy compression. DPI 100, JPEG quality 45.",
  },
  advanced: {
    label: "Advanced",
    description: "Choose specific settings or target a file size.",
  },
};



export default function PdfCompress() {
  const { sharedPdf, loadFile, loadFromBytes } = useSharedPdf();
  const [handle, setHandle] = createSignal<string | null>(null);
  const [fileName, setFileName] = createSignal("");
  const [fileSize, setFileSize] = createSignal(0);
  const [analysis, setAnalysis] = createSignal<PdfAnalysis | null>(null);

  // Preset
  const [preset, setPreset] = createSignal<Preset>("lossless");

  // Top-level options (all presets)
  const [stripMetadata, setStripMetadata] = createSignal(true);
  const [grayscale, setGrayscale] = createSignal(false);

  // Advanced sub-mode
  const [advancedSubMode, setAdvancedSubMode] =
    createSignal<AdvancedSubMode>("direct");

  // Advanced > Direct
  const [dpiEnabled, setDpiEnabled] = createSignal(false);
  const [dpi, setDpi] = createSignal("150");
  const [encodingChoice, setEncodingChoice] =
    createSignal<EncodingChoice>("none");
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
  const [compressedData, setCompressedData] =
    createSignal<ArrayBuffer | null>(null);
  const [error, setError] = createSignal("");

  // Sync from shared PDF
  createEffect(on(sharedPdf, (pdf) => {
    if (pdf) {
      setHandle(pdf.handle);
      setFileName(pdf.fileName);
      setFileSize(pdf.fileSize);
      setError("");
      setResult(null);
      setCompressedData(null);
      setAnalysis(null);
      // Fetch analysis in background
      pdfWorker.analyzePdf(pdf.handle).then((a) => {
        setAnalysis(a);
        if (a.max_dpi != null) setDpi(String(Math.round(a.max_dpi)));
        if (a.estimated_jpeg_quality != null)
          setJpegQuality(String(a.estimated_jpeg_quality));
      });
    } else {
      setHandle(null);
      setFileName("");
      setFileSize(0);
      setAnalysis(null);
      setResult(null);
      setCompressedData(null);
    }
  }));

  async function handleFiles(files: File[]) {
    const file = files[0];
    if (!file) return;
    setError("");
    try {
      await loadFile(file);
    } catch (err: any) {
      setError(err.message || "Failed to load PDF");
    }
  }

  function buildOptions() {
    const p = preset();
    const base: Record<string, unknown> = {
      preset: p,
      strip_metadata: stripMetadata(),
      grayscale: grayscale(),
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
      const options = buildOptions();
      const res = await compressWithParallel(h, options);
      setResult(res.result);
      setCompressedData(res.data);
    } catch (err: any) {
      setError(err.message || "Compression failed");
    } finally {
      setCompressing(false);
    }
  }

  /** Try parallel compression via worker pool, fall back to sequential. */
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
      // Phase 1: structural lossless + extract image tasks
      setProgressLabel("Optimizing structure...");
      setProgressPct(0);
      const phase1 = await pdfWorker.compressBegin(h, options);

      if (!phase1.complete && phase1.imageTasks && phase1.imageTasks.length > 0) {
        const pool = getRenderPool();

        // Check if this is a target-size mode (needs iterative steps)
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

        // Non-target-size: process all images then finalize
        setProgressLabel(`Processing ${phase1.imageTasks.length} images...`);
        const results = await pool.processImageTasks(phase1.imageTasks, onImageProgress);

        setProgressLabel("Finalizing...");
        setProgressPct(100);
        return pdfWorker.compressFinish(results);
      }

      // No parallel work needed — finalize with empty results
      setProgressLabel("Finalizing...");
      setProgressPct(100);
      return pdfWorker.compressFinish([]);
    } catch (e) {
      // Fall back to sequential compression if parallel fails
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
    <div>
      <Show when={!handle()}>
        <DropZone onFiles={handleFiles} accept=".pdf">
          <p class="text-sm text-gray-500">
            <span class="font-medium">Drop a PDF here</span> or click to browse
          </p>
        </DropZone>
      </Show>

      <Show when={handle()}>
        <div class="mt-4 space-y-4 max-w-lg">
          <p class="text-sm text-gray-600">
            {fileName()} — {formatSize(fileSize())}
          </p>

          {/* Analysis panel */}
          <Show when={analysis()}>
            {(a) => {
              const info = a();
              return (
                <div class="bg-blue-50 border border-blue-200 rounded p-3 text-xs text-blue-800 flex flex-wrap gap-x-4 gap-y-1">
                  <span>
                    Images: {info.jpeg_image_count} JPEG,{" "}
                    {info.non_jpeg_image_count} PNG
                  </span>
                  <Show when={info.max_dpi != null}>
                    <span>Max DPI: ~{Math.round(info.max_dpi!)}</span>
                  </Show>
                  <Show when={info.estimated_jpeg_quality != null}>
                    <span>
                      Est. JPEG quality: ~{info.estimated_jpeg_quality}
                    </span>
                  </Show>
                  <Show when={info.total_image_count === 0}>
                    <span class="text-blue-600">No optimizable images found</span>
                  </Show>
                </div>
              );
            }}
          </Show>

          {/* Preset selector */}
          <div class="space-y-2">
            <p class="text-xs font-medium text-gray-500 uppercase tracking-wide">
              Compression Level
            </p>
            <div class="grid grid-cols-5 gap-1">
              <For each={Object.keys(PRESET_INFO) as Preset[]}>
                {(p) => (
                  <button
                    onClick={() => setPreset(p)}
                    class="px-2 py-1.5 text-xs font-medium rounded border transition-colors"
                    classList={{
                      "bg-blue-600 text-white border-blue-600":
                        preset() === p,
                      "bg-white text-gray-700 border-gray-300 hover:bg-gray-50":
                        preset() !== p,
                    }}
                  >
                    {PRESET_INFO[p].label}
                  </button>
                )}
              </For>
            </div>
            <p class="text-xs text-gray-400">
              {PRESET_INFO[preset()].description}
            </p>
          </div>

          {/* Top-level options — always visible */}
          <div class="space-y-2 border-t border-gray-200 pt-3">
            <label class="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={stripMetadata()}
                onChange={(e) => setStripMetadata(e.currentTarget.checked)}
                class="rounded border-gray-300"
              />
              <span class="text-gray-700">
                Strip metadata, annotations & bookmarks
              </span>
            </label>
            <label class="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={grayscale()}
                onChange={(e) => setGrayscale(e.currentTarget.checked)}
                class="rounded border-gray-300"
              />
              <span class="text-gray-700">Convert to grayscale</span>
            </label>
          </div>

          {/* Advanced panel */}
          <Show when={preset() === "advanced"}>
            <div class="space-y-4 border-t border-gray-200 pt-3">
              {/* Sub-mode selector */}
              <div class="flex gap-1">
                <button
                  onClick={() => setAdvancedSubMode("direct")}
                  class="px-3 py-1 text-xs font-medium rounded border transition-colors"
                  classList={{
                    "bg-gray-800 text-white border-gray-800":
                      advancedSubMode() === "direct",
                    "bg-white text-gray-600 border-gray-300 hover:bg-gray-50":
                      advancedSubMode() !== "direct",
                  }}
                >
                  Direct Settings
                </button>
                <button
                  onClick={() => setAdvancedSubMode("target_size")}
                  class="px-3 py-1 text-xs font-medium rounded border transition-colors"
                  classList={{
                    "bg-gray-800 text-white border-gray-800":
                      advancedSubMode() === "target_size",
                    "bg-white text-gray-600 border-gray-300 hover:bg-gray-50":
                      advancedSubMode() !== "target_size",
                  }}
                >
                  Target Size
                </button>
              </div>

              {/* Direct Settings */}
              <Show when={advancedSubMode() === "direct"}>
                <div class="space-y-3">
                  {/* Image Resolution */}
                  <div class="space-y-2">
                    <p class="text-xs font-medium text-gray-500 uppercase tracking-wide">
                      Image Resolution
                    </p>
                    <label
                      class="flex items-center gap-2 text-sm"
                      classList={{ "opacity-40": !hasImages() }}
                    >
                      <input
                        type="checkbox"
                        checked={dpiEnabled()}
                        onChange={(e) => setDpiEnabled(e.currentTarget.checked)}
                        disabled={!hasImages()}
                        class="rounded border-gray-300"
                      />
                      <span class="text-gray-700">Downsample images</span>
                    </label>
                    <Show when={dpiEnabled() && hasImages()}>
                      <div class="pl-6 flex items-center gap-2">
                        <label class="flex items-center gap-1 text-sm text-gray-700">
                          Target DPI
                          <input
                            type="number"
                            min="72"
                            max="600"
                            step="10"
                            value={dpi()}
                            onInput={(e) => setDpi(e.currentTarget.value)}
                            class="w-20 border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                          />
                        </label>
                        <Show when={analysis()?.max_dpi != null}>
                          <span class="text-xs text-gray-400">
                            (detected: ~{Math.round(analysis()!.max_dpi!)} DPI)
                          </span>
                        </Show>
                      </div>
                    </Show>
                    <Show when={!hasImages() && analysis() != null}>
                      <p class="pl-6 text-xs text-gray-400">
                        No optimizable images in this PDF
                      </p>
                    </Show>
                  </div>

                  {/* Image Encoding */}
                  <div class="space-y-2">
                    <p class="text-xs font-medium text-gray-500 uppercase tracking-wide">
                      Image Encoding
                    </p>
                    <div class="space-y-1.5">
                      <label class="flex items-center gap-2 text-sm">
                        <input
                          type="radio"
                          name="encoding"
                          checked={encodingChoice() === "none"}
                          onChange={() => setEncodingChoice("none")}
                          class="border-gray-300"
                        />
                        <span class="text-gray-700">None</span>
                      </label>
                      <label
                        class="flex items-center gap-2 text-sm"
                        classList={{ "opacity-40": !hasJpegs() }}
                      >
                        <input
                          type="radio"
                          name="encoding"
                          checked={encodingChoice() === "jpeg"}
                          onChange={() => setEncodingChoice("jpeg")}
                          disabled={!hasJpegs()}
                          class="border-gray-300"
                        />
                        <span class="text-gray-700">JPEG recompression</span>
                      </label>
                      <Show when={encodingChoice() === "jpeg" && hasJpegs()}>
                        <div class="pl-6 flex items-center gap-2">
                          <label class="flex items-center gap-1 text-sm text-gray-700">
                            Quality
                            <input
                              type="number"
                              min="10"
                              max="95"
                              step="5"
                              value={jpegQuality()}
                              onInput={(e) =>
                                setJpegQuality(e.currentTarget.value)
                              }
                              class="w-20 border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                            />
                          </label>
                          <Show
                            when={analysis()?.estimated_jpeg_quality != null}
                          >
                            <span class="text-xs text-gray-400">
                              (detected: ~{analysis()!.estimated_jpeg_quality})
                            </span>
                          </Show>
                        </div>
                      </Show>
                      <Show when={!hasJpegs() && analysis() != null}>
                        <p class="pl-6 text-xs text-gray-400">
                          No JPEG images detected
                        </p>
                      </Show>
                      <label
                        class="flex items-center gap-2 text-sm"
                        classList={{ "opacity-40": !hasImages() }}
                      >
                        <input
                          type="radio"
                          name="encoding"
                          checked={encodingChoice() === "jp2"}
                          onChange={() => setEncodingChoice("jp2")}
                          disabled={!hasImages()}
                          class="border-gray-300"
                        />
                        <span class="text-gray-700">JPEG 2000 encoding</span>
                        <span class="text-xs text-amber-600">
                          Limited viewer support
                        </span>
                      </label>
                    </div>
                  </div>
                </div>
              </Show>

              {/* Target Size */}
              <Show when={advancedSubMode() === "target_size"}>
                <div class="space-y-3">
                  <div class="flex items-center gap-2">
                    <label class="flex items-center gap-1 text-sm text-gray-700">
                      Target
                      <input
                        type="number"
                        min="0.1"
                        step="0.1"
                        value={targetSizeMB()}
                        onInput={(e) => setTargetSizeMB(e.currentTarget.value)}
                        class="w-24 border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </label>
                    <span class="text-sm text-gray-600">MB</span>
                  </div>

                  <p class="text-xs text-gray-400">
                    The system progressively reduces image quality until the
                    target is reached. Set minimum acceptable values:
                  </p>

                  <div class="space-y-2">
                    <div class="flex items-center gap-2">
                      <label class="flex items-center gap-1 text-sm text-gray-700">
                        Min DPI
                        <input
                          type="number"
                          min="72"
                          max="600"
                          step="10"
                          value={minDpi()}
                          onInput={(e) => setMinDpi(e.currentTarget.value)}
                          class="w-20 border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      </label>
                      <Show when={analysis()?.max_dpi != null}>
                        <span class="text-xs text-gray-400">
                          (currently ~{Math.round(analysis()!.max_dpi!)} DPI)
                        </span>
                      </Show>
                    </div>

                    <div
                      class="flex items-center gap-2"
                      classList={{ "opacity-40": jp2InTargetMode() }}
                    >
                      <label class="flex items-center gap-1 text-sm text-gray-700">
                        Min JPEG quality
                        <input
                          type="number"
                          min="10"
                          max="95"
                          step="5"
                          value={minJpegQuality()}
                          onInput={(e) =>
                            setMinJpegQuality(e.currentTarget.value)
                          }
                          disabled={jp2InTargetMode()}
                          class="w-20 border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      </label>
                      <Show when={analysis()?.estimated_jpeg_quality != null}>
                        <span class="text-xs text-gray-400">
                          (currently ~{analysis()!.estimated_jpeg_quality})
                        </span>
                      </Show>
                    </div>

                    <label class="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={jp2InTargetMode()}
                        onChange={(e) =>
                          setJp2InTargetMode(e.currentTarget.checked)
                        }
                        class="rounded border-gray-300"
                      />
                      <span class="text-gray-700">
                        Use JPEG 2000 instead of JPEG
                      </span>
                      <span class="text-xs text-amber-600">
                        Limited viewer support
                      </span>
                    </label>
                  </div>
                </div>
              </Show>
            </div>
          </Show>

          <button
            onClick={compress}
            disabled={compressing()}
            class="px-4 py-2 bg-blue-600 text-white rounded disabled:opacity-50 text-sm font-medium"
          >
            {compressing() ? "Compressing..." : "Compress"}
          </button>

          {/* Progress bar */}
          <Show when={compressing()}>
            <div class="space-y-1">
              <div class="flex justify-between text-xs text-gray-500">
                <span>{progressLabel()}</span>
                <span>{progressPct()}%</span>
              </div>
              <div class="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
                <div
                  class="bg-blue-600 h-full rounded-full transition-all duration-150"
                  style={{ width: `${progressPct()}%` }}
                />
              </div>
            </div>
          </Show>
        </div>

        {/* Results */}
        <Show when={result()}>
          {(r) => {
            const res = r();
            const savings = res.original_size - res.compressed_size;
            const pct = ((savings / res.original_size) * 100).toFixed(1);
            return (
              <div class="mt-6 space-y-3 max-w-lg">
                <div class="bg-gray-50 border border-gray-200 rounded p-4 space-y-2">
                  <div class="flex justify-between text-sm">
                    <span class="text-gray-600">Original</span>
                    <span class="font-medium">
                      {formatSize(res.original_size)}
                    </span>
                  </div>
                  <div class="flex justify-between text-sm">
                    <span class="text-gray-600">Compressed</span>
                    <span class="font-medium">
                      {formatSize(res.compressed_size)}
                    </span>
                  </div>
                  <div class="flex justify-between text-sm">
                    <span class="text-gray-600">Saved</span>
                    <span class="font-medium text-green-600">
                      {formatSize(savings)} ({pct}%)
                    </span>
                  </div>
                  <Show
                    when={
                      preset() === "advanced" &&
                      advancedSubMode() === "target_size"
                    }
                  >
                    <div class="flex justify-between text-sm">
                      <span class="text-gray-600">Target met</span>
                      <span
                        class="font-medium"
                        classList={{
                          "text-green-600": res.target_met,
                          "text-amber-600": !res.target_met,
                        }}
                      >
                        {res.target_met ? "Yes" : "No (best effort)"}
                      </span>
                    </div>
                  </Show>
                </div>

                <Show when={res.techniques_applied.length > 0}>
                  <div class="text-sm text-gray-600">
                    <p class="font-medium mb-1">Techniques applied:</p>
                    <ul class="list-disc list-inside space-y-0.5">
                      <For each={res.techniques_applied}>
                        {(t) => <li>{t}</li>}
                      </For>
                    </ul>
                  </div>
                </Show>

                <button
                  onClick={useCompressedResult}
                  class="px-4 py-2 bg-blue-600 text-white rounded text-sm font-medium"
                >
                  Apply compression
                </button>
              </div>
            );
          }}
        </Show>
      </Show>

      <Show when={error()}>
        <div class="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mt-4 text-sm">
          {error()}
        </div>
      </Show>
    </div>
  );
}
