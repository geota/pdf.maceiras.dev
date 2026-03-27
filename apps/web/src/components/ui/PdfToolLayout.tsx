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
  children: JSX.Element;
}

/** Shared layout shell for PDF tool pages (Split, Reorder, etc.). */
export default function PdfToolLayout(props: Props) {
  return (
    <div>
      <Show when={!props.handle() && !props.pendingFiles()}>
        <DropZone onFiles={props.onFiles} accept=".pdf" multiple>
          <p class="text-sm text-gray-500">
            <span class="font-medium">Drop PDF files here</span> or click to browse
          </p>
        </DropZone>
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
        {props.children}
      </Show>

      <Show when={props.error()}>
        <div class="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mt-4 text-sm">
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
