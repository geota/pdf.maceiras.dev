import { createSignal, For, Show, type JSX } from "solid-js";
import { useSharedPdf } from "../../PdfContext";

export interface PageAction {
  id: string;
  icon: () => JSX.Element;
  label: string;
  showOn: "thumbnail" | "fullpage" | "both";
  onAction: (pageIndex: number) => void;
}

/** Overlay of action buttons shown on hover over a page thumbnail or full page. */
export function PageActionOverlay(props: {
  pageIndex: number;
  actions: PageAction[];
  position: "thumbnail" | "fullpage";
}) {
  const filtered = () =>
    props.actions.filter(
      (a) => a.showOn === "both" || a.showOn === props.position
    );

  return (
    <Show when={filtered().length > 0}>
      <div
        class={`absolute z-10 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity ${
          props.position === "thumbnail"
            ? "top-0.5 left-0.5"
            : "top-2 left-2"
        }`}
      >
        <For each={filtered()}>
          {(action) => (
            <button
              title={action.label}
              onClick={(e) => {
                e.stopPropagation();
                action.onAction(props.pageIndex);
              }}
              class={`flex items-center justify-center rounded bg-black/60 hover:bg-black/80 text-white transition-colors ${
                props.position === "thumbnail"
                  ? "w-5 h-5 text-[10px]"
                  : "w-8 h-8 text-sm"
              }`}
            >
              {action.icon()}
            </button>
          )}
        </For>
      </div>
    </Show>
  );
}

/** Dropdown menu for per-page operations, shown top-right on full-size renders. */
export function PageMenuOverlay(props: {
  pageIndex: number;
  onCrop: (pageIndex: number) => void;
  onScale?: (pageIndex: number) => void;
}) {
  const [open, setOpen] = createSignal(false);

  return (
    <div class="absolute z-10 top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        class="flex items-center justify-center w-8 h-8 rounded bg-black/60 hover:bg-black/80 text-white transition-colors"
        title="Page operations"
      >
        <EllipsisIcon />
      </button>
      <Show when={open()}>
        <div
          class="absolute right-0 mt-1 w-36 rounded-md bg-gray-900/95 shadow-lg ring-1 ring-white/10 py-1 text-sm"
          onClick={(e) => e.stopPropagation()}
        >
          <MenuItem
            label="Crop"
            onClick={() => {
              setOpen(false);
              props.onCrop(props.pageIndex);
            }}
          />
          <MenuItem
            label="Scale"
            onClick={() => {
              setOpen(false);
              props.onScale?.(props.pageIndex);
            }}
          />
          <MenuItem label="Compress" disabled />
        </div>
      </Show>
    </div>
  );
}

function MenuItem(props: { label: string; onClick?: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={props.onClick}
      disabled={props.disabled}
      class={`w-full text-left px-3 py-1.5 ${
        props.disabled
          ? "text-gray-500 cursor-not-allowed"
          : "text-white hover:bg-white/10 cursor-pointer"
      }`}
    >
      {props.label}
      {props.disabled && <span class="ml-1 text-[10px] text-gray-500">(soon)</span>}
    </button>
  );
}

const EllipsisIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" class="w-full h-full p-1.5">
    <circle cx="12" cy="5" r="1.5" />
    <circle cx="12" cy="12" r="1.5" />
    <circle cx="12" cy="19" r="1.5" />
  </svg>
);

const RotateCWIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-full h-full p-0.5">
    <path d="M12 5H6a2 2 0 0 0-2 2v3" />
    <path d="m9 8 3-3-3-3" />
    <path d="M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
  </svg>
);

const RotateCCWIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-full h-full p-0.5">
    <path d="M20 9V7a2 2 0 0 0-2-2h-6" />
    <path d="m15 2-3 3 3 3" />
    <path d="M20 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2" />
  </svg>
);

/** Returns the standard set of per-page actions (rotate only). */
export function usePageActions(): PageAction[] {
  const { rotatePage } = useSharedPdf();

  return [
    {
      id: "rotate-cw",
      icon: RotateCWIcon,
      label: "Rotate clockwise",
      showOn: "both",
      onAction: (pageIndex) => rotatePage(pageIndex, 90),
    },
    {
      id: "rotate-ccw",
      icon: RotateCCWIcon,
      label: "Rotate counter-clockwise",
      showOn: "both",
      onAction: (pageIndex) => rotatePage(pageIndex, -90),
    },
  ];
}
