# Next Steps — Per-Page Operations

## Current State

The deferred ops system (`PdfContext.tsx`) supports three per-page operations:
- **Rotate** — CSS `transform: rotate()`, works correctly
- **Crop** — positioned canvas in overflow:hidden card, bounding box resizes (**needs testing**)
- **Scale** — changes `baseAspect` via `effectiveScale()` (**not working correctly**)

All ops are stored as an ordered `PageOp[]` per page and flushed to WASM in linearized round-based order.

## Known Issues / Needs Testing

### Scale + Crop + Rotation composition
All three ops are now CSS-deferred. Needs manual testing for:
- Scale alone: bounding box should change aspect ratio, canvas stretches to fill
- Scale + rotation: bounding box should reflect both
- Scale + crop: canvas positioned for crop, stretched for scale
- All three combined

### Crop bounding box
The clip-path approach was replaced with positioned canvas (`width/height: 100/crop.w/h %`) in an overflow:hidden card. Needs testing across thumbnails, full-size pages, and reorder view.

### ScaleOverlay UX
- The "maintain aspect ratio" checkbox uses the *original* page aspect, but if there's already a pending crop it should use the cropped aspect

## Files Changed (this session)

### Data Model
- `apps/web/src/PdfContext.tsx` — `PageOp` union type with `rotate | crop | scale`, ordered list per page, round-based flush, `effectiveRotation/Crop/Scale` helpers

### Rust Backend
- `crates/pdf-core/src/page_ops.rs` — `scale_page()`: wraps content in CTM, updates MediaBox
- `crates/pdf-wasm/src/lib.rs` — `scalePage` WASM binding
- `packages/pdf-wasm-pkg/pdf_wasm.d.ts` — TypeScript declaration (manual, needs `make wasm` to regenerate properly)

### Worker/Client
- `apps/web/src/worker.ts` — `scalePage` method
- `apps/web/src/pdf-worker-client.ts` — export `scalePage`

### UI Components
- `apps/web/src/components/ui/ScaleOverlay.tsx` — new: preset sizes (A3/A4/A5/Letter/Legal/Tabloid), custom mm inputs, aspect ratio lock
- `apps/web/src/components/ui/PageActions.tsx` — `PageMenuOverlay` dropdown (top-right, ellipsis icon) with Crop, Scale, Compress (stub). Rotate icons changed to Lucide `rotate-cw-square`/`rotate-ccw-square`
- `apps/web/src/components/ui/CropOverlay.tsx` — returns `CropRect` (fractional) instead of PDF points, accepts `initialCrop` prop
- `apps/web/src/components/ui/DocumentViewer.tsx` — wired up scale target/overlay, uses `effectiveScale` for baseAspect, crop uses positioned canvas instead of clip-path
- `apps/web/src/components/ui/Thumbnail.tsx` — same pattern changes
- `apps/web/src/components/ui/ThumbnailGrid.tsx` — type updated to `PageOp[]`
- `apps/web/src/components/PdfReorder.tsx` — same pattern changes
- `apps/web/src/components/PdfSplit.tsx` — passes `pendingOps()` (type flows through)

## TODO

- [ ] Fix scale CSS preview (canvas must stretch to fill new aspect ratio)
- [ ] Test crop bounding box resize end-to-end
- [ ] Test scale + crop + rotation composition
- [ ] Run `make wasm` to regenerate WASM package (currently using manual .d.ts patch)
- [ ] Implement Compress in the page menu dropdown (stub exists)
- [ ] Consider adding undo for per-page ops (clear ops for a page)
