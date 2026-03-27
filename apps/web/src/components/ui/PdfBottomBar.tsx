import type { JSX } from "solid-js";

interface Props {
  /** Left-side info text */
  info: JSX.Element;
  /** Additional action buttons rendered before Download/Restart */
  extra?: JSX.Element;
  onDownload?: () => void;
  onRestart: () => void;
}

export default function PdfBottomBar(props: Props) {
  return (
    <div class="flex items-center justify-between px-3 py-1 border-t shrink-0 border-gray-200 bg-gray-50">
      <p class="text-xs text-gray-500">
        {props.info}
      </p>
      <div class="flex items-center gap-3">
        {props.extra}
        {props.onDownload && (
          <button
            onClick={props.onDownload}
            class="text-xs font-medium hover:underline text-blue-500 hover:text-blue-700"
          >
            Download
          </button>
        )}
        <button
          onClick={props.onRestart}
          class="text-xs font-medium hover:underline text-red-500 hover:text-red-700"
        >
          Restart
        </button>
      </div>
    </div>
  );
}
