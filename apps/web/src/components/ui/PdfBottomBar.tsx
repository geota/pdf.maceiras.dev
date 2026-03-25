import type { JSX } from "solid-js";

interface Props {
  /** Left-side info text */
  info: JSX.Element;
  /** Dark theme for overlays */
  dark?: boolean;
  /** Additional action buttons rendered before Download/Close */
  extra?: JSX.Element;
  onDownload?: () => void;
  onClose: () => void;
}

export default function PdfBottomBar(props: Props) {
  const borderColor = () => props.dark ? "border-gray-700" : "border-gray-200";
  const bgColor = () => props.dark ? "bg-gray-900/90" : "bg-gray-50";
  const textColor = () => props.dark ? "text-gray-400" : "text-gray-500";
  const downloadHover = () => props.dark ? "text-blue-400 hover:text-blue-300" : "text-blue-500 hover:text-blue-700";
  const closeHover = () => props.dark ? "text-red-400 hover:text-red-300" : "text-red-500 hover:text-red-700";

  return (
    <div class={`flex items-center justify-between px-3 py-1 border-t shrink-0 ${borderColor()} ${bgColor()}`}>
      <p class={`text-xs ${textColor()}`}>
        {props.info}
      </p>
      <div class="flex items-center gap-3">
        {props.extra}
        {props.onDownload && (
          <button
            onClick={props.onDownload}
            class={`text-xs font-medium hover:underline ${downloadHover()}`}
          >
            Download
          </button>
        )}
        <button
          onClick={props.onClose}
          class={`text-xs font-medium hover:underline ${closeHover()}`}
        >
          Close
        </button>
      </div>
    </div>
  );
}
