import { createEffect, For, Show } from "solid-js";
import { PageActionOverlay, type PageAction } from "./PageActions";
import { effectiveRotation, effectiveCrop, effectiveScale, type PageOp } from "../../PdfContext";

interface Props {
  imageData: ImageData | undefined;
  pageIndex: number;
  selected?: boolean;
  /** Override border/ring color when selected, e.g. "border-red-500 ring-red-300" */
  selectedClass?: string;
  /** Small colored dots shown in the top-right corner (e.g. group membership indicators) */
  badges?: string[];
  /** Per-page action buttons shown on hover */
  actions?: PageAction[];
  /** Pending per-page operations (ordered list). */
  pendingOps?: PageOp[];
  /** Ref callback for the outer wrapper div (e.g. for sortable binding). */
  ref?: (el: HTMLDivElement) => void;
  /** Show grab cursor instead of pointer (for drag-and-drop). */
  draggable?: boolean;
  /** Dim the thumbnail (e.g. while being dragged). */
  dragging?: boolean;
  onClick?: (e: MouseEvent) => void;
  onDblClick?: (e: MouseEvent) => void;
}

const DEFAULT_SELECTED = "border-blue-500 ring-2 ring-blue-300";

export default function Thumbnail(props: Props) {
  let canvasRef: HTMLCanvasElement | undefined;

  createEffect(() => {
    const img = props.imageData;
    if (!canvasRef || !img) return;
    canvasRef.width = img.width;
    canvasRef.height = img.height;
    const ctx = canvasRef.getContext("2d")!;
    ctx.putImageData(img, 0, 0);
  });

  const ops = () => props.pendingOps ?? [];
  const rot = () => effectiveRotation(ops());
  const crop = () => effectiveCrop(ops());
  const scale = () => effectiveScale(ops());

  const baseAspect = () => {
    const s = scale();
    if (s) return s.widthPts / s.heightPts;
    const img = props.imageData;
    if (!img || img.height === 0) return 3 / 4;
    return img.width / img.height;
  };

  // After crop, the effective aspect ratio changes
  const croppedAspect = () => {
    const c = crop();
    if (!c) return baseAspect();
    return (c.w / c.h) * baseAspect();
  };

  const isSideways = () => {
    const r = ((rot() % 360) + 360) % 360;
    return r === 90 || r === 270;
  };

  // Outer card aspect: rotated cropped aspect
  const spacerAspect = () => isSideways() ? 1 / croppedAspect() : croppedAspect();

  // Inner card scale when sideways
  const cardScale = () => isSideways() ? croppedAspect() : 1;

  const cardTransform = () => {
    const r = rot();
    if (!r) return undefined;
    const s = cardScale();
    return s !== 1
      ? `translate(-50%, -50%) rotate(${r}deg) scale(${s})`
      : `translate(-50%, -50%) rotate(${r}deg)`;
  };

  // Canvas sizing: crop positions within card, scale stretches to fill
  const canvasStyle = () => {
    const c = crop();
    if (c) {
      return {
        position: "absolute" as const,
        width: `${100 / c.w}%`,
        height: `${100 / c.h}%`,
        left: `${(-c.x / c.w) * 100}%`,
        top: `${(-c.y / c.h) * 100}%`,
      };
    }
    if (scale()) return { width: "100%", height: "100%" };
    return {};
  };

  const cursor = () => props.draggable ? "cursor-grab active:cursor-grabbing" : "cursor-pointer";

  return (
    <div
      ref={props.ref}
      onClick={(e) => props.onClick?.(e)}
      onDblClick={(e) => props.onDblClick?.(e)}
      class={`group relative w-full rounded border-2 overflow-hidden transition-[aspect-ratio,border-color,box-shadow] duration-200 ${cursor()} ${
        props.selected
          ? props.selectedClass ?? DEFAULT_SELECTED
          : "border-gray-200 hover:border-gray-400"
      }`}
      classList={{ "opacity-50": props.dragging }}
      style={{ "aspect-ratio": `${spacerAspect()}` }}
    >
      {/* Rotating inner — card uses cropped aspect, canvas positioned for crop */}
      <div
        class="absolute top-1/2 left-1/2 w-full overflow-hidden transition-[transform] duration-200"
        style={{
          "aspect-ratio": `${croppedAspect()}`,
          transform: cardTransform() ?? "translate(-50%, -50%)",
          "transform-origin": "center center",
        }}
      >
        <Show
          when={props.imageData}
          fallback={
            <div class="w-full aspect-[3/4] bg-gray-100 animate-pulse" />
          }
        >
          <canvas
            ref={canvasRef}
            class="w-full h-auto"
            style={canvasStyle()}
          />
        </Show>
      </div>
      {/* Non-rotating overlays — pinned to the outer card */}
      <Show when={props.actions}>
        <PageActionOverlay pageIndex={props.pageIndex} actions={props.actions!} position="thumbnail" />
      </Show>
      <Show when={props.badges && props.badges.length > 0}>
        <div class="absolute top-0.5 right-0.5 flex gap-0.5">
          <For each={props.badges}>
            {(dotClass) => <span class={`w-2 h-2 rounded-full ${dotClass}`} />}
          </For>
        </div>
      </Show>
      <div class="absolute bottom-0 left-0 right-0 bg-black/50 text-white text-xs text-center py-0.5">
        {props.pageIndex + 1}
      </div>
    </div>
  );
}
