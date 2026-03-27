import { onCleanup, onMount } from "solid-js";
import PdfViewer from "../PdfViewer";
import { useSharedPdf } from "../../PdfContext";

interface Props {
  /** Page to scroll to on open */
  pageIndex: number;
  onClose: () => void;
}

/** Full-screen overlay that reuses PdfViewer in dark mode. */
export default function PagePreview(props: Props) {
  const { setPreviewOpen } = useSharedPdf();

  onMount(() => setPreviewOpen(true));
  onCleanup(() => setPreviewOpen(false));

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") props.onClose();
  }
  document.addEventListener("keydown", handleKeyDown);
  onCleanup(() => document.removeEventListener("keydown", handleKeyDown));

  return (
    <div class="fixed top-0 left-0 right-0 bottom-[25px] z-40 bg-black/75 flex flex-col">
      {/* Close button */}
      <button
        onClick={props.onClose}
        class="absolute top-3 right-3 z-50 w-7 h-7 flex items-center justify-center rounded bg-black/50 text-red-400 hover:text-red-300 hover:bg-black/70 text-sm font-bold"
      >
        ✕
      </button>
      <PdfViewer
        dark
        initialPage={props.pageIndex}
      />
    </div>
  );
}
