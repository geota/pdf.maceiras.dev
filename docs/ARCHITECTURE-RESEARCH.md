# pdf.maceiras.dev: Architecture Research Document

> **Date:** 2026-03-16
> **Status:** Initial Research / Pre-Implementation

---

## Table of Contents

1. [Project Vision](#1-project-vision)
2. [Rust PDF Library Ecosystem](#2-rust-pdf-library-ecosystem)
3. [Non-Rust PDF Tools (Inspiration)](#3-non-rust-pdf-tools-inspiration)
4. [PDF Specification Complexity](#4-pdf-specification-complexity)
5. [Rust-to-WASM Compilation](#5-rust-to-wasm-compilation)
6. [WASM Limitations & Constraints](#6-wasm-limitations--constraints)
7. [Data Transfer Patterns (JS ↔ WASM)](#7-data-transfer-patterns-js--wasm)
8. [Web Framework Analysis](#8-web-framework-analysis)
9. [PDF Viewer UI Architecture](#9-pdf-viewer-ui-architecture)
10. [Recommended Technology Stack](#10-recommended-technology-stack)
11. [Project Architecture & Directory Structure](#11-project-architecture--directory-structure)
12. [Phase 1 Implementation Plan](#12-phase-1-implementation-plan)
13. [Technical Risks & Mitigations](#13-technical-risks--mitigations)

---

## 1. Project Vision

Build a PDF editing web application similar to PDFGear, running entirely client-side. The architecture consists of:

- **Rust SDK (`pdf-core`)**: Core PDF manipulation library — open, save, merge, split, compress
- **WASM bindings (`pdf-wasm`)**: Thin wrapper exposing the SDK to JavaScript via `wasm-bindgen`
- **Web app**: Interactive PDF editor powered by the WASM module, no server-side processing
- **CLI (future phase)**: Command-line tool reusing `pdf-core`

### Phase 1 Core Features
1. Opening and Viewing PDFs
2. Saving PDFs
3. Merging PDFs
4. Splitting PDFs
5. Compressing PDFs

---

## 2. Rust PDF Library Ecosystem

### 2.1 `lopdf` ⭐ (Recommended for manipulation)

| Aspect | Details |
|--------|---------|
| **Repo** | https://github.com/J-F-Liu/lopdf |
| **License** | MIT |
| **Status** | Actively maintained (periodic releases through 2024-2025) |
| **WASM** | **Yes** — pure Rust, compiles cleanly to `wasm32-unknown-unknown` |

| Capability | Support |
|------------|---------|
| Open/Parse PDFs | Yes — robust parsing of PDF 1.0–2.0 |
| Render PDFs | **No** |
| Merge PDFs | Yes — combine pages from multiple documents |
| Split PDFs | Yes — extract page ranges into new documents |
| Compress/Optimize | Partial — compress/decompress streams (FlateDecode), remove unused objects |
| Save/Write PDFs | Yes — write modified PDFs back to bytes |

**Key details:**
- Represents PDFs as a dictionary of numbered objects (`ObjectId -> Object`), mapping directly to the PDF object model
- Supports adding/removing/reordering pages, modifying object streams, updating cross-reference tables, incremental saves
- Does NOT parse or interpret page *content streams* (drawing commands are treated as opaque byte streams)
- Font handling is minimal — no font parsing/subsetting engine
- Encryption: basic support for standard security handler
- **Primary dependency**: `flate2` (has pure-Rust backend via `miniz_oxide`)

**Limitation**: No rendering capability. Needs a separate solution for viewing.

### 2.2 `pdf` crate (pdf-rs)

| Aspect | Details |
|--------|---------|
| **License** | MIT |
| **Status** | Sporadic updates; not highly active |
| **WASM** | Theoretically possible (pure Rust) but not a stated goal |

- Focuses on *reading* PDF files: parsing xref tables, object trees, page trees, content streams
- Models PDF objects using Rust's type system
- Handles incremental updates and linearized PDFs partially
- Font handling is partial — CIDFont, TrueType, Type1 partially supported
- Encryption: basic support (RC4, some AES)
- **Not suitable as a foundation** without significant work — no writing/modification support

### 2.3 `printpdf`

| Aspect | Details |
|--------|---------|
| **License** | MIT |
| **Status** | Active through 2024-2025 |
| **WASM** | Yes — pure Rust |

- **Generation only** — cannot read existing PDFs
- Creates new PDF documents programmatically (text, lines, shapes, images)
- Supports embedding TrueType/OpenType fonts, image embedding (JPEG, PNG, BMP)
- SVG path drawing, layers support
- Useful for future features requiring PDF creation from scratch

### 2.4 `pdfium-render` ⭐ (Recommended for rendering)

| Aspect | Details |
|--------|---------|
| **License** | MIT (bindings) / BSD (PDFium) |
| **Status** | Actively maintained through 2024-2025 |
| **WASM** | **Yes** — explicitly supports WASM target with pre-compiled PDFium WASM binary |

| Capability | Support |
|------------|---------|
| Open/Parse PDFs | Yes — full PDFium parsing |
| Render PDFs | **Yes** — high-quality rendering to bitmaps |
| Merge PDFs | Yes — via PDFium's document manipulation APIs |
| Split PDFs | Yes — page extraction/import between documents |
| Compress/Optimize | Limited |
| Save/Write PDFs | Yes |

**Key details:**
- Wraps Google's PDFium (Chrome/Chromium's PDF engine) — extremely mature and battle-tested
- Rendering quality is excellent: fonts, transparency, color spaces, annotations
- Text extraction with position information, form filling, annotation reading
- WASM binary is ~2–5 MB depending on build configuration
- **The strongest candidate for the "viewing/rendering" feature in WASM**

### 2.5 `mupdf-rs`

| Aspect | Details |
|--------|---------|
| **License** | **AGPL-3.0** (dealbreaker for closed-source) |
| **WASM** | Difficult — C library, complex cross-compilation |

- Wraps MuPDF via FFI — arguably the highest-quality open-source PDF renderer
- AGPL license rules this out unless the entire application is open-sourced or a commercial license is purchased

### 2.6 Other Notable Libraries

| Library | Purpose | WASM | License |
|---------|---------|------|---------|
| `pdf-writer` | Low-level PDF generation | Yes | MIT |
| `pdf-extract` | Text extraction (built on `pdf` crate) | Possible | MIT |
| `genpdf` | High-level PDF generation (on top of `printpdf`) | Yes | MIT |
| `krilla` | Modern PDF generation (PDF/A, PDF/UA support) | Yes | MIT |

### 2.7 Comparison Matrix

| Feature | lopdf | printpdf | pdfium-render | mupdf-rs | pdf (pdf-rs) |
|---------|-------|----------|---------------|----------|-------------|
| Parse/Open | ✅ | ❌ | ✅ | ✅ | ✅ |
| Render | ❌ | ❌ | **✅** | **✅** | ❌ |
| Merge | ✅ | ❌ | ✅ | ✅ | ❌ |
| Split | ✅ | ❌ | ✅ | ✅ | ❌ |
| Compress | Partial | ❌ | Limited | Some | ❌ |
| Write/Save | ✅ | ✅ (new only) | ✅ | ✅ | Limited |
| WASM | **Clean** | **Clean** | **Yes (with PDFium)** | Difficult | Possible |
| Pure Rust | ✅ | ✅ | ❌ (C++ dep) | ❌ (C dep) | ✅ |
| License | MIT | MIT | MIT/BSD | **AGPL** | MIT |

---

## 3. Non-Rust PDF Tools (Inspiration)

### pdf.js (Mozilla)
- **Language**: JavaScript | **License**: Apache 2.0
- Pure JS PDF parser + renderer — the dominant browser-based PDF viewer
- Renders to Canvas 2D API with font engine + hinting
- Handles an enormous range of real-world PDFs
- **Read-only** — no modification/save
- Architecture: layered (core parser → display/render → viewer UI)
- Key patterns: page virtualization, render queue, Web Workers, multi-resolution rendering, text layer, annotation layer
- **Relevance**: Sets the baseline for browser PDF viewing. Could be used for the viewing layer alongside the Rust SDK for manipulation

### PDFium (Google/Chromium)
- **Language**: C++ | **License**: BSD 3-Clause
- Full parsing, high-quality rendering, text extraction, form filling, annotations, digital signatures
- Forked from Foxit SDK, heavily modified by Google
- **Compiles to WASM** — official WASM builds exist (how Chrome's PDF viewer works)
- BSD license is very permissive
- **Relevance**: Via `pdfium-render`, best path to rendering in WASM

### qpdf ⭐ (Architecture inspiration)
- **Language**: C++ | **License**: Apache 2.0
- PDF transformation, optimization, linearization, encryption/decryption, merge, split
- **Does NOT render** — manipulates PDF at the object/structure level without interpreting content streams
- Extremely robust at handling malformed PDFs
- Content-preserving transformations
- **Highly relevant**: qpdf's structural manipulation approach aligns with what `lopdf` does in Rust and is the model to follow for merge/split/compress

### PyPDF / pikepdf
- **PyPDF** (Python, BSD): Pure Python merge, split, encryption, metadata
- **pikepdf** (Python bindings to qpdf, MPL-2.0): More robust structural manipulation
- **Relevance**: API design inspiration — pikepdf shows how to expose qpdf-like capabilities through a high-level API

### MuPDF / Poppler
- Both have rendering quality but restrictive licenses (AGPL / GPL)
- Not practical for this project due to licensing

---

## 4. PDF Specification Complexity

### Key Structures

| Structure | Complexity |
|-----------|-----------|
| **Object Model** | 8 basic types (booleans, integers, reals, strings, names, arrays, dictionaries, streams). Indirect objects form a graph. |
| **Cross-Reference Table** | Maps object numbers to byte offsets. Two formats: traditional xref table and compressed xref streams (PDF 1.5+). Incremental updates create chains. |
| **Content Streams** | PostScript-like operators for path construction, text, color, images. Requires graphics state stack tracking. |
| **Fonts** | 5 types (Type1, TrueType, OpenType/CFF, Type3, CIDFont). Encoding tables, ToUnicode CMaps, font subsetting. **The hardest part.** |
| **Color Spaces** | DeviceRGB/CMYK/Gray, calibrated (CalRGB, Lab), ICCBased, Indexed, Separation, DeviceN, Pattern. |
| **Images** | Multiple compression: FlateDecode, DCTDecode (JPEG), JPXDecode (JPEG2000), CCITTFaxDecode, JBIG2, LZW. Filter chains. |
| **Encryption** | RC4 (40/128-bit), AES-128/256. Per-stream/per-string encryption. |
| **Other** | Annotations, AcroForms, digital signatures, tagged PDF, optional content groups, transparency groups. |

### What Makes PDF Manipulation Hard

1. **Write-optimized format** — not designed for editing; moving content requires recalculating positions
2. **Incremental updates** — appending is easy, compacting requires full rewrite
3. **Font subsetting on merge** — merging PDFs with different font subsets requires complex font manipulation
4. **Content stream manipulation** — anything beyond page-level operations requires parsing drawing commands
5. **Backward compatibility** — spec spans PDF 1.0 (1993) through PDF 2.0 (2020)

---

## 5. Rust-to-WASM Compilation

### 5.1 Toolchain

| Tool | Purpose |
|------|---------|
| **wasm-pack** | Standard build tool — invokes cargo, runs wasm-bindgen CLI, runs wasm-opt, produces npm package |
| **wasm-bindgen** | Proc macro + CLI enabling high-level Rust/JS interop beyond basic numeric types |
| **wasm-opt** (Binaryen) | WASM-specific optimization passes (DCE, inlining, constant folding). 10–30% size reduction. |

**Build targets:**
- `--target bundler` — for Vite/webpack (ES modules) ← **recommended**
- `--target web` — for native ESM loading via `<script type="module">`
- `--target nodejs` — for Node.js

**Target triple:** Use `wasm32-unknown-unknown` exclusively (not `wasm32-wasi`, which is for server-side runtimes).

### 5.2 Types That Cross the JS/WASM Boundary

| Category | Types | Notes |
|----------|-------|-------|
| Primitives | `u8`–`u64`, `i8`–`i64`, `f32`, `f64`, `bool` | Direct, no overhead |
| Strings | `String`, `&str` | Copied (UTF-8 → UTF-16 conversion) |
| Byte slices | `Vec<u8>`, `&[u8]` | Copied; use `js_sys::Uint8Array` for zero-copy view |
| JS types | `JsValue`, `js_sys::*`, `web_sys::*` | Opaque handles, no copying |
| Structs | `#[wasm_bindgen] struct` | Passed as opaque pointer |
| Enums | `#[wasm_bindgen] enum` | C-style only (no data variants) |
| Option/Result | `Option<T>`, `Result<T, JsValue>` | Nullable / return-or-throw |

### 5.3 WASM Binary Size

| Project Complexity | Unoptimized | Optimized (`-Os` + wasm-opt) |
|-------------------|-------------|------------------------------|
| Minimal | 1.5–2 MB | 20–50 KB |
| Medium library | 3–8 MB | 500 KB – 2 MB |
| Full PDF library | 8–20 MB | 2–6 MB |
| With image decoding | 15–30 MB | 4–10 MB |

**Size optimization strategies (by impact):**

```toml
# Cargo.toml [profile.release]
opt-level = "z"       # Optimize for size
lto = true            # Link-time optimization (10-20% savings)
codegen-units = 1     # Better cross-crate optimization
strip = true          # Remove debug symbols
panic = "abort"       # Smaller than unwind; fine for WASM
```

Additional: avoid `format!`/`println!` (pulls in formatting machinery ~100–300KB), feature-gate aggressively, use `cargo-bloat` and `twiggy` for size profiling.

**Target for Phase 1:** Under 500 KB gzipped (manipulation only, no rendering).

---

## 6. WASM Limitations & Constraints

### 6.1 Memory

- WASM uses linear memory — grows in 64KB pages, **hard limit 4GB** (wasm32)
- Memory can only grow, **never shrink** during module lifetime
- 100MB PDF + processing buffers can easily require 300–500MB
- Mobile browsers: practical limit is 1–2GB
- **Mitigations**: Process pages individually, free intermediate buffers promptly, set maximum memory, consider worker reload for memory reclamation

### 6.2 File I/O

No direct filesystem access. All file input via JavaScript:
- `<input type="file">` / drag-and-drop
- `File.arrayBuffer()` → `Uint8Array` → pass to WASM
- Output: return `Vec<u8>` → create Blob → trigger download

### 6.3 Threading

- Default: **single-threaded**
- Multi-threading requires `SharedArrayBuffer` + COOP/COEP headers:
  - `Cross-Origin-Opener-Policy: same-origin`
  - `Cross-Origin-Embedder-Policy: require-corp`
- **wasm-bindgen-rayon**: bridges Rayon parallel iterators to Web Workers with shared memory
- **Recommendation**: Start single-threaded in a Web Worker. Use task-level parallelism (one worker per page) if needed. Only pursue SharedArrayBuffer if profiling shows a bottleneck.

### 6.4 Crate Compatibility

| ❌ Incompatible | Alternative |
|-----------------|-------------|
| `std::fs`, `walkdir`, `tempfile` | web-sys File API |
| `std::net`, `reqwest` (default) | `reqwest` with `wasm` feature, `gloo-net` |
| `std::time::Instant` | `web-sys::Performance::now()`, `instant` crate |
| `std::thread::spawn` | Web Workers, wasm-bindgen-rayon |
| C FFI: `openssl`, `libz-sys`, `freetype-sys` | `rustls`, `flate2` (rust_backend), `ab-glyph` |
| `memmap2` | Read into `Vec<u8>` |
| `rand` (default) | `rand` with `js` feature |

| ✅ Works in WASM |
|------------------|
| `serde`, `serde_json`, `image`, `flate2` (rust_backend), `nom`/`winnow`, `log` + `console_log`, `regex`, `unicode-*` crates |

### 6.5 Debugging

- **`console_error_panic_hook`**: Converts Rust panics to readable `console.error` messages (essential)
- **Source maps**: `wasm-pack build --dev` generates DWARF debug info, Chrome DevTools can set breakpoints in Rust source
- **`console_log` crate**: Route Rust `log::info!()` to browser console
- **Performance profiling**: Chrome DevTools Performance tab shows WASM function names

---

## 7. Data Transfer Patterns (JS ↔ WASM)

### 7.1 Copy into WASM Memory (Simplest)

```rust
#[wasm_bindgen]
pub fn load_pdf(data: &[u8]) -> Result<PdfDocument, JsError> {
    // data has been copied into WASM linear memory
}
```
Cost: One full copy (~10–50ms for 50MB). Fine for Phase 1.

### 7.2 Direct Memory Write (Avoids one copy, for >50MB files)

```rust
#[wasm_bindgen]
pub fn allocate(size: usize) -> *mut u8 { /* ... */ }

#[wasm_bindgen]
pub fn load_pdf_from_ptr(ptr: *mut u8, len: usize) -> Result<PdfDocument, JsError> { /* ... */ }
```

### 7.3 Transferable ArrayBuffers (Recommended for Worker communication)

```javascript
// Zero-copy transfer — source loses access, no special headers needed
worker.postMessage({ pdfData: arrayBuffer }, [arrayBuffer]);
```

Use **Transferable ArrayBuffers** for passing PDF data to/from workers. Only use SharedArrayBuffer if multiple workers must read the same data simultaneously.

### 7.4 Progress Callbacks

```rust
#[wasm_bindgen]
pub fn compress_pdf_with_progress(
    data: &[u8],
    level: u8,
    on_progress: &js_sys::Function,
) -> Result<Vec<u8>, JsError> {
    let callback = |progress: f64| {
        let _ = on_progress.call1(&JsValue::NULL, &JsValue::from_f64(progress));
    };
    // ...
}
```

---

## 8. Web Framework Analysis

### 8.1 Astro — Analysis

**Strengths**: Static-first, islands architecture, framework-agnostic, Vite-powered, excellent for content sites.

**Fundamental mismatch**: Astro is designed for content-heavy MPAs (blogs, docs, marketing). A PDF editor is a highly interactive, stateful SPA — the opposite of Astro's design target.

**WASM integration issues:**
1. SSR conflict — WASM modules fail during server-side rendering; must use `client:only` for all WASM components, defeating Astro's core value
2. SPA mismatch — persistent state requires `transition:persist` workarounds
3. Pre-bundling issues — Vite's esbuild doesn't handle `.wasm` well, needs `optimizeDeps.exclude`
4. Worker support adds complexity when layered through Astro islands

**Verdict**: **Not recommended for the PDF editor itself.** Excellent for a marketing/docs site deployed separately.

**If you still want Astro**: Build the editor as a standalone component, embed with `client:only="react"` or `client:only="solid"`. Astro becomes a shell that serves static HTML.

### 8.2 Framework Comparison

| Feature | Astro | Next.js | SvelteKit | SolidStart | **Plain Vite** |
|---------|-------|---------|-----------|------------|---------------|
| WASM integration | Tricky (SSR) | Moderate | Good | Good | **Best** |
| SPA suitability | Poor | Moderate | Good | Good | **Best** |
| Bundle size | Varies | Large | Small | Smallest | **Smallest** |
| Client-side focus | Low | Medium | Medium | Medium | **Full** |
| Complexity | Medium | High | Medium | Medium | **Low** |

### 8.3 Plain Vite + UI Framework (Recommended)

No meta-framework. Direct Vite with a UI library.

```js
// vite.config.ts
import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

export default defineConfig({
  plugins: [solid(), wasm(), topLevelAwait()],
});
```

**Why this wins:**
- Simplest WASM integration — no SSR to conflict with
- Full control over routing, state, WASM loading
- Fastest dev server startup
- Deploys as static files to any CDN

### 8.4 UI Framework Choice

| Framework | Runtime Size | Rendering | WASM Integration | Ecosystem |
|-----------|-------------|-----------|-------------------|-----------|
| **Solid.js** ⭐ | ~7KB | Fine-grained reactivity, no VDOM | Clean | Growing |
| Svelte | ~0KB (compiled) | Compiled, no runtime | Good | Medium |
| React | ~40KB | Virtual DOM | Excellent (most examples) | Largest |
| Vue | ~30KB | Virtual DOM + reactivity | Good | Large |

**Recommendation: Solid.js** — fine-grained reactivity avoids re-rendering overhead critical for canvas-heavy apps. Small runtime keeps JS bundle size down since the WASM binary is already large. JSX syntax is familiar to React developers.

**Acceptable alternative: Svelte** — compiles away to vanilla JS, excellent performance, slightly larger ecosystem.

### 8.5 Rust-Native Web Frameworks (Leptos, Yew, Dioxus)

**Not recommended** for the PDF editor UI because:
1. DOM interaction through WASM is slower than native JS for frequent small updates (scrolling, zooming)
2. Rust compile times for UI iteration are much slower than Vite's HMR
3. Ecosystem is immature — no equivalent of npm's UI component libraries
4. Architecture mismatch — the ideal split is Rust for computation, JS for presentation

However, **Leptos/Dioxus could be interesting for a future desktop version** via Tauri.

---

## 9. PDF Viewer UI Architecture

### 9.1 Rendering Approach: Canvas + HTML Overlay (Hybrid)

Following pdf.js's proven architecture:

```
┌─────────────────────────────────┐
│         HTML Overlay Layer      │  ← Annotations, form fields, cursors
├─────────────────────────────────┤
│         Text Layer (invisible)  │  ← Positioned <span> elements for text selection
├─────────────────────────────────┤
│         Canvas Layer            │  ← PDF page rasterized by WASM
└─────────────────────────────────┘
```

### 9.2 Rendering Pipeline

```
PDF File (ArrayBuffer)
    │
    ▼
[Web Worker] WASM parses PDF structure
    │
    ▼
[Web Worker] WASM renders page to pixel buffer (at requested DPI/zoom)
    │
    ▼
Transfer pixel buffer to main thread (Transferable ArrayBuffer)
    │
    ▼
[Main Thread] Create ImageData, draw to Canvas
    │
    ▼
[Main Thread] Overlay text layer + annotation layer
```

### 9.3 Key UI Patterns (from pdf.js)

- **Page virtualization**: Only render visible pages + small buffer (critical for large PDFs)
- **Render queue**: Priority ordering — visible pages first, then adjacent
- **Multi-resolution**: Instant CSS transform for zoom feedback, then re-render at new resolution
- **Text layer**: Invisible HTML spans positioned over canvas for text selection
- **Virtual scrolling**: Libraries like `@tanstack/virtual` for large documents

### 9.4 Rendering Options

For Phase 1, two viable approaches:

**Option A: pdf.js for rendering + Rust/WASM for manipulation**
- Use pdf.js as the viewing engine (proven, handles edge cases)
- Use Rust WASM SDK for merge/split/compress operations
- Lower implementation effort for viewing
- Adds pdf.js as a dependency (~2.5MB)

**Option B: PDFium via `pdfium-render` for rendering + `lopdf` for manipulation**
- PDFium WASM binary handles rendering (2–5MB)
- `lopdf`-based Rust code handles manipulation
- Single technology stack (all Rust/WASM)
- Higher implementation effort but more unified architecture

**Recommendation**: Start with **Option A** (pdf.js for viewing) to get a working product faster, with the option to migrate to Option B later.

---

## 10. Recommended Technology Stack

| Layer | Technology | Justification |
|-------|-----------|---------------|
| **PDF Manipulation** | `lopdf` (or custom inspired by it) | Pure Rust, WASM-compatible, MIT, covers merge/split/compress |
| **PDF Viewing** | pdf.js (Phase 1) | Proven, handles edge cases, fast path to working viewer |
| **WASM Build** | wasm-pack + wasm-bindgen | Standard Rust→WASM pipeline, generates TypeScript types |
| **Build Tool** | Vite (plain, no meta-framework) | Simplest WASM integration, no SSR conflicts |
| **UI Framework** | Solid.js | Best performance for canvas apps, fine-grained reactivity, small runtime |
| **Styling** | Tailwind CSS | Utility-first, rapid development |
| **Worker Communication** | comlink | Transparent RPC over Web Workers |
| **WASM Vite Plugins** | vite-plugin-wasm + vite-plugin-top-level-await | Seamless ESM WASM imports |
| **State Management** | Solid.js signals/stores (built-in) | No external library needed |
| **Testing** | cargo test + wasm-pack test + Playwright | Pyramid: unit → WASM integration → E2E |
| **Task Runner** | just (justfile) | Cross-platform, simpler than Makefiles |
| **Deployment** | Static hosting (Cloudflare Pages / Vercel / Netlify) | No server needed |
| **Marketing Site** | Astro (separate) | Astro excels at content sites |

---

## 11. Project Architecture & Directory Structure

### 11.1 Monorepo Structure

```
pdf.maceiras.dev/
├── Cargo.toml                    # Workspace root
├── Cargo.lock
├── justfile                      # Top-level task runner
├── .github/
│   └── workflows/
│       └── ci.yml
│
├── crates/
│   ├── pdf-core/                 # Core PDF manipulation library (PURE RUST)
│   │   ├── Cargo.toml
│   │   ├── src/
│   │   │   ├── lib.rs            # Public API re-exports
│   │   │   ├── document.rs       # Document struct and methods
│   │   │   ├── metadata.rs       # Metadata extraction
│   │   │   ├── merge.rs          # Merge operations
│   │   │   ├── split.rs          # Split operations
│   │   │   ├── compress.rs       # Compression operations
│   │   │   ├── error.rs          # PdfError type
│   │   │   └── types.rs          # PageRange, CompressionLevel, etc.
│   │   └── tests/
│   │       └── fixtures/         # Sample PDFs for testing
│   │
│   ├── pdf-wasm/                 # WASM bindings (thin wrapper)
│   │   ├── Cargo.toml
│   │   ├── src/
│   │   │   ├── lib.rs            # wasm-bindgen exports
│   │   │   ├── document.rs       # WasmDocument wrapper
│   │   │   └── utils.rs          # JS interop helpers
│   │   └── tests/
│   │       └── web.rs            # wasm-bindgen-test browser tests
│   │
│   └── pdf-cli/                  # Future: CLI tool
│       ├── Cargo.toml
│       └── src/
│           └── main.rs
│
├── packages/
│   ├── pdf-wasm-pkg/             # wasm-pack output (gitignored, built artifact)
│   │
│   └── pdf-worker/               # Web Worker wrapper (TypeScript)
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── client.ts         # Main-thread API (PdfWorkerClient)
│           ├── worker.ts         # Worker entry point
│           └── types.ts          # Shared message types
│
├── apps/
│   └── web/                      # Vite + Solid.js application
│       ├── package.json
│       ├── vite.config.ts
│       ├── tsconfig.json
│       ├── index.html
│       ├── public/
│       ├── src/
│       │   ├── App.tsx
│       │   ├── index.tsx
│       │   ├── pages/
│       │   │   ├── Home.tsx
│       │   │   ├── Viewer.tsx
│       │   │   ├── Merge.tsx
│       │   │   ├── Split.tsx
│       │   │   └── Compress.tsx
│       │   ├── components/
│       │   │   ├── PdfViewer.tsx
│       │   │   ├── FileDropZone.tsx
│       │   │   ├── PageThumbnails.tsx
│       │   │   ├── ProgressBar.tsx
│       │   │   └── Toolbar.tsx
│       │   ├── hooks/
│       │   │   ├── usePdfWorker.ts
│       │   │   └── useFileHandler.ts
│       │   └── lib/
│       │       ├── pdf-worker.ts # Worker singleton
│       │       └── storage.ts    # IndexedDB helpers
│       └── tests/
│           └── e2e/
│
├── fixtures/                     # Shared test PDFs
├── pnpm-workspace.yaml
├── package.json                  # Root package.json
└── .gitignore
```

### 11.2 Key Configuration Files

**Workspace Cargo.toml:**
```toml
[workspace]
resolver = "2"
members = [
    "crates/pdf-core",
    "crates/pdf-wasm",
    "crates/pdf-cli",
]

[workspace.dependencies]
lopdf = "0.34"
thiserror = "2"
log = "0.4"
flate2 = { version = "1", default-features = false, features = ["rust_backend"] }
serde = { version = "1", features = ["derive"] }

[profile.release]
lto = true
opt-level = "z"
strip = true
codegen-units = 1
panic = "abort"
```

**pdf-core/Cargo.toml:**
```toml
[package]
name = "pdf-core"
version = "0.1.0"
edition = "2024"

[features]
default = []
parallel = ["dep:rayon"]  # Not available in WASM

[dependencies]
lopdf = { workspace = true }
thiserror = { workspace = true }
log = { workspace = true }
flate2 = { workspace = true }
image = { version = "0.25", default-features = false, features = ["jpeg", "png"] }

[dependencies.rayon]
version = "1"
optional = true

[target.'cfg(not(target_arch = "wasm32"))'.dependencies]
memmap2 = "0.9"
```

**pdf-wasm/Cargo.toml:**
```toml
[package]
name = "pdf-wasm"
version = "0.1.0"
edition = "2024"

[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
pdf-core = { path = "../pdf-core" }
wasm-bindgen = "0.2"
js-sys = "0.3"
serde-wasm-bindgen = "0.6"
console_error_panic_hook = "0.1"
console_log = "1"
log = { workspace = true }
serde = { workspace = true }
```

**pnpm-workspace.yaml:**
```yaml
packages:
  - 'packages/*'
  - 'apps/*'
```

### 11.3 WASM Binding Layer Design

The WASM crate should be a **thin wrapper** — all logic lives in `pdf-core`:

```rust
// crates/pdf-wasm/src/lib.rs
use wasm_bindgen::prelude::*;
use pdf_core::{Document as CoreDocument, CompressionLevel as CoreLevel};

#[wasm_bindgen(start)]
pub fn init() {
    console_error_panic_hook::set_once();
    console_log::init_with_level(log::Level::Info).ok();
}

#[wasm_bindgen]
pub struct PdfDocument {
    inner: CoreDocument,
}

#[wasm_bindgen]
impl PdfDocument {
    #[wasm_bindgen(constructor)]
    pub fn new(data: &[u8]) -> Result<PdfDocument, JsError> {
        let doc = CoreDocument::from_bytes(data)
            .map_err(|e| JsError::new(&e.to_string()))?;
        Ok(PdfDocument { inner: doc })
    }

    #[wasm_bindgen(getter, js_name = "pageCount")]
    pub fn page_count(&self) -> u32 {
        self.inner.metadata().page_count
    }

    #[wasm_bindgen(js_name = "toBytes")]
    pub fn to_bytes(&self) -> Result<Vec<u8>, JsError> {
        self.inner.to_bytes()
            .map_err(|e| JsError::new(&e.to_string()))
    }
}

#[wasm_bindgen(js_name = "mergePdfs")]
pub fn merge_pdfs(pdfs: Vec<js_sys::Uint8Array>) -> Result<Vec<u8>, JsError> {
    let byte_vecs: Vec<Vec<u8>> = pdfs.iter().map(|a| a.to_vec()).collect();
    let slices: Vec<&[u8]> = byte_vecs.iter().map(|v| v.as_slice()).collect();
    pdf_core::merge_bytes(&slices)
        .map_err(|e| JsError::new(&e.to_string()))
}
```

### 11.4 Web Worker Architecture

```
┌──────────────────────┐     postMessage     ┌─────────────────────────┐
│     Main Thread      │ ◄─────────────────► │      Web Worker         │
│                      │                      │                         │
│  - UI rendering      │  {type, payload}     │  - WASM module loaded   │
│  - PDF.js viewer     │  (Transferable)      │  - All PDF operations   │
│  - User interactions │                      │  - Heavy computation    │
│  - Progress display  │                      │  - File processing      │
└──────────────────────┘                      └─────────────────────────┘
```

### 11.5 Astro Configuration (If Used for Wrapper/Marketing)

```js
// astro.config.mjs
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';

export default defineConfig({
  integrations: [react()],
  vite: {
    optimizeDeps: {
      exclude: ['pdf-wasm-pkg'],
    },
    server: {
      headers: {
        // Only needed if using SharedArrayBuffer (multi-threaded WASM)
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      },
    },
  },
});
```

Hydration directives for WASM components: use `client:only="react"` (or `client:only="solid"`) since WASM APIs don't exist during SSR.

---

## 12. Phase 1 Implementation Plan

### 12.1 Milestones

| # | Milestone | Deliverable |
|---|-----------|-------------|
| 1 | Project scaffold | Cargo workspace, pnpm workspace, justfile, CI |
| 2 | pdf-core: read/write | Load PDF from bytes, extract metadata, write back |
| 3 | pdf-core: merge | Merge N PDFs into one |
| 4 | pdf-core: split | Extract page ranges into new PDF |
| 5 | pdf-core: compress | Re-compress streams, downsample images |
| 6 | pdf-wasm bindings | Thin wrappers for all pdf-core operations |
| 7 | Web Worker layer | TypeScript worker client + worker script |
| 8 | Web app: viewer | pdf.js integration, file open, basic viewing |
| 9 | Web app: merge tool | Upload multiple, reorder, merge, download |
| 10 | Web app: split tool | Page selection UI, split, download |
| 11 | Web app: compress tool | Level selector, compress, size comparison, download |
| 12 | Polish & testing | E2E tests, error handling, edge cases, UX |

### 12.2 Build Pipeline

**Development:**
```
just dev
  ├── cargo watch on pdf-core (rebuild on Rust changes)
  ├── wasm-pack build --dev (rebuild WASM, skips wasm-opt)
  └── vite dev (dev server with HMR)
```

**Production:**
```
just build
  ├── cargo build --release -p pdf-core
  ├── wasm-pack build --release crates/pdf-wasm
  │       └── wasm-opt -Oz (automatic)
  ├── pnpm --filter web build
  └── Output: apps/web/dist/ (deployable static site)
```

### 12.3 Testing Strategy

```
         ┌───────────┐
         │   E2E     │  Playwright: full user flows
         │  (few)    │  (open PDF, merge, download)
         ├───────────┤
         │Integration│  wasm-pack test: WASM functions
         │  (some)   │  in headless browser
         ├───────────┤
         │   Unit    │  cargo test: PDF manipulation
         │  (many)   │  logic, edge cases, formats
         └───────────┘
```

### 12.4 CI/CD Pipeline

```yaml
# .github/workflows/ci.yml
jobs:
  rust:      # cargo fmt, clippy, test
  wasm:      # wasm-pack build + test (headless Chrome)
  web:       # pnpm install, build, test
  deploy:    # Static site deployment (on main)
```

### 12.5 Dependency Versions

```toml
# Rust
lopdf = "0.34"
wasm-bindgen = "0.2"
js-sys = "0.3"
serde = "1"
serde-wasm-bindgen = "0.6"
thiserror = "2"
flate2 = "1"           # with rust_backend feature
image = "0.25"
log = "0.4"
console_log = "1"
console_error_panic_hook = "0.1"
wasm-bindgen-test = "0.3"
```

```json
// JavaScript
"pdfjs-dist": "^4.x",
"solid-js": "^1.x",
"vite": "^6.x",
"vite-plugin-wasm": "^3.x",
"vite-plugin-top-level-await": "^1.x",
"comlink": "^4.x",
"@playwright/test": "^1.50"
```

---

## 13. Technical Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| lopdf cannot handle certain PDF variants | Medium | High | Maintain test corpus of real-world PDFs; fall back to less aggressive manipulation for edge cases |
| WASM binary too large (>1 MB gzipped) | Low | Medium | Audit dependencies aggressively; lazy-load features; use `twiggy` profiler |
| Compression doesn't meaningfully reduce size | Medium | Medium | Implement multiple strategies (stream recompression, image downsampling, font deduplication); show honest results |
| pdf.js and Rust SDK disagree on page structure | Low | Medium | Use pdf.js as source of truth for viewing; Rust SDK for manipulation only |
| Memory pressure with large files (>100MB) | Medium | Medium | Set file size limits; test extensively; implement streaming where possible |
| Vite WASM plugin compatibility issues | Low | Low | Pin versions; test dev + prod builds in CI |

---

## 14. Implementation Progress Tracker

### Spike (Complete)

| # | Milestone | Status |
|---|-----------|--------|
| 1 | Project scaffold | Done |
| 2 | pdf-core: read/write | Done |
| 3 | pdf-core: merge | Done |
| 4 | pdf-core: split | Done |
| 5 | pdf-wasm bindings | Done |
| 6 | Web Worker layer (Comlink + handles) | Done |
| 7 | Web app: viewer (pdfium-render) | Done |
| 8 | Web app: merge tool (basic) | Done |
| 9 | Web app: split tool (basic) | Done |

### Phase A: Foundation (Pure Frontend)

| # | Task | Status |
|---|------|--------|
| A1 | Reusable DropZone component | Done |
| A2 | Thumbnail rendering (hooks + components) | Done |
| A3 | Multi-select hook (useSelection) | Done |
| A4 | App layout redesign (tabs → sidebar) | Done |

### Phase B: Rust Backend Extensions

| # | Task | Status |
|---|------|--------|
| B1 | Extract shared page_utils from merge.rs | Done |
| B2 | Page reordering (reorder.rs + WASM + worker) | Done |
| B3 | Metadata editing (read/write + WASM + worker) | Done |

### Phase C: Rich UI Features

| # | Task | Status |
|---|------|--------|
| C1 | Better merge UI (DropZone + sortable list + thumbnails) | Done |
| C2 | Better split UI (ThumbnailGrid + visual page selection) | Done |
| C3 | Page reorder tool (draggable thumbnails + multi-select) | Done |
| C4 | Metadata editor (form + save) | Done |
| C5 | Enhance PdfViewer (DropZone + thumbnail strip) | Done |

### Phase D: Polish & Deploy

| # | Task | Status |
|---|------|--------|
| D1 | Production build config | Done |
| D2 | Deployment config (COOP/COEP headers) | Done |
| D3 | Error handling & edge cases | Not started |

---

## Appendix A: Alternative Rendering Approaches (Future)

If you want to eliminate the pdf.js dependency later:

1. **pdfium-render + PDFium WASM**: Render entirely from Rust via PDFium's WASM binary (2–5MB). Highest quality.
2. **pdf-rs + tiny-skia**: Pure Rust parsing + rasterization. Substantial implementation effort but smallest dependency footprint.
3. **Hybrid**: Parse content streams in Rust, emit Canvas 2D drawing commands, execute on JS Canvas. Avoids pixel buffer transfer but requires implementing PDF operators→Canvas mapping.

## Appendix B: Astro Island Hydration Reference

| Directive | When to Use |
|-----------|-------------|
| `client:load` | Needs interactivity immediately (toolbar) |
| `client:idle` | Can wait until page is idle (tool panels) |
| `client:visible` | Only when scrolled into view |
| `client:only="solid"` | Uses browser-only APIs (WASM, Workers, File API) — **skip SSR entirely** |
