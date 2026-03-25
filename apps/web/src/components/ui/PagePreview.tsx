import { createSignal, onCleanup } from "solid-js";
import DocumentViewer from "./DocumentViewer";
import PdfBottomBar from "./PdfBottomBar";
import { useSharedPdf } from "../../PdfContext";
import { formatSize } from "../../lib/format";

interface Props {
  handle: string;
  fileName: string;
  pageCount: number;
  /** Page to scroll to on open */
  pageIndex: number;
  onClose: () => void;
}

export default function PagePreview(props: Props) {
  const { sharedPdf, download } = useSharedPdf();
  const [activePage, setActivePage] = createSignal(props.pageIndex);

  // Escape to close
  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") props.onClose();
  }
  document.addEventListener("keydown", handleKeyDown);
  onCleanup(() => document.removeEventListener("keydown", handleKeyDown));

  return (
    <div class="fixed top-0 right-0 bottom-0 z-40 bg-black/75 flex flex-col" style="left: 12rem;">
      <DocumentViewer
        handle={props.handle}
        pageCount={props.pageCount}
        initialPage={props.pageIndex}
        onActivePageChange={setActivePage}
        theme="dark"
      />

      <PdfBottomBar
        dark
        info={<>
          {props.fileName}
          {" — "}
          Page {activePage() + 1} of {props.pageCount}
          {sharedPdf()?.fileSize ? <>{" \u00b7 "}{formatSize(sharedPdf()!.fileSize)}</> : null}
        </>}
        onDownload={download}
        onClose={props.onClose}
      />
    </div>
  );
}
