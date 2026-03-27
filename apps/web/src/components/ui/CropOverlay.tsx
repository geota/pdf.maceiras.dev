import { createSignal, onMount, onCleanup } from "solid-js";
import type { CropRect } from "../../PdfContext";

type DragMode =
  | "move"
  | "nw" | "ne" | "sw" | "se"
  | "n" | "s" | "e" | "w"
  | null;

interface Props {
  onConfirm: (crop: CropRect) => void;
  onCancel: () => void;
  /** Pre-populate with an existing crop for re-editing. */
  initialCrop?: CropRect;
}

/**
 * Interactive crop rectangle overlay rendered on top of a full-size page.
 * The overlay fills its parent (which must be position:relative).
 *
 * All coordinates are fractional [0..1] relative to the page.
 */
export default function CropOverlay(props: Props) {
  let containerRef: HTMLDivElement | undefined;

  const INSET = 0.1;
  const [sel, setSel] = createSignal<CropRect>(
    props.initialCrop ?? { x: INSET, y: INSET, w: 1 - 2 * INSET, h: 1 - 2 * INSET },
  );

  let dragMode: DragMode = null;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragStartSel = { x: 0, y: 0, w: 0, h: 0 };

  function getContainerSize() {
    if (!containerRef) return { cw: 1, ch: 1 };
    return { cw: containerRef.clientWidth, ch: containerRef.clientHeight };
  }

  function clamp(v: number, min: number, max: number) {
    return Math.max(min, Math.min(max, v));
  }

  function onPointerDown(e: PointerEvent, mode: DragMode) {
    e.preventDefault();
    e.stopPropagation();
    dragMode = mode;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragStartSel = { ...sel() };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent) {
    if (!dragMode) return;
    e.preventDefault();
    const { cw, ch } = getContainerSize();
    const dx = (e.clientX - dragStartX) / cw;
    const dy = (e.clientY - dragStartY) / ch;
    const s = dragStartSel;
    const MIN_SIZE = 0.02;

    if (dragMode === "move") {
      const nx = clamp(s.x + dx, 0, 1 - s.w);
      const ny = clamp(s.y + dy, 0, 1 - s.h);
      setSel({ x: nx, y: ny, w: s.w, h: s.h });
      return;
    }

    let x = s.x, y = s.y, w = s.w, h = s.h;

    // Horizontal edges
    if (dragMode.includes("w")) {
      const newX = clamp(s.x + dx, 0, s.x + s.w - MIN_SIZE);
      w = s.w - (newX - s.x);
      x = newX;
    }
    if (dragMode.includes("e")) {
      w = clamp(s.w + dx, MIN_SIZE, 1 - s.x);
    }

    // Vertical edges
    if (dragMode.includes("n")) {
      const newY = clamp(s.y + dy, 0, s.y + s.h - MIN_SIZE);
      h = s.h - (newY - s.y);
      y = newY;
    }
    if (dragMode.includes("s")) {
      h = clamp(s.h + dy, MIN_SIZE, 1 - s.y);
    }

    setSel({ x, y, w, h });
  }

  function onPointerUp() {
    dragMode = null;
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") props.onCancel();
    if (e.key === "Enter") confirm();
  }

  onMount(() => {
    document.addEventListener("keydown", handleKeyDown);
  });
  onCleanup(() => {
    document.removeEventListener("keydown", handleKeyDown);
  });

  function confirm() {
    props.onConfirm(sel());
  }

  // Computed pixel styles from fractional sel
  const pct = (v: number) => `${v * 100}%`;

  return (
    <div
      ref={containerRef}
      class="absolute inset-0 z-20"
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {/* Dark mask — 4 rectangles around the selection cutout */}
      <div class="absolute bg-black/50" style={{
        top: "0", left: "0", right: "0",
        height: pct(sel().y),
      }} />
      <div class="absolute bg-black/50" style={{
        top: pct(sel().y + sel().h), left: "0", right: "0",
        bottom: "0",
      }} />
      <div class="absolute bg-black/50" style={{
        top: pct(sel().y), left: "0",
        width: pct(sel().x), height: pct(sel().h),
      }} />
      <div class="absolute bg-black/50" style={{
        top: pct(sel().y), right: "0",
        left: pct(sel().x + sel().w), height: pct(sel().h),
      }} />

      {/* Selection border */}
      <div
        class="absolute border-2 border-white/90 cursor-move"
        style={{
          top: pct(sel().y), left: pct(sel().x),
          width: pct(sel().w), height: pct(sel().h),
        }}
        onPointerDown={(e) => onPointerDown(e, "move")}
      >
        {/* Corner handles */}
        <Handle pos="nw" onPointerDown={onPointerDown} />
        <Handle pos="ne" onPointerDown={onPointerDown} />
        <Handle pos="sw" onPointerDown={onPointerDown} />
        <Handle pos="se" onPointerDown={onPointerDown} />
        {/* Edge handles */}
        <Handle pos="n" onPointerDown={onPointerDown} />
        <Handle pos="s" onPointerDown={onPointerDown} />
        <Handle pos="e" onPointerDown={onPointerDown} />
        <Handle pos="w" onPointerDown={onPointerDown} />
      </div>

      {/* Confirm / Cancel bar */}
      <div class="absolute bottom-4 left-1/2 -translate-x-1/2 flex gap-2">
        <button
          onClick={confirm}
          class="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded shadow font-medium"
        >
          Apply crop
        </button>
        <button
          onClick={props.onCancel}
          class="px-4 py-1.5 bg-gray-600 hover:bg-gray-700 text-white text-sm rounded shadow"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

const CURSOR_MAP: Record<string, string> = {
  nw: "nwse-resize", se: "nwse-resize",
  ne: "nesw-resize", sw: "nesw-resize",
  n: "ns-resize", s: "ns-resize",
  e: "ew-resize", w: "ew-resize",
};

const POS_STYLES: Record<string, Record<string, string>> = {
  nw: { top: "-4px", left: "-4px" },
  ne: { top: "-4px", right: "-4px" },
  sw: { bottom: "-4px", left: "-4px" },
  se: { bottom: "-4px", right: "-4px" },
  n: { top: "-4px", left: "50%", "margin-left": "-4px" },
  s: { bottom: "-4px", left: "50%", "margin-left": "-4px" },
  e: { right: "-4px", top: "50%", "margin-top": "-4px" },
  w: { left: "-4px", top: "50%", "margin-top": "-4px" },
};

function Handle(props: {
  pos: string;
  onPointerDown: (e: PointerEvent, mode: DragMode) => void;
}) {
  return (
    <div
      class="absolute w-2 h-2 bg-white border border-gray-400 rounded-sm"
      style={{ ...POS_STYLES[props.pos], cursor: CURSOR_MAP[props.pos] }}
      onPointerDown={(e) => props.onPointerDown(e, props.pos as DragMode)}
    />
  );
}
