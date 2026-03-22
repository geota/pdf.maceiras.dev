/** Format a single group's ordered pages for display.
 *  Consecutive ascending runs become ranges (1-3), everything else uses +. */
export function groupToText(pages: number[]): string {
  if (pages.length === 0) return "";
  const parts: string[] = [];
  let i = 0;
  while (i < pages.length) {
    let runEnd = i;
    while (runEnd + 1 < pages.length && pages[runEnd + 1] === pages[runEnd] + 1) {
      runEnd++;
    }
    if (runEnd > i) {
      parts.push(`${pages[i] + 1}-${pages[runEnd] + 1}`);
      i = runEnd + 1;
    } else {
      parts.push(`${pages[i] + 1}`);
      i++;
    }
  }
  return parts.join("+");
}

/** Resolve a possibly-negative 1-based index.
 *  Positive: used as-is (1 = first page). Negative: -1 = last page, -2 = second-to-last. */
export function resolveIndex(idx: number, maxPage: number): number {
  return idx < 0 ? maxPage + 1 + idx : idx;
}

/** Parse a slice expression like start:stop:step (1-indexed, stop is exclusive).
 *  Supports negative indices (-1 = last page). Returns pages in traversal order. */
export function parseSlice(text: string, maxPage: number): number[] | null {
  const parts = text.split(":").map((s) => s.trim());
  if (parts.length < 2 || parts.length > 3) return null;
  const step = parts.length === 3 && parts[2] ? parseInt(parts[2], 10) : 1;
  if (isNaN(step) || step === 0) return null;
  const rawStart = parts[0] ? parseInt(parts[0], 10) : undefined;
  const rawStop = parts[1] ? parseInt(parts[1], 10) : undefined;
  if (rawStart !== undefined && isNaN(rawStart)) return null;
  if (rawStop !== undefined && isNaN(rawStop)) return null;
  const start = rawStart !== undefined
    ? resolveIndex(rawStart, maxPage)
    : step > 0 ? 1 : maxPage;
  const stop = rawStop !== undefined
    ? resolveIndex(rawStop, maxPage)
    : step > 0 ? maxPage + 1 : 0;
  const pages: number[] = [];
  if (step > 0) {
    for (let i = start; i < stop && i <= maxPage; i += step) {
      if (i >= 1) pages.push(i - 1);
    }
  } else {
    for (let i = start; i > stop && i >= 1; i += step) {
      if (i <= maxPage) pages.push(i - 1);
    }
  }
  return pages;
}

/** Parse a single group segment (uses + for non-contiguous, - for ranges, : for slices).
 *  Returns an ordered array — order matters for the output PDF. */
export function parseGroupSegment(text: string, maxPage: number): number[] | null {
  const pages: number[] = [];
  for (const part of text.split("+")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (trimmed.includes(":")) {
      const slicePages = parseSlice(trimmed, maxPage);
      if (!slicePages) return null;
      pages.push(...slicePages);
    } else {
      const match = trimmed.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
      if (!match) return null;
      const start = parseInt(match[1], 10);
      const end = match[2] ? parseInt(match[2], 10) : start;
      if (start < 1 || end < start || end > maxPage) return null;
      for (let i = start - 1; i < end; i++) pages.push(i);
    }
  }
  return pages;
}

/** Check if a +-part is a range (N or N-M) that contains a 1-indexed page */
function rangeContains(part: string, page1: number): boolean {
  const match = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
  if (!match) return false;
  const start = parseInt(match[1], 10);
  const end = match[2] ? parseInt(match[2], 10) : start;
  return page1 >= start && page1 <= end;
}

/** Remove a page from a range part, returning replacement parts.
 *  e.g. "3-8" remove 5 → ["3-4", "6-8"], "3-8" remove 3 → ["4-8"], "5" remove 5 → [] */
function splitRange(part: string, page1: number): string[] {
  const match = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
  if (!match) return [part];
  const start = parseInt(match[1], 10);
  const end = match[2] ? parseInt(match[2], 10) : start;
  const result: string[] = [];
  // Left portion
  if (page1 > start) {
    result.push(page1 - 1 === start ? `${start}` : `${start}-${page1 - 1}`);
  }
  // Right portion
  if (page1 < end) {
    result.push(page1 + 1 === end ? `${end}` : `${page1 + 1}-${end}`);
  }
  return result;
}

/** Remove a 0-indexed page from a segment string, preserving slices and editing ranges.
 *  Falls back to full regeneration from resolvedPages only if the page is exclusively in slices. */
export function removePageFromSegmentText(
  segment: string,
  pageIndex: number,
  maxPage: number,
  resolvedPages: number[],
): string {
  const page1 = pageIndex + 1;
  const parts = segment.split("+");

  // First pass: try to find a non-slice part that contains this page
  for (let i = 0; i < parts.length; i++) {
    const trimmed = parts[i].trim();
    if (trimmed.includes(":")) continue; // skip slices
    if (!rangeContains(trimmed, page1)) continue;

    // Found it — split/remove this range part
    const replacement = splitRange(trimmed, page1);
    const newParts = [
      ...parts.slice(0, i),
      ...replacement,
      ...parts.slice(i + 1),
    ].filter((p) => p.trim() !== "");
    return newParts.join("+");
  }

  // Page is only in a slice — expand the slice that contains it, keep others intact
  for (let i = 0; i < parts.length; i++) {
    const trimmed = parts[i].trim();
    if (!trimmed.includes(":")) continue;
    const slicePages = parseSlice(trimmed, maxPage);
    if (!slicePages || !slicePages.includes(pageIndex)) continue;

    // Expand this slice without the removed page
    const filtered = slicePages.filter((p) => p !== pageIndex);
    const replacement = groupToText(filtered);
    const newParts = [
      ...parts.slice(0, i),
      ...(replacement ? [replacement] : []),
      ...parts.slice(i + 1),
    ].filter((p) => p.trim() !== "");
    return newParts.join("+");
  }

  // Fallback: regenerate entirely
  return groupToText(resolvedPages);
}

/** Compact a segment by sorting and merging non-slice parts.
 *  If no slices present, sorts all pages and produces the shortest form.
 *  If slices present, keeps slices intact and compacts only non-slice parts. */
export function compactSegment(segment: string, maxPage: number): string {
  const parts = segment.split("+").map((s) => s.trim()).filter((s) => s !== "");
  if (parts.length === 0) return "";

  const sliceParts: string[] = [];
  const nonSlicePages: number[] = [];

  for (const part of parts) {
    if (part.includes(":")) {
      sliceParts.push(part);
    } else {
      const match = part.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
      if (!match) continue;
      const start = parseInt(match[1], 10);
      const end = match[2] ? parseInt(match[2], 10) : start;
      for (let i = start - 1; i < end; i++) nonSlicePages.push(i);
    }
  }

  if (sliceParts.length === 0) {
    // No slices — sort, deduplicate, and compact everything
    const unique = [...new Set(nonSlicePages)].sort((a, b) => a - b);
    return groupToText(unique);
  }

  // Has slices — remove pages already covered by slices from non-slice pool, then compact the rest
  const slicePageSet = new Set<number>();
  for (const sp of sliceParts) {
    const resolved = parseSlice(sp, maxPage);
    if (resolved) for (const p of resolved) slicePageSet.add(p);
  }
  const remaining = [...new Set(nonSlicePages)]
    .filter((p) => !slicePageSet.has(p))
    .sort((a, b) => a - b);
  const compactedNonSlice = groupToText(remaining);

  const result = [...sliceParts, ...(compactedNonSlice ? [compactedNonSlice] : [])];
  return result.join("+");
}

/** Parse full expression: comma separates groups, + separates ranges within a group */
export function parseFullExpression(text: string, maxPage: number): number[][] | null {
  const groups: number[][] = [];
  for (const segment of text.split(",")) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    const pages = parseGroupSegment(trimmed, maxPage);
    if (!pages) return null;
    if (pages.length > 0) groups.push(pages);
  }
  return groups;
}
