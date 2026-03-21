import { createSignal } from "solid-js";

export function useSelection() {
  const [selected, setSelected] = createSignal<Set<number>>(new Set());
  let lastClicked: number | null = null;

  function handleSelect(index: number, e: MouseEvent) {
    const isMeta = e.metaKey || e.ctrlKey;
    const isShift = e.shiftKey;

    setSelected((prev) => {
      const next = new Set(prev);

      if (isShift && lastClicked !== null) {
        // Range select from lastClicked to index
        const start = Math.min(lastClicked, index);
        const end = Math.max(lastClicked, index);
        for (let i = start; i <= end; i++) {
          next.add(i);
        }
      } else if (isMeta) {
        // Toggle single item
        if (next.has(index)) {
          next.delete(index);
        } else {
          next.add(index);
        }
      } else {
        // Single select — replace selection
        next.clear();
        next.add(index);
      }

      return next;
    });

    lastClicked = index;
  }

  function selectAll(count: number) {
    const all = new Set<number>();
    for (let i = 0; i < count; i++) all.add(i);
    setSelected(all);
  }

  function clearSelection() {
    setSelected(new Set<number>());
    lastClicked = null;
  }

  function selectRange(start: number, end: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (let i = start; i <= end; i++) {
        next.add(i);
      }
      return next;
    });
  }

  return { selected, handleSelect, selectAll, clearSelection, selectRange };
}
