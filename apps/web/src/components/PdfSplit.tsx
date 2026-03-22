import { createSignal, createMemo, For, onCleanup, Show } from "solid-js";
import * as pdfWorker from "../pdf-worker-client";
import { getRenderPool } from "../render-pool";
import DropZone from "./ui/DropZone";
import ThumbnailGrid from "./ui/ThumbnailGrid";
import MergeStep from "./ui/MergeStep";
import { useThumbnails } from "../hooks/useThumbnails";
import { groupToText, parseFullExpression, removePageFromSegmentText, compactSegment } from "../lib/page-ranges";

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
  /** Ordered list of 0-indexed page indices — order determines output page order */
  pages: number[];
}

let nextGroupId = 0;


export default function PdfSplit() {
  const [handle, setHandle] = createSignal<string | null>(null);
  const [fileName, setFileName] = createSignal("");
  const [pageCount, setPageCount] = createSignal(0);
  const [groups, setGroups] = createSignal<SplitGroup[]>([]);
  const [activeGroupId, setActiveGroupId] = createSignal<number | null>(null);
  const [visibleGroupIds, setVisibleGroupIds] = createSignal<Set<number>>(new Set<number>());
  const [rangeText, setRangeText] = createSignal("");
  const [splitting, setSplitting] = createSignal(false);
  const [error, setError] = createSignal("");
  const [pendingFiles, setPendingFiles] = createSignal<File[] | null>(null);

  const { thumbnails, loading: thumbsLoading, loadAll, updateVisiblePages } = useThumbnails(handle, pageCount);

  onCleanup(() => {
    const h = handle();
    if (h) pdfWorker.unloadDocument(h);
  });

  // Map from page index -> list of group indices it belongs to (deduplicated)
  const pageGroupsMap = createMemo(() => {
    const map = new Map<number, number[]>();
    groups().forEach((g, gIdx) => {
      const seen = new Set<number>();
      for (const p of g.pages) {
        if (seen.has(p)) continue;
        seen.add(p);
        const list = map.get(p);
        if (list) {
          if (!list.includes(gIdx)) list.push(gIdx);
        } else {
          map.set(p, [gIdx]);
        }
      }
    });
    return map;
  });

  /** Get the text segments split by comma, preserving original syntax */
  function getTextSegments(): string[] {
    return rangeText().split(",").map((s) => s.trim());
  }

  /** Replace a single group's text segment, compact it, and rejoin */
  function updateSegment(groupIdx: number, newSegment: string) {
    const segments = getTextSegments().filter((s) => s !== "");
    while (segments.length <= groupIdx) segments.push("");
    segments[groupIdx] = compactSegment(newSegment, pageCount());
    setRangeText(segments.filter((s) => s !== "").join(", "));
  }

  /** Append a page to a group's text segment, extending a trailing range if consecutive */
  function appendPageToSegment(groupIdx: number, page1: number) {
    const segments = getTextSegments().filter((s) => s !== "");
    const current = segments[groupIdx] ?? "";

    if (!current) {
      updateSegment(groupIdx, `${page1}`);
      return;
    }

    // Check if we can extend a trailing range/number
    // Match trailing number or range at end: ...+N or ...+N-M or just N or N-M
    const trailingMatch = current.match(/(^|.*\+)(\d+)(?:-(\d+))?$/);
    if (trailingMatch) {
      const prefix = trailingMatch[1]; // everything before the trailing part (including +)
      const trailStart = parseInt(trailingMatch[2], 10);
      const trailEnd = trailingMatch[3] ? parseInt(trailingMatch[3], 10) : trailStart;

      if (page1 === trailEnd + 1) {
        // Extend the trailing range
        const newTrail = `${trailStart}-${page1}`;
        updateSegment(groupIdx, `${prefix}${newTrail}`);
        return;
      }
    }

    // Otherwise just append +N
    updateSegment(groupIdx, `${current}+${page1}`);
  }

  /** Remove a page from a group — surgically edits the text, preserving slices */
  function removePageFromSegment(groupIdx: number, pageIndex: number, updatedPages: number[]) {
    const segments = getTextSegments().filter((s) => s !== "");
    const current = segments[groupIdx] ?? "";
    if (!current) {
      updateSegment(groupIdx, groupToText(updatedPages));
      return;
    }
    updateSegment(groupIdx, removePageFromSegmentText(current, pageIndex, pageCount(), updatedPages));
  }

  function syncRangeTextFromGroups() {
    setRangeText(groups().map((g) => groupToText(g.pages)).join(", "));
  }

  // Border color: use first visible group this page belongs to
  function pageColorClass(pageIndex: number): string | undefined {
    const gIdxList = pageGroupsMap().get(pageIndex);
    if (!gIdxList) return undefined;
    const visible = visibleGroupIds();
    const allGroups = groups();
    for (const gIdx of gIdxList) {
      if (visible.has(allGroups[gIdx].id)) {
        return GROUP_COLORS[gIdx % GROUP_COLORS.length].border;
      }
    }
    return undefined;
  }

  // Badge dots: show all groups this page belongs to
  function pageBadges(pageIndex: number): string[] {
    const gIdxList = pageGroupsMap().get(pageIndex);
    if (!gIdxList || gIdxList.length <= 1) return [];
    return gIdxList.map((gIdx) => GROUP_COLORS[gIdx % GROUP_COLORS.length].dot);
  }

  function resetState() {
    const prev = handle();
    if (prev) pdfWorker.unloadDocument(prev);
    setHandle(null);
    setFileName("");
    setPageCount(0);
    setGroups([]);
    setActiveGroupId(null);
    setVisibleGroupIds(new Set<number>());
    setRangeText("");
    setError("");
    setPendingFiles(null);
  }

  async function handleFiles(files: File[]) {
    if (!files.length) return;
    resetState();

    if (files.length > 1) {
      // Multiple files — show merge step first
      setPendingFiles(files);
      return;
    }

    // Single file — load directly
    const file = files[0];
    setFileName(file.name);
    try {
      const data = await file.arrayBuffer();
      const result = await pdfWorker.loadDocument(data);
      setHandle(result.handle);
      setPageCount(result.pageCount);
      addGroup();
      loadAll();
    } catch (err: any) {
      setError(err.message || "Failed to load PDF");
    }
  }

  function handleMerged(mergedHandle: string, mergedPageCount: number, mergedFileName: string) {
    setPendingFiles(null);
    setFileName(mergedFileName);
    setHandle(mergedHandle);
    setPageCount(mergedPageCount);
    addGroup();
    loadAll();
  }

  function addGroup() {
    const id = nextGroupId++;
    const group: SplitGroup = { id, pages: [] };
    setGroups((prev) => [...prev, group]);
    setActiveGroupId(id);
    setVisibleGroupIds(new Set([id]));
  }

  function removeGroup(id: number) {
    setGroups((prev) => prev.filter((g) => g.id !== id));
    setVisibleGroupIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    if (activeGroupId() === id) {
      const remaining = groups().filter((g) => g.id !== id);
      const newActive = remaining.length > 0 ? remaining[0].id : null;
      setActiveGroupId(newActive);
      if (newActive != null) setVisibleGroupIds(new Set([newActive]));
    }
    syncRangeTextFromGroups();
  }

  function handlePageClick(pageIndex: number, _e: MouseEvent) {
    const gId = activeGroupId();
    if (gId == null) return;

    const allGroups = groups();
    const groupIdx = allGroups.findIndex((g) => g.id === gId);
    if (groupIdx === -1) return;

    const group = allGroups[groupIdx];
    const isRemoving = group.pages.includes(pageIndex);

    setGroups((prev) =>
      prev.map((g) => {
        if (g.id !== gId) return g;
        if (isRemoving) {
          return { ...g, pages: g.pages.filter((p) => p !== pageIndex) };
        }
        return { ...g, pages: [...g.pages, pageIndex] };
      })
    );

    if (isRemoving) {
      removePageFromSegment(groupIdx, pageIndex, groups()[groupIdx].pages);
    } else {
      appendPageToSegment(groupIdx, pageIndex + 1); // +1 for 1-indexed display
    }
  }

  function applyRangeText() {
    const text = rangeText();
    if (!text.trim()) {
      setGroups((prev) => prev.map((g) => ({ ...g, pages: [] })));
      setError("");
      return;
    }
    const parsed = parseFullExpression(text, pageCount());
    if (!parsed) {
      setError("Invalid format. Use e.g. 1-3+5, 7-10, 1:20:2 (comma = group, + = same group, : = slice)");
      return;
    }
    setError("");

    // Rebuild groups to match parsed result — reuse existing group IDs, create new ones as needed
    setGroups((prev) => {
      const result: SplitGroup[] = [];
      for (let i = 0; i < parsed.length; i++) {
        const id = i < prev.length ? prev[i].id : nextGroupId++;
        result.push({ id, pages: parsed[i] });
      }
      return result;
    });
    // Make all groups visible and set first as active
    const currentGroups = groups();
    setVisibleGroupIds(new Set(currentGroups.map((g) => g.id)));
    if (currentGroups.length > 0 && !currentGroups.some((g) => g.id === activeGroupId())) {
      setActiveGroupId(currentGroups[0].id);
    }
  }

  /** Build contiguous ranges from ordered page list, preserving order. */
  function groupRanges(): { start: number; end: number }[][] {
    return groups()
      .filter((g) => g.pages.length > 0)
      .map((g) => {
        const pages = g.pages;
        const ranges: { start: number; end: number }[] = [];
        let start = pages[0];
        let prev = pages[0];
        for (let i = 1; i < pages.length; i++) {
          if (pages[i] === prev + 1) {
            prev = pages[i];
          } else {
            ranges.push({ start, end: prev + 1 });
            start = pages[i];
            prev = pages[i];
          }
        }
        ranges.push({ start, end: prev + 1 });
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

      // Ensure document is loaded in pool workers (may already be from thumbnails)
      const pool = getRenderPool();
      await pool.ensureLoaded(h, () => pdfWorker.getDocumentBytes(h));
      const allParts = await pool.splitPdfParallel(h, allRanges);

      for (let gi = 0; gi < allParts.length; gi++) {
        const parts = allParts[gi];
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
    groups().reduce((sum, g) => sum + g.pages.length, 0)
  );

  return (
    <div>
      <Show when={!handle() && !pendingFiles()}>
        <DropZone onFiles={handleFiles} accept=".pdf" multiple>
          <p class="text-sm text-gray-500">
            <span class="font-medium">Drop PDF files here</span> or click to browse
          </p>
        </DropZone>
      </Show>

      <Show when={pendingFiles()}>
        {(files) => (
          <MergeStep
            files={files()}
            onMerged={handleMerged}
            onStartOver={resetState}
          />
        )}
      </Show>

      <Show when={handle()}>
        <div class="mt-4">
          <div class="flex items-center justify-between mb-3">
            <p class="text-sm text-gray-600">
              {fileName()} — {pageCount()} pages
              {thumbsLoading() ? " (loading thumbnails...)" : ""}
            </p>
            <button
              onClick={resetState}
              class="text-xs text-gray-500 hover:underline"
            >
              Start over
            </button>
          </div>

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
                  const isVisible = () => visibleGroupIds().has(group.id);
                  return (
                    <button
                      onClick={(e) => {
                        if (e.metaKey || e.ctrlKey) {
                          // Toggle visibility, set active if making visible
                          setVisibleGroupIds((prev) => {
                            const next = new Set(prev);
                            if (next.has(group.id)) next.delete(group.id);
                            else next.add(group.id);
                            return next;
                          });
                          if (!visibleGroupIds().has(group.id)) {
                            // Was just toggled on
                            setActiveGroupId(group.id);
                          }
                        } else {
                          // Exclusive select
                          setActiveGroupId(group.id);
                          setVisibleGroupIds(new Set([group.id]));
                        }
                      }}
                      class={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                        isActive()
                          ? `${color().bg} ${color().text} ring-2 ring-offset-1 ring-current`
                          : isVisible()
                            ? `${color().bg} ${color().text}`
                            : `${color().bg} ${color().text} opacity-40 hover:opacity-70`
                      }`}
                    >
                      <span class={`w-2 h-2 rounded-full ${color().dot}`} />
                      Group {gIdx() + 1}
                      <span class="text-[10px] opacity-70">
                        ({group.pages.length})
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

            {/* Combined range input */}
            <div class="flex items-center gap-2">
              <input
                type="text"
                value={rangeText()}
                onInput={(e) => setRangeText(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") applyRangeText();
                }}
                placeholder="e.g. 1-3+5, 7-10, 1:20:2  (, = group  + = join  : = slice)"
                class="border border-gray-300 rounded px-2 py-1 text-sm flex-1 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <button
                onClick={() => applyRangeText()}
                class="text-xs text-blue-600 hover:underline shrink-0"
              >
                Apply
              </button>
            </div>
          </div>

          <p class="text-xs text-gray-400 mb-2">
            Click thumbnails to add to active group. {"\u2318"}+click groups to view multiple.
          </p>

          <ThumbnailGrid
            pageCount={pageCount()}
            thumbnails={thumbnails()}
            pageColorClass={pageColorClass}
            pageBadges={pageBadges}
            onPageClick={handlePageClick}
            onVisiblePagesChange={updateVisiblePages}
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
                  : `Split into ${groups().filter((g) => g.pages.length > 0).length} PDF${
                      groups().filter((g) => g.pages.length > 0).length !== 1 ? "s" : ""
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
