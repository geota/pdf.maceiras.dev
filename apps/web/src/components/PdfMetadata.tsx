import { createSignal, createEffect, Show, on } from "solid-js";
import * as pdfWorker from "../pdf-worker-client";
import PdfToolLayout from "./ui/PdfToolLayout";
import ThumbnailGrid from "./ui/ThumbnailGrid";
import { useThumbnails } from "../hooks/useThumbnails";
import { useSharedPdf } from "../PdfContext";
import { usePageActions } from "./ui/PageActions";
import { PanelLabel, PanelFooter } from "./ui/PanelControls";

export default function PdfMetadata() {
  const { sharedPdf, loadFile, loadFromBytes, flushOps } = useSharedPdf();
  const [handle, setHandle] = createSignal<string | null>(null);
  const [fileName, setFileName] = createSignal("");
  const [pageCount, setPageCount] = createSignal(0);
  const [title, setTitle] = createSignal("");
  const [author, setAuthor] = createSignal("");
  const [subject, setSubject] = createSignal("");
  const [keywords, setKeywords] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal("");
  const [success, setSuccess] = createSignal("");
  const [pendingFiles, setPendingFiles] = createSignal<File[] | null>(null);
  const [previewPage, setPreviewPage] = createSignal<number | null>(null);

  const pageActions = usePageActions();
  const { thumbnails, loadAll, updateVisiblePages } = useThumbnails(handle, pageCount);

  // Sync from shared PDF
  createEffect(on(sharedPdf, (pdf) => {
    if (pdf) {
      setHandle(pdf.handle);
      setFileName(pdf.fileName);
      setPageCount(pdf.pageCount);
      setError("");
      setSuccess("");
      loadAll();
      pdfWorker.getMetadata(pdf.handle).then((meta) => {
        setTitle(meta.title ?? "");
        setAuthor(meta.author ?? "");
        setSubject(meta.subject ?? "");
        setKeywords(meta.keywords ?? "");
      });
    } else {
      resetState();
    }
  }));

  function resetState() {
    setHandle(null);
    setFileName("");
    setPageCount(0);
    setTitle("");
    setAuthor("");
    setSubject("");
    setKeywords("");
    setError("");
    setSuccess("");
    setPendingFiles(null);
  }

  async function handleFiles(files: File[]) {
    const file = files[0];
    if (!file) return;
    resetState();
    setError("");
    try {
      await loadFile(file);
    } catch (err: any) {
      setError(err.message || "Failed to load PDF");
    }
  }

  function handleMerged(mergedHandle: string, mergedPageCount: number, mergedFileName: string) {
    setPendingFiles(null);
    setHandle(mergedHandle);
    setFileName(mergedFileName);
    setPageCount(mergedPageCount);
    loadAll();
  }

  async function save() {
    const h = handle();
    if (!h) return;

    setSaving(true);
    setError("");
    setSuccess("");
    try {
      await flushOps();
      const result = await pdfWorker.setMetadata(h, {
        title: title() || null,
        author: author() || null,
        subject: subject() || null,
        keywords: keywords() || null,
      });
      await loadFromBytes(result, fileName());
      setSuccess("Metadata updated.");
    } catch (err: any) {
      setError(err.message || "Failed to save metadata");
    } finally {
      setSaving(false);
    }
  }

  return (
    <PdfToolLayout
      handle={handle}
      error={error}
      pendingFiles={pendingFiles}
      previewPage={previewPage}
      onFiles={handleFiles}
      onMerged={handleMerged}
      onResetFiles={resetState}
      onClosePreview={() => setPreviewPage(null)}
      panelTitle="Metadata"
      panel={
        <div class="flex flex-col flex-1 min-h-0">
          <div class="flex-1 overflow-y-auto p-4 space-y-5">
            <Field label="Title" value={title()} onInput={setTitle} />
            <Field label="Author" value={author()} onInput={setAuthor} />
            <Field label="Subject" value={subject()} onInput={setSubject} />
            <Field label="Keywords" value={keywords()} onInput={setKeywords} />
          </div>

          <PanelFooter
            statusText={`${pageCount()} pages`}
            saving={saving()}
            onSave={save}
          >
            <Show when={success()}>
              <p class="text-xs text-green-600">{success()}</p>
            </Show>
          </PanelFooter>
        </div>
      }
    >
      <ThumbnailGrid
        pageCount={pageCount()}
        thumbnails={thumbnails()}
        pageActions={pageActions}
        onPageDblClick={(pageIndex) => setPreviewPage(pageIndex)}
        onVisiblePagesChange={updateVisiblePages}
      />
    </PdfToolLayout>
  );
}

function Field(props: {
  label: string;
  value: string;
  onInput: (v: string) => void;
}) {
  return (
    <div>
      <PanelLabel>{props.label}</PanelLabel>
      <input
        type="text"
        value={props.value}
        onInput={(e) => props.onInput(e.currentTarget.value)}
        class="w-full border border-gray-300 rounded px-3 py-1.5 text-sm mt-1 focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
    </div>
  );
}
