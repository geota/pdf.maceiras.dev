# Feasibility Study: Rewriting PDFium in Rust

**Date:** 2026-03-21
**Status:** Research / Analysis
**Canonical PDFium repo:** https://pdfium.googlesource.com/pdfium/

---

## 1. Executive Summary

Rewriting PDFium in pure Rust is **technically feasible but represents a multi-year, team-scale effort** comparable in scope to projects like Servo (browser engine) or rustls (TLS). PDFium is an estimated 500K–700K lines of C++ implementing a large subset of the 972-page PDF 2.0 specification (ISO 32000-2). The payoff — a memory-safe, WASM-native PDF engine with idiomatic Rust APIs — is significant, but the realistic path involves incremental module replacement rather than a monolithic rewrite.

---

## 2. PDFium: Scope & Architecture

### 2.1 Module Breakdown

PDFium is organized into distinct subsystems:

| Module | Directory | Responsibility | Relative Complexity |
|--------|-----------|---------------|-------------------|
| **Public API** | `fpdfsdk/` | C-style `FPDF_*` interface for embedders | Medium |
| **PDF Parser** | `core/fpdfapi/parser/` | PDF syntax, xref tables, object streams, encryption | Very High |
| **Page Model** | `core/fpdfapi/page/` | Content streams, page objects, operators | Very High |
| **Renderer** | `core/fpdfapi/render/` | Rasterization orchestration, progressive rendering | Very High |
| **Graphics Engine** | `core/fxge/` | Device abstraction, AGG/Skia backends, bitmap ops | High |
| **Font Engine** | `core/fxge/` + FreeType | Font loading, shaping, CID/CMap, substitution | Very High |
| **Document Model** | `core/fpdfdoc/` | Bookmarks, links, annotations, AcroForms | High |
| **Text Extraction** | `core/fpdftext/` | Text page construction, search, Unicode handling | Medium-High |
| **Foundation** | `core/fxcrt/` | Strings, containers, memory, platform abstraction | Medium |
| **Codecs** | `core/fxcodec/` | JPEG, JPEG2000, JBIG2, Fax, Flate decompression | High |
| **JavaScript** | `fxjs/` | V8 bindings for form scripting | Medium |
| **XFA Forms** | `xfa/` | XML Forms Architecture (optional) | Very High |

### 2.2 Third-Party Dependencies

| Dependency | Purpose | Rust Equivalent |
|-----------|---------|----------------|
| FreeType | Font rasterization | `rusttype`, `ab_glyph`, `fontdue`, or FFI to FreeType |
| ICU | Unicode normalization, BiDi, line breaking | `icu4x` (pure Rust, maintained by Unicode Consortium) |
| zlib | Flate compression | `flate2` (with `miniz_oxide` pure Rust backend) |
| libjpeg-turbo | JPEG decoding | `zune-jpeg`, `jpeg-decoder` |
| libpng | PNG decoding | `png` crate |
| libopenjpeg | JPEG 2000 | `jpeg2k` (FFI) or `openjp2` — **no mature pure-Rust option** |
| lcms2 | ICC color management | `lcms2` (FFI) — **no mature pure-Rust option** |
| V8 | JavaScript execution | `boa_engine` (pure Rust JS), `deno_core` (V8 FFI) |
| Skia/AGG | 2D rendering | `tiny-skia` (pure Rust), `raqote`, `vello` |

### 2.3 Estimated Codebase Size

Based on published analyses and directory structure:
- **Core modules:** ~350K–450K lines of C++
- **XFA subsystem:** ~100K–150K lines (optional, can be excluded)
- **Tests and fuzzers:** ~100K+ lines
- **Total production code:** ~500K–700K lines

---

## 3. Existing Rust PDF Ecosystem

### 3.1 Current Libraries

| Library | Focus | Maturity | WASM | Rendering | Forms | Limitations |
|---------|-------|----------|------|-----------|-------|-------------|
| [lopdf](https://github.com/J-F-Liu/lopdf) | Read/write/manipulate | Mature | Yes | No | No | No rendering, no text extraction |
| [pdf-rs](https://github.com/pdf-rs/pdf) | Read/alter/write | Medium | Unknown | Via `pdf_render` | No | Writing is experimental |
| [printpdf](https://github.com/fschutt/printpdf) | Create/read/render | Medium | Yes | SVG output | No | Rendering via resvg, not pixel-perfect |
| [pdf_oxide](https://github.com/yfedoseev/pdf_oxide) | Extract/create/edit | New | Yes | No | Partial | No rendering engine |
| [pdfium-render](https://github.com/ajrcarey/pdfium-render) | Rust wrapper for PDFium | Mature | Yes* | Yes | Yes | *Requires compiled PDFium WASM module |

### 3.2 Gap Analysis

No existing pure-Rust library provides:
- Full PDF rendering (pixel-accurate rasterization)
- Complete AcroForm support with JavaScript
- Annotation editing
- Digital signature validation
- Progressive rendering
- CJK font handling with CID/CMap

This gap is precisely what a Rust PDFium rewrite would fill.

---

## 4. Technical Feasibility by Module

### 4.1 Parser & Document Model — HIGH FEASIBILITY

**Why:** PDF parsing is well-understood, heavily specified, and the Rust ecosystem has strong foundations (`nom`, `winnow` for parsing; existing work in `lopdf` and `pdf-rs`). Memory safety from Rust eliminates entire classes of parser bugs that PDFium's fuzzers have historically caught.

**WASM:** No platform dependencies. Straightforward compilation.

**Effort:** 3–6 months for a team of 2–3.

### 4.2 Text Extraction — HIGH FEASIBILITY

**Why:** `icu4x` provides pure-Rust Unicode handling (BiDi, normalization, segmentation) backed by the Unicode Consortium. Text layout algorithms are complex but well-documented.

**WASM:** `icu4x` is explicitly designed for WASM. No blockers.

**Effort:** 2–4 months.

### 4.3 Image Codecs — HIGH FEASIBILITY (with caveats)

**Why:** Pure-Rust implementations exist for JPEG, PNG, and Flate. JBIG2 and JPEG 2000 are the outliers.

**Blockers:**
- **JPEG 2000:** No production-ready pure-Rust decoder. Would need either FFI to `openjpeg` (breaks pure-Rust goal) or a new implementation. JPEG 2000 is used in some PDFs but is not ubiquitous.
- **JBIG2:** Used in scanned document PDFs. No pure-Rust implementation. Would need to be written (~5K–10K lines).

**WASM:** FFI codecs can be compiled to WASM separately; pure-Rust codecs compile natively.

**Effort:** 2–3 months (pure Rust codecs) + 3–6 months (JBIG2/JPEG2000 if writing from scratch).

### 4.4 Font Engine — MEDIUM FEASIBILITY

**Why:** This is one of the hardest subsystems. PDF fonts involve TrueType, OpenType, Type1, CFF, CID-keyed fonts with CMap mappings, font substitution, and hinting. Rust has building blocks:
- `ttf-parser` — fast, no-alloc OpenType parser
- `rustybuzz` — HarfBuzz port for shaping
- `fontdue` / `ab_glyph` — rasterization

**Gaps:**
- Type1 and CFF font support is incomplete in the Rust ecosystem
- CID/CMap handling for CJK needs custom work
- Font substitution logic (mapping missing fonts to available ones) is PDFium-specific logic

**WASM:** Pure-Rust font stack compiles to WASM without issue. No system font access in WASM (must bundle or embed fonts).

**Effort:** 6–12 months. This is on the critical path.

### 4.5 2D Rendering Engine — MEDIUM FEASIBILITY

**Why:** PDFium uses AGG (Anti-Grain Geometry) by default and optionally Skia. Pure-Rust alternatives exist:
- `tiny-skia` — pure Rust, Skia-subset, path rendering, anti-aliasing
- `vello` — GPU-accelerated 2D renderer (newer, Linebender project)
- `raqote` — pure Rust 2D graphics library

`tiny-skia` is the most realistic drop-in. It handles paths, fills, strokes, clipping, and anti-aliased rendering. It does NOT handle text (must rasterize glyphs separately) or color management.

**Gaps:**
- Blend modes (PDF supports 16 standard blend modes — `tiny-skia` supports most)
- Pattern/shading (gradients, tiling) — partially supported
- Transparency groups / soft masks — need careful implementation
- Color spaces (CalRGB, Lab, ICCBased) — need `lcms2` or a Rust equivalent

**WASM:** `tiny-skia` compiles to WASM. `vello` requires WebGPU (browser support still emerging).

**Effort:** 6–12 months to match PDFium's rendering fidelity.

### 4.6 Forms (AcroForm) — MEDIUM FEASIBILITY

**Why:** AcroForm field types (text, checkbox, radio, dropdown, signature) are well-specified. The data model is part of the PDF object tree. Rendering form widgets requires the rendering engine.

**Gaps:**
- Form JavaScript (calculate, validate, format actions) requires a JS engine
- `boa_engine` (pure Rust JS) is viable but performance-limited compared to V8
- Many real-world PDFs rely on JavaScript for form behavior

**WASM:** In browser contexts, could delegate JS execution to the host environment instead of embedding an engine — a significant architectural advantage.

**Effort:** 3–6 months (without JS), 6–12 months (with embedded JS engine).

### 4.7 Annotations — HIGH FEASIBILITY

**Why:** Annotation types (markup, stamps, links, pop-ups) are data structures with rendering rules. Complex but well-specified.

**WASM:** No blockers.

**Effort:** 2–4 months.

### 4.8 Digital Signatures — LOW-MEDIUM FEASIBILITY

**Why:** PDF signature validation involves PKCS#7/CMS parsing, X.509 certificate chains, and hash verification. Rust has `ring`, `rustls`, and `x509-parser`, but PDF-specific signature semantics (incremental saves, byte-range digests) need custom implementation.

**WASM:** Crypto crates generally compile to WASM. Certificate trust stores are platform-specific and would need to be provided externally.

**Effort:** 3–6 months.

### 4.9 XFA Forms — NOT RECOMMENDED

**Why:** XFA is a deprecated, Adobe-proprietary XML-based form system. PDF 2.0 removed XFA. Even PDFium makes it optional. Chrome has it disabled. Reimplementing XFA would be ~100K+ lines for a dying standard.

**Recommendation:** Exclude from scope entirely.

### 4.10 JavaScript Engine — MEDIUM FEASIBILITY

**Why:** PDF JavaScript is a restricted subset (not full browser JS). Options:
- **boa_engine:** Pure Rust, WASM-compatible, ECMAScript-compliant. Performance is 10–50x slower than V8 but adequate for form scripting.
- **Host delegation (WASM):** In browser targets, JS can be evaluated by the host. This is elegant and zero-cost.
- **V8/QuickJS FFI:** Faster but breaks pure-Rust and complicates WASM.

**WASM:** `boa_engine` compiles to WASM. Host delegation is even simpler.

**Effort:** 2–4 months for host delegation; 4–8 months for embedded boa integration.

---

## 5. WASM Compilation Assessment

### 5.1 Pure-Rust Advantage

A pure-Rust rewrite's biggest advantage over PDFium is **native WASM compilation**. Currently, using PDFium in WASM requires:
1. Compiling PDFium's C++ to WASM via Emscripten (~15–20 MB binary)
2. Loading two separate WASM modules (PDFium + Rust app)
3. Cross-module FFI overhead

A Rust-native library compiles to a single WASM module via `wasm-pack` / `wasm-bindgen` with:
- Smaller binary size (tree-shaking, no Emscripten runtime)
- No cross-module FFI overhead
- `wasm-opt` for further size reduction
- Direct `wasm-bindgen` exports for TypeScript-friendly APIs

### 5.2 WASM-Specific Constraints

| Constraint | Impact | Mitigation |
|-----------|--------|------------|
| No filesystem | Cannot load system fonts | Bundle fonts or accept user-provided fonts |
| No threads (without SharedArrayBuffer) | Single-threaded rendering | Progressive rendering, chunked work |
| Memory limits (~2–4 GB) | Large PDFs may hit limits | Streaming/lazy parsing, page-at-a-time loading |
| No system calls | No network, no hardware acceleration | Acceptable for PDF processing |
| Binary size | Users download the WASM module | Target <5 MB with `wasm-opt -Oz`, feature flags |

### 5.3 Estimated WASM Binary Sizes

| Configuration | Estimated Size |
|--------------|---------------|
| Parser + text extraction only | 1–2 MB |
| + Rendering (tiny-skia) | 3–5 MB |
| + Fonts (subset of Noto) | 5–15 MB (font-dependent) |
| + Forms + JS (boa) | 6–10 MB (without fonts) |
| Full PDFium via Emscripten (baseline) | 15–25 MB |

---

## 6. Idiomatic Rust API Design

### 6.1 Principles

PDFium's C API (`FPDF_*`) is flat, handle-based, and error-prone. A Rust rewrite should provide:

```rust
// PDFium C API (current state of the art for Rust consumers)
let doc = FPDF_LoadDocument(path, password);
let page = FPDF_LoadPage(doc, 0);
let width = FPDF_GetPageWidthF(page);
FPDF_ClosePage(page);
FPDF_CloseDocument(doc);

// Idiomatic Rust API (proposed)
let doc = Document::open("file.pdf").with_password("secret")?;
let page = doc.page(0)?;
let width = page.width();
// Resources freed on drop — no manual close calls

// Iteration
for page in doc.pages() {
    for annotation in page.annotations() {
        println!("{}: {}", annotation.kind(), annotation.content());
    }
}

// Builder pattern for creation
let doc = Document::builder()
    .page(Page::builder()
        .size(PageSize::A4)
        .text("Hello", font, 12.0, Point::new(72.0, 720.0))
        .build())
    .build();
```

### 6.2 Key API Design Decisions

| Aspect | Approach |
|--------|----------|
| Error handling | `Result<T, PdfError>` with `thiserror` — no null returns |
| Resource management | RAII via `Drop` — no manual `Close` calls |
| Iteration | `Iterator` trait for pages, annotations, form fields, text runs |
| Rendering | Trait-based backends (`RenderTarget`) — swap AGG/Skia/tiny-skia |
| Async | Optional `async` rendering for WASM (`wasm-bindgen-futures`) |
| Feature flags | Cargo features: `rendering`, `forms`, `javascript`, `signatures` |
| Zero-copy | `&[u8]` and `Cow<'_, str>` where possible for parsed data |
| Thread safety | `Send + Sync` on core types; document-level lock granularity |

---

## 7. Incremental Strategy

A monolithic rewrite is impractical. The recommended approach:

### Phase 1: Foundation (Months 1–6)
- PDF parser (objects, xref, streams, encryption)
- Document model (pages, resources, metadata)
- Text extraction with Unicode support
- Basic codec support (Flate, JPEG, PNG)
- **Deliverable:** A `pdf-core` crate that can parse and extract text from real-world PDFs
- **WASM milestone:** Text extraction works in the browser

### Phase 2: Rendering (Months 6–14)
- Content stream interpreter (operators → drawing commands)
- Integration with `tiny-skia` for rasterization
- Font loading and glyph rendering (TrueType/OpenType)
- Color space handling
- Image XObject rendering
- **Deliverable:** Pixel rendering of common PDF pages
- **WASM milestone:** Render PDF pages to `<canvas>` via `ImageData`

### Phase 3: Interactivity (Months 14–20)
- AcroForm field model and rendering
- Annotation model and rendering
- Form JavaScript (host delegation in WASM, `boa` native)
- Link handling and navigation
- **Deliverable:** Interactive form-filling in browser

### Phase 4: Completeness (Months 20–30)
- CJK font support (CID/CMap)
- Advanced color management (ICC profiles)
- JBIG2 and JPEG 2000 codecs
- Digital signature validation
- Progressive rendering
- Accessibility (tagged PDF)
- **Deliverable:** Feature parity with PDFium (minus XFA)

---

## 8. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Rendering fidelity gaps | High | High | Extensive test corpus (PDFium has thousands of test files); pixel-diff CI |
| CJK/complex script support | High | Medium | Leverage `rustybuzz` (HarfBuzz port); focus on common scripts first |
| JPEG 2000 pure-Rust gap | Medium | Medium | FFI fallback to openjpeg; JPEG2000 is rare in web PDFs |
| PDF spec ambiguities | High | Medium | Use PDFium's behavior as reference; test against real-world corpus |
| Scope creep (full spec) | High | High | Feature flags; explicit "not supported" for edge cases (3D, multimedia) |
| Performance vs C++ | Low | Medium | Rust is competitive; `tiny-skia` benchmarks well; SIMD via `std::simd` |
| Team/funding sustainability | High | Critical | Open-source community model; corporate sponsorship; phased delivery |

---

## 9. Effort Estimate

| Phase | Scope | Team Size | Duration | Person-Months |
|-------|-------|-----------|----------|---------------|
| Phase 1 | Parser, text, codecs | 2–3 | 6 months | 12–18 |
| Phase 2 | Rendering, fonts | 3–4 | 8 months | 24–32 |
| Phase 3 | Forms, annotations, JS | 2–3 | 6 months | 12–18 |
| Phase 4 | CJK, signatures, polish | 2–3 | 10 months | 20–30 |
| **Total** | | | **~30 months** | **~68–98** |

This assumes experienced Rust developers with PDF domain knowledge.

---

## 10. Recommendation

### For the pdf-rs project specifically:

The full rewrite is out of scope for a solo/small-team project. However, **targeted modules** from this roadmap directly serve the pdf-rs webapp:

1. **Phase 1 (parser + text extraction)** is achievable and immediately useful — it replaces `lopdf` with a more capable foundation.
2. **Phase 2 (rendering)** would eliminate the dependency on `pdf.js` for viewing, enabling a fully-Rust pipeline from PDF bytes to pixels, all in WASM.

### For the broader ecosystem:

A Rust-native PDFium alternative would be a landmark project. The strongest argument for it:
- **Security:** PDFium has had hundreds of CVEs. Rust eliminates memory safety bugs by construction.
- **WASM:** Native compilation vs Emscripten cross-compilation is a generational improvement in binary size and developer experience.
- **Embeddability:** A Cargo crate with feature flags is dramatically easier to integrate than PDFium's GN/Ninja build system.

The strongest argument against:
- **Scale:** 500K+ lines of battle-tested C++ cannot be replicated quickly or easily.
- **Fidelity:** PDFium renders billions of PDFs daily in Chrome. Matching that pixel-perfect fidelity takes years of edge-case fixes.
- **Existing investment:** `pdfium-render` already provides idiomatic Rust + WASM by wrapping PDFium directly.

### Bottom line:

**Start with Phase 1 as a standalone crate.** If it gains traction and community support, proceed incrementally. The wrapping approach (`pdfium-render`) remains the pragmatic choice for production use today, while a pure-Rust engine is the better long-term bet.

---

## Sources

- [PDFium source repository](https://pdfium.googlesource.com/pdfium/)
- [PDFium GitHub mirror](https://github.com/chromium/pdfium)
- [PDFium architecture overview (DeepWiki)](https://deepwiki.com/chromium/pdfium/1-overview)
- [PDFium build & dependencies (DeepWiki)](https://deepwiki.com/chromium/pdfium/1.1-building-and-dependencies)
- [pdfium-render crate](https://github.com/ajrcarey/pdfium-render)
- [lopdf](https://github.com/J-F-Liu/lopdf)
- [pdf-rs](https://github.com/pdf-rs/pdf)
- [pdf_oxide](https://github.com/yfedoseev/pdf_oxide)
- [printpdf](https://github.com/fschutt/printpdf)
- [PDF 2.0 specification info](https://www.loc.gov/preservation/digital/formats/fdd/fdd000474.shtml)
- [PDF Association — digital signatures](https://pdfa.org/pdf-and-digital-signatures/)
