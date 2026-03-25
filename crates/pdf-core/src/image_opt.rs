//! Image optimization for PDF compression (Phase 2).
//!
//! Extracts image XObject streams, decodes them, and re-encodes with
//! downsampling and/or lossy JPEG compression.

use image::codecs::jpeg::JpegEncoder;
use image::{DynamicImage, ImageBuffer, ImageReader};
use lopdf::{dictionary, Document, Object, ObjectId, Stream};
use serde::{Deserialize, Serialize};
use std::io::Cursor;

/// Information about a PDF image XObject needed for optimization.
pub struct PdfImage {
    pub id: ObjectId,
    pub width: u32,
    pub height: u32,
    #[allow(dead_code)]
    pub bpc: u32,
    pub components: u32,
    pub is_dct: bool,
    pub color_space_name: Vec<u8>,
}

/// Result of single-pass image processing.
#[derive(Debug, Default)]
pub struct ImageProcessStats {
    pub downsampled: usize,
    pub recompressed_jpeg: usize,
    pub recompressed_jp2: usize,
    pub grayscaled: usize,
}

/// Compute effective DPI for an image given its display size on page.
fn effective_dpi_for(img: &PdfImage, page_sizes: &[(ObjectId, (f64, f64))]) -> f64 {
    let (dw, dh) = page_sizes
        .iter()
        .find(|(id, _)| *id == img.id)
        .map(|(_, s)| *s)
        .unwrap_or((612.0, 792.0));
    let dpi_x = img.width as f64 / (dw / 72.0);
    let dpi_y = img.height as f64 / (dh / 72.0);
    dpi_x.max(dpi_y)
}

/// Detect the maximum effective DPI across all images in the document.
/// Returns `None` if no images are found.
pub fn detect_max_dpi(images: &[PdfImage], page_sizes: &[(ObjectId, (f64, f64))]) -> Option<f64> {
    let mut max_dpi: Option<f64> = None;

    for img_info in images {
        let eff = effective_dpi_for(img_info, page_sizes);
        max_dpi = Some(max_dpi.map_or(eff, |m: f64| m.max(eff)));
    }

    max_dpi
}

/// Generate a list of DPI steps from the current max DPI down to `floor_dpi`,
/// decrementing by `step`. Skips the first step if it's within 10% of current.
pub fn dpi_steps(max_dpi: f64, floor_dpi: f64, step: f64) -> Vec<f64> {
    let mut steps = Vec::new();
    let mut dpi = (max_dpi / step).floor() * step; // Round down to nearest step
    if dpi >= max_dpi * 0.9 {
        dpi -= step; // First step would be negligible, skip it
    }
    while dpi >= floor_dpi {
        steps.push(dpi);
        dpi -= step;
    }
    // Ensure floor is included if not already
    if steps.last().is_none_or(|&last| last > floor_dpi) {
        steps.push(floor_dpi);
    }
    steps
}

/// Estimate the JPEG quality of images in the document.
///
/// Extracts DQT (quantization table) markers from each JPEG image and compares
/// against IJG standard tables to estimate quality. Returns the estimated quality
/// of the highest-quality image, or `None` if no JPEG images are found.
pub fn estimate_jpeg_quality(doc: &Document, images: &[PdfImage]) -> Option<u8> {
    let mut best_quality: Option<u8> = None;

    for img in images {
        if !img.is_dct {
            continue;
        }

        let stream_bytes = match doc.objects.get(&img.id) {
            Some(Object::Stream(s)) => &s.content,
            _ => continue,
        };

        let estimated = estimate_single_image_quality(true, stream_bytes);
        best_quality = Some(best_quality.map_or(estimated, |q: u8| q.max(estimated)));
    }

    best_quality
}

/// IJG standard luminance quantization table (quality 50 baseline).
#[rustfmt::skip]
const STD_LUMINANCE_QT: [u16; 64] = [
    16,  11,  10,  16,  24,  40,  51,  61,
    12,  12,  14,  19,  26,  58,  60,  55,
    14,  13,  16,  24,  40,  57,  69,  56,
    14,  17,  22,  29,  51,  87,  80,  62,
    18,  22,  37,  56,  68, 109, 103,  77,
    24,  35,  55,  64,  81, 104, 113,  92,
    49,  64,  78,  87, 103, 121, 120, 101,
    72,  92,  95,  98, 112, 100, 103,  99,
];

/// IJG standard chrominance quantization table (quality 50 baseline).
#[rustfmt::skip]
const STD_CHROMINANCE_QT: [u16; 64] = [
    17,  18,  24,  47,  99,  99,  99,  99,
    18,  21,  26,  66,  99,  99,  99,  99,
    24,  26,  56,  99,  99,  99,  99,  99,
    47,  66,  99,  99,  99,  99,  99,  99,
    99,  99,  99,  99,  99,  99,  99,  99,
    99,  99,  99,  99,  99,  99,  99,  99,
    99,  99,  99,  99,  99,  99,  99,  99,
    99,  99,  99,  99,  99,  99,  99,  99,
];

/// Estimate JPEG quality by extracting DQT (Define Quantization Table) markers
/// and comparing against the IJG standard tables. This is the same method used
/// by ImageMagick's `identify -verbose` and similar tools.
///
/// Returns None if no DQT markers are found or the data is not valid JPEG.
fn estimate_quality_from_dqt(jpeg_data: &[u8]) -> Option<u8> {
    let tables = extract_quantization_tables(jpeg_data)?;
    if tables.is_empty() {
        return None;
    }

    // Use the first (luminance) table for estimation; average with chrominance if present
    let lum_quality = estimate_quality_from_table(&tables[0], &STD_LUMINANCE_QT);
    if tables.len() >= 2 {
        let chr_quality = estimate_quality_from_table(&tables[1], &STD_CHROMINANCE_QT);
        // Weight luminance more heavily as it has more impact on perceived quality
        Some(((lum_quality as u16 * 2 + chr_quality as u16) / 3) as u8)
    } else {
        Some(lum_quality)
    }
}

/// Extract quantization tables from JPEG data by parsing DQT markers.
fn extract_quantization_tables(data: &[u8]) -> Option<Vec<[u16; 64]>> {
    if data.len() < 2 || data[0] != 0xFF || data[1] != 0xD8 {
        return None; // Not a JPEG
    }

    let mut tables = Vec::new();
    let mut pos = 2;

    while pos + 1 < data.len() {
        if data[pos] != 0xFF {
            pos += 1;
            continue;
        }

        let marker = data[pos + 1];
        pos += 2;

        // End of image or start of scan — stop
        if marker == 0xD9 || marker == 0xDA {
            break;
        }

        // Skip standalone markers (RST, SOI, EOI, TEM)
        if marker == 0x00 || marker == 0x01 || (0xD0..=0xD7).contains(&marker) {
            continue;
        }

        if pos + 1 >= data.len() {
            break;
        }

        let seg_len = u16::from_be_bytes([data[pos], data[pos + 1]]) as usize;
        if seg_len < 2 || pos + seg_len > data.len() {
            break;
        }

        // DQT marker = 0xDB
        if marker == 0xDB {
            let mut offset = 2; // skip length field
            while offset < seg_len {
                if pos + offset >= data.len() {
                    break;
                }
                let pq_tq = data[pos + offset];
                let precision = (pq_tq >> 4) & 0x0F; // 0 = 8-bit, 1 = 16-bit
                offset += 1;

                let mut qt = [0u16; 64];
                for v in &mut qt {
                    if pos + offset >= data.len() {
                        break;
                    }
                    if precision == 0 {
                        *v = data[pos + offset] as u16;
                        offset += 1;
                    } else {
                        if pos + offset + 1 >= data.len() {
                            break;
                        }
                        *v = u16::from_be_bytes([data[pos + offset], data[pos + offset + 1]]);
                        offset += 2;
                    }
                }
                tables.push(qt);
            }
        }

        pos += seg_len;
    }

    if tables.is_empty() {
        None
    } else {
        Some(tables)
    }
}

/// Given an actual quantization table and the corresponding standard table,
/// estimate the JPEG quality level (1-100) using the IJG formula inversion.
fn estimate_quality_from_table(actual: &[u16; 64], standard: &[u16; 64]) -> u8 {
    // For each coefficient, compute what quality scale factor would produce it.
    // IJG formula: if quality >= 50: scale = 200 - 2*quality
    //              if quality <  50: scale = 5000 / quality
    // And: actual[i] = max(1, floor((standard[i] * scale + 50) / 100))
    //
    // We invert: scale ≈ actual[i] * 100 / standard[i]
    // Then average across all coefficients.
    let mut sum_scale = 0.0f64;
    let mut count = 0u32;

    for i in 0..64 {
        if standard[i] == 0 {
            continue;
        }
        let s = (actual[i] as f64) * 100.0 / (standard[i] as f64);
        sum_scale += s;
        count += 1;
    }

    if count == 0 {
        return 85;
    }

    let avg_scale = sum_scale / count as f64;

    // Invert the IJG quality-to-scale mapping
    let quality = if avg_scale >= 100.0 {
        // scale = 200 - 2*q → q = (200 - scale) / 2
        // But scale >= 100 means q <= 50
        (5000.0 / avg_scale).round() as i32
    } else {
        // scale = 200 - 2*q → q = (200 - scale) / 2
        ((200.0 - avg_scale) / 2.0).round() as i32
    };

    quality.clamp(1, 100) as u8
}

/// Estimate JPEG quality for a single image.
/// For DCT (JPEG) images, parses DQT markers from the JPEG data.
/// Falls back to compression ratio heuristic if DQT parsing fails.
/// For non-DCT images being converted to JPEG for the first time, returns 90.
fn estimate_single_image_quality(is_dct: bool, jpeg_data: &[u8]) -> u8 {
    if !is_dct {
        return 90; // First-time JPEG conversion — use high quality
    }
    estimate_quality_from_dqt(jpeg_data).unwrap_or(85)
}

/// Downsample images whose effective DPI exceeds `target_dpi`.
/// Returns the number of images downsampled.
pub fn downsample_images(doc: &mut Document, target_dpi: f64) -> usize {
    let images = collect_images(doc);
    let page_sizes = collect_page_image_sizes(doc);
    let mut count = 0;

    for img_info in &images {
        // Find the display size for this image by checking which pages reference it
        let display_size = page_sizes
            .iter()
            .find(|(id, _)| *id == img_info.id)
            .map(|(_, size)| *size);

        // If we can't determine display size, assume image fills a Letter page
        let (display_w_pts, display_h_pts) = display_size.unwrap_or((612.0, 792.0));

        // Calculate effective DPI
        let display_w_inches = display_w_pts / 72.0;
        let display_h_inches = display_h_pts / 72.0;
        let dpi_x = img_info.width as f64 / display_w_inches;
        let dpi_y = img_info.height as f64 / display_h_inches;
        let effective_dpi = dpi_x.max(dpi_y);

        if effective_dpi <= target_dpi * 1.1 {
            continue; // Already at or below target, skip
        }

        // Calculate new dimensions
        let scale = target_dpi / effective_dpi;
        let new_w = ((img_info.width as f64 * scale).round() as u32).max(1);
        let new_h = ((img_info.height as f64 * scale).round() as u32).max(1);

        if new_w >= img_info.width || new_h >= img_info.height {
            continue;
        }

        // Decode, resize, re-encode
        if let Ok(dynamic) = decode_pdf_image(doc, img_info) {
            let stream_bytes = doc
                .objects
                .get(&img_info.id)
                .and_then(|o| if let Object::Stream(s) = o { Some(s.content.as_slice()) } else { None })
                .unwrap_or(&[]);
            let quality = estimate_single_image_quality(img_info.is_dct, stream_bytes);
            let resized = dynamic.resize_exact(
                new_w,
                new_h,
                image::imageops::FilterType::CatmullRom,
            );
            if replace_image_as_jpeg(doc, img_info.id, &resized, quality) {
                count += 1;
            }
        }
    }

    count
}

/// Re-encode images as JPEG at the specified quality level.
/// Only processes images that would benefit (already-JPEG at lower quality, or
/// non-JPEG images). Returns the number of images recompressed.
pub fn recompress_images_lossy(doc: &mut Document, jpeg_quality: u8) -> usize {
    let images = collect_images(doc);
    let mut count = 0;

    for img_info in &images {
        // Skip tiny images (icons, masks) — not worth lossy compression
        if img_info.width < 64 || img_info.height < 64 {
            continue;
        }

        if let Ok(dynamic) = decode_pdf_image(doc, img_info) {
            let original_size = doc
                .objects
                .get(&img_info.id)
                .and_then(|o| {
                    if let Object::Stream(s) = o {
                        Some(s.content.len())
                    } else {
                        None
                    }
                })
                .unwrap_or(0);

            // Encode as JPEG at specified quality
            let mut jpeg_buf = Vec::new();
            let encoder = JpegEncoder::new_with_quality(&mut jpeg_buf, jpeg_quality);
            if dynamic.write_with_encoder(encoder).is_err() {
                continue;
            }

            // Only replace if the new encoding is actually smaller
            if jpeg_buf.len() < original_size
                && replace_image_with_jpeg_bytes(
                    doc,
                    img_info.id,
                    jpeg_buf,
                    dynamic.width(),
                    dynamic.height(),
                    &img_info.color_space_name,
                )
            {
                count += 1;
            }
        }
    }

    count
}

/// Convert color images to grayscale. Returns the number of images converted.
pub fn convert_images_to_grayscale(doc: &mut Document) -> usize {
    let images = collect_images(doc);
    let mut count = 0;

    for img_info in &images {
        // Only convert RGB/CMYK, skip already-gray images
        if img_info.components <= 1 {
            continue;
        }

        if let Ok(dynamic) = decode_pdf_image(doc, img_info) {
            let stream_bytes = doc
                .objects
                .get(&img_info.id)
                .and_then(|o| if let Object::Stream(s) = o { Some(s.content.as_slice()) } else { None })
                .unwrap_or(&[]);
            let quality = estimate_single_image_quality(img_info.is_dct, stream_bytes);
            let gray = dynamic.grayscale();
            if replace_image_as_jpeg(doc, img_info.id, &gray, quality) {
                count += 1;
            }
        }
    }

    count
}

/// Re-encode images as lossy JPEG 2000 using justjp2.
/// JPEG 2000 typically achieves better compression than JPEG at equivalent
/// visual quality. Returns the number of images recompressed.
pub fn recompress_images_jpeg2000(doc: &mut Document) -> usize {
    let images = collect_images(doc);
    let mut count = 0;

    for img_info in &images {
        // Skip tiny images
        if img_info.width < 64 || img_info.height < 64 {
            continue;
        }

        // Skip indexed / CMYK
        if img_info.color_space_name == b"Indexed" || img_info.components == 4 {
            continue;
        }

        if let Ok(dynamic) = decode_pdf_image(doc, img_info) {
            let original_size = doc
                .objects
                .get(&img_info.id)
                .and_then(|o| {
                    if let Object::Stream(s) = o {
                        Some(s.content.len())
                    } else {
                        None
                    }
                })
                .unwrap_or(0);

            if let Some(jp2_bytes) = encode_as_jpeg2000(&dynamic, false) {
                // Only replace if JP2 is actually smaller
                if jp2_bytes.len() < original_size {
                    let w = dynamic.width();
                    let h = dynamic.height();
                    let cs = if dynamic.color().channel_count() == 1 {
                        b"DeviceGray" as &[u8]
                    } else {
                        b"DeviceRGB"
                    };

                    if replace_image_with_jpx_bytes(doc, img_info.id, jp2_bytes, w, h, cs) {
                        count += 1;
                    }
                }
            }
        }
    }

    count
}

/// Encode a DynamicImage as JPEG 2000 using justjp2.
/// `lossless` controls whether to use reversible (5/3) or irreversible (9/7) DWT.
fn encode_as_jpeg2000(img: &DynamicImage, lossless: bool) -> Option<Vec<u8>> {
    use std::borrow::Cow;

    let width = img.width();
    let height = img.height();

    let params = justjp2::EncodeParams {
        lossless,
        format: justjp2::CodecFormat::J2k, // Raw codestream (smaller than JP2 container)
        ..Default::default()
    };

    let components = match img.color().channel_count() {
        1 => {
            // Avoid to_luma8() copy if already Luma8
            let gray_data: Cow<[u8]> = match img {
                DynamicImage::ImageLuma8(buf) => Cow::Borrowed(buf.as_raw()),
                _ => Cow::Owned(img.to_luma8().into_raw()),
            };
            vec![justjp2::Component {
                data: gray_data.iter().map(|&b| b as i32).collect(),
                width,
                height,
                precision: 8,
                signed: false,
                dx: 1,
                dy: 1,
            }]
        }
        _ => {
            // Avoid to_rgb8() copy if already Rgb8
            let rgb_data: Cow<[u8]> = match img {
                DynamicImage::ImageRgb8(buf) => Cow::Borrowed(buf.as_raw()),
                _ => Cow::Owned(img.to_rgb8().into_raw()),
            };
            let raw = rgb_data.as_ref();
            let pixel_count = (width * height) as usize;
            let mut r = Vec::with_capacity(pixel_count);
            let mut g = Vec::with_capacity(pixel_count);
            let mut b = Vec::with_capacity(pixel_count);
            for i in 0..pixel_count {
                r.push(raw[i * 3] as i32);
                g.push(raw[i * 3 + 1] as i32);
                b.push(raw[i * 3 + 2] as i32);
            }
            vec![
                justjp2::Component { data: r, width, height, precision: 8, signed: false, dx: 1, dy: 1 },
                justjp2::Component { data: g, width, height, precision: 8, signed: false, dx: 1, dy: 1 },
                justjp2::Component { data: b, width, height, precision: 8, signed: false, dx: 1, dy: 1 },
            ]
        }
    };

    let jp2_image = justjp2::Image {
        width,
        height,
        components,
    };

    justjp2::encode(&jp2_image, &params).ok()
}

/// Replace an image stream with JPEG 2000 (JPXDecode) bytes.
fn replace_image_with_jpx_bytes(
    doc: &mut Document,
    id: ObjectId,
    jpx_bytes: Vec<u8>,
    width: u32,
    height: u32,
    cs_name: &[u8],
) -> bool {
    let len = jpx_bytes.len() as i64;
    let new_dict = dictionary! {
        "Type" => "XObject",
        "Subtype" => "Image",
        "Width" => Object::Integer(width as i64),
        "Height" => Object::Integer(height as i64),
        "ColorSpace" => Object::Name(cs_name.to_vec()),
        "BitsPerComponent" => Object::Integer(8),
        "Filter" => "JPXDecode",
        "Length" => Object::Integer(len),
    };

    let new_stream = Stream::new(new_dict, jpx_bytes);
    doc.objects.insert(id, Object::Stream(new_stream));
    true
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

/// Summary of image types found in a PDF document.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageSummary {
    pub jpeg_count: u32,
    pub non_jpeg_count: u32,
}

/// Count images by encoding type (JPEG vs non-JPEG/PNG).
pub fn collect_images_summary(images: &[PdfImage]) -> ImageSummary {
    let jpeg_count = images.iter().filter(|i| i.is_dct).count() as u32;
    ImageSummary {
        jpeg_count,
        non_jpeg_count: images.len() as u32 - jpeg_count,
    }
}

/// Process all images in a single pass: decode once, then apply
/// grayscale / downsample / encode. Avoids redundant document scans
/// and redundant decode+encode cycles that happen when each operation
/// is a separate function call.
pub fn process_images_single_pass(
    doc: &mut Document,
    images: &[PdfImage],
    page_sizes: &[(ObjectId, (f64, f64))],
    target_dpi: Option<f64>,
    jpeg_quality: Option<u8>,
    jp2: bool,
    grayscale: bool,
) -> ImageProcessStats {
    let mut stats = ImageProcessStats::default();

    for img_info in images {
        let is_tiny = img_info.width < 64 || img_info.height < 64;
        let will_grayscale = grayscale && img_info.components > 1;

        // Check if downsampling is needed
        let eff_dpi = target_dpi.map(|_| effective_dpi_for(img_info, page_sizes));
        let will_downsample = match (target_dpi, eff_dpi) {
            (Some(target), Some(eff)) => eff > target * 1.1 && !is_tiny,
            _ => false,
        };

        let will_reencode_jpeg = jpeg_quality.is_some() && !jp2 && !is_tiny;
        let will_reencode_jp2 = jp2 && !is_tiny
            && img_info.color_space_name != b"Indexed"
            && img_info.components != 4;

        // Skip if nothing to do
        if !will_downsample && !will_reencode_jpeg && !will_reencode_jp2 && !will_grayscale {
            continue;
        }

        let Ok(mut dynamic) = decode_pdf_image(doc, img_info) else { continue };

        let (original_size, estimated_quality) = doc
            .objects
            .get(&img_info.id)
            .and_then(|o| if let Object::Stream(s) = o {
                Some((s.content.len(), estimate_single_image_quality(img_info.is_dct, &s.content)))
            } else {
                None
            })
            .unwrap_or((0, 85));

        // 1. Grayscale
        if will_grayscale {
            dynamic = dynamic.grayscale();
            stats.grayscaled += 1;
        }

        // 2. Downsample
        let mut did_downsample = false;
        if will_downsample {
            let target = target_dpi.unwrap();
            let eff = eff_dpi.unwrap();
            let scale = target / eff;
            let new_w = ((img_info.width as f64 * scale).round() as u32).max(1);
            let new_h = ((img_info.height as f64 * scale).round() as u32).max(1);
            if new_w < img_info.width && new_h < img_info.height {
                dynamic = dynamic.resize_exact(
                    new_w,
                    new_h,
                    image::imageops::FilterType::CatmullRom,
                );
                did_downsample = true;
                stats.downsampled += 1;
            }
        }

        let was_modified = did_downsample || will_grayscale;

        // 3. Encode — pick final encoding
        if will_reencode_jp2 {
            if let Some(jp2_bytes) = encode_as_jpeg2000(&dynamic, false) {
                if was_modified || jp2_bytes.len() < original_size {
                    let w = dynamic.width();
                    let h = dynamic.height();
                    let cs = if dynamic.color().channel_count() == 1 {
                        b"DeviceGray" as &[u8]
                    } else {
                        b"DeviceRGB"
                    };
                    replace_image_with_jpx_bytes(doc, img_info.id, jp2_bytes, w, h, cs);
                    stats.recompressed_jp2 += 1;
                }
            }
        } else if will_reencode_jpeg {
            let quality = jpeg_quality.unwrap();
            let mut jpeg_buf = Vec::new();
            let encoder = JpegEncoder::new_with_quality(&mut jpeg_buf, quality);
            if dynamic.write_with_encoder(encoder).is_ok()
                && (was_modified || jpeg_buf.len() < original_size)
            {
                let w = dynamic.width();
                let h = dynamic.height();
                let cs_name = if dynamic.color().channel_count() == 1 {
                    b"DeviceGray" as &[u8]
                } else {
                    b"DeviceRGB"
                };
                replace_image_with_jpeg_bytes(doc, img_info.id, jpeg_buf, w, h, cs_name);
                stats.recompressed_jpeg += 1;
            }
        } else if was_modified {
            // Modified but no specific encoding — use estimated quality from original
            replace_image_as_jpeg(doc, img_info.id, &dynamic, estimated_quality);
            stats.recompressed_jpeg += 1;
        }
    }

    stats
}

// ---------------------------------------------------------------------------
// Parallel image processing — extract tasks for distribution across workers
// ---------------------------------------------------------------------------

/// A self-contained image processing task that can be sent to any worker.
/// Contains the raw image bytes and all parameters needed for processing.
#[derive(Debug, Serialize, Deserialize)]
pub struct ImageTask {
    pub task_index: usize,
    /// lopdf ObjectId parts for mapping results back
    pub obj_num: u32,
    pub obj_gen: u16,
    /// Stream content: JPEG bytes for DCT, decompressed pixels for raw
    #[serde(with = "serde_bytes")]
    pub image_bytes: Vec<u8>,
    pub is_dct: bool,
    pub width: u32,
    pub height: u32,
    pub components: u32,
    pub color_space_name: String,
    pub effective_dpi: f64,
    pub original_size: usize,
    // Processing parameters
    pub target_dpi: Option<f64>,
    pub jpeg_quality: Option<u8>,
    pub jp2: bool,
    pub grayscale: bool,
    /// When true, apply lossless optimization (oxipng) instead of lossy encoding
    #[serde(default)]
    pub lossless: bool,
}

/// Result of processing a single image task.
#[derive(Debug, Serialize, Deserialize)]
pub struct ImageTaskResult {
    pub task_index: usize,
    pub obj_num: u32,
    pub obj_gen: u16,
    #[serde(with = "serde_bytes")]
    pub encoded_bytes: Vec<u8>,
    pub new_width: u32,
    pub new_height: u32,
    pub filter_name: String,
    pub color_space: String,
    pub downsampled: bool,
    pub grayscaled: bool,
    pub reencoded: bool,
    /// PNG predictor parameters (only set for FlateDecode lossless results)
    #[serde(default)]
    pub predictor_colors: Option<u32>,
}

/// Extract image tasks from a document for parallel processing.
/// Each task is self-contained: includes image bytes and processing params.
pub fn extract_image_tasks(
    doc: &Document,
    images: &[PdfImage],
    page_sizes: &[(ObjectId, (f64, f64))],
    target_dpi: Option<f64>,
    jpeg_quality: Option<u8>,
    jp2: bool,
    grayscale: bool,
) -> Vec<ImageTask> {
    let mut tasks = Vec::new();

    for (idx, img_info) in images.iter().enumerate() {
        let is_tiny = img_info.width < 64 || img_info.height < 64;
        let will_grayscale = grayscale && img_info.components > 1;
        let eff_dpi = effective_dpi_for(img_info, page_sizes);
        let will_downsample = target_dpi.is_some_and(|t| eff_dpi > t * 1.1 && !is_tiny);
        let will_reencode_jpeg = jpeg_quality.is_some() && !jp2 && !is_tiny;
        let will_reencode_jp2 = jp2
            && !is_tiny
            && img_info.color_space_name != b"Indexed"
            && img_info.components != 4;

        if !will_downsample && !will_reencode_jpeg && !will_reencode_jp2 && !will_grayscale {
            continue;
        }

        let stream = match doc.objects.get(&img_info.id) {
            Some(Object::Stream(s)) => s,
            _ => continue,
        };

        let original_size = stream.content.len();

        // Extract image bytes: JPEG bytes for DCT, decompressed pixels for raw
        let image_bytes = if img_info.is_dct {
            let filters = stream.filters().unwrap_or_default();
            if filters.len() > 1 {
                stream
                    .get_plain_content()
                    .unwrap_or_else(|_| stream.content.clone())
            } else {
                stream.content.clone()
            }
        } else {
            match stream.get_plain_content() {
                Ok(bytes) => bytes,
                Err(_) => continue,
            }
        };

        tasks.push(ImageTask {
            task_index: idx,
            obj_num: img_info.id.0,
            obj_gen: img_info.id.1,
            image_bytes,
            is_dct: img_info.is_dct,
            width: img_info.width,
            height: img_info.height,
            components: img_info.components,
            color_space_name: String::from_utf8_lossy(&img_info.color_space_name).to_string(),
            effective_dpi: eff_dpi,
            original_size,
            target_dpi,
            jpeg_quality,
            jp2,
            grayscale,
            lossless: false,
        });
    }

    tasks
}

/// Extract lossless image tasks from a document for parallel oxipng processing.
/// Only extracts non-DCT, non-JPX images that can benefit from oxipng.
pub fn extract_lossless_image_tasks(
    doc: &Document,
    images: &[PdfImage],
) -> Vec<ImageTask> {
    let mut tasks = Vec::new();

    for (idx, img_info) in images.iter().enumerate() {
        // Only process non-DCT images
        if img_info.is_dct {
            continue;
        }
        // Skip JPXDecode images
        let is_jpx = doc.objects.get(&img_info.id).is_none_or(|obj| {
            if let Object::Stream(s) = obj {
                s.filters().is_ok_and(|f| f.iter().any(|n| n == b"JPXDecode"))
            } else {
                true
            }
        });
        if is_jpx {
            continue;
        }
        // Skip indexed/CMYK
        if img_info.color_space_name == b"Indexed" || img_info.components == 4 {
            continue;
        }

        let stream = match doc.objects.get(&img_info.id) {
            Some(Object::Stream(s)) => s,
            _ => continue,
        };

        let original_size = stream.content.len();

        // Get decompressed pixels
        let image_bytes = match stream.get_plain_content() {
            Ok(bytes) => bytes,
            Err(_) => continue,
        };

        tasks.push(ImageTask {
            task_index: idx,
            obj_num: img_info.id.0,
            obj_gen: img_info.id.1,
            image_bytes,
            is_dct: false,
            width: img_info.width,
            height: img_info.height,
            components: img_info.components,
            color_space_name: String::from_utf8_lossy(&img_info.color_space_name).to_string(),
            effective_dpi: 0.0,
            original_size,
            target_dpi: None,
            jpeg_quality: None,
            jp2: false,
            grayscale: false,
            lossless: true,
        });
    }

    tasks
}

/// Process a single image task independently of any document.
/// This is the function called by pool workers in parallel.
pub fn process_image_task(task: &ImageTask) -> Option<ImageTaskResult> {
    // Lossless path: oxipng optimization
    if task.lossless {
        return process_lossless_task(task);
    }

    // Decode image from raw bytes
    let mut dynamic = if task.is_dct {
        let reader = ImageReader::new(Cursor::new(&task.image_bytes))
            .with_guessed_format()
            .ok()?;
        reader.decode().ok()?
    } else {
        if task.color_space_name == "Indexed" || task.components == 4 {
            return None;
        }
        let expected =
            (task.width as usize) * (task.height as usize) * (task.components as usize);
        if task.image_bytes.len() < expected {
            return None;
        }
        match task.components {
            1 => {
                let buf = ImageBuffer::from_raw(
                    task.width,
                    task.height,
                    task.image_bytes[..expected].to_vec(),
                )?;
                DynamicImage::ImageLuma8(buf)
            }
            3 => {
                let buf = ImageBuffer::from_raw(
                    task.width,
                    task.height,
                    task.image_bytes[..expected].to_vec(),
                )?;
                DynamicImage::ImageRgb8(buf)
            }
            _ => return None,
        }
    };

    let is_tiny = task.width < 64 || task.height < 64;
    let will_grayscale = task.grayscale && task.components > 1;
    let will_downsample = task
        .target_dpi
        .is_some_and(|t| task.effective_dpi > t * 1.1 && !is_tiny);
    let will_reencode_jpeg = task.jpeg_quality.is_some() && !task.jp2 && !is_tiny;
    let will_reencode_jp2 = task.jp2
        && !is_tiny
        && task.color_space_name != "Indexed"
        && task.components != 4;

    let mut did_grayscale = false;
    let mut did_downsample = false;

    // 1. Grayscale
    if will_grayscale {
        dynamic = dynamic.grayscale();
        did_grayscale = true;
    }

    // 2. Downsample
    if will_downsample {
        let target = task.target_dpi.unwrap();
        let scale = target / task.effective_dpi;
        let new_w = ((task.width as f64 * scale).round() as u32).max(1);
        let new_h = ((task.height as f64 * scale).round() as u32).max(1);
        if new_w < task.width && new_h < task.height {
            dynamic = dynamic.resize_exact(
                new_w,
                new_h,
                image::imageops::FilterType::CatmullRom,
            );
            did_downsample = true;
        }
    }

    let was_modified = did_downsample || did_grayscale;

    // Helper to build result
    let make_result =
        |bytes: Vec<u8>, filter: &str, dynamic: &DynamicImage, reenc: bool| ImageTaskResult {
            task_index: task.task_index,
            obj_num: task.obj_num,
            obj_gen: task.obj_gen,
            encoded_bytes: bytes,
            new_width: dynamic.width(),
            new_height: dynamic.height(),
            filter_name: filter.to_string(),
            color_space: if dynamic.color().channel_count() == 1 {
                "DeviceGray".to_string()
            } else {
                "DeviceRGB".to_string()
            },
            downsampled: did_downsample,
            grayscaled: did_grayscale,
            reencoded: reenc,
            predictor_colors: None,
        };

    // 3. Encode
    if will_reencode_jp2 {
        let jp2_bytes = encode_as_jpeg2000(&dynamic, false)?;
        if was_modified || jp2_bytes.len() < task.original_size {
            return Some(make_result(jp2_bytes, "JPXDecode", &dynamic, true));
        }
    } else if will_reencode_jpeg {
        let quality = task.jpeg_quality.unwrap();
        let mut jpeg_buf = Vec::new();
        let encoder = JpegEncoder::new_with_quality(&mut jpeg_buf, quality);
        if dynamic.write_with_encoder(encoder).is_ok()
            && (was_modified || jpeg_buf.len() < task.original_size)
        {
            return Some(make_result(jpeg_buf, "DCTDecode", &dynamic, true));
        }
    } else if was_modified {
        let quality = estimate_single_image_quality(task.is_dct, &task.image_bytes);
        let mut jpeg_buf = Vec::new();
        let encoder = JpegEncoder::new_with_quality(&mut jpeg_buf, quality);
        if dynamic.write_with_encoder(encoder).is_ok() {
            return Some(make_result(jpeg_buf, "DCTDecode", &dynamic, false));
        }
    }

    None
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Collect metadata for all image XObject streams in the document.
pub fn collect_images(doc: &Document) -> Vec<PdfImage> {
    doc.objects
        .iter()
        .filter_map(|(&id, obj)| {
            let stream = match obj {
                Object::Stream(s) => s,
                _ => return None,
            };

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

            let width = stream.dict.get(b"Width").ok()?.as_i64().ok()? as u32;
            let height = stream.dict.get(b"Height").ok()?.as_i64().ok()? as u32;
            let bpc = stream
                .dict
                .get(b"BitsPerComponent")
                .ok()
                .and_then(|v| v.as_i64().ok())
                .unwrap_or(8) as u32;

            let (cs_name, components) = resolve_color_space(&stream.dict, doc);

            let is_dct = stream.filters().is_ok_and(|filters| {
                filters.iter().any(|f| f == b"DCTDecode")
            });

            // Skip images with SMask for now (alpha channels complicate things)
            if stream.dict.has(b"SMask") {
                return None;
            }

            // Skip 1-bit images (likely scanned text / masks)
            if bpc == 1 {
                return None;
            }

            Some(PdfImage {
                id,
                width,
                height,
                bpc,
                components,
                is_dct,
                color_space_name: cs_name,
            })
        })
        .collect()
}

/// Resolve the color space name and number of components from an image dict.
fn resolve_color_space(dict: &lopdf::Dictionary, doc: &Document) -> (Vec<u8>, u32) {
    let cs_obj = match dict.get(b"ColorSpace") {
        Ok(obj) => obj,
        Err(_) => return (b"DeviceGray".to_vec(), 1),
    };

    match cs_obj {
        Object::Name(name) => {
            let components = match name.as_slice() {
                b"DeviceRGB" => 3,
                b"DeviceCMYK" => 4,
                b"DeviceGray" => 1,
                _ => 3, // Assume RGB for unknown
            };
            (name.clone(), components)
        }
        Object::Reference(id) => {
            // Dereference and try again
            if let Ok(resolved) = doc.get_object(*id) {
                match resolved {
                    Object::Name(name) => {
                        let components = match name.as_slice() {
                            b"DeviceRGB" => 3,
                            b"DeviceCMYK" => 4,
                            b"DeviceGray" => 1,
                            _ => 3,
                        };
                        (name.clone(), components)
                    }
                    Object::Array(arr) if !arr.is_empty() => {
                        // Array form: [/ICCBased ref] or [/Indexed /DeviceRGB ...]
                        if let Some(Ok(name)) = arr.first().map(|o| o.as_name()) {
                            match name {
                                b"ICCBased" => {
                                    // Try to read N from the ICC stream dict
                                    let n = arr
                                        .get(1)
                                        .and_then(|o| {
                                            if let Object::Reference(r) = o {
                                                doc.get_object(*r).ok()
                                            } else {
                                                None
                                            }
                                        })
                                        .and_then(|o| {
                                            if let Object::Stream(s) = o {
                                                s.dict.get(b"N").ok()?.as_i64().ok()
                                            } else {
                                                None
                                            }
                                        })
                                        .unwrap_or(3) as u32;
                                    let cs = match n {
                                        1 => b"DeviceGray".to_vec(),
                                        4 => b"DeviceCMYK".to_vec(),
                                        _ => b"DeviceRGB".to_vec(),
                                    };
                                    (cs, n)
                                }
                                b"Indexed" => {
                                    // Indexed color — 1 component per pixel (palette index)
                                    // Base color space determines the palette entries
                                    (b"Indexed".to_vec(), 1)
                                }
                                _ => (name.to_vec(), 3),
                            }
                        } else {
                            (b"DeviceRGB".to_vec(), 3)
                        }
                    }
                    _ => (b"DeviceRGB".to_vec(), 3),
                }
            } else {
                (b"DeviceRGB".to_vec(), 3)
            }
        }
        Object::Array(arr) if !arr.is_empty() => {
            // Inline array form
            if let Some(Ok(name)) = arr.first().map(|o| o.as_name()) {
                match name {
                    b"ICCBased" => {
                        let n = arr
                            .get(1)
                            .and_then(|o| {
                                if let Object::Reference(r) = o {
                                    doc.get_object(*r).ok()
                                } else {
                                    None
                                }
                            })
                            .and_then(|o| {
                                if let Object::Stream(s) = o {
                                    s.dict.get(b"N").ok()?.as_i64().ok()
                                } else {
                                    None
                                }
                            })
                            .unwrap_or(3) as u32;
                        let cs = match n {
                            1 => b"DeviceGray".to_vec(),
                            4 => b"DeviceCMYK".to_vec(),
                            _ => b"DeviceRGB".to_vec(),
                        };
                        (cs, n)
                    }
                    b"Indexed" => (b"Indexed".to_vec(), 1),
                    _ => (name.to_vec(), 3),
                }
            } else {
                (b"DeviceRGB".to_vec(), 3)
            }
        }
        _ => (b"DeviceRGB".to_vec(), 3),
    }
}

/// Decode a PDF image XObject stream into a DynamicImage.
fn decode_pdf_image(doc: &Document, info: &PdfImage) -> std::result::Result<DynamicImage, String> {
    let stream = match doc.objects.get(&info.id) {
        Some(Object::Stream(s)) => s,
        _ => return Err("not a stream".into()),
    };

    if info.is_dct {
        // DCTDecode = JPEG bitstream. The stream content IS the JPEG data.
        // If there are additional filters (e.g., Flate wrapping DCT), the content
        // field holds the encoded bytes. For pure DCTDecode, content is raw JPEG.
        let filters = stream.filters().unwrap_or_default();
        let content = if filters.len() > 1 {
            // Multiple filters — the outer filters wrap the JPEG bytes.
            // get_plain_content strips all filters. But lopdf can't decode DCT,
            // so we need to manually decompress only the non-DCT filters.
            // For simplicity, try get_plain_content first, fall back to raw content.
            stream
                .get_plain_content()
                .unwrap_or_else(|_| stream.content.clone())
        } else {
            // Single DCTDecode filter — content is raw JPEG bytes
            stream.content.clone()
        };

        let reader = ImageReader::new(Cursor::new(&content))
            .with_guessed_format()
            .map_err(|e| format!("format guess: {e}"))?;
        reader.decode().map_err(|e| format!("JPEG decode: {e}"))
    } else {
        // Raw pixel data — reconstruct based on width, height, BPC, components
        let content = stream
            .get_plain_content()
            .map_err(|e| format!("decompress: {e}"))?;

        // Skip Indexed color spaces — palette lookup is complex
        if info.color_space_name == b"Indexed" {
            return Err("indexed color space not supported".into());
        }

        // Skip CMYK — would need ICC conversion
        if info.components == 4 {
            return Err("CMYK not supported for re-encoding".into());
        }

        let expected_len =
            (info.width as usize) * (info.height as usize) * (info.components as usize);

        if content.len() < expected_len {
            return Err(format!(
                "buffer too small: got {} expected {}",
                content.len(),
                expected_len
            ));
        }

        match info.components {
            1 => {
                let buf = ImageBuffer::from_raw(info.width, info.height, content[..expected_len].to_vec())
                    .ok_or("failed to create gray buffer")?;
                Ok(DynamicImage::ImageLuma8(buf))
            }
            3 => {
                let buf = ImageBuffer::from_raw(info.width, info.height, content[..expected_len].to_vec())
                    .ok_or("failed to create RGB buffer")?;
                Ok(DynamicImage::ImageRgb8(buf))
            }
            _ => Err(format!("unsupported component count: {}", info.components)),
        }
    }
}

/// Encode a DynamicImage as JPEG and replace the stream in the document.
fn replace_image_as_jpeg(
    doc: &mut Document,
    id: ObjectId,
    img: &DynamicImage,
    quality: u8,
) -> bool {
    let mut jpeg_buf = Vec::new();
    let encoder = JpegEncoder::new_with_quality(&mut jpeg_buf, quality);
    if img.write_with_encoder(encoder).is_err() {
        return false;
    }

    let cs_name = if img.color().channel_count() == 1 {
        b"DeviceGray".to_vec()
    } else {
        b"DeviceRGB".to_vec()
    };

    replace_image_with_jpeg_bytes(doc, id, jpeg_buf, img.width(), img.height(), &cs_name)
}

/// Replace an image stream with raw JPEG bytes and update the dictionary.
fn replace_image_with_jpeg_bytes(
    doc: &mut Document,
    id: ObjectId,
    jpeg_bytes: Vec<u8>,
    width: u32,
    height: u32,
    cs_name: &[u8],
) -> bool {
    let components: i64 = match cs_name {
        b"DeviceGray" => 1,
        b"DeviceCMYK" => 4,
        _ => 3,
    };

    let len = jpeg_bytes.len() as i64;
    let new_dict = dictionary! {
        "Type" => "XObject",
        "Subtype" => "Image",
        "Width" => Object::Integer(width as i64),
        "Height" => Object::Integer(height as i64),
        "ColorSpace" => Object::Name(cs_name.to_vec()),
        "BitsPerComponent" => Object::Integer(8),
        "Filter" => "DCTDecode",
        "Length" => Object::Integer(len),
    };

    // Keep DecodeParms if components != 3 (some viewers need it)
    let _ = components; // used implicitly via cs_name

    let new_stream = Stream::new(new_dict, jpeg_bytes);
    doc.objects.insert(id, Object::Stream(new_stream));
    true
}

/// Losslessly recompress non-DCT/JPX images using oxipng's superior PNG
/// filter selection and deflate compression. The optimized PNG IDAT data is
/// stored in the PDF stream with FlateDecode + PNG predictor (Predictor=15).
/// Returns the number of images recompressed.
pub fn recompress_images_oxipng(doc: &mut Document) -> usize {
    let images = collect_images(doc);
    let mut count = 0;

    for img_info in &images {
        // Only process non-DCT/JPX images (raw pixel + FlateDecode)
        if img_info.is_dct {
            continue;
        }
        // Skip images already using JPXDecode
        let is_jpx = doc.objects.get(&img_info.id).is_none_or(|obj| {
            if let Object::Stream(s) = obj {
                s.filters().is_ok_and(|f| f.iter().any(|n| n == b"JPXDecode"))
            } else {
                true
            }
        });
        if is_jpx {
            continue;
        }

        // Skip indexed/CMYK — complex color handling
        if img_info.color_space_name == b"Indexed" || img_info.components == 4 {
            continue;
        }

        let original_size = match doc.objects.get(&img_info.id) {
            Some(Object::Stream(s)) => s.content.len(),
            _ => continue,
        };

        if let Ok(dynamic) = decode_pdf_image(doc, img_info) {
            let raw_pixels = match img_info.components {
                1 => dynamic.to_luma8().into_raw(),
                _ => dynamic.to_rgb8().into_raw(),
            };

            let color_type = if img_info.components == 1 {
                oxipng::ColorType::Grayscale { transparent_shade: None }
            } else {
                oxipng::ColorType::RGB { transparent_color: None }
            };

            let raw_image = match oxipng::RawImage::new(
                img_info.width,
                img_info.height,
                color_type,
                oxipng::BitDepth::Eight,
                raw_pixels,
            ) {
                Ok(r) => r,
                Err(_) => continue,
            };

            let opts = oxipng::Options {
                strip: oxipng::StripChunks::All,
                optimize_alpha: false,
                force: true,
                #[cfg(not(target_arch = "wasm32"))]
                timeout: Some(std::time::Duration::from_secs(10)),
                #[cfg(target_arch = "wasm32")]
                timeout: None,
                ..oxipng::Options::from_preset(3)
            };

            let optimized_png = match raw_image.create_optimized_png(&opts) {
                Ok(png) => png,
                Err(_) => continue,
            };

            // Extract IDAT data from the optimized PNG
            let idat_data = match extract_png_idat(&optimized_png) {
                Some(data) => data,
                None => continue,
            };

            // Only replace if smaller
            if idat_data.len() >= original_size {
                continue;
            }

            let colors = img_info.components as i64;
            let cs_name = if img_info.components == 1 {
                b"DeviceGray" as &[u8]
            } else {
                b"DeviceRGB"
            };

            let decode_parms = dictionary! {
                "Predictor" => Object::Integer(15),
                "Colors" => Object::Integer(colors),
                "BitsPerComponent" => Object::Integer(8),
                "Columns" => Object::Integer(img_info.width as i64),
            };

            let new_dict = dictionary! {
                "Type" => "XObject",
                "Subtype" => "Image",
                "Width" => Object::Integer(img_info.width as i64),
                "Height" => Object::Integer(img_info.height as i64),
                "ColorSpace" => Object::Name(cs_name.to_vec()),
                "BitsPerComponent" => Object::Integer(8),
                "Filter" => "FlateDecode",
                "DecodeParms" => Object::Dictionary(decode_parms),
                "Length" => Object::Integer(idat_data.len() as i64),
            };

            let new_stream = Stream::new(new_dict, idat_data);
            doc.objects.insert(img_info.id, Object::Stream(new_stream));
            count += 1;
        }
    }

    count
}

/// Process a single lossless image task using oxipng optimization.
fn process_lossless_task(task: &ImageTask) -> Option<ImageTaskResult> {
    // Reconstruct pixel data from raw bytes
    let expected = (task.width as usize) * (task.height as usize) * (task.components as usize);
    if task.image_bytes.len() < expected {
        return None;
    }

    let raw_pixels = task.image_bytes[..expected].to_vec();
    let color_type = if task.components == 1 {
        oxipng::ColorType::Grayscale { transparent_shade: None }
    } else {
        oxipng::ColorType::RGB { transparent_color: None }
    };

    let raw_image = oxipng::RawImage::new(
        task.width,
        task.height,
        color_type,
        oxipng::BitDepth::Eight,
        raw_pixels,
    ).ok()?;

    let opts = oxipng::Options {
        strip: oxipng::StripChunks::All,
        optimize_alpha: false,
        force: true,
        #[cfg(not(target_arch = "wasm32"))]
        timeout: Some(std::time::Duration::from_secs(10)),
        #[cfg(target_arch = "wasm32")]
        timeout: None,
        ..oxipng::Options::from_preset(3)
    };

    let optimized_png = raw_image.create_optimized_png(&opts).ok()?;
    let idat_data = extract_png_idat(&optimized_png)?;

    // Only return if smaller than original
    if idat_data.len() >= task.original_size {
        return None;
    }

    Some(ImageTaskResult {
        task_index: task.task_index,
        obj_num: task.obj_num,
        obj_gen: task.obj_gen,
        encoded_bytes: idat_data,
        new_width: task.width,
        new_height: task.height,
        filter_name: "FlateDecode".to_string(),
        color_space: if task.components == 1 {
            "DeviceGray".to_string()
        } else {
            "DeviceRGB".to_string()
        },
        downsampled: false,
        grayscaled: false,
        reencoded: true,
        predictor_colors: Some(task.components),
    })
}

/// Parse a PNG file and extract the concatenated raw IDAT chunk data.
/// Returns `None` if the PNG is invalid.
fn extract_png_idat(png_data: &[u8]) -> Option<Vec<u8>> {
    // PNG signature: 8 bytes
    if png_data.len() < 8 || &png_data[..8] != b"\x89PNG\r\n\x1a\n" {
        return None;
    }

    let mut idat = Vec::new();
    let mut pos = 8;

    while pos + 12 <= png_data.len() {
        let length = u32::from_be_bytes([
            png_data[pos], png_data[pos + 1], png_data[pos + 2], png_data[pos + 3],
        ]) as usize;
        let chunk_type = &png_data[pos + 4..pos + 8];

        if pos + 12 + length > png_data.len() {
            break;
        }

        if chunk_type == b"IDAT" {
            idat.extend_from_slice(&png_data[pos + 8..pos + 8 + length]);
        }

        // Move past: length(4) + type(4) + data(length) + crc(4)
        pos += 12 + length;
    }

    if idat.is_empty() { None } else { Some(idat) }
}

/// Try to find display sizes of images by scanning page MediaBox values.
/// Returns (ObjectId, (width_pts, height_pts)) pairs.
/// This is a simplified heuristic — assumes images fill their page.
pub fn collect_page_image_sizes(doc: &Document) -> Vec<(ObjectId, (f64, f64))> {
    let mut results = Vec::new();
    let pages = doc.get_pages();

    for &page_id in pages.values() {
        let page = match doc.get_object(page_id) {
            Ok(Object::Dictionary(d)) => d,
            _ => continue,
        };

        // Get page dimensions from MediaBox
        let (page_w, page_h) = match page.get(b"MediaBox") {
            Ok(Object::Array(arr)) if arr.len() == 4 => {
                let w = obj_to_f64(&arr[2]).unwrap_or(612.0);
                let h = obj_to_f64(&arr[3]).unwrap_or(792.0);
                (w, h)
            }
            _ => (612.0, 792.0),
        };

        // Find image XObject references in this page's resources
        let resources = match page.get(b"Resources") {
            Ok(Object::Dictionary(d)) => Some(d),
            Ok(Object::Reference(id)) => doc
                .get_object(*id)
                .ok()
                .and_then(|o| o.as_dict().ok()),
            _ => None,
        };

        if let Some(res) = resources {
            if let Ok(Object::Dictionary(xobjects)) = res.get(b"XObject") {
                for (_name, value) in xobjects.iter() {
                    if let Object::Reference(img_id) = value {
                        results.push((*img_id, (page_w, page_h)));
                    }
                }
            } else if let Ok(Object::Reference(xobj_ref)) = res.get(b"XObject") {
                if let Ok(Object::Dictionary(xobjects)) = doc.get_object(*xobj_ref) {
                    for (_name, value) in xobjects.iter() {
                        if let Object::Reference(img_id) = value {
                            results.push((*img_id, (page_w, page_h)));
                        }
                    }
                }
            }
        }
    }

    results
}

fn obj_to_f64(obj: &Object) -> Option<f64> {
    match obj {
        Object::Integer(i) => Some(*i as f64),
        Object::Real(f) => Some((*f).into()),
        _ => None,
    }
}
