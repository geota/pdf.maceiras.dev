export default function AboutPage() {
  return (
    <div class="h-full overflow-y-auto">
      <div class="max-w-2xl mx-auto p-8 space-y-8">
        <div>
          <h2 class="text-lg font-semibold text-gray-900">About</h2>
          <p class="mt-2 text-sm text-gray-600 leading-relaxed">
            pdf.maceiras.dev is a browser-based PDF toolkit. View, merge, split,
            reorder, compress, and edit metadata — all processing happens locally
            in your browser using WebAssembly. No files are ever uploaded to a server.
          </p>
        </div>

        <div>
          <h2 class="text-lg font-semibold text-gray-900">Open Source Libraries</h2>
          <p class="mt-2 text-sm text-gray-600">
            This project is built on the following open source projects:
          </p>
          <ul class="mt-3 space-y-2 text-sm">
            <li>
              <a href="https://www.solidjs.com/" target="_blank" rel="noopener" class="text-blue-600 hover:underline font-medium">SolidJS</a>
              <span class="text-gray-500"> — Reactive UI framework</span>
            </li>
            <li>
              <a href="https://pdfium.googlesource.com/pdfium/" target="_blank" rel="noopener" class="text-blue-600 hover:underline font-medium">PDFium</a>
              <span class="text-gray-500"> — PDF rendering engine (via </span>
              <a href="https://crates.io/crates/pdfium-render" target="_blank" rel="noopener" class="text-blue-600 hover:underline">pdfium-render</a>
              <span class="text-gray-500">)</span>
            </li>
            <li>
              <a href="https://crates.io/crates/lopdf" target="_blank" rel="noopener" class="text-blue-600 hover:underline font-medium">lopdf</a>
              <span class="text-gray-500"> — PDF document manipulation</span>
            </li>
            <li>
              <a href="https://crates.io/crates/image" target="_blank" rel="noopener" class="text-blue-600 hover:underline font-medium">image</a>
              <span class="text-gray-500"> — Image decoding and encoding</span>
            </li>
            <li>
              <a href="https://crates.io/crates/oxipng" target="_blank" rel="noopener" class="text-blue-600 hover:underline font-medium">oxipng</a>
              <span class="text-gray-500"> — PNG optimization</span>
            </li>
            <li>
              <a href="https://crates.io/crates/flate2" target="_blank" rel="noopener" class="text-blue-600 hover:underline font-medium">flate2</a>
              <span class="text-gray-500"> — DEFLATE compression</span>
            </li>
            <li>
              <a href="https://crates.io/crates/justjp2" target="_blank" rel="noopener" class="text-blue-600 hover:underline font-medium">justjp2</a>
              <span class="text-gray-500"> — JPEG 2000 support</span>
            </li>
            <li>
              <a href="https://rustwasm.github.io/wasm-pack/" target="_blank" rel="noopener" class="text-blue-600 hover:underline font-medium">wasm-pack</a>
              <span class="text-gray-500"> — Rust to WebAssembly toolchain</span>
            </li>
            <li>
              <a href="https://tailwindcss.com/" target="_blank" rel="noopener" class="text-blue-600 hover:underline font-medium">Tailwind CSS</a>
              <span class="text-gray-500"> — Utility-first CSS framework</span>
            </li>
            <li>
              <a href="https://vite.dev/" target="_blank" rel="noopener" class="text-blue-600 hover:underline font-medium">Vite</a>
              <span class="text-gray-500"> — Frontend build tool</span>
            </li>
            <li>
              <a href="https://github.com/GoogleChromeLabs/comlink" target="_blank" rel="noopener" class="text-blue-600 hover:underline font-medium">Comlink</a>
              <span class="text-gray-500"> — Web Worker RPC</span>
            </li>
          </ul>
        </div>

        <div>
          <h2 class="text-lg font-semibold text-gray-900">Terms of Use</h2>
          <p class="mt-2 text-sm text-gray-600 leading-relaxed">
            All PDF processing occurs entirely in your browser. No files are
            uploaded, stored, or transmitted to any server. Your documents never
            leave your device.
          </p>
          <p class="mt-2 text-sm text-gray-600 leading-relaxed">
            This tool is provided as-is on a best-effort basis. By using
            pdf.maceiras.dev, you acknowledge that the author assumes no
            liability for any loss, corruption, or damage to your PDF files or
            any other data. Always keep backups of your original documents before
            processing.
          </p>
        </div>
      </div>
    </div>
  );
}
