import { createSignal, JSX, Show } from "solid-js";

interface Props {
  onFiles: (files: File[]) => void;
  accept?: string;
  multiple?: boolean;
  children?: JSX.Element;
}

export default function DropZone(props: Props) {
  const [dragOver, setDragOver] = createSignal(false);
  let inputRef: HTMLInputElement | undefined;

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  }

  function handleDragLeave(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);

    const files = Array.from(e.dataTransfer?.files ?? []);
    const filtered = props.accept
      ? files.filter((f) => {
          const ext = "." + f.name.split(".").pop()?.toLowerCase();
          return props.accept!.split(",").some(
            (a) => a.trim() === f.type || a.trim() === ext
          );
        })
      : files;

    if (!props.multiple && filtered.length > 1) {
      props.onFiles([filtered[0]]);
    } else if (filtered.length > 0) {
      props.onFiles(filtered);
    }
  }

  function handleInput(e: Event) {
    const input = e.target as HTMLInputElement;
    if (input.files?.length) {
      props.onFiles(Array.from(input.files));
      input.value = "";
    }
  }

  return (
    <div
      onDragOver={handleDragOver}
      onDragEnter={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onClick={() => inputRef?.click()}
      class={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors ${
        dragOver()
          ? "border-blue-500 bg-blue-50"
          : "border-gray-300 hover:border-gray-400"
      }`}
    >
      <input
        ref={inputRef}
        type="file"
        accept={props.accept}
        multiple={props.multiple}
        onInput={handleInput}
        class="hidden"
      />
      <Show
        when={props.children}
        fallback={
          <div class="text-sm text-gray-500">
            <p class="font-medium">Drop PDF files here</p>
            <p class="mt-1">or click to browse</p>
          </div>
        }
      >
        {props.children}
      </Show>
    </div>
  );
}
