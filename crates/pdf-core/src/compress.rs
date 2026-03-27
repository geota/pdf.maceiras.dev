use lopdf::{dictionary, Document, Object, ObjectId, Stream};
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};

use crate::error::{PdfError, Result};
use crate::image_opt::ImageTaskResult;

// =========================================================================
// Types
// =========================================================================

/// Compression preset that maps to fixed DPI + JPEG quality settings.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum CompressionPreset {
    #[default]
    Lossless,
    Low,
    Medium,
    High,
    Advanced,
}

/// Advanced sub-mode: either direct settings or target-size-based iteration.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "mode")]
pub enum AdvancedMode {
    /// User specifies exact DPI and/or encoding settings.
    #[serde(rename = "direct")]
    Direct {
        #[serde(default)]
        dpi: Option<f64>,
        /// Mutually exclusive with `jp2`.
        #[serde(default)]
        jpeg_quality: Option<u8>,
        /// Mutually exclusive with `jpeg_quality`.
        #[serde(default)]
        jp2: bool,
    },
    /// System iteratively reduces quality until target size is reached.
    #[serde(rename = "target_size")]
    TargetSize {
        #[serde(deserialize_with = "deserialize_f64_as_usize")]
        target_bytes: usize,
        #[serde(default = "default_min_dpi")]
        min_dpi: f64,
        #[serde(default = "default_min_jpeg_quality")]
        min_jpeg_quality: u8,
        /// Use JP2 instead of JPEG quality stepping.
        #[serde(default)]
        jp2: bool,
    },
}

/// User-configurable compression options.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompressOptions {
    #[serde(default)]
    pub preset: CompressionPreset,
    /// Strip metadata, annotations, bookmarks. Top-level, applies to all presets.
    #[serde(default = "default_true")]
    pub strip_metadata: bool,
    /// Convert images to grayscale. Top-level, applies to all presets.
    #[serde(default)]
    pub grayscale: bool,
    /// Advanced sub-mode. Only used when `preset == Advanced`.
    #[serde(default)]
    pub advanced: Option<AdvancedMode>,
    /// 0-based page indices for per-page image operations. If None, all pages.
    #[serde(default)]
    pub selected_pages: Option<Vec<u32>>,
}

fn default_true() -> bool { true }
fn default_min_dpi() -> f64 { 72.0 }
fn default_min_jpeg_quality() -> u8 { 45 }

/// Accept JS f64 and convert to usize (JS numbers are always f64).
fn deserialize_f64_as_usize<'de, D>(deserializer: D) -> std::result::Result<usize, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let val: f64 = Deserialize::deserialize(deserializer)?;
    Ok(val as usize)
}

impl Default for CompressOptions {
    fn default() -> Self {
        Self {
            preset: CompressionPreset::Lossless,
            strip_metadata: true,
            grayscale: false,
            advanced: None,
            selected_pages: None,
        }
    }
}

/// Resolved lossy settings ready for the pipeline (not user-facing).
struct ResolvedSettings {
    dpi: Option<f64>,
    jpeg_quality: Option<u8>,
    jp2: bool,
}

impl CompressOptions {
    /// Resolve preset + top-level options into flat settings for non-target-size modes.
    fn resolve(&self) -> ResolvedSettings {
        let (dpi, jpeg_quality, jp2) = match &self.preset {
            CompressionPreset::Lossless => (None, None, false),
            CompressionPreset::Low => (Some(200.0), Some(80), false),
            CompressionPreset::Medium => (Some(150.0), Some(65), false),
            CompressionPreset::High => (Some(100.0), Some(45), false),
            CompressionPreset::Advanced => match &self.advanced {
                Some(AdvancedMode::Direct { dpi, jpeg_quality, jp2 }) => {
                    (*dpi, *jpeg_quality, *jp2)
                }
                // TargetSize is handled separately; this shouldn't be called for it
                _ => (None, None, false),
            },
        };
        ResolvedSettings { dpi, jpeg_quality, jp2 }
    }

    /// Build the per-page image filter set, or None if all pages are selected.
    fn page_image_filter(&self, doc: &Document) -> Option<HashSet<ObjectId>> {
        self.selected_pages.as_ref().map(|pages| {
            crate::image_opt::collect_image_ids_for_pages(doc, pages)
        })
    }
}

/// Result of a compression operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompressionResult {
    pub original_size: usize,
    pub compressed_size: usize,
    pub techniques_applied: Vec<String>,
    /// Whether the target size was met (only meaningful for target-size mode).
    pub target_met: bool,
}

/// PDF analysis information surfaced to the user.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PdfAnalysis {
    pub max_dpi: Option<f64>,
    pub estimated_jpeg_quality: Option<u8>,
    pub jpeg_image_count: u32,
    pub non_jpeg_image_count: u32,
    pub total_image_count: u32,
}

/// Per-page image analysis (surfaced to UI for page stats and used for compress filtering).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PageAnalysis {
    pub image_count: u32,
    pub max_dpi: Option<f64>,
    pub estimated_jpeg_quality: Option<u8>,
    /// Estimated byte size of image streams on this page.
    pub estimated_image_bytes: usize,
    /// XObject IDs on this page — [obj_num, obj_gen] pairs for JS interop.
    pub image_ids: Vec<[u32; 2]>,
}

/// Detailed analysis: global summary + per-page breakdown.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetailedAnalysis {
    pub summary: PdfAnalysis,
    pub pages: Vec<PageAnalysis>,
}

/// Analyze a PDF and return image statistics without modifying it.
pub fn analyze_pdf(data: &[u8]) -> Result<PdfAnalysis> {
    Ok(analyze_pdf_detailed(data)?.summary)
}

/// Detailed analysis: global summary + per-page image stats.
/// Traverses the page tree and image objects exactly once.
pub fn analyze_pdf_detailed(data: &[u8]) -> Result<DetailedAnalysis> {
    let doc = Document::load_mem(data)
        .map_err(|e| PdfError::InvalidPdf(e.to_string()))?;

    let images = crate::image_opt::collect_images(&doc);
    let page_image_map = crate::image_opt::build_page_image_map(&doc);
    let page_dims = crate::image_opt::collect_page_dims(&doc);

    // Index images by ObjectId for O(1) lookup
    let image_index: std::collections::HashMap<ObjectId, &crate::image_opt::PdfImage> =
        images.iter().map(|img| (img.id, img)).collect();

    // Global stats (accumulated while building per-page)
    let mut global_max_dpi: Option<f64> = None;
    let mut global_best_quality: Option<u8> = None;
    let mut global_jpeg_count = 0u32;
    let mut global_non_jpeg_count = 0u32;

    let mut page_analyses = Vec::with_capacity(page_image_map.len());

    for (page_idx, xobj_ids) in page_image_map.iter().enumerate() {
        let (page_w, page_h) = page_dims.get(page_idx).copied().unwrap_or((612.0, 792.0));
        let mut page_max_dpi: Option<f64> = None;
        let mut page_best_quality: Option<u8> = None;
        let mut page_image_count = 0u32;
        let mut page_image_bytes = 0usize;
        let mut page_ids = Vec::new();

        for &xobj_id in xobj_ids {
            let Some(img) = image_index.get(&xobj_id) else { continue };
            page_image_count += 1;
            page_ids.push([xobj_id.0, xobj_id.1 as u32]);

            // DPI for this image on this page
            let dpi_x = img.width as f64 / (page_w / 72.0);
            let dpi_y = img.height as f64 / (page_h / 72.0);
            let eff_dpi = dpi_x.max(dpi_y);
            page_max_dpi = Some(page_max_dpi.map_or(eff_dpi, |m: f64| m.max(eff_dpi)));
            global_max_dpi = Some(global_max_dpi.map_or(eff_dpi, |m: f64| m.max(eff_dpi)));

            // Stream size estimate
            if let Some(Object::Stream(s)) = doc.objects.get(&xobj_id) {
                page_image_bytes += s.content.len();

                // JPEG quality estimate
                if img.is_dct {
                    let q = crate::image_opt::estimate_quality_from_dqt(&s.content);
                    if let Some(q) = q {
                        page_best_quality = Some(page_best_quality.map_or(q, |prev: u8| prev.max(q)));
                        global_best_quality = Some(global_best_quality.map_or(q, |prev: u8| prev.max(q)));
                    }
                }
            }

            if img.is_dct { global_jpeg_count += 1; } else { global_non_jpeg_count += 1; }
        }

        page_analyses.push(PageAnalysis {
            image_count: page_image_count,
            max_dpi: page_max_dpi,
            estimated_jpeg_quality: page_best_quality,
            estimated_image_bytes: page_image_bytes,
            image_ids: page_ids,
        });
    }

    Ok(DetailedAnalysis {
        summary: PdfAnalysis {
            max_dpi: global_max_dpi,
            estimated_jpeg_quality: global_best_quality,
            jpeg_image_count: global_jpeg_count,
            non_jpeg_image_count: global_non_jpeg_count,
            total_image_count: global_jpeg_count + global_non_jpeg_count,
        },
        pages: page_analyses,
    })
}

// =========================================================================
// Compression pipeline
// =========================================================================

/// Compress a PDF with the given options.
pub fn compress_bytes(data: &[u8], opts: &CompressOptions) -> Result<(Vec<u8>, CompressionResult)> {
    let original_size = data.len();

    log::info!(
        "[compress] start: {} bytes, preset: {:?}, strip_metadata: {}, grayscale: {}",
        original_size, opts.preset, opts.strip_metadata, opts.grayscale
    );

    let mut doc = Document::load_mem(data)
        .map_err(|e| PdfError::InvalidPdf(e.to_string()))?;

    let mut techniques = Vec::new();

    // Determine pipeline shape before starting
    let is_target_size = opts.preset == CompressionPreset::Advanced
        && matches!(&opts.advanced, Some(AdvancedMode::TargetSize { .. }));
    let resolved = opts.resolve();
    let is_lossy = resolved.dpi.is_some() || resolved.jpeg_quality.is_some() || resolved.jp2;

    // =======================================================================
    // Phase 1: Structural lossless (always applied)
    // =======================================================================
    apply_lossless_structural(&mut doc, opts.strip_metadata, &mut techniques);

    // =======================================================================
    // Phase 2: Image processing
    // =======================================================================
    if is_target_size {
        // Target-size path: apply grayscale first (filtered by selected pages), then iterative loop
        if opts.grayscale {
            log::info!("[compress] converting to grayscale...");
            let images = crate::image_opt::collect_images(&doc);
            let allowed = opts.page_image_filter(&doc);
            let stats = crate::image_opt::process_images_single_pass(
                &mut doc, &images, &HashMap::new(), None, None, false, true, allowed.as_ref(),
            );
            if stats.grayscaled > 0 {
                let msg = format!("Converted {} images to grayscale", stats.grayscaled);
                log::info!("[compress] {msg}");
                techniques.push(msg);
            }
        }
        let (target_bytes, min_dpi, min_jpeg_quality, jp2) = match opts.advanced.as_ref().unwrap() {
            AdvancedMode::TargetSize { target_bytes, min_dpi, min_jpeg_quality, jp2 } => {
                (*target_bytes, *min_dpi, *min_jpeg_quality, *jp2)
            }
            _ => unreachable!(),
        };
        return compress_to_target(
            doc, original_size, target_bytes, min_dpi, min_jpeg_quality, jp2, techniques,
        );
    }

    if is_lossy || opts.grayscale {
        // Single-pass: grayscale + downsample + encode in one decode cycle
        log::info!("[compress] single-pass image processing...");
        let images = crate::image_opt::collect_images(&doc);
        let allowed = opts.page_image_filter(&doc);
        let page_sizes = crate::image_opt::collect_page_image_sizes(&doc);
        let stats = crate::image_opt::process_images_single_pass(
            &mut doc,
            &images,
            &page_sizes,
            resolved.dpi,
            resolved.jpeg_quality,
            resolved.jp2,
            opts.grayscale,
            allowed.as_ref(),
        );
        if stats.grayscaled > 0 {
            techniques.push(format!("Converted {} images to grayscale", stats.grayscaled));
        }
        if stats.downsampled > 0 {
            let dpi = resolved.dpi.unwrap_or(0.0) as u32;
            let label = if dpi < 200 { " (below print quality)" } else { "" };
            techniques.push(format!("Downsampled {} images to {} DPI{}", stats.downsampled, dpi, label));
        }
        if stats.recompressed_jp2 > 0 {
            techniques.push(format!("Re-encoded {} images as JPEG 2000", stats.recompressed_jp2));
        }
        if stats.recompressed_jpeg > 0 {
            let q = resolved.jpeg_quality.unwrap_or(80);
            techniques.push(format!("JPEG recompressed {} images (quality {})", stats.recompressed_jpeg, q));
        }
    } else {
        // Lossless only — apply lossless image ops (oxipng, flate recompress)
        log::info!("[compress] lossless image optimization...");
        apply_lossless_images(&mut doc, &mut techniques);
    }

    log::info!("[compress] finalizing...");
    finalize(doc, original_size, None, techniques)
}

// =========================================================================
// Parallel compression pipeline
// =========================================================================

/// State held between compress_begin and compress_finish calls.
/// Safe because WASM is single-threaded.
enum ParallelState {
    /// Intermediate state — document needs image results applied.
    InProgress {
        doc: Box<Document>,
        techniques: Vec<String>,
        original_size: usize,
    },
    /// Target-size iterative state — between steps.
    TargetSizeInProgress {
        doc: Box<Document>,
        techniques: Vec<String>,
        original_size: usize,
        target_bytes: usize,
        current_dpi: f64,
        next_dpi: f64,
        current_quality: f64,
        next_quality: f64,
        min_dpi: f64,
        min_quality: f64,
        jp2: bool,
        /// 0-based page indices for per-page filtering (None = all pages).
        selected_pages: Option<Vec<u32>>,
    },
    /// Already complete (target-size or no-op) — just return the result.
    Complete {
        output: Vec<u8>,
        result: CompressionResult,
    },
}

thread_local! {
    static PARALLEL_STATE: RefCell<Option<ParallelState>> = const { RefCell::new(None) };
}

/// Phase 1: structural lossless + extract image tasks for parallel processing.
///
/// If no parallel work is needed (lossless preset, target-size mode, no images),
/// returns `Ok(None)` after running the full sequential pipeline and storing
/// the result in the parallel state for `compress_finish` to retrieve.
///
/// If parallel work is needed, returns `Ok(Some(tasks))` and stores the
/// intermediate document state for `compress_finish`.
pub fn compress_begin(
    data: &[u8],
    opts: &CompressOptions,
) -> Result<Option<Vec<crate::image_opt::ImageTask>>> {
    let original_size = data.len();

    // Target-size and lossless-only presets run the full sequential pipeline
    let is_target_size = opts.preset == CompressionPreset::Advanced
        && matches!(&opts.advanced, Some(AdvancedMode::TargetSize { .. }));

    if is_target_size {
        return compress_target_begin(data, opts);
    }

    let mut doc = Document::load_mem(data)
        .map_err(|e| PdfError::InvalidPdf(e.to_string()))?;
    let mut techniques = Vec::new();

    log::info!(
        "[compress-parallel] phase1: {} bytes, preset: {:?}",
        original_size, opts.preset
    );

    // Structural lossless
    apply_lossless_structural(&mut doc, opts.strip_metadata, &mut techniques);

    // Determine if we need parallel image processing
    let resolved = opts.resolve();
    let is_lossy = resolved.dpi.is_some() || resolved.jpeg_quality.is_some() || resolved.jp2;

    if !is_lossy && !opts.grayscale {
        // Lossless — run Flate recompress sequentially, extract oxipng tasks for parallel
        log::info!("[compress-parallel] lossless: running Flate recompress inline...");
        let recompressed = recompress_images_lossless(&mut doc);
        if recompressed > 0 {
            let msg = format!("Losslessly recompressed {} images", recompressed);
            log::info!("[compress-parallel] {msg}");
            techniques.push(msg);
        }

        // Extract lossless tasks for oxipng parallelization
        let images = crate::image_opt::collect_images(&doc);
        let allowed = opts.page_image_filter(&doc);
        let lossless_tasks = crate::image_opt::extract_lossless_image_tasks(&doc, &images, allowed.as_ref());

        PARALLEL_STATE.with(|state| {
            *state.borrow_mut() = Some(ParallelState::InProgress { doc: Box::new(doc), techniques, original_size });
        });

        if lossless_tasks.is_empty() {
            return Ok(None);
        }

        log::info!("[compress-parallel] lossless: extracted {} oxipng tasks", lossless_tasks.len());
        return Ok(Some(lossless_tasks));
    }

    // Extract image tasks for parallel processing
    let images = crate::image_opt::collect_images(&doc);
    let page_sizes = crate::image_opt::collect_page_image_sizes(&doc);
    let allowed = opts.page_image_filter(&doc);
    let tasks = crate::image_opt::extract_image_tasks(
        &doc,
        &images,
        &page_sizes,
        resolved.dpi,
        resolved.jpeg_quality,
        resolved.jp2,
        opts.grayscale,
        allowed.as_ref(),
    );

    if tasks.is_empty() {
        // No processable images
        PARALLEL_STATE.with(|state| {
            *state.borrow_mut() = Some(ParallelState::InProgress { doc: Box::new(doc), techniques, original_size });
        });
        return Ok(None);
    }

    log::info!("[compress-parallel] phase1: extracted {} image tasks", tasks.len());

    // Store intermediate state
    PARALLEL_STATE.with(|state| {
        *state.borrow_mut() = Some(ParallelState::InProgress { doc: Box::new(doc), techniques, original_size });
    });

    Ok(Some(tasks))
}

/// Phase 3: apply processed image results and finalize the document.
/// Call after distributing tasks from `compress_begin` across workers.
/// If `results` is empty (phase1 returned None), finalizes the lossless result.
pub fn compress_finish(
    results: Vec<ImageTaskResult>,
) -> Result<(Vec<u8>, CompressionResult)> {
    let state = PARALLEL_STATE.with(|state| {
        state.borrow_mut().take()
            .ok_or_else(|| PdfError::InvalidPdf("No compression in progress".into()))
    })?;

    // If already complete or target-size done, return directly
    let (mut doc, mut techniques, original_size) = match state {
        ParallelState::Complete { output, result } => {
            return Ok((output, result));
        }
        ParallelState::TargetSizeInProgress { doc, techniques, original_size, target_bytes, jp2, .. } => {
            // Target-size done with no more steps — apply JP2 if enabled and finalize
            let mut doc = *doc;
            if jp2 {
                let jp2_count = crate::image_opt::recompress_images_jpeg2000(&mut doc);
                let mut techniques = techniques;
                if jp2_count > 0 {
                    techniques.push(format!("Re-encoded {} images as JPEG 2000", jp2_count));
                }
                return finalize(doc, original_size, Some(target_bytes), techniques);
            }
            return finalize(doc, original_size, Some(target_bytes), techniques);
        }
        ParallelState::InProgress { doc, techniques, original_size } => {
            (*doc, techniques, original_size)
        }
    };

    if results.is_empty() {
        log::info!("[compress-parallel] phase3: no image results, finalizing lossless");
        return finalize(doc, original_size, None, techniques);
    }

    log::info!("[compress-parallel] phase3: applying {} image results", results.len());

    // Apply processed images back to the document
    let mut downsampled = 0usize;
    let mut grayscaled_count = 0usize;
    let mut reencoded_jpeg = 0usize;
    let mut reencoded_jp2 = 0usize;
    let mut oxipng_count = 0usize;

    for result in results {
        let id: ObjectId = (result.obj_num, result.obj_gen);

        let len = result.encoded_bytes.len() as i64;
        let mut new_dict = lopdf::dictionary! {
            "Type" => "XObject",
            "Subtype" => "Image",
            "Width" => Object::Integer(result.new_width as i64),
            "Height" => Object::Integer(result.new_height as i64),
            "ColorSpace" => Object::Name(result.color_space.clone().into_bytes()),
            "BitsPerComponent" => Object::Integer(8),
            "Filter" => Object::Name(result.filter_name.as_bytes().to_vec()),
            "Length" => Object::Integer(len),
        };

        // Add PNG predictor params for FlateDecode (lossless oxipng results)
        if result.filter_name == "FlateDecode" {
            if let Some(colors) = result.predictor_colors {
                let decode_parms = dictionary! {
                    "Predictor" => Object::Integer(15),
                    "Colors" => Object::Integer(colors as i64),
                    "BitsPerComponent" => Object::Integer(8),
                    "Columns" => Object::Integer(result.new_width as i64),
                };
                new_dict.set("DecodeParms", Object::Dictionary(decode_parms));
            }
        }

        let new_stream = Stream::new(new_dict, result.encoded_bytes);
        doc.objects.insert(id, Object::Stream(new_stream));

        if result.downsampled { downsampled += 1; }
        if result.grayscaled { grayscaled_count += 1; }
        if result.filter_name == "FlateDecode" && result.predictor_colors.is_some() {
            oxipng_count += 1;
        } else if result.reencoded {
            if result.filter_name == "JPXDecode" { reencoded_jp2 += 1; }
            else { reencoded_jpeg += 1; }
        }
    }

    if grayscaled_count > 0 {
        techniques.push(format!("Converted {} images to grayscale", grayscaled_count));
    }
    if downsampled > 0 {
        techniques.push(format!("Downsampled {} images", downsampled));
    }
    if reencoded_jp2 > 0 {
        techniques.push(format!("Re-encoded {} images as JPEG 2000", reencoded_jp2));
    }
    if reencoded_jpeg > 0 {
        techniques.push(format!("JPEG recompressed {} images", reencoded_jpeg));
    }
    if oxipng_count > 0 {
        techniques.push(format!("Oxipng-optimized {} images", oxipng_count));
    }

    finalize(doc, original_size, None, techniques)
}

/// Discard any in-progress parallel compression state.
pub fn compress_begin_cleanup() {
    PARALLEL_STATE.with(|state| {
        *state.borrow_mut() = None;
    });
}

// =========================================================================
// Target-size parallel pipeline
// =========================================================================

/// Begin target-size compression. Runs structural lossless + grayscale,
/// then returns the first iteration's image tasks (or None if already under target).
fn compress_target_begin(
    data: &[u8],
    opts: &CompressOptions,
) -> Result<Option<Vec<crate::image_opt::ImageTask>>> {
    let original_size = data.len();
    let mut doc = Document::load_mem(data)
        .map_err(|e| PdfError::InvalidPdf(e.to_string()))?;
    let mut techniques = Vec::new();

    apply_lossless_structural(&mut doc, opts.strip_metadata, &mut techniques);

    // Apply grayscale upfront if requested (filtered by selected pages)
    if opts.grayscale {
        let images = crate::image_opt::collect_images(&doc);
        let allowed = opts.page_image_filter(&doc);
        let stats = crate::image_opt::process_images_single_pass(
            &mut doc, &images, &HashMap::new(), None, None, false, true, allowed.as_ref(),
        );
        if stats.grayscaled > 0 {
            techniques.push(format!("Converted {} images to grayscale", stats.grayscaled));
        }
    }

    let (target_bytes, min_dpi, min_jpeg_quality, jp2) = match opts.advanced.as_ref().unwrap() {
        AdvancedMode::TargetSize { target_bytes, min_dpi, min_jpeg_quality, jp2 } => {
            (*target_bytes, *min_dpi, *min_jpeg_quality, *jp2)
        }
        _ => unreachable!(),
    };

    log::info!(
        "[compress-target] begin: target={} bytes, min_dpi={}, min_quality={}, jp2={}",
        target_bytes, min_dpi, min_jpeg_quality, jp2
    );

    // Check if already under target
    if estimate_under_target(&doc, target_bytes) {
        log::info!("[compress-target] already under target after structural lossless");
        let (output, result) = finalize(doc, original_size, Some(target_bytes), techniques)?;
        PARALLEL_STATE.with(|state| {
            *state.borrow_mut() = Some(ParallelState::Complete { output, result });
        });
        return Ok(None);
    }

    // Detect current DPI and quality
    let images = crate::image_opt::collect_images(&doc);
    let page_sizes = crate::image_opt::collect_page_image_sizes(&doc);
    let detected_dpi = crate::image_opt::detect_max_dpi(&images, &page_sizes);
    let detected_quality = crate::image_opt::estimate_jpeg_quality(&doc, &images);

    let current_dpi = detected_dpi.unwrap_or(0.0);
    let current_quality = detected_quality.unwrap_or(90) as f64;

    let mut next_dpi = (current_dpi / 50.0).floor() * 50.0;
    if next_dpi >= current_dpi * 0.9 {
        next_dpi -= 50.0;
    }
    let next_quality = ((current_quality / 10.0).floor() * 10.0) - 10.0;
    let min_quality = if jp2 { current_quality } else { min_jpeg_quality as f64 };

    // Try to extract tasks for the first step
    let allowed = opts.page_image_filter(&doc);
    let tasks = extract_target_step_tasks(
        &doc, &images, &page_sizes,
        current_dpi, next_dpi, min_dpi,
        current_quality, next_quality, min_quality, jp2,
        allowed.as_ref(),
    );

    PARALLEL_STATE.with(|state| {
        *state.borrow_mut() = Some(ParallelState::TargetSizeInProgress {
            doc: Box::new(doc),
            techniques,
            original_size,
            target_bytes,
            current_dpi,
            next_dpi,
            current_quality,
            next_quality,
            min_dpi,
            min_quality,
            jp2,
            selected_pages: opts.selected_pages.clone(),
        });
    });

    if tasks.is_empty() {
        // No more steps possible — finalize via compress_finish
        return Ok(None);
    }

    log::info!("[compress-target] first step: {} tasks", tasks.len());
    Ok(Some(tasks))
}

/// Apply results from a target-size step and compute the next step's tasks.
/// Returns `Ok(Some(tasks))` for the next step, or `Ok(None)` if done (target met
/// or no more steps). Call `compress_finish([])` to get the final result.
pub fn compress_target_step(
    results: Vec<ImageTaskResult>,
) -> Result<Option<Vec<crate::image_opt::ImageTask>>> {
    let state = PARALLEL_STATE.with(|state| {
        state.borrow_mut().take()
            .ok_or_else(|| PdfError::InvalidPdf("No target-size compression in progress".into()))
    })?;

    let (mut doc, mut techniques, original_size, target_bytes,
         mut current_dpi, mut next_dpi, mut current_quality, mut next_quality,
         min_dpi, min_quality, jp2, selected_pages) = match state {
        ParallelState::TargetSizeInProgress {
            doc, techniques, original_size, target_bytes,
            current_dpi, next_dpi, current_quality, next_quality,
            min_dpi, min_quality, jp2, selected_pages,
        } => (*doc, techniques, original_size, target_bytes,
              current_dpi, next_dpi, current_quality, next_quality,
              min_dpi, min_quality, jp2, selected_pages),
        _ => return Err(PdfError::InvalidPdf("Expected TargetSizeInProgress state".into())),
    };

    // Apply results from the previous step
    let mut step_downsampled = 0usize;
    let mut step_reencoded = 0usize;
    for result in &results {
        let id: ObjectId = (result.obj_num, result.obj_gen);
        let len = result.encoded_bytes.len() as i64;
        let mut new_dict = lopdf::dictionary! {
            "Type" => "XObject",
            "Subtype" => "Image",
            "Width" => Object::Integer(result.new_width as i64),
            "Height" => Object::Integer(result.new_height as i64),
            "ColorSpace" => Object::Name(result.color_space.clone().into_bytes()),
            "BitsPerComponent" => Object::Integer(8),
            "Filter" => Object::Name(result.filter_name.as_bytes().to_vec()),
            "Length" => Object::Integer(len),
        };
        if result.filter_name == "FlateDecode" {
            if let Some(colors) = result.predictor_colors {
                let decode_parms = dictionary! {
                    "Predictor" => Object::Integer(15),
                    "Colors" => Object::Integer(colors as i64),
                    "BitsPerComponent" => Object::Integer(8),
                    "Columns" => Object::Integer(result.new_width as i64),
                };
                new_dict.set("DecodeParms", Object::Dictionary(decode_parms));
            }
        }
        let new_stream = Stream::new(new_dict, result.encoded_bytes.clone());
        doc.objects.insert(id, Object::Stream(new_stream));
        if result.downsampled { step_downsampled += 1; }
        if result.reencoded { step_reencoded += 1; }
    }

    if step_downsampled > 0 {
        let dpi_label = current_dpi.min(next_dpi + 50.0);
        techniques.push(format!("Downsampled {} images to ~{} DPI", step_downsampled, dpi_label as u32));
    }
    if step_reencoded > 0 {
        techniques.push(format!("Recompressed {} images", step_reencoded));
    }

    // Advance the step
    let can_step_dpi = next_dpi >= min_dpi && current_dpi > min_dpi;
    let can_step_quality = !jp2 && next_quality >= min_quality && current_quality > min_quality;

    if can_step_dpi {
        current_dpi = next_dpi.max(min_dpi);
        next_dpi -= 50.0;
    }
    if can_step_quality {
        current_quality = next_quality.max(min_quality);
        next_quality -= 10.0;
    }

    // Check if under target
    if estimate_under_target(&doc, target_bytes) {
        log::info!("[compress-target] under target after step");
        let (output, result) = finalize(doc, original_size, Some(target_bytes), techniques)?;
        PARALLEL_STATE.with(|state| {
            *state.borrow_mut() = Some(ParallelState::Complete { output, result });
        });
        return Ok(None);
    }

    // Try the next step
    let images = crate::image_opt::collect_images(&doc);
    let page_sizes = crate::image_opt::collect_page_image_sizes(&doc);
    let allowed = selected_pages.as_ref().map(|pages| {
        crate::image_opt::collect_image_ids_for_pages(&doc, pages)
    });
    let tasks = extract_target_step_tasks(
        &doc, &images, &page_sizes,
        current_dpi, next_dpi, min_dpi,
        current_quality, next_quality, min_quality, jp2,
        allowed.as_ref(),
    );

    if tasks.is_empty() {
        // No more steps — try JP2 if enabled, then finalize
        if jp2 {
            let jp2_count = crate::image_opt::recompress_images_jpeg2000(&mut doc);
            if jp2_count > 0 {
                techniques.push(format!("Re-encoded {} images as JPEG 2000", jp2_count));
            }
        }
        let (output, result) = finalize(doc, original_size, Some(target_bytes), techniques)?;
        PARALLEL_STATE.with(|state| {
            *state.borrow_mut() = Some(ParallelState::Complete { output, result });
        });
        return Ok(None);
    }

    PARALLEL_STATE.with(|state| {
        *state.borrow_mut() = Some(ParallelState::TargetSizeInProgress {
            doc: Box::new(doc),
            techniques,
            original_size,
            target_bytes,
            current_dpi,
            next_dpi,
            current_quality,
            next_quality,
            min_dpi,
            min_quality,
            jp2,
            selected_pages,
        });
    });

    log::info!("[compress-target] next step: {} tasks, dpi={:.0}, quality={:.0}", tasks.len(), current_dpi, current_quality);
    Ok(Some(tasks))
}

/// Extract tasks for a single target-size iteration step.
#[allow(clippy::too_many_arguments)]
fn extract_target_step_tasks(
    doc: &Document,
    images: &[crate::image_opt::PdfImage],
    page_sizes: &HashMap<ObjectId, (f64, f64)>,
    current_dpi: f64,
    next_dpi: f64,
    min_dpi: f64,
    _current_quality: f64,
    next_quality: f64,
    min_quality: f64,
    jp2: bool,
    allowed_ids: Option<&HashSet<ObjectId>>,
) -> Vec<crate::image_opt::ImageTask> {
    let can_step_dpi = next_dpi >= min_dpi && current_dpi > min_dpi;
    let can_step_quality = !jp2 && next_quality >= min_quality;

    if !can_step_dpi && !can_step_quality {
        return Vec::new();
    }

    let target_dpi = if can_step_dpi { Some(next_dpi.max(min_dpi)) } else { None };
    let jpeg_quality = if can_step_quality { Some(next_quality.max(min_quality) as u8) } else { None };

    crate::image_opt::extract_image_tasks(
        doc, images, page_sizes,
        target_dpi, jpeg_quality, false, false,
        allowed_ids,
    )
}

// =========================================================================
// Target-size sequential pipeline (fallback)
// =========================================================================

/// Iteratively reduce DPI and JPEG quality to hit a target file size.
fn compress_to_target(
    mut doc: Document,
    original_size: usize,
    target_bytes: usize,
    min_dpi: f64,
    min_jpeg_quality: u8,
    jp2: bool,
    mut techniques: Vec<String>,
) -> Result<(Vec<u8>, CompressionResult)> {
    log::info!(
        "[compress] target-size mode: target={} bytes ({:.1} MB), min_dpi={}, min_jpeg_quality={}, jp2={}",
        target_bytes, target_bytes as f64 / 1_048_576.0, min_dpi, min_jpeg_quality, jp2
    );

    // Quick estimate check — avoids full serialization
    let est_size = estimate_size(&doc);
    log::info!("[compress] estimated size after structural lossless: {} bytes ({:.1} MB)", est_size, est_size as f64 / 1_048_576.0);

    if est_size <= target_bytes {
        log::info!("[compress] estimate under target after lossless phase!");
        return finalize(doc, original_size, Some(target_bytes), techniques);
    }

    // --- Interleaved DPI / JPEG quality reduction ---
    let images = crate::image_opt::collect_images(&doc);
    let page_sizes = crate::image_opt::collect_page_image_sizes(&doc);
    let detected_dpi = crate::image_opt::detect_max_dpi(&images, &page_sizes);
    let detected_quality = crate::image_opt::estimate_jpeg_quality(&doc, &images);

    let mut current_dpi = detected_dpi.unwrap_or(0.0);
    let mut current_quality = detected_quality.unwrap_or(90) as f64;

    log::info!("[compress] detected DPI: {:.0}, estimated JPEG quality: {:.0}", current_dpi, current_quality);

    let mut next_dpi = (current_dpi / 50.0).floor() * 50.0;
    if next_dpi >= current_dpi * 0.9 {
        next_dpi -= 50.0;
    }
    let mut next_quality = ((current_quality / 10.0).floor() * 10.0) - 10.0;

    let min_quality = if jp2 { current_quality } else { min_jpeg_quality as f64 }; // skip JPEG stepping if jp2

    loop {
        let can_step_dpi = next_dpi >= min_dpi && current_dpi > min_dpi;
        let can_step_quality = !jp2 && next_quality >= min_quality && current_quality > min_quality;

        if !can_step_dpi && !can_step_quality {
            break;
        }

        // Step DPI
        if can_step_dpi {
            let target_dpi = next_dpi.max(min_dpi);
            log::info!("[compress] downsampling to {} DPI...", target_dpi as u32);
            let downsampled = crate::image_opt::downsample_images(&mut doc, target_dpi);
            if downsampled > 0 {
                let label = if target_dpi < 200.0 { " (below print quality)" } else { "" };
                let msg = format!("Downsampled {} images to {} DPI{}", downsampled, target_dpi as u32, label);
                log::info!("[compress] {msg}");
                techniques.push(msg);
            }
            current_dpi = target_dpi;
            next_dpi -= 50.0;

            if estimate_under_target(&doc, target_bytes) {
                log::info!("[compress] estimate under target after downsample");
                return finalize(doc, original_size, Some(target_bytes), techniques);
            }
        }

        // Step JPEG quality (skipped when jp2 is enabled)
        if can_step_quality {
            let target_q = (next_quality.max(min_quality)) as u8;
            log::info!("[compress] JPEG recompressing at quality {}...", target_q);
            let recompressed = crate::image_opt::recompress_images_lossy(&mut doc, target_q);
            if recompressed > 0 {
                let msg = format!("JPEG recompressed {} images (quality {})", recompressed, target_q);
                log::info!("[compress] {msg}");
                techniques.push(msg);
            }
            current_quality = target_q as f64;
            next_quality -= 10.0;

            if estimate_under_target(&doc, target_bytes) {
                log::info!("[compress] estimate under target after JPEG recompress");
                return finalize(doc, original_size, Some(target_bytes), techniques);
            }
        }
    }

    // --- JP2 as final encoding step (if enabled) ---
    if jp2 {
        log::info!("[compress] JPEG 2000 re-encoding...");
        let jp2_count = crate::image_opt::recompress_images_jpeg2000(&mut doc);
        if jp2_count > 0 {
            let msg = format!("Re-encoded {} images as JPEG 2000", jp2_count);
            log::info!("[compress] {msg}");
            techniques.push(msg);
        }
    }

    log::info!("[compress] all techniques exhausted, finalizing...");
    finalize(doc, original_size, Some(target_bytes), techniques)
}

// =========================================================================
// Lossless phase (shared)
// =========================================================================

/// Structural lossless: prune objects, selective Flate recompression
/// (skips image streams — they'll be handled by image-specific ops),
/// and strip metadata.
fn apply_lossless_structural(doc: &mut Document, strip_metadata_flag: bool, techniques: &mut Vec<String>) {
    // Prune unused objects
    log::info!("[compress] pruning unused objects...");
    let objects_before = doc.objects.len();
    doc.delete_zero_length_streams();
    doc.prune_objects();
    doc.renumber_objects();
    let objects_after = doc.objects.len();
    if objects_after < objects_before {
        let msg = format!("Pruned {} unused objects", objects_before - objects_after);
        log::info!("[compress] {msg}");
        techniques.push(msg);
    }

    // Selective Flate recompression — skip image streams (they'll be
    // replaced by lossy encoding or processed by lossless image ops)
    log::info!("[compress] recompressing non-image streams (Flate)...");
    let mut flate_count = 0;
    for obj in doc.objects.values_mut() {
        if let Object::Stream(stream) = obj {
            let is_image = stream
                .dict
                .get(b"Subtype")
                .ok()
                .and_then(|v| v.as_name().ok())
                .is_some_and(|n| n == b"Image");
            if is_image {
                continue;
            }
            let _ = stream.decompress();
            if stream.compress().is_ok() {
                flate_count += 1;
            }
        }
    }
    if flate_count > 0 {
        techniques.push(format!("Recompressed {} non-image streams (Flate)", flate_count));
    }
    log::info!("[compress] estimated size: {:.1} MB", estimate_size(doc) as f64 / 1_048_576.0);

    // Strip metadata & non-visual elements
    if strip_metadata_flag {
        log::info!("[compress] stripping metadata...");
        let stripped = strip_metadata_objects(doc);
        if stripped > 0 {
            let msg = format!("Stripped {} metadata/annotation objects", stripped);
            log::info!("[compress] {msg}");
            techniques.push(msg);
        }
    }
}

/// Lossless image-specific ops: Flate recompress + oxipng.
/// Only called for Lossless preset (skipped when lossy encoding will replace images).
fn apply_lossless_images(doc: &mut Document, techniques: &mut Vec<String>) {
    log::info!("[compress] lossless image recompression...");
    let recompressed = recompress_images_lossless(doc);
    if recompressed > 0 {
        let msg = format!("Losslessly recompressed {} images", recompressed);
        log::info!("[compress] {msg}");
        techniques.push(msg);
    }

    log::info!("[compress] oxipng optimization...");
    let oxipng_count = crate::image_opt::recompress_images_oxipng(doc);
    if oxipng_count > 0 {
        let msg = format!("Oxipng-optimized {} images", oxipng_count);
        log::info!("[compress] {msg}");
        techniques.push(msg);
    }
}

// =========================================================================
// Helpers
// =========================================================================

/// Estimate document size by summing all stream content lengths + overhead.
fn estimate_size(doc: &Document) -> usize {
    let mut size: usize = 0;
    for obj in doc.objects.values() {
        match obj {
            Object::Stream(s) => {
                size += s.content.len();
                size += 200;
            }
            _ => size += 50,
        }
    }
    size
}

/// Check if estimated size is under target.
fn estimate_under_target(doc: &Document, target_bytes: usize) -> bool {
    estimate_size(doc) <= target_bytes
}

/// Serialize with modern format and return result.
fn finalize(
    mut doc: Document,
    original_size: usize,
    target_bytes: Option<usize>,
    techniques: Vec<String>,
) -> Result<(Vec<u8>, CompressionResult)> {
    let output = save_modern(&mut doc)?;
    let compressed_size = output.len();
    let target_met = target_bytes.is_none_or(|t| compressed_size <= t);

    log::info!(
        "[compress] done: {} -> {} bytes ({:.1}% reduction), target_met: {}",
        original_size, compressed_size,
        (1.0 - compressed_size as f64 / original_size as f64) * 100.0,
        target_met
    );

    Ok((
        output,
        CompressionResult {
            original_size,
            compressed_size,
            techniques_applied: techniques,
            target_met,
        },
    ))
}

/// Save using PDF 1.5+ object streams and xref streams for best structural compression.
fn save_modern(doc: &mut Document) -> Result<Vec<u8>> {
    let mut buf = Vec::new();
    let options = lopdf::SaveOptions::builder()
        .use_object_streams(true)
        .use_xref_streams(true)
        .compression_level(6)
        .build();
    doc.save_with_options(&mut buf, options)?;
    Ok(buf)
}

/// Strip annotations, bookmarks, forms, XMP metadata, JS, embedded files, and actions.
fn strip_metadata_objects(doc: &mut Document) -> usize {
    let mut removed = 0;

    let page_ids: Vec<ObjectId> = doc.get_pages().values().copied().collect();
    for page_id in page_ids {
        if let Ok(page) = doc.get_object_mut(page_id).and_then(|o| o.as_dict_mut()) {
            if page.has(b"Annots") {
                if let Ok(Object::Array(annots)) = page.get(b"Annots") {
                    removed += annots.len();
                }
                page.remove(b"Annots");
            }
            if page.has(b"AA") {
                page.remove(b"AA");
                removed += 1;
            }
        }
    }

    let catalog_keys_to_strip: &[&[u8]] = &[
        b"Outlines",
        b"AcroForm",
        b"Metadata",
        b"OpenAction",
        b"AA",
    ];

    if let Ok(catalog) = doc.catalog_mut() {
        for key in catalog_keys_to_strip {
            if catalog.has(key) {
                catalog.remove(key);
                removed += 1;
            }
        }

        if let Ok(Object::Reference(names_id)) = catalog.get(b"Names") {
            let names_id = *names_id;
            if let Ok(names) = doc.get_object_mut(names_id).and_then(|o| o.as_dict_mut()) {
                for key in &[b"JavaScript" as &[u8], b"EmbeddedFiles"] {
                    if names.has(key) {
                        names.remove(key);
                        removed += 1;
                    }
                }
            }
        }
    }

    doc.prune_objects();
    doc.renumber_objects();

    removed
}

/// Find image streams using suboptimal encoding and recompress with Flate.
fn recompress_images_lossless(doc: &mut Document) -> usize {
    let image_ids: Vec<ObjectId> = doc
        .objects
        .iter()
        .filter_map(|(&id, obj)| {
            if let Object::Stream(stream) = obj {
                let is_image = stream
                    .dict
                    .get(b"Subtype")
                    .ok()
                    .and_then(|v| v.as_name().ok())
                    .map(|n| n == b"Image")
                    .unwrap_or(false);

                if !is_image {
                    return None;
                }

                let dominated_by_lossy = stream.filters().is_ok_and(|filters| {
                    filters
                        .iter()
                        .any(|f| f == b"DCTDecode" || f == b"JPXDecode")
                });

                if dominated_by_lossy {
                    return None;
                }

                Some(id)
            } else {
                None
            }
        })
        .collect();

    let mut count = 0;

    for id in image_ids {
        if let Some(Object::Stream(stream)) = doc.objects.get_mut(&id) {
            let _ = stream.decompress();
            if stream.compress().is_ok() {
                count += 1;
            }
        }
    }

    count
}

// =========================================================================
// Tests
// =========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::dictionary;

    fn make_test_pdf() -> Vec<u8> {
        let mut doc = Document::with_version("1.7");
        let pages_id = doc.new_object_id();
        let pages = dictionary! {
            "Type" => "Pages",
            "Kids" => Object::Array(vec![]),
            "Count" => Object::Integer(0),
        };
        doc.objects.insert(pages_id, Object::Dictionary(pages));
        let catalog = dictionary! {
            "Type" => "Catalog",
            "Pages" => Object::Reference(pages_id),
        };
        let catalog_id = doc.add_object(Object::Dictionary(catalog));
        doc.trailer.set("Root", Object::Reference(catalog_id));

        let mut buf = Vec::new();
        doc.save_to(&mut buf).unwrap();
        buf
    }

    #[test]
    fn compress_lossless_preset() {
        let buf = make_test_pdf();
        let opts = CompressOptions::default();
        let (_output, result) = compress_bytes(&buf, &opts).unwrap();
        assert!(!result.techniques_applied.is_empty());
        assert!(result.target_met); // no target = always met
    }

    #[test]
    fn compress_low_preset() {
        let buf = make_test_pdf();
        let opts = CompressOptions {
            preset: CompressionPreset::Low,
            ..Default::default()
        };
        let (_output, result) = compress_bytes(&buf, &opts).unwrap();
        assert!(!result.techniques_applied.is_empty());
    }

    #[test]
    fn compress_advanced_direct() {
        let buf = make_test_pdf();
        let opts = CompressOptions {
            preset: CompressionPreset::Advanced,
            advanced: Some(AdvancedMode::Direct {
                dpi: Some(150.0),
                jpeg_quality: Some(70),
                jp2: false,
            }),
            ..Default::default()
        };
        let (_output, result) = compress_bytes(&buf, &opts).unwrap();
        assert!(!result.techniques_applied.is_empty());
    }

    #[test]
    fn compress_advanced_target_size() {
        let buf = make_test_pdf();
        let opts = CompressOptions {
            preset: CompressionPreset::Advanced,
            advanced: Some(AdvancedMode::TargetSize {
                target_bytes: 1_000_000,
                min_dpi: 72.0,
                min_jpeg_quality: 45,
                jp2: false,
            }),
            ..Default::default()
        };
        let (_output, result) = compress_bytes(&buf, &opts).unwrap();
        assert!(result.target_met);
    }

    #[test]
    fn resolve_presets() {
        let low = CompressOptions { preset: CompressionPreset::Low, ..Default::default() };
        let r = low.resolve();
        assert_eq!(r.dpi, Some(200.0));
        assert_eq!(r.jpeg_quality, Some(80));
        assert!(!r.jp2);

        let high = CompressOptions { preset: CompressionPreset::High, ..Default::default() };
        let r = high.resolve();
        assert_eq!(r.dpi, Some(100.0));
        assert_eq!(r.jpeg_quality, Some(45));
    }

    #[test]
    fn analyze_pdf_works() {
        let buf = make_test_pdf();
        let analysis = analyze_pdf(&buf).unwrap();
        assert_eq!(analysis.total_image_count, 0);
        assert!(analysis.max_dpi.is_none());
        assert!(analysis.estimated_jpeg_quality.is_none());
    }

    #[test]
    fn parallel_phase1_lossless_returns_none() {
        let buf = make_test_pdf();
        let opts = CompressOptions::default(); // Lossless
        let tasks = compress_begin(&buf, &opts).unwrap();
        assert!(tasks.is_none(), "lossless preset should not produce image tasks");
        // Phase 3 should finalize the lossless result
        let (_output, result) = compress_finish(vec![]).unwrap();
        assert!(!result.techniques_applied.is_empty());
    }

    #[test]
    fn parallel_phase1_lossy_no_images_returns_none() {
        let buf = make_test_pdf();
        let opts = CompressOptions {
            preset: CompressionPreset::Low,
            ..Default::default()
        };
        let tasks = compress_begin(&buf, &opts).unwrap();
        assert!(tasks.is_none(), "no images = no tasks");
        let (_output, result) = compress_finish(vec![]).unwrap();
        assert!(!result.techniques_applied.is_empty());
    }

    #[test]
    fn parallel_target_size_returns_none() {
        let buf = make_test_pdf();
        let opts = CompressOptions {
            preset: CompressionPreset::Advanced,
            advanced: Some(AdvancedMode::TargetSize {
                target_bytes: 1_000_000,
                min_dpi: 72.0,
                min_jpeg_quality: 45,
                jp2: false,
            }),
            ..Default::default()
        };
        let tasks = compress_begin(&buf, &opts).unwrap();
        assert!(tasks.is_none(), "target-size runs sequentially");
        let (_output, result) = compress_finish(vec![]).unwrap();
        assert!(result.target_met);
    }
}
