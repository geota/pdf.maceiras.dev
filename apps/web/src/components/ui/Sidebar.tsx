import { For } from "solid-js";

export type Route = "view" | "merge" | "split" | "reorder" | "compress" | "metadata" | "about";

interface NavItem {
  route: Route;
  label: string;
}

const navItems: NavItem[] = [
  { route: "view", label: "View" },
  { route: "merge", label: "Merge" },
  { route: "split", label: "Split" },
  { route: "reorder", label: "Reorder" },
  { route: "compress", label: "Compress" },
  { route: "metadata", label: "Metadata" },
];

interface Props {
  active: Route;
  onNavigate: (route: Route) => void;
}

export default function Sidebar(props: Props) {
  return (
    <aside class="w-48 shrink-0 bg-gray-900 text-gray-300 flex flex-col">
      <div class="px-4 py-5">
        <h1 class="text-lg font-bold text-white tracking-tight">pdf.maceiras.dev</h1>
      </div>
      <nav class="flex-1 px-2 space-y-1">
        <For each={navItems}>
          {(item) => (
            <button
              onClick={() => props.onNavigate(item.route)}
              class={`w-full text-left px-3 py-2 rounded text-sm transition-colors ${
                props.active === item.route
                  ? "bg-gray-700 text-white font-medium"
                  : "hover:bg-gray-800 hover:text-white"
              }`}
            >
              {item.label}
            </button>
          )}
        </For>
      </nav>
      <div class="px-4 py-3 border-t border-gray-800">
        <button
          onClick={() => props.onNavigate("about")}
          class={`text-[11px] transition-colors ${
            props.active === "about"
              ? "text-gray-300"
              : "text-gray-500 hover:text-gray-400"
          }`}
        >
          About & Terms
        </button>
      </div>
    </aside>
  );
}
