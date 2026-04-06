import { Show, type JSX } from "solid-js";
import DropZone from "./DropZone";
import MergeStep from "./MergeStep";
import PagePreview from "./PagePreview";

interface Props {
  handle: () => string | null;
  error: () => string;
  pendingFiles: () => File[] | null;
  previewPage: () => number | null;
  onFiles: (files: File[]) => void;
  onMerged: (handle: string, pageCount: number, fileName: string) => void;
  onResetFiles: () => void;
  onClosePreview: () => void;
  /** Main content area (thumbnail grid, file list, etc.). */
  children: JSX.Element;
  /** Right-side panel content (controls, options, action buttons). */
  panel?: JSX.Element;
  /** Title shown at top of the right panel. */
  panelTitle?: string;
  /** Remove padding from the main content area. */
  noPadding?: boolean;
}

/** Shared layout shell for PDF tool pages.
 *  When `panel` is provided, renders a two-zone layout:
 *  center (scrollable grid) + right panel (scrollable controls). */
export default function PdfToolLayout(props: Props) {
  return (
    <div class="h-full flex flex-col">
      <Show when={!props.handle() && !props.pendingFiles()}>
        <div class="flex-1 p-6">
          <DropZone onFiles={props.onFiles} accept=".pdf,application/pdf" multiple fill>
            <p class="text-sm text-gray-500">
              <span class="font-medium">Drop PDF files here</span> or click to browse
            </p>
          </DropZone>
        </div>
      </Show>

      <Show when={props.pendingFiles()}>
        {(files) => (
          <MergeStep
            files={files()}
            onMerged={props.onMerged}
            onStartOver={props.onResetFiles}
          />
        )}
      </Show>

      <Show when={props.handle()}>
        <div class="flex-1 flex min-h-0">
          {/* Center: main content (grid) */}
          <div class={`flex-1 flex flex-col overflow-y-auto${props.noPadding ? "" : " p-4"}`}>
            {props.children}
          </div>

          {/* Right panel */}
          <Show when={props.panel}>
            <aside class="w-80 shrink-0 border-l border-gray-200 bg-white flex flex-col">
              <Show when={props.panelTitle}>
                <div class="px-4 py-3 border-b border-gray-100 shrink-0">
                  <h3 class="text-sm font-medium text-gray-900">{props.panelTitle}</h3>
                </div>
              </Show>
              {props.panel}
            </aside>
          </Show>
        </div>
      </Show>

      <Show when={props.error()}>
        <div class="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mx-4 mb-2 text-sm">
          {props.error()}
        </div>
      </Show>

      <Show when={props.previewPage() != null && props.handle()}>
        <PagePreview
          pageIndex={props.previewPage()!}
          onClose={props.onClosePreview}
        />
      </Show>
    </div>
  );
}
