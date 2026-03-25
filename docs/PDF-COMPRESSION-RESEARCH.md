# pdf.maceiras.dev: PDF Compression Research

> **Date:** 2026-03-22
> **Status:** Research / Pre-Implementation
> **Goal:** Target-size-aware PDF compression that iteratively applies techniques in quality-preserving priority order

---

## 1. Feature Overview

The user sets a **target file size** (e.g., "under 5 MB"). The compressor applies techniques in a priority queue ordered by **quality impact** (least destructive first). After each technique, the file size is re-measured. The loop exits as soon as the target is met — or reports "best effort" if all techniques are exhausted.

### Priority Order (Least → Most Destructive)

| Priority | Technique | Typical Savings | Quality Impact |
|----------|-----------|-----------------|----------------|
| 1 | Stream recompression (Flate level 9) | 5–15% | None |
| 2 | Object & xref stream packing | 11–38% | None |
| 3 | Unused object pruning | 1–10% | None |
| 4 | Metadata & markup stripping | 1–5% | Minimal |
| 5 | Image lossless recompression | 5–20% | None |
| 6 | Image downsampling (150 DPI) | 20–60% | Low–Medium |
| 7 | Font subsetting | 5–30% | None (visual) |
| 8 | Image lossy recompression (JPEG quality reduction) | 30–70% | Medium |
| 9 | Color conversion (grayscale) | 20–50% | High |
| 10 | Image downsampling (72 DPI) | 40–80% | High |
| 11 | Layer/transparency flattening | Variable | Medium–High |

---

## 2. Technique-by-Technique Analysis

### 2.1 Stream Recompression (Flate Level 9)

**What:** Decompress all Flate-encoded streams and recompress at maximum zlib level.

**lopdf API:**
```rust
// Decompress all streams in the document
doc.decompress();

// Recompress all streams
doc.compress();

// Or use SaveOptions for level control:
let options = SaveOptions::default()
    .compression_level(9);  // zlib 0-9, default 6
doc.save_with_options(&mut buf, options)?;
```

**Implementation difficulty:** ⭐ Trivial
- lopdf has `Document::compress()` and `Document::decompress()` built in.
- `Stream::compress()` / `Stream::decompress()` work per-stream.
- `Stream::filters()` returns the current filter chain.
- `SaveOptions::compression_level(9)` sets max zlib compression on save.

**Caveats:**
- DCTDecode (JPEG) and JPXDecode (JPEG2000) streams should NOT be re-Flate-compressed — they're already optimally encoded. Check `filters()` before recompressing.
- Font streams have `allows_compression = false` — lopdf respects this automatically.

---

### 2.2 Object & Cross-Reference Stream Packing

**What:** Use PDF 1.5+ object streams to pack multiple non-stream objects into compressed containers. Replace ASCII xref tables with binary xref streams.

**lopdf API:**
```rust
// One-liner for modern format:
doc.save_modern(&mut buf)?;

// Or fine-grained control:
let options = SaveOptions::default()
    .use_object_streams(true)
    .use_xref_streams(true)
    .max_objects_per_stream(200)
    .compression_level(9);
doc.save_with_options(&mut buf, options)?;
```

**Implementation difficulty:** ⭐ Trivial
- Entirely built into lopdf. `save_modern()` does everything.
- Savings of 11–38% reported in lopdf benchmarks, up to 61% on some files.

**Caveats:**
- Output is PDF 1.5+. Older viewers (pre-2004) won't open it. Acceptable for a modern web tool.

---

### 2.3 Unused Object Pruning

**What:** Remove orphaned objects not reachable from the document catalog — leftover from edits, incremental saves, or bad generators.

**lopdf API:**
```rust
// Remove unreferenced objects
doc.prune_objects();

// Renumber remaining objects to eliminate gaps
doc.renumber_objects();

// Delete zero-length streams (empty content)
doc.delete_zero_length_streams();
```

**Implementation difficulty:** ⭐ Trivial
- All methods are built into lopdf.
- `prune_objects()` traverses from the trailer and removes anything unreachable.
- Safe to run on any document.

---

### 2.4 Metadata & Markup Stripping

**What:** Remove elements that don't affect visual rendering: bookmarks, annotations (links, comments, highlights), form fields, JavaScript, embedded files, XMP metadata, document info beyond basics.

**lopdf API:**
```rust
// Remove all annotations from a page
let annot_ids = doc.get_page_annotations(page_id);
for annot_id in annot_ids {
    doc.remove_annot(annot_id)?;
}

// Remove the Outlines (bookmarks) tree
if let Ok(Object::Reference(outlines_id)) = doc.catalog()?.get(b"Outlines") {
    // Recursively delete outline tree
    doc.delete_object(outlines_id);
}
doc.catalog_mut()?.remove(b"Outlines");

// Remove AcroForm (interactive forms)
doc.catalog_mut()?.remove(b"AcroForm");

// Remove document-level JavaScript
doc.catalog_mut()?.remove(b"Names");  // or selectively remove JS entries

// Remove XMP metadata stream
doc.catalog_mut()?.remove(b"Metadata");

// Strip Info dict to bare minimum
// (keep Title/Author, remove Creator/Producer/timestamps)
```

**Implementation difficulty:** ⭐⭐ Easy
- lopdf provides `get_page_annotations()`, `remove_annot()`, and full dictionary manipulation.
- Requires iterating pages for per-page cleanup.
- Need to be careful not to remove structural entries from the catalog.
- The main work is knowing *which* keys to strip — the PDF spec defines many optional entries.

**Keys to strip from catalog:**
- `Outlines` — bookmarks/TOC
- `AcroForm` — interactive forms
- `Metadata` — XMP metadata stream
- `Names` → `JavaScript` — document JS
- `Names` → `EmbeddedFiles` — attached files
- `OpenAction` — auto-run actions
- `AA` — additional actions (on pages too)

**Keys to strip from page dictionaries:**
- `Annots` — annotations (links, comments, stamps)
- `AA` — page-level actions
- `StructParents` — accessibility tags (if user opts in)

---

### 2.5 Image Lossless Recompression

**What:** Find image XObject streams that use suboptimal encoding (uncompressed, LZW, or ASCII-based filters) and re-encode with Flate or keep DCT/JPX as-is.

**How to find images with lopdf:**
```rust
for (obj_id, obj) in &doc.objects {
    if let Object::Stream(ref stream) = obj {
        let dict = &stream.dict;
        let is_image = dict.get(b"Subtype")
            .and_then(|v| v.as_name().ok())
            .map(|n| n == b"Image")
            .unwrap_or(false);

        if is_image {
            let filters = stream.filters();
            let width = dict.get(b"Width")?.as_i64()?;
            let height = dict.get(b"Height")?.as_i64()?;
            let bpc = dict.get(b"BitsPerComponent")?.as_i64()?;
            let cs = dict.get(b"ColorSpace")?.as_name()?;
            // Decide whether to recompress...
        }
    }
}
```

**Implementation difficulty:** ⭐⭐ Easy
- Iterate `doc.objects`, check `Subtype == Image`.
- For streams with no filter or ASCII filters: decompress, recompress with Flate.
- Skip streams already using DCTDecode or JPXDecode.
- Use `stream.set_plain_content(bytes)` then `stream.compress()`.

**Caveats:**
- Must update the stream's `/Filter` entry in the dictionary.
- Some images have `/SMask` (alpha channel) as a separate stream — handle both.

---

### 2.6 Image Downsampling (150 DPI → 72 DPI)

**What:** Reduce image pixel dimensions so they match the on-page display size at a target DPI. A 3000×2000 image displayed at 5×3.33 inches at 150 DPI only needs 750×500 pixels.

**How to calculate current DPI:**
```
DPI = image_pixels / (display_inches)
display_inches = page_units / 72  (PDF uses 72 units/inch)
```
The image's display size comes from the CTM (current transformation matrix) in the page's content stream, or from the page's MediaBox if the image fills the page.

**Implementation approach:**
1. Extract raw image bytes from stream (`stream.get_plain_content()`)
2. Decode with the `image` crate
3. Calculate effective DPI from image dimensions vs. display dimensions
4. If effective DPI > target DPI, resize using Lanczos3 filter
5. Re-encode as JPEG (for photographic) or PNG/Flate (for flat-color)
6. Replace stream content and update Width/Height/Filter in dictionary

**Required crates:**
```toml
[dependencies]
image = { version = "0.25", default-features = false, features = ["jpeg", "png"] }
```

**Implementation difficulty:** ⭐⭐⭐⭐ Hard
- **Image decoding** is the main challenge. PDF images aren't standard JPEG/PNG files — they're raw pixel data with separate colorspace, BPC, and filter metadata.
- **DCTDecode streams** are raw JPEG bitstreams (no JFIF header sometimes) — `image` crate can usually decode these.
- **Flate-decoded image streams** are raw pixel buffers — must reconstruct using Width × Height × BPC × components.
- **ColorSpace** handling is complex: can be `/DeviceRGB`, `/DeviceCMYK`, `/DeviceGray`, `/ICCBased`, `/Indexed`, `/CalGray`, `/CalRGB`, or arrays referencing other objects.
- **Display size detection** requires parsing the page content stream to find the `cm` (concat matrix) operator that positions the image, or falling back to MediaBox.
- **SMask** (soft mask / alpha) streams must be downsampled in parallel.
- **Inline images** (BI/ID/EI operators in content stream) are a separate path.

**WASM considerations:**
- The `image` crate compiles to WASM with `default-features = false`.
- Must disable multithreaded features.
- JPEG decode/encode is CPU-intensive; consider chunked processing with progress callbacks.

---

### 2.7 Font Subsetting

**What:** For each embedded font, determine which glyphs are actually used on pages, then strip unused glyphs from the font program to shrink it.

**How fonts are stored in PDF:**
```
Font Dictionary → /FontDescriptor → /FontFile (Type1) or /FontFile2 (TrueType) or /FontFile3 (CFF/OpenType)
```
The font program is a stream object containing the binary font data.

**Implementation approach:**
1. Find all font objects: iterate pages → Resources → Font dictionary
2. For each font, collect used glyphs by parsing content streams for `Tj`, `TJ`, `'`, `"` operators
3. Map character codes → glyph IDs using the font's `/Encoding` and `/ToUnicode` CMap
4. Extract the font stream bytes
5. Subset using `allsorts` crate
6. Replace the font stream and update `/FontDescriptor` lengths

**Required crates:**
```toml
[dependencies]
allsorts = "0.15"  # or allsorts-subset-browser for WASM
```

**Implementation difficulty:** ⭐⭐⭐⭐⭐ Very Hard
- **Glyph usage detection** requires a content stream parser that handles all text operators, encoding vectors, CMap tables, and composite fonts (CIDFont).
- **Font format diversity:** Type1, TrueType, OpenType/CFF, Type3 (procedural fonts — can't subset).
- **allsorts** handles TrueType and OpenType subsetting well, but Type1 fonts need a different approach.
- **CIDFont + CMap** combinations (common in Asian-language PDFs) are significantly more complex.
- **Encoding pitfalls:** PDFs can use custom encodings, `Differences` arrays, and predefined encodings (WinAnsi, MacRoman, etc.).
- **WASM compatibility:** `allsorts` is pure Rust and should compile to WASM, but the `allsorts-subset-browser` fork may be needed for edge cases.

**Recommendation:** Defer to a later phase. Focus on the techniques above it in priority. Font subsetting alone could be a multi-week project for robust handling.

---

### 2.8 Image Lossy Recompression (JPEG Quality Reduction)

**What:** Re-encode photographic images at lower JPEG quality. A quality of 60-75 is often visually indistinguishable for most content while saving 40-70%.

**Implementation approach:**
1. Same image extraction as §2.6
2. Decode image to pixel buffer
3. Re-encode as JPEG with quality parameter (e.g., 85 → 65 → 45 in progressive passes)
4. Replace stream, set filter to `/DCTDecode`

**Required crates:** Same as §2.6 (`image` crate with jpeg feature).

**Implementation difficulty:** ⭐⭐⭐ Medium
- Same image extraction challenges as downsampling.
- Quality selection strategy: start at 75, check size, drop to 60, then 45.
- Must preserve CMYK images (convert to RGB first or skip).
- For images that are already JPEG: decode → re-encode at lower quality (generation loss, but acceptable at ≥60).

---

### 2.9 Color Conversion (RGB/CMYK → Grayscale)

**What:** Convert color images to 8-bit grayscale, reducing data by 66% (RGB→Gray) or 75% (CMYK→Gray).

**Implementation approach:**
1. Extract image pixels
2. Convert using luminance formula: `Gray = 0.299R + 0.587G + 0.114B`
3. Replace stream with single-channel data
4. Update `/ColorSpace` to `/DeviceGray`, `/BitsPerComponent` to 8

**Implementation difficulty:** ⭐⭐⭐ Medium
- Pixel conversion is straightforward with the `image` crate.
- Must update the color space reference in the image dictionary.
- CMYK → Gray requires ICC-aware conversion for accuracy, or a simple formula: `Gray = 1 - min(1, 0.3C + 0.59M + 0.11Y + K)`.
- This is **destructive** — color information is permanently lost. Should be opt-in / last resort.
- Must also handle `/Indexed` (palette) color spaces by converting the palette.

---

### 2.10 Aggressive Image Downsampling (72 DPI)

Same as §2.6 but with target DPI of 72 (screen resolution). Applied only after 150 DPI downsampling didn't achieve the target.

**Implementation difficulty:** Same as §2.6. No additional code — just a parameter change.

---

### 2.11 Layer/Transparency Flattening

**What:** Merge Optional Content Groups (layers) into base content and pre-composite transparency effects into opaque results.

**How it works in PDF:**
- Layers are controlled by `/OCG` (Optional Content Group) markers in content streams and `/OCProperties` in the catalog.
- Transparency uses `/SMask`, `/CA`/`ca` (opacity), blend modes, and soft masks.
- Flattening renders the visual result and replaces complex structures with simple opaque content.

**Implementation difficulty:** ⭐⭐⭐⭐⭐ Very Hard (bordering impractical with lopdf alone)
- Requires a **full PDF renderer** to composit transparency correctly.
- lopdf is a structural library — it doesn't understand rendering semantics.
- Possible approach: use pdfium-render to rasterize pages, then create new image-only pages. But this converts vector content to raster, which defeats the purpose for text-heavy documents.
- **Recommendation:** Skip for v1. If needed, offer a "rasterize page" nuclear option that converts individual pages to images.

---

## 3. Dependency Matrix

| Technique | lopdf Built-in | Additional Crates | WASM Safe |
|-----------|---------------|-------------------|-----------|
| Stream recompression | ✅ `compress()`/`decompress()` | None | ✅ Yes |
| Object stream packing | ✅ `save_modern()` | None | ✅ Yes |
| Object pruning | ✅ `prune_objects()` | None | ✅ Yes |
| Metadata stripping | ✅ Dict manipulation | None | ✅ Yes |
| Image lossless recompress | ✅ Stream access | None | ✅ Yes |
| Image downsampling | ✅ Stream access | `image` (no default features) | ✅ Yes* |
| Font subsetting | ✅ Stream access | `allsorts` | ⚠️ Needs testing |
| Lossy JPEG recompress | ✅ Stream access | `image` | ✅ Yes* |
| Color → grayscale | ✅ Stream access | `image` | ✅ Yes* |
| Layer flattening | ❌ Needs renderer | `pdfium-render` | ⚠️ Complex |

\* `image` crate requires `default-features = false` for WASM. Disable rayon/threading features.

---

## 4. Proposed Implementation Phases

### Phase 1: Zero-Dependency Wins (lopdf only) — ~1–2 days

```rust
pub struct CompressOptions {
    pub target_size: Option<usize>,  // bytes
    pub max_passes: u8,              // default: 1 for each technique
}
```

**Techniques applied (always, in order):**
1. `doc.prune_objects()` + `doc.renumber_objects()` + `doc.delete_zero_length_streams()`
2. `doc.decompress()` then `doc.compress()` (recompress all streams at level 9)
3. Strip metadata (annotations, bookmarks, forms, XMP, JS, embedded files)
4. `doc.save_modern()` (object streams + xref streams)
5. Measure size → return if under target

**New files:**
- `crates/pdf-core/src/compress.rs`

**No new dependencies.**

### Phase 2: Image Optimization (add `image` crate) — ~3–5 days

**Techniques applied (if Phase 1 didn't hit target):**
5. Image lossless recompression (non-DCT/JPX → Flate)
6. Image downsampling to 150 DPI
7. Image lossy JPEG recompression (quality 75 → 60)
8. Image downsampling to 72 DPI
9. Image lossy JPEG recompression (quality 45)

**New dependencies:**
```toml
image = { version = "0.25", default-features = false, features = ["jpeg", "png"] }
```

**Biggest challenge:** Correctly extracting PDF image data and reconstructing it for the `image` crate. Need to handle:
- Flate-decoded raw pixels (Width × Height × components × BPC/8)
- DCTDecode (JPEG) passthrough
- ColorSpace resolution (direct name vs. indirect reference vs. array)

### Phase 3: Font Subsetting (add `allsorts`) — ~1–2 weeks

**Only if Phase 1+2 aren't sufficient for typical use cases.** This is the highest-effort technique and provides moderate savings only when fonts are large and mostly unused.

### Phase 4: Color Conversion — ~2–3 days (after Phase 2 infrastructure exists)

- RGB → Grayscale conversion as a final aggressive measure
- Reuses Phase 2 image extraction pipeline

---

## 5. Compression Loop Architecture

```
┌─────────────────────────────────────────────┐
│  Input: PDF bytes + target_size             │
├─────────────────────────────────────────────┤
│                                             │
│  1. Load document (lopdf)                   │
│  2. current_size = input.len()              │
│                                             │
│  for technique in priority_queue:           │
│    if current_size <= target_size: break     │
│    apply(technique, &mut doc)               │
│    current_size = doc.to_bytes().len()      │
│                                             │
│  3. Return compressed bytes + report        │
│     - original_size                         │
│     - final_size                            │
│     - techniques_applied: Vec<String>       │
│     - target_met: bool                      │
│                                             │
└─────────────────────────────────────────────┘
```

**Important:** Serializing after every technique (`doc.to_bytes()`) is necessary to get accurate size measurements but is expensive. Optimization: only serialize after *groups* of techniques (e.g., all structural cleanup as one pass, then measure; all image work as one pass, then measure).

### Return Type

```rust
pub struct CompressionResult {
    pub data: Vec<u8>,
    pub original_size: usize,
    pub compressed_size: usize,
    pub techniques_applied: Vec<String>,
    pub target_met: bool,
}
```

---

## 6. Key lopdf API Reference (v0.34)

Our project uses **lopdf 0.34**. Key APIs confirmed available:

| API | Purpose |
|-----|---------|
| `Document::compress()` | Compress all streams |
| `Document::decompress()` | Decompress all streams |
| `Document::prune_objects()` | Remove unreferenced objects |
| `Document::renumber_objects()` | Compact object IDs |
| `Document::delete_zero_length_streams()` | Remove empty streams |
| `Document::save_to(&mut buf)` | Serialize to writer |
| `Document::get_page_annotations(page_id)` | List annotation object IDs |
| `Document::remove_annot(annot_id)` | Delete an annotation |
| `Document::get_pages()` | Map of page number → object ID |
| `Document::get_object(id)` / `get_object_mut(id)` | Access objects |
| `Document::delete_object(id)` | Remove an object |
| `Stream::get_plain_content()` | Decompress and return bytes |
| `Stream::set_plain_content(bytes)` | Set content (auto-updates length) |
| `Stream::compress()` / `decompress()` | Per-stream compression |
| `Stream::filters()` | List current filters |
| `Stream::allows_compression` | Flag (false for fonts) |

**Note:** lopdf 0.34 may not have `save_modern()` / `SaveOptions` — those appear in 0.38+. We should consider upgrading to lopdf 0.39+ to get object stream support. If upgrading is not feasible, Phase 1 still works (just skip technique #2).

---

## 7. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| lopdf 0.34 lacks `save_modern()` | High | Medium | Upgrade to 0.39+ or skip object streams |
| Image extraction fails on exotic colorspaces | Medium | Medium | Fallback: skip unrecognized images |
| WASM binary size bloat from `image` crate | Medium | Low | `default-features = false`, only jpeg+png |
| Font subsetting breaks rendering | High | High | Defer to Phase 3, extensive testing |
| Lossy recompression degrades important visuals | Low | Medium | Conservative quality floor (≥45), user preview |
| Content stream parsing for DPI calc is brittle | Medium | Medium | Fallback: assume image fills MediaBox |

---

## 8. Recommendation

**Start with Phase 1** — it requires zero new dependencies, uses only proven lopdf APIs, and can deliver 15–40% savings on typical PDFs through structural optimization alone.

**Phase 2 is the high-impact phase** — image optimization is where the biggest wins are for most real-world PDFs (which are image-heavy). Budget 3–5 days and start with JPEG-only handling (DCTDecode streams), which is the simplest path since JPEG bytes can be decoded/re-encoded directly without PDF-specific pixel reconstruction.

**Defer Phase 3 (font subsetting)** unless users report large files where fonts are the dominant size contributor.

**Skip Phase 4 (layer flattening)** — the implementation cost vs. benefit ratio is poor, and it risks degrading vector content quality.

---

## 9. Subsequent Improvements

### WASM Multi-threading for JPEG 2000

The `justjp2` crate uses `rayon` for parallel tile encoding. On `wasm32-unknown-unknown`, rayon degrades to single-threaded execution. To preserve multi-threading in the browser:

- Use [`wasm-bindgen-rayon`](https://github.com/nicholastmosher/wasm-bindgen-rayon) to bridge rayon's thread pool to Web Workers
- Requires `SharedArrayBuffer` and `Cross-Origin-Isolation` headers (already in use for our render pool)
- Expected to significantly speed up JPEG 2000 encoding for large images
- Implementation: add `wasm-bindgen-rayon` to pdf-wasm, configure rayon's global thread pool at init time

### Current Compression Pipeline (as implemented)

```
Phase 1 (lossless, lopdf only):
  1. Prune unused objects
  2. Recompress streams (Flate 9)
  3. Strip metadata/annotations
  4. Lossless image recompression

Phase 2 (image optimization):
  5. DPI steps down to 200 (print-quality floor, 50 DPI increments)
  6. JPEG 2000 re-encoding (lossy, via justjp2)
  7. JPEG quality 75
  8. JPEG quality 55
  9. Grayscale conversion
  --- quality barrier ---
  10. DPI steps below 200 → 72 (last resort, labeled "below print quality")
```

---

## Sources

- [lopdf GitHub Repository](https://github.com/J-F-Liu/lopdf)
- [lopdf Document API](https://docs.rs/lopdf/latest/lopdf/struct.Document.html)
- [lopdf Stream API](https://docs.rs/lopdf/latest/lopdf/struct.Stream.html)
- [lopdf xobject module](https://docs.rs/lopdf/latest/lopdf/xobject/index.html)
- [allsorts Font Subsetting](https://github.com/yeslogic/allsorts)
- [allsorts-subset-browser](https://docs.rs/allsorts-subset-browser/latest/allsorts_subset_browser/)
- [image crate](https://github.com/image-rs/image)
- [Datalogics: PDF Image Downsampling and Recompression](https://www.datalogics.com/blog-pdf-optimizer-downsampling)
- [Artifex: Optimizing PDF File Size with PyMuPDF](https://artifex.com/blog/optimizing-pdf-file-size-with-pymupdf-three-essential-techniques)
- [Nitro: Image Optimization Settings](https://www.gonitro.com/user-guide/pro/article/image-optimization-settings)
