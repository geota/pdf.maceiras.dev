import { Show } from "solid-js";
import { formatSize } from "../../lib/format";

const PT_TO_MM = 25.4 / 72;

export interface PageImageStats {
  image_count: number;
  max_dpi: number | null;
  estimated_jpeg_quality: number | null;
  estimated_image_bytes: number;
}

interface Props {
  fileName: string;
  pageCount: number;
  fileSize?: number;
  /** When set, shows "Page N of M" instead of "M pages". */
  activePage?: number;
  /** Active page dimensions in PDF points — shown as mm. */
  pageDims?: [number, number] | null;
  /** Per-page image stats (shown when viewing a single page). */
  pageStats?: PageImageStats | null;
}

/** Shared status line used in both the main bottom bar and PagePreview overlay. */
export default function PdfStatusInfo(props: Props) {
  return (
    <>
      {props.fileName}
      {" — "}
      {props.activePage != null
        ? <>Page {props.activePage + 1} of {props.pageCount}</>
        : <>{props.pageCount} page{props.pageCount !== 1 ? "s" : ""}</>
      }
      <Show when={props.pageDims}>
        {" \u00b7 "}
        {Math.round(props.pageDims![0] * PT_TO_MM)} × {Math.round(props.pageDims![1] * PT_TO_MM)} mm
      </Show>
      <Show when={props.pageStats}>
        {(stats) => (
          <>
            <Show when={stats().image_count > 0}>
              {" \u00b7 "}
              {stats().image_count} image{stats().image_count !== 1 ? "s" : ""}
              <Show when={stats().max_dpi != null}>
                {" @ "}{Math.round(stats().max_dpi!)} DPI
              </Show>
              <Show when={stats().estimated_image_bytes > 0}>
                {" ("}{formatSize(stats().estimated_image_bytes)}{")"}
              </Show>
            </Show>
            <Show when={stats().image_count === 0}>
              {" \u00b7 "}no images
            </Show>
          </>
        )}
      </Show>
      <Show when={props.fileSize}>
        {" \u00b7 "}
        {formatSize(props.fileSize!)}
      </Show>
    </>
  );
}
