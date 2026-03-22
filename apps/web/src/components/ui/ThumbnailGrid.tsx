import { For } from "solid-js";
import Thumbnail from "./Thumbnail";

interface Props {
  pageCount: number;
  thumbnails: Map<number, ImageData>;
  selectedPages?: Set<number>;
  /** Per-page color class override. If provided, takes precedence over selectedPages for styling. */
  pageColorClass?: (pageIndex: number) => string | undefined;
  onPageClick?: (pageIndex: number, e: MouseEvent) => void;
}

export default function ThumbnailGrid(props: Props) {
  return (
    <div class="grid grid-cols-4 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-8 gap-3">
      <For each={Array.from({ length: props.pageCount }, (_, i) => i)}>
        {(pageIndex) => {
          const colorClass = props.pageColorClass?.(pageIndex);
          const isSelected = colorClass != null || (props.selectedPages?.has(pageIndex) ?? false);
          return (
            <Thumbnail
              imageData={props.thumbnails.get(pageIndex)}
              pageIndex={pageIndex}
              selected={isSelected}
              selectedClass={colorClass}
              onClick={(e) => props.onPageClick?.(pageIndex, e)}
            />
          );
        }}
      </For>
    </div>
  );
}
