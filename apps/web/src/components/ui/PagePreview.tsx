import { onCleanup } from "solid-js";
import PdfViewer from "../PdfViewer";

interface Props {
  /** Page to scroll to on open */
  pageIndex: number;
  onClose: () => void;
}

/** Full-screen overlay that reuses PdfViewer in dark/bottomBar mode. */
export default function PagePreview(props: Props) {
  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") props.onClose();
  }
  document.addEventListener("keydown", handleKeyDown);
  onCleanup(() => document.removeEventListener("keydown", handleKeyDown));

  return (
    <div class="fixed top-0 right-0 bottom-0 z-40 bg-black/75 flex flex-col" style="left: 12rem;">
      <PdfViewer
        dark
        bottomBar
        initialPage={props.pageIndex}
        onClose={props.onClose}
      />
    </div>
  );
}
