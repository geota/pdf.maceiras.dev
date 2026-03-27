import { createSignal, createEffect, For, Show, onMount, onCleanup } from "solid-js";

// PDF points per unit
const MM_TO_PT = 72 / 25.4;
const PT_TO_MM = 25.4 / 72;

interface PageSize {
  label: string;
  /** Width × Height in PDF points (portrait orientation) */
  w: number;
  h: number;
}

/** Convert mm dimensions to PDF points. */
function mm(w: number, h: number): { w: number; h: number } {
  return { w: w * MM_TO_PT, h: h * MM_TO_PT };
}

// ISO 216 A series (A0–A10)
const A_SIZES: PageSize[] = [
  { label: "A0", ...mm(841, 1189) },
  { label: "A1", ...mm(594, 841) },
  { label: "A2", ...mm(420, 594) },
  { label: "A3", ...mm(297, 420) },
  { label: "A4", ...mm(210, 297) },
  { label: "A5", ...mm(148, 210) },
  { label: "A6", ...mm(105, 148) },
  { label: "A7", ...mm(74, 105) },
  { label: "A8", ...mm(52, 74) },
  { label: "A9", ...mm(37, 52) },
  { label: "A10", ...mm(26, 37) },
];

// ISO 216 B series (B0–B10)
const B_SIZES: PageSize[] = [
  { label: "B0", ...mm(1000, 1414) },
  { label: "B1", ...mm(707, 1000) },
  { label: "B2", ...mm(500, 707) },
  { label: "B3", ...mm(353, 500) },
  { label: "B4", ...mm(250, 353) },
  { label: "B5", ...mm(176, 250) },
  { label: "B6", ...mm(125, 176) },
  { label: "B7", ...mm(88, 125) },
  { label: "B8", ...mm(62, 88) },
  { label: "B9", ...mm(44, 62) },
  { label: "B10", ...mm(31, 44) },
];

// ISO 269 C series (C0–C10) — envelope sizes
const C_SIZES: PageSize[] = [
  { label: "C0", ...mm(917, 1297) },
  { label: "C1", ...mm(648, 917) },
  { label: "C2", ...mm(458, 648) },
  { label: "C3", ...mm(324, 458) },
  { label: "C4", ...mm(229, 324) },
  { label: "C5", ...mm(162, 229) },
  { label: "C6", ...mm(114, 162) },
  { label: "C7", ...mm(81, 114) },
  { label: "C8", ...mm(57, 81) },
  { label: "C9", ...mm(40, 57) },
  { label: "C10", ...mm(28, 40) },
];

// North American sizes
const NA_SIZES: PageSize[] = [
  { label: "Letter", w: 612, h: 792 },
  { label: "Legal", w: 612, h: 1008 },
  { label: "Tabloid", w: 792, h: 1224 },
];

type SizeGroup = "A" | "B" | "C" | "NA";
const SIZE_GROUPS: { id: SizeGroup; label: string; sizes: PageSize[] }[] = [
  { id: "A", label: "A", sizes: A_SIZES },
  { id: "B", label: "B", sizes: B_SIZES },
  { id: "C", label: "C", sizes: C_SIZES },
  { id: "NA", label: "US", sizes: NA_SIZES },
];

interface Props {
  /** Current page dimensions in PDF points */
  pageDims: [number, number];
  onConfirm: (widthPts: number, heightPts: number) => void;
  onCancel: () => void;
}

export default function ScaleOverlay(props: Props) {
  const originalAspect = () => props.pageDims[0] / props.pageDims[1];

  const [widthMm, setWidthMm] = createSignal(Math.round(props.pageDims[0] * PT_TO_MM));
  const [heightMm, setHeightMm] = createSignal(Math.round(props.pageDims[1] * PT_TO_MM));
  const [lockAspect, setLockAspect] = createSignal(true);
  const [activeGroup, setActiveGroup] = createSignal<SizeGroup>("A");

  function selectPreset(size: PageSize) {
    // Match orientation of current page
    const isLandscape = props.pageDims[0] > props.pageDims[1];
    const w = isLandscape ? size.h : size.w;
    const h = isLandscape ? size.w : size.h;
    setWidthMm(Math.round(w * PT_TO_MM));
    setHeightMm(Math.round(h * PT_TO_MM));
  }

  function onWidthChange(val: number) {
    setWidthMm(val);
    if (lockAspect()) {
      setHeightMm(Math.round(val / originalAspect()));
    }
  }

  function onHeightChange(val: number) {
    setHeightMm(val);
    if (lockAspect()) {
      setWidthMm(Math.round(val * originalAspect()));
    }
  }

  function confirm() {
    props.onConfirm(widthMm() * MM_TO_PT, heightMm() * MM_TO_PT);
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") props.onCancel();
    if (e.key === "Enter") confirm();
  }

  onMount(() => document.addEventListener("keydown", handleKeyDown));
  onCleanup(() => document.removeEventListener("keydown", handleKeyDown));

  return (
    <div class="absolute inset-0 z-20 flex items-center justify-center bg-black/40">
      <div
        class="bg-white rounded-lg shadow-xl p-5 w-80 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 class="text-sm font-semibold text-gray-800">Scale page</h3>

        {/* Current dimensions */}
        <p class="text-xs text-gray-500">
          Current: {Math.round(props.pageDims[0] * PT_TO_MM)} × {Math.round(props.pageDims[1] * PT_TO_MM)} mm
        </p>

        {/* Presets */}
        <div>
          <p class="text-xs font-medium text-gray-600 mb-1.5">Page size</p>
          {/* Series tabs */}
          <div class="flex gap-0.5 mb-2 border-b border-gray-200">
            <For each={SIZE_GROUPS}>
              {(group) => (
                <button
                  onClick={() => setActiveGroup(group.id)}
                  class={`px-3 py-1 text-xs font-medium border-b-2 transition-colors ${
                    activeGroup() === group.id
                      ? "border-blue-600 text-blue-600"
                      : "border-transparent text-gray-500 hover:text-gray-700"
                  }`}
                >
                  {group.label}
                </button>
              )}
            </For>
          </div>
          {/* Size buttons for active group */}
          <div class="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto">
            <For each={SIZE_GROUPS.find((g) => g.id === activeGroup())?.sizes ?? []}>
              {(size) => {
                const isLandscape = () => props.pageDims[0] > props.pageDims[1];
                const presetW = () => Math.round((isLandscape() ? size.h : size.w) * PT_TO_MM);
                const presetH = () => Math.round((isLandscape() ? size.w : size.h) * PT_TO_MM);
                const isActive = () => widthMm() === presetW() && heightMm() === presetH();
                return (
                  <button
                    onClick={() => selectPreset(size)}
                    class={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                      isActive()
                        ? "bg-blue-600 text-white"
                        : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                    }`}
                  >
                    {size.label}
                  </button>
                );
              }}
            </For>
          </div>
        </div>

        {/* Custom dimensions */}
        <div>
          <p class="text-xs font-medium text-gray-600 mb-1.5">Custom (mm)</p>
          <div class="flex items-center gap-2">
            <div class="flex-1">
              <label class="text-[10px] text-gray-400 block mb-0.5">Width</label>
              <input
                type="number"
                value={widthMm()}
                onInput={(e) => onWidthChange(parseInt(e.currentTarget.value) || 0)}
                class="w-full border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
            <span class="text-gray-400 mt-4">×</span>
            <div class="flex-1">
              <label class="text-[10px] text-gray-400 block mb-0.5">Height</label>
              <input
                type="number"
                value={heightMm()}
                onInput={(e) => onHeightChange(parseInt(e.currentTarget.value) || 0)}
                class="w-full border border-gray-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
          </div>
        </div>

        {/* Aspect ratio lock */}
        <label class="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={lockAspect()}
            onChange={(e) => setLockAspect(e.currentTarget.checked)}
            class="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
          />
          <span class="text-xs text-gray-600">Maintain aspect ratio</span>
        </label>

        {/* Actions */}
        <div class="flex gap-2 pt-1">
          <button
            onClick={confirm}
            class="flex-1 px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded font-medium"
          >
            Apply
          </button>
          <button
            onClick={props.onCancel}
            class="flex-1 px-4 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm rounded"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
