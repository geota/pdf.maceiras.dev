import { Show, type JSX } from "solid-js";

// ─── Full-width button (single-select or toggle) ───────────────────────────

interface PanelButtonProps {
  active: boolean;
  label: string;
  description?: string;
  /** Small badge text shown after label, e.g. "limited support" */
  badge?: string;
  onClick: () => void;
  disabled?: boolean;
}

export function PanelButton(props: PanelButtonProps) {
  return (
    <button
      onClick={props.onClick}
      class="w-full text-left px-3 py-2 rounded border transition-colors"
      classList={{
        "bg-blue-600 border-blue-600": props.active,
        "bg-white border-gray-300 hover:bg-gray-50": !props.active,
        "opacity-40 pointer-events-none": props.disabled,
      }}
    >
      <div class="flex items-center gap-2">
        <span
          class="text-xs font-medium"
          classList={{ "text-white": props.active, "text-gray-700": !props.active }}
        >
          {props.label}
        </span>
        <Show when={props.badge}>
          <span class="text-[10px] text-amber-500">{props.badge}</span>
        </Show>
      </div>
      <Show when={props.description}>
        <div
          class="text-[10px] mt-0.5 truncate"
          classList={{
            "text-blue-200": props.active,
            "text-gray-400": !props.active,
          }}
        >
          {props.description}
        </div>
      </Show>
    </button>
  );
}

// ─── Full-width button with inline number input ────────────────────────────

interface PanelInputRowProps {
  label: string;
  suffix?: string;
  value: string;
  onInput: (v: string) => void;
  /** If provided, row is toggleable. Clicking label area toggles; clicking input auto-activates. */
  active?: boolean;
  onToggle?: () => void;
  min?: string;
  max?: string;
  step?: string;
  disabled?: boolean;
}

export function PanelInputRow(props: PanelInputRowProps) {
  const isToggle = () => props.onToggle !== undefined;
  const isActive = () => (isToggle() ? props.active! : true);
  const isBlue = () => isToggle() && isActive();

  function handleClick() {
    if (isToggle()) props.onToggle!();
  }

  function handleInputClick(e: MouseEvent) {
    e.stopPropagation();
    if (isToggle() && !isActive()) props.onToggle!();
  }

  return (
    <div
      onClick={isToggle() ? handleClick : undefined}
      class="w-full flex items-center px-3 py-2 rounded border transition-colors"
      classList={{
        "bg-blue-600 border-blue-600": isBlue(),
        "bg-white border-gray-300": !isBlue() && !props.disabled,
        "hover:bg-gray-50 cursor-pointer": isToggle() && !isBlue() && !props.disabled,
        "cursor-pointer": isToggle() && isBlue(),
        "opacity-40 pointer-events-none": props.disabled,
      }}
    >
      <span
        class="text-xs font-medium flex-1"
        classList={{
          "text-white": isBlue(),
          "text-gray-700": !isBlue(),
        }}
      >
        {props.label}
        <Show when={props.suffix}>
          <span classList={{ "text-blue-200": isBlue(), "text-gray-400": !isBlue() }}>{" "}({props.suffix})</span>
        </Show>
      </span>
      <input
        type="number"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onInput={(e) => {
          e.stopPropagation();
          props.onInput(e.currentTarget.value);
        }}
        onClick={handleInputClick}
        class="w-16 border rounded px-2 py-0.5 text-xs text-right focus:outline-none focus:ring-1 focus:ring-blue-400 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
        classList={{
          "border-blue-400 bg-blue-500 text-white": isBlue(),
          "border-gray-300 bg-white text-gray-700": !isBlue(),
        }}
      />
    </div>
  );
}

// ─── Segmented control (two exclusive options) ─────────────────────────────

interface SegmentedControlProps {
  options: [string, string];
  active: number;
  onChange: (idx: number) => void;
}

export function SegmentedControl(props: SegmentedControlProps) {
  return (
    <div class="flex rounded border border-gray-300 overflow-hidden">
      <button
        onClick={() => props.onChange(0)}
        class="flex-1 py-1.5 text-xs font-medium transition-colors"
        classList={{
          "bg-gray-800 text-white": props.active === 0,
          "bg-white text-gray-600 hover:bg-gray-50": props.active !== 0,
        }}
      >
        {props.options[0]}
      </button>
      <div class="w-px bg-gray-300" />
      <button
        onClick={() => props.onChange(1)}
        class="flex-1 py-1.5 text-xs font-medium transition-colors"
        classList={{
          "bg-gray-800 text-white": props.active === 1,
          "bg-white text-gray-600 hover:bg-gray-50": props.active !== 1,
        }}
      >
        {props.options[1]}
      </button>
    </div>
  );
}

// ─── Section label ─────────────────────────────────────────────────────────

export function PanelLabel(props: { children: JSX.Element }) {
  return <label class="text-xs font-medium text-gray-500 block">{props.children}</label>;
}

// ─── Panel footer: page count + select all/clear + save button ─────────────

interface PanelFooterProps {
  /** Left-side status text, e.g. "12/20 pages" */
  statusText: string;
  saving: boolean;
  disabled?: boolean;
  onSave: () => void;
  onSelectAll?: () => void;
  onClearSelection?: () => void;
  allSelected?: boolean;
  /** Extra content above the save button (progress, results, etc.) */
  children?: JSX.Element;
}

export function PanelFooter(props: PanelFooterProps) {
  return (
    <div class="p-4 border-t border-gray-100 space-y-3">
      {props.children}
      <div class="flex items-center justify-between text-xs text-gray-400">
        <span>{props.statusText}</span>
        <Show when={props.onSelectAll && props.onClearSelection}>
          <Show when={!props.allSelected}>
            <span class="text-blue-500 hover:underline cursor-pointer" onClick={props.onSelectAll}>Select All</span>
          </Show>
          <Show when={props.allSelected}>
            <span class="hover:underline cursor-pointer" onClick={props.onClearSelection}>Clear Selection</span>
          </Show>
        </Show>
      </div>
      <button
        onClick={props.onSave}
        disabled={props.disabled || props.saving}
        class="w-full py-2 bg-blue-600 text-white rounded text-sm font-medium disabled:opacity-40"
      >
        {props.saving ? "Saving..." : "Save"}
      </button>
    </div>
  );
}

// ─── Expression input with Apply button ────────────────────────────────────

interface ExpressionInputProps {
  value: string;
  onInput: (v: string) => void;
  onApply: () => void;
  placeholder: string;
  hint: string;
}

export function ExpressionInput(props: ExpressionInputProps) {
  return (
    <div class="space-y-1.5">
      <PanelLabel>Expression</PanelLabel>
      <input
        type="text"
        value={props.value}
        onInput={(e) => props.onInput(e.currentTarget.value)}
        onKeyDown={(e) => { if (e.key === "Enter") props.onApply(); }}
        placeholder={props.placeholder}
        class="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
      <button
        onClick={props.onApply}
        class="w-full py-1.5 text-xs font-medium text-blue-600 border border-gray-300 rounded hover:bg-gray-50"
      >
        Apply
      </button>
      <p class="text-xs text-gray-400">{props.hint}</p>
    </div>
  );
}
