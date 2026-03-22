import { createEffect, Show } from "solid-js";

interface Props {
  imageData: ImageData | undefined;
  pageIndex: number;
  selected?: boolean;
  /** Override border/ring color when selected, e.g. "border-red-500 ring-red-300" */
  selectedClass?: string;
  onClick?: (e: MouseEvent) => void;
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

  return (
    <div
      onClick={(e) => props.onClick?.(e)}
      class={`relative cursor-pointer rounded border-2 overflow-hidden transition-colors ${
        props.selected
          ? props.selectedClass ?? DEFAULT_SELECTED
          : "border-gray-200 hover:border-gray-400"
      }`}
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
        />
      </Show>
      <div class="absolute bottom-0 left-0 right-0 bg-black/50 text-white text-xs text-center py-0.5">
        {props.pageIndex + 1}
      </div>
    </div>
  );
}
