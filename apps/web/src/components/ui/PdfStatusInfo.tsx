import { Show } from "solid-js";
import { formatSize } from "../../lib/format";

const PT_TO_MM = 25.4 / 72;

interface Props {
  fileName: string;
  pageCount: number;
  fileSize?: number;
  /** When set, shows "Page N of M" instead of "M pages". */
  activePage?: number;
  /** Active page dimensions in PDF points — shown as mm. */
  pageDims?: [number, number] | null;
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
      <Show when={props.fileSize}>
        {" \u00b7 "}
        {formatSize(props.fileSize!)}
      </Show>
    </>
  );
}
