# pdf.maceiras.dev

A browser-based PDF toolkit. View, merge, split, reorder, compress, and edit metadata — all processing happens locally in your browser using WebAssembly. No files are uploaded to any server.

## Features

- **View** — Scroll through pages with thumbnail sidebar navigation
- **Merge** — Combine multiple PDFs with drag-and-drop reordering
- **Split** — Extract page ranges into separate documents using expressions
- **Reorder** — Rearrange, duplicate, or remove pages via drag-and-drop or expressions
- **Compress** — Lossless and lossy compression with target file size support
- **Metadata** — View and edit PDF title, author, subject, and keywords
- **Per-page operations** — Rotate, crop, and scale individual pages from any tool

## Tech Stack

- **Frontend:** [SolidJS](https://www.solidjs.com/) + [Tailwind CSS](https://tailwindcss.com/) + [Vite](https://vite.dev/)
- **PDF engine:** Rust compiled to WebAssembly via [wasm-pack](https://rustwasm.github.io/wasm-pack/)
  - [PDFium](https://pdfium.googlesource.com/pdfium/) (via [pdfium-render](https://crates.io/crates/pdfium-render)) for rendering
  - [lopdf](https://crates.io/crates/lopdf) for PDF manipulation
  - [image](https://crates.io/crates/image), [oxipng](https://crates.io/crates/oxipng), [flate2](https://crates.io/crates/flate2) for compression
- **Parallelism:** Web Worker pool for rendering and image processing

## Project Structure

```
apps/web/          SolidJS frontend
crates/pdf-core/   Rust PDF manipulation library
crates/pdf-wasm/   WASM bindings for pdf-core + PDFium
packages/          Generated WASM package (build artifact)
docs/              Research and design documents
```

## Development

```sh
make install   # Install JS dependencies
make dev       # Build WASM (dev) + start Vite dev server
make build     # Full production build (WASM release + Vite)
make test      # Run Rust + web tests
make lint      # Run clippy + Biome + typecheck
make fmt       # Format Rust + TypeScript
```

Requires: [Rust](https://rustup.rs/), [wasm-pack](https://rustwasm.github.io/wasm-pack/installer/), [Node.js](https://nodejs.org/), [pnpm](https://pnpm.io/)

## Deployment

Hosted on [Cloudflare Pages](https://pages.cloudflare.com/) as a static site.

```sh
npx wrangler pages deploy   # Deploy from apps/web/dist
```

## License

MIT
