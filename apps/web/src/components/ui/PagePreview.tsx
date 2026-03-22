import { createSignal, onCleanup } from "solid-js";
import DocumentViewer from "./DocumentViewer";

interface Props {
  handle: string;
  pageCount: number;
  /** Page to scroll to on open */
  pageIndex: number;
  onClose: () => void;
}

export default function PagePreview(props: Props) {
  const [activePage, setActivePage] = createSignal(props.pageIndex);

  // Escape to close
  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") props.onClose();
  }
  document.addEventListener("keydown", handleKeyDown);
  onCleanup(() => document.removeEventListener("keydown", handleKeyDown));

  return (
    <div class="fixed top-0 right-0 bottom-0 z-40 bg-black/75 flex flex-col" style="left: 12rem;">
      {/* Header */}
      <div class="flex items-center justify-between px-4 py-2 bg-gray-900/90 shrink-0">
        <span class="text-white text-sm">
          Page {activePage() + 1} of {props.pageCount}
        </span>
        <button
          onClick={props.onClose}
          class="text-gray-400 hover:text-white transition-colors p-1"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <DocumentViewer
        handle={props.handle}
        pageCount={props.pageCount}
        initialPage={props.pageIndex}
        onActivePageChange={setActivePage}
        theme="dark"
      />
    </div>
  );
}
