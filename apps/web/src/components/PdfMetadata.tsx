import { createSignal, createEffect, Show, on } from "solid-js";
import * as pdfWorker from "../pdf-worker-client";
import DropZone from "./ui/DropZone";
import { useSharedPdf } from "../PdfContext";

export default function PdfMetadata() {
  const { sharedPdf, loadFile, loadFromBytes } = useSharedPdf();
  const [handle, setHandle] = createSignal<string | null>(null);
  const [fileName, setFileName] = createSignal("");
  const [title, setTitle] = createSignal("");
  const [author, setAuthor] = createSignal("");
  const [subject, setSubject] = createSignal("");
  const [keywords, setKeywords] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal("");
  const [success, setSuccess] = createSignal("");

  // Sync from shared PDF
  createEffect(on(sharedPdf, (pdf) => {
    if (pdf) {
      setHandle(pdf.handle);
      setFileName(pdf.fileName);
      setError("");
      setSuccess("");
      // Fetch metadata
      pdfWorker.getMetadata(pdf.handle).then((meta) => {
        setTitle(meta.title ?? "");
        setAuthor(meta.author ?? "");
        setSubject(meta.subject ?? "");
        setKeywords(meta.keywords ?? "");
      });
    } else {
      setHandle(null);
      setFileName("");
      setTitle("");
      setAuthor("");
      setSubject("");
      setKeywords("");
    }
  }));

  async function handleFiles(files: File[]) {
    const file = files[0];
    if (!file) return;
    setError("");
    setSuccess("");
    try {
      await loadFile(file);
    } catch (err: any) {
      setError(err.message || "Failed to load PDF");
    }
  }

  async function save() {
    const h = handle();
    if (!h) return;

    setSaving(true);
    setError("");
    setSuccess("");
    try {
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
    <div>
      <Show when={!handle()}>
        <DropZone onFiles={handleFiles} accept=".pdf">
          <p class="text-sm text-gray-500">
            <span class="font-medium">Drop a PDF here</span> or click to browse
          </p>
        </DropZone>
      </Show>

      <Show when={handle()}>
        <div class="mt-4 space-y-4 max-w-md">
          <p class="text-sm text-gray-600">{fileName()}</p>

          <Field label="Title" value={title()} onInput={setTitle} />
          <Field label="Author" value={author()} onInput={setAuthor} />
          <Field label="Subject" value={subject()} onInput={setSubject} />
          <Field label="Keywords" value={keywords()} onInput={setKeywords} />

          <button
            onClick={save}
            disabled={saving()}
            class="px-4 py-2 bg-blue-600 text-white rounded disabled:opacity-50 text-sm font-medium"
          >
            {saving() ? "Saving..." : "Save metadata"}
          </button>

          <Show when={success()}>
            <p class="text-sm text-green-600">{success()}</p>
          </Show>
        </div>
      </Show>

      <Show when={error()}>
        <div class="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mt-4 text-sm">
          {error()}
        </div>
      </Show>
    </div>
  );
}

function Field(props: {
  label: string;
  value: string;
  onInput: (v: string) => void;
}) {
  return (
    <div>
      <label class="block text-sm font-medium text-gray-700 mb-1">
        {props.label}
      </label>
      <input
        type="text"
        value={props.value}
        onInput={(e) => props.onInput(e.currentTarget.value)}
        class="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
      />
    </div>
  );
}
