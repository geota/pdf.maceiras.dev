import { createSignal, createMemo, For, onCleanup, Show } from "solid-js";
import * as pdfWorker from "../pdf-worker-client";
import DropZone from "./ui/DropZone";
import ThumbnailGrid from "./ui/ThumbnailGrid";
import { useThumbnails } from "../hooks/useThumbnails";

// Colors for groups — border + ring classes
const GROUP_COLORS = [
  { border: "border-blue-500 ring-2 ring-blue-300", bg: "bg-blue-100", text: "text-blue-700", dot: "bg-blue-500", label: "Blue" },
  { border: "border-emerald-500 ring-2 ring-emerald-300", bg: "bg-emerald-100", text: "text-emerald-700", dot: "bg-emerald-500", label: "Green" },
  { border: "border-orange-500 ring-2 ring-orange-300", bg: "bg-orange-100", text: "text-orange-700", dot: "bg-orange-500", label: "Orange" },
  { border: "border-purple-500 ring-2 ring-purple-300", bg: "bg-purple-100", text: "text-purple-700", dot: "bg-purple-500", label: "Purple" },
  { border: "border-pink-500 ring-2 ring-pink-300", bg: "bg-pink-100", text: "text-pink-700", dot: "bg-pink-500", label: "Pink" },
  { border: "border-cyan-500 ring-2 ring-cyan-300", bg: "bg-cyan-100", text: "text-cyan-700", dot: "bg-cyan-500", label: "Cyan" },
  { border: "border-amber-500 ring-2 ring-amber-300", bg: "bg-amber-100", text: "text-amber-700", dot: "bg-amber-500", label: "Amber" },
  { border: "border-rose-500 ring-2 ring-rose-300", bg: "bg-rose-100", text: "text-rose-700", dot: "bg-rose-500", label: "Rose" },
];

interface SplitGroup {
  id: number;
  pages: Set<number>;
  rangeText: string;
}

let nextGroupId = 0;

function pagesToRangeText(pages: Set<number>): string {
  const sorted = [...pages].sort((a, b) => a - b);
  if (sorted.length === 0) return "";
  const parts: string[] = [];
  let start = sorted[0];
  let end = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === end + 1) {
      end = sorted[i];
    } else {
      parts.push(start === end ? `${start + 1}` : `${start + 1}-${end + 1}`);
      start = sorted[i];
      end = sorted[i];
    }
  }
  parts.push(start === end ? `${start + 1}` : `${start + 1}-${end + 1}`);
  return parts.join(", ");
}

function parseRangeText(text: string, maxPage: number): Set<number> | null {
  const pages = new Set<number>();
  for (const part of text.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!match) return null;
    const start = parseInt(match[1], 10);
    const end = match[2] ? parseInt(match[2], 10) : start;
    if (start < 1 || end < start || end > maxPage) return null;
    for (let i = start - 1; i < end; i++) pages.add(i);
  }
  return pages;
}

export default function PdfSplit() {
  const [handle, setHandle] = createSignal<string | null>(null);
  const [fileName, setFileName] = createSignal("");
  const [pageCount, setPageCount] = createSignal(0);
  const [groups, setGroups] = createSignal<SplitGroup[]>([]);
  const [activeGroupId, setActiveGroupId] = createSignal<number | null>(null);
  const [splitting, setSplitting] = createSignal(false);
  const [error, setError] = createSignal("");

  const { thumbnails, loading: thumbsLoading, loadAll } = useThumbnails(handle, pageCount);

  onCleanup(() => {
    const h = handle();
    if (h) pdfWorker.unloadDocument(h);
  });

  // Map from page index -> group index (for coloring)
  const pageGroupMap = createMemo(() => {
    const map = new Map<number, number>();
    groups().forEach((g, gIdx) => {
      for (const p of g.pages) map.set(p, gIdx);
    });
    return map;
  });

  function pageColorClass(pageIndex: number): string | undefined {
    const gIdx = pageGroupMap().get(pageIndex);
    if (gIdx == null) return undefined;
    return GROUP_COLORS[gIdx % GROUP_COLORS.length].border;
  }

  async function handleFiles(files: File[]) {
    const file = files[0];
    if (!file) return;

    const prev = handle();
    if (prev) pdfWorker.unloadDocument(prev);

    setError("");
    setFileName(file.name);
    setGroups([]);
    setActiveGroupId(null);

    try {
      const data = await file.arrayBuffer();
      const result = await pdfWorker.loadDocument(data);
      setHandle(result.handle);
      setPageCount(result.pageCount);
      addGroup(); // start with one group
      loadAll();
    } catch (err: any) {
      setError(err.message || "Failed to load PDF");
    }
  }

  function addGroup() {
    const id = nextGroupId++;
    const group: SplitGroup = { id, pages: new Set(), rangeText: "" };
    setGroups((prev) => [...prev, group]);
    setActiveGroupId(id);
  }

  function removeGroup(id: number) {
    setGroups((prev) => prev.filter((g) => g.id !== id));
    if (activeGroupId() === id) {
      const remaining = groups().filter((g) => g.id !== id);
      setActiveGroupId(remaining.length > 0 ? remaining[0].id : null);
    }
  }

  function handlePageClick(pageIndex: number, _e: MouseEvent) {
    const gId = activeGroupId();
    if (gId == null) return;

    // Check if page is already in another group — remove it from there first
    setGroups((prev) =>
      prev.map((g) => {
        if (g.id === gId) {
          const next = new Set(g.pages);
          if (next.has(pageIndex)) next.delete(pageIndex);
          else next.add(pageIndex);
          return { ...g, pages: next, rangeText: pagesToRangeText(next) };
        }
        if (g.pages.has(pageIndex)) {
          const next = new Set(g.pages);
          next.delete(pageIndex);
          return { ...g, pages: next, rangeText: pagesToRangeText(next) };
        }
        return g;
      })
    );
  }

  function updateGroupRangeText(id: number, text: string) {
    setGroups((prev) =>
      prev.map((g) => (g.id === id ? { ...g, rangeText: text } : g))
    );
  }

  function applyRangeText(id: number) {
    const group = groups().find((g) => g.id === id);
    if (!group) return;
    const pages = parseRangeText(group.rangeText, pageCount());
    if (!pages) {
      setError("Invalid range format. Use e.g. 1-3, 5, 7-10");
      return;
    }
    setError("");

    // Remove these pages from other groups, then set on this group
    setGroups((prev) =>
      prev.map((g) => {
        if (g.id === id) {
          return { ...g, pages, rangeText: pagesToRangeText(pages) };
        }
        // Remove overlapping pages from other groups
        const cleaned = new Set([...g.pages].filter((p) => !pages.has(p)));
        if (cleaned.size !== g.pages.size) {
          return { ...g, pages: cleaned, rangeText: pagesToRangeText(cleaned) };
        }
        return g;
      })
    );
  }

  function groupRanges(): { start: number; end: number }[][] {
    return groups()
      .filter((g) => g.pages.size > 0)
      .map((g) => {
        const sorted = [...g.pages].sort((a, b) => a - b);
        const ranges: { start: number; end: number }[] = [];
        let start = sorted[0];
        let end = sorted[0];
        for (let i = 1; i < sorted.length; i++) {
          if (sorted[i] === end + 1) {
            end = sorted[i];
          } else {
            ranges.push({ start, end: end + 1 });
            start = sorted[i];
            end = sorted[i];
          }
        }
        ranges.push({ start, end: end + 1 });
        return ranges;
      });
  }

  async function split() {
    const h = handle();
    if (!h) return;

    const allRanges = groupRanges();
    if (allRanges.length === 0) {
      setError("No pages selected in any group");
      return;
    }

    setSplitting(true);
    setError("");
    try {
      const baseName = fileName().replace(/\.pdf$/i, "");
      for (let gi = 0; gi < allRanges.length; gi++) {
        const ranges = allRanges[gi];
        const parts = await pdfWorker.splitPdf(h, ranges);
        // If a group has non-contiguous pages, each sub-range is a separate part
        // Merge them conceptually by downloading each
        if (parts.length === 1) {
          downloadBlob(parts[0], `${baseName}_group${gi + 1}.pdf`);
        } else {
          parts.forEach((part: ArrayBuffer, ri: number) => {
            downloadBlob(part, `${baseName}_group${gi + 1}_part${ri + 1}.pdf`);
          });
        }
      }
    } catch (err: any) {
      setError(err.message || "Split failed");
    } finally {
      setSplitting(false);
    }
  }

  function downloadBlob(data: ArrayBuffer, filename: string) {
    const blob = new Blob([data], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  const totalSelected = createMemo(() =>
    groups().reduce((sum, g) => sum + g.pages.size, 0)
  );

  return (
    <div>
      <DropZone onFiles={handleFiles} accept=".pdf">
        <p class="text-sm text-gray-500">
          <span class="font-medium">Drop a PDF here</span> or click to browse
        </p>
      </DropZone>

      <Show when={handle()}>
        <div class="mt-4">
          <p class="text-sm text-gray-600 mb-3">
            {fileName()} — {pageCount()} pages
            {thumbsLoading() ? " (loading thumbnails...)" : ""}
          </p>

          {/* Group controls */}
          <div class="mb-4 space-y-2">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="text-xs font-medium text-gray-500 uppercase tracking-wide">
                Groups:
              </span>
              <For each={groups()}>
                {(group, gIdx) => {
                  const color = () => GROUP_COLORS[gIdx() % GROUP_COLORS.length];
                  const isActive = () => activeGroupId() === group.id;
                  return (
                    <button
                      onClick={() => setActiveGroupId(group.id)}
                      class={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                        isActive()
                          ? `${color().bg} ${color().text} ring-2 ring-offset-1 ring-current`
                          : `${color().bg} ${color().text} opacity-60 hover:opacity-100`
                      }`}
                    >
                      <span class={`w-2 h-2 rounded-full ${color().dot}`} />
                      Group {gIdx() + 1}
                      <span class="text-[10px] opacity-70">
                        ({group.pages.size})
                      </span>
                      <Show when={groups().length > 1}>
                        <span
                          onClick={(e) => {
                            e.stopPropagation();
                            removeGroup(group.id);
                          }}
                          class="ml-0.5 hover:opacity-100 opacity-50 cursor-pointer"
                        >
                          x
                        </span>
                      </Show>
                    </button>
                  );
                }}
              </For>
              <button
                onClick={addGroup}
                disabled={groups().length >= GROUP_COLORS.length}
                class="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-gray-200 text-gray-600 hover:bg-gray-300 disabled:opacity-30"
              >
                + Add group
              </button>
            </div>

            {/* Range text input for active group */}
            <Show when={activeGroupId() != null}>
              {(() => {
                const group = () => groups().find((g) => g.id === activeGroupId());
                const gIdx = () => groups().findIndex((g) => g.id === activeGroupId());
                const color = () => GROUP_COLORS[gIdx() % GROUP_COLORS.length];
                return (
                  <Show when={group()}>
                    <div class="flex items-center gap-2">
                      <span class={`w-2 h-2 rounded-full shrink-0 ${color().dot}`} />
                      <input
                        type="text"
                        value={group()!.rangeText}
                        onInput={(e) =>
                          updateGroupRangeText(activeGroupId()!, e.currentTarget.value)
                        }
                        onKeyDown={(e) => {
                          if (e.key === "Enter") applyRangeText(activeGroupId()!);
                        }}
                        placeholder="e.g. 1-3, 5, 7-10"
                        class="border border-gray-300 rounded px-2 py-1 text-sm w-48 focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                      <button
                        onClick={() => applyRangeText(activeGroupId()!)}
                        class="text-xs text-blue-600 hover:underline"
                      >
                        Apply
                      </button>
                      <span class="text-xs text-gray-400">
                        or click thumbnails below
                      </span>
                    </div>
                  </Show>
                );
              })()}
            </Show>
          </div>

          <ThumbnailGrid
            pageCount={pageCount()}
            thumbnails={thumbnails()}
            pageColorClass={pageColorClass}
            onPageClick={handlePageClick}
          />

          <Show when={totalSelected() > 0}>
            <div class="mt-4">
              <button
                onClick={split}
                disabled={splitting()}
                class="px-4 py-2 bg-green-600 text-white rounded disabled:opacity-50 text-sm font-medium"
              >
                {splitting()
                  ? "Splitting..."
                  : `Split into ${groups().filter((g) => g.pages.size > 0).length} PDF${
                      groups().filter((g) => g.pages.size > 0).length !== 1 ? "s" : ""
                    }`}
              </button>
            </div>
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
