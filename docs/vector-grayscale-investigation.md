# Vector Grayscale — Investigation & Black Box Bug

## Status: Hidden from UI (2026-03-28)

Vector grayscale is implemented but hidden from the UI due to a rendering bug that
produces black boxes on certain PDFs. The code is retained for future work.

---

## How it works

The vector grayscale approach rewrites PDF content streams at the byte level to
convert color operators to their grayscale equivalents, preserving text
selectability, vector scalability, and PDF structure.

### Content stream rewriting (`grayscale.rs`)

- Byte-level tokenizer parses content streams without a full decode/encode cycle
- Rewrites color operators: `rg`/`RG` (RGB), `k`/`K` (CMYK), `sc`/`scn`/`SC`/`SCN`
- Tracks `cs`/`CS` state to resolve named color spaces for `scn`/`SCN`
- Recurses into Form XObjects (nested content streams via `Do` operator)
- Builds color space map from page Resources to determine component counts
- Handles ICCBased (/N), CalRGB, CalGray, Lab, Separation, DeviceN
- Skips patterns and indexed color spaces (can't safely convert)
- Luminance formula: L = 0.299*R + 0.587*G + 0.114*B (ITU-R BT.601)

### Image grayscale (separate, in `image_opt.rs`)

- Handled by the compression pipeline via `process_images_single_pass`
- Decodes JPEG/Flate images, converts via `image` crate `.grayscale()`, re-encodes
- Skips images with SMask (alpha/transparency) — they complicate things
- Skips 1-bit images (masks, scanned text)
- Supports JPEG 2000 via `justjp2` crate (some files fail to decode)

---

## Known bugs

### Black box on SEBASTIAN-ACTA-NACIMIENTO-DIGITAL-MEXICO.pdf

**Symptom:** A rectangular area of the page turns completely black after vector
grayscale conversion.

**Test PDF structure (page 1):**
- Background: `/img0` = (4,0) — 1700x2200 RGB JPEG, placed via `585 0 0 775 15 2 cm`
- Barcodes: 5 Form XObjects (Xf1–Xf5) containing small rectangles with `0 0 0 rg`
- Logo: `/img2` = (13,0) — 125x125 RGB JPEG
- Overlay: `/img4` = (15,0) — 250x171 RGB, 147 bytes FlateDecode, **has SMask=(14,0)**
  - The SMask (14,0) is 250x171 DeviceGray, 3782 bytes
  - 147 compressed bytes for 128KB raw = solid/near-solid color with alpha mask
- Small images: (8,0) = 1x1 Indexed, (16,0) = 73x73 RGB JPEG

**Content stream analysis:**
- 114 operators rewritten — ALL are neutral grays:
  - `0 0 0 rg` → `0 g` (black)
  - `0.8 0.8 0.8 rg` → `0.8 g` (light gray)
  - `1 1 1 rg` → `1 g` (white)
  - `0 0 0 RG` → `0 G` (black stroke)
- One actual color: `1 0.2 0.2 rg` (reddish) at end of stream
- Converting neutral grays should produce visually identical output

**Investigation performed:**
1. Staged PDF generation (content-only, images-only, both combined)
2. Full image dictionary dumps before/after conversion
3. Content stream operator analysis
4. Form XObject inspection (all use `0 0 0 rg` — trivial)
5. Confirmed `strip_image_smasks` removal did NOT fix the bug

**Images converted:** (4,0), (13,0), (16,0) — the 3 RGB images without SMask
**Images skipped:** (8,0) Indexed, (14,0) Gray, (15,0) has SMask

**Key observations:**
- Image (15,0) has SMask and is NOT touched by grayscale — so it's not the cause
- Image (4,0) originally uses `[/ICCBased 3 0 R]` color space; after conversion it
  becomes `/DeviceGray` with a completely new dict (all original properties dropped)
- The `replace_image_as_jpeg` function creates an entirely new stream dictionary,
  dropping ALL original properties except dimensions and basic image fields

### Next steps to investigate

1. **Check if lopdf save itself corrupts the PDF:** A `SEBASTIAN-save-only.pdf` was
   generated (load + save, no modifications). Open it to verify baseline rendering.

2. **Isolate which image conversion causes the bug:** Generate PDFs with only one
   image converted at a time: (4,0) alone, (13,0) alone, (16,0) alone. This requires
   making `decode_pdf_image`, `estimate_single_image_quality`, and
   `replace_image_as_jpeg` public (or adding pub wrappers).

3. **Check ICCBased → DeviceGray transition:** Image (4,0) uses an ICCBased color
   profile. When replaced with a DeviceGray JPEG, the ICC profile stream (3,0) becomes
   an orphan. Some PDF viewers might have issues if the page Resources still reference
   the ICC profile but the image no longer uses it.

4. **Preserve original dict properties:** `replace_image_as_jpeg` creates a brand new
   dict. Consider instead modifying the existing dict in-place (update ColorSpace,
   Filter, content) to preserve any properties the viewer might depend on.

5. **Test in different viewers:** The black box might be viewer-specific. Test in
   Chrome's built-in viewer, Firefox, Preview.app, and Adobe Reader.

6. **Check if the bug is in content stream rewriting or image conversion:** The staged
   PDFs exist at `~/Downloads/SEBASTIAN-stage{1,2,3}-*.pdf`. Open stage1 (content
   only) and stage2 (images only) separately to determine which causes the black box.

### ADRIAN-ACTA-NACIMIENTO-MEXICO.pdf — untouched by vector grayscale

**Root cause identified:** All content stream colors are already grayscale (`g`
operator). The only colored element is image (82,0) which uses JPXDecode (JPEG 2000).
The `justjp2` crate fails with "encoded tile header truncated" and the `image` crate
also can't decode it. This specific JP2 file is incompatible with all available
pure-Rust decoders. **Solution:** Use rasterize mode for this PDF, or integrate a more
capable JP2 decoder.

---

## Code locations

| File | Role |
|------|------|
| `crates/pdf-core/src/grayscale.rs` | Content stream rewriting (byte-level tokenizer + rewriter) |
| `crates/pdf-core/src/image_opt.rs` | Image decode/grayscale/re-encode, `collect_images`, `process_images_single_pass` |
| `crates/pdf-core/src/compress.rs` | Compression pipelines that orchestrate grayscale conversion |
| `apps/web/src/components/PdfCompress.tsx` | UI — vector option hidden, rasterize still available |

## Double grayscaling fix (2026-03-28)

`convert_document_to_grayscale` is now the single self-contained entry point for all
grayscale conversion — it handles both content stream rewriting AND image conversion.
The compression pipelines call it once and pass `grayscale=false` to any subsequent
image processing steps, preventing double conversion.
