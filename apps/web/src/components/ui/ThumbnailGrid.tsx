import { For, onCleanup, onMount } from "solid-js";
import Thumbnail from "./Thumbnail";
import type { PageAction } from "./PageActions";
import type { PageOp } from "../../PdfContext";

interface Props {
  pageCount: number;
  thumbnails: Map<number, ImageData>;
  selectedPages?: Set<number>;
  /** Per-page color class override. If provided, takes precedence over selectedPages for styling. */
  pageColorClass?: (pageIndex: number) => string | undefined;
  /** Small colored dots for group membership indicators */
  pageBadges?: (pageIndex: number) => string[];
  /** Per-page action buttons shown on hover */
  pageActions?: PageAction[];
  /** Pending per-page operations (ordered list per page). */
  pendingOps?: Map<number, PageOp[]>;
  onPageClick?: (pageIndex: number, e: MouseEvent) => void;
  onPageDblClick?: (pageIndex: number, e: MouseEvent) => void;
  /** Called when the set of visible page indices changes (for render prioritization). */
  onVisiblePagesChange?: (visible: Set<number>) => void;
}

export default function ThumbnailGrid(props: Props) {
  let gridRef: HTMLDivElement | undefined;
  const elementToPage = new Map<Element, number>();
  const visibleSet = new Set<number>();
  let observer: IntersectionObserver | undefined;

  onMount(() => {
    if (!props.onVisiblePagesChange || !gridRef) return;

    observer = new IntersectionObserver(
      (entries) => {
        let changed = false;
        for (const entry of entries) {
          const pageIdx = elementToPage.get(entry.target);
          if (pageIdx == null) continue;
          if (entry.isIntersecting && !visibleSet.has(pageIdx)) {
            visibleSet.add(pageIdx);
            changed = true;
          } else if (!entry.isIntersecting && visibleSet.has(pageIdx)) {
            visibleSet.delete(pageIdx);
            changed = true;
          }
        }
        if (changed) {
          props.onVisiblePagesChange!(new Set(visibleSet));
        }
      },
      { root: null, rootMargin: "200px 0px", threshold: 0 }
    );
  });

  onCleanup(() => {
    observer?.disconnect();
  });

  function observeElement(el: HTMLDivElement, pageIndex: number) {
    elementToPage.set(el, pageIndex);
    observer?.observe(el);
  }

  return (
    <div ref={gridRef} class="grid grid-cols-4 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-8 gap-3">
      <For each={Array.from({ length: props.pageCount }, (_, i) => i)}>
        {(pageIndex) => {
          const colorClass = () => props.pageColorClass?.(pageIndex);
          const isSelected = () => colorClass() != null || (props.selectedPages?.has(pageIndex) ?? false);
          const badges = () => props.pageBadges?.(pageIndex) ?? [];
          return (
            <div ref={(el) => observeElement(el, pageIndex)}>
              <Thumbnail
                imageData={props.thumbnails.get(pageIndex)}
                pageIndex={pageIndex}
                selected={isSelected()}
                selectedClass={colorClass()}
                badges={badges()}
                actions={props.pageActions}
                pendingOps={props.pendingOps?.get(pageIndex)}
                onClick={(e) => props.onPageClick?.(pageIndex, e)}
                onDblClick={(e) => props.onPageDblClick?.(pageIndex, e)}
              />
            </div>
          );
        }}
      </For>
    </div>
  );
}
