mod helpers;

use lopdf::{dictionary, Document, Object, Stream};
use pdf_core::compress::{compress_bytes, compress_begin, compress_finish, AdvancedMode, CompressOptions, CompressionPreset};
use pdf_core::image_opt;
use pdf_core::PdfDocument;

/// Create a test PDF with an embedded RGB image of the given dimensions.
/// The image is raw uncompressed RGB pixels (worst case for compression).
fn make_pdf_with_image(img_w: u32, img_h: u32) -> Vec<u8> {
    let mut doc = Document::with_version("1.7");
    let pages_id = doc.new_object_id();

    // Create a raw RGB image (gradient pattern — compressible but realistic)
    let pixel_count = (img_w * img_h) as usize;
    let mut pixels = Vec::with_capacity(pixel_count * 3);
    for y in 0..img_h {
        for x in 0..img_w {
            pixels.push((x % 256) as u8);
            pixels.push((y % 256) as u8);
            pixels.push(((x + y) % 256) as u8);
        }
    }

    let img_dict = dictionary! {
        "Type" => "XObject",
        "Subtype" => "Image",
        "Width" => Object::Integer(img_w as i64),
        "Height" => Object::Integer(img_h as i64),
        "ColorSpace" => "DeviceRGB",
        "BitsPerComponent" => Object::Integer(8),
        "Length" => Object::Integer(pixels.len() as i64),
    };

    let img_stream = Stream::new(img_dict, pixels);
    let img_id = doc.add_object(Object::Stream(img_stream));

    // Content stream that paints the image across the full page (612x792 pts)
    let content = format!(
        "q {} 0 0 {} 0 0 cm /Img1 Do Q",
        612, 792
    )
    .into_bytes();
    let content_id = doc.add_object(Stream::new(dictionary! {}, content));

    let font_id = doc.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type1",
        "BaseFont" => "Helvetica",
    });

    let resources = dictionary! {
        "Font" => dictionary! { "F1" => Object::Reference(font_id) },
        "XObject" => dictionary! { "Img1" => Object::Reference(img_id) },
    };

    let page = dictionary! {
        "Type" => "Page",
        "Parent" => Object::Reference(pages_id),
        "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
        "Contents" => Object::Reference(content_id),
        "Resources" => resources,
    };
    let page_id = doc.add_object(page);

    let pages = dictionary! {
        "Type" => "Pages",
        "Kids" => vec![Object::Reference(page_id)],
        "Count" => Object::Integer(1),
    };
    doc.objects.insert(pages_id, Object::Dictionary(pages));

    let catalog = dictionary! {
        "Type" => "Catalog",
        "Pages" => Object::Reference(pages_id),
    };
    let catalog_id = doc.add_object(catalog);
    doc.trailer.set("Root", Object::Reference(catalog_id));

    let mut buf = Vec::new();
    doc.save_to(&mut buf).unwrap();
    buf
}

/// Create a test PDF with a JPEG-encoded image (DCTDecode).
fn make_pdf_with_jpeg_image(img_w: u32, img_h: u32, quality: u8) -> Vec<u8> {
    use image::codecs::jpeg::JpegEncoder;
    use image::{ImageBuffer, RgbImage};

    // Create an RGB image with a gradient
    let img: RgbImage = ImageBuffer::from_fn(img_w, img_h, |x, y| {
        image::Rgb([(x % 256) as u8, (y % 256) as u8, ((x + y) % 256) as u8])
    });

    // Encode as JPEG
    let mut jpeg_buf = Vec::new();
    let encoder = JpegEncoder::new_with_quality(&mut jpeg_buf, quality);
    image::DynamicImage::ImageRgb8(img)
        .write_with_encoder(encoder)
        .unwrap();

    let mut doc = Document::with_version("1.7");
    let pages_id = doc.new_object_id();

    let img_dict = dictionary! {
        "Type" => "XObject",
        "Subtype" => "Image",
        "Width" => Object::Integer(img_w as i64),
        "Height" => Object::Integer(img_h as i64),
        "ColorSpace" => "DeviceRGB",
        "BitsPerComponent" => Object::Integer(8),
        "Filter" => "DCTDecode",
        "Length" => Object::Integer(jpeg_buf.len() as i64),
    };

    let img_stream = Stream::new(img_dict, jpeg_buf);
    let img_id = doc.add_object(Object::Stream(img_stream));

    let content = format!("q {} 0 0 {} 0 0 cm /Img1 Do Q", 612, 792).into_bytes();
    let content_id = doc.add_object(Stream::new(dictionary! {}, content));

    let resources = dictionary! {
        "XObject" => dictionary! { "Img1" => Object::Reference(img_id) },
    };

    let page = dictionary! {
        "Type" => "Page",
        "Parent" => Object::Reference(pages_id),
        "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
        "Contents" => Object::Reference(content_id),
        "Resources" => resources,
    };
    let page_id = doc.add_object(page);

    let pages = dictionary! {
        "Type" => "Pages",
        "Kids" => vec![Object::Reference(page_id)],
        "Count" => Object::Integer(1),
    };
    doc.objects.insert(pages_id, Object::Dictionary(pages));

    let catalog = dictionary! {
        "Type" => "Catalog",
        "Pages" => Object::Reference(pages_id),
    };
    let catalog_id = doc.add_object(catalog);
    doc.trailer.set("Root", Object::Reference(catalog_id));

    let mut buf = Vec::new();
    doc.save_to(&mut buf).unwrap();
    buf
}

// -----------------------------------------------------------------------
// Downsample tests
// -----------------------------------------------------------------------

#[test]
fn downsample_reduces_high_dpi_image() {
    // 3000x3000 image on a 612x792 page => ~352 DPI
    // Downsampling to 150 DPI should reduce to ~1275x1650
    let pdf = make_pdf_with_image(3000, 3000);
    let original_size = pdf.len();

    let mut doc = Document::load_mem(&pdf).unwrap();
    let count = image_opt::downsample_images(&mut doc, 150.0);

    assert!(count > 0, "should have downsampled at least one image");

    let mut buf = Vec::new();
    doc.save_to(&mut buf).unwrap();
    assert!(
        buf.len() < original_size,
        "downsampled PDF ({}) should be smaller than original ({})",
        buf.len(),
        original_size
    );
}

#[test]
fn downsample_skips_low_dpi_image() {
    // 100x100 image on a 612x792 page => ~12 DPI — already below 150
    let pdf = make_pdf_with_image(100, 100);

    let mut doc = Document::load_mem(&pdf).unwrap();
    let count = image_opt::downsample_images(&mut doc, 150.0);

    assert_eq!(count, 0, "should not downsample a low-DPI image");
}

#[test]
fn downsample_72dpi_more_aggressive() {
    let pdf = make_pdf_with_image(2000, 2000);

    let mut doc_150 = Document::load_mem(&pdf).unwrap();
    image_opt::downsample_images(&mut doc_150, 150.0);
    let mut buf_150 = Vec::new();
    doc_150.save_to(&mut buf_150).unwrap();

    let mut doc_72 = Document::load_mem(&pdf).unwrap();
    image_opt::downsample_images(&mut doc_72, 72.0);
    let mut buf_72 = Vec::new();
    doc_72.save_to(&mut buf_72).unwrap();

    assert!(
        buf_72.len() < buf_150.len(),
        "72 DPI ({}) should be smaller than 150 DPI ({})",
        buf_72.len(),
        buf_150.len()
    );
}

// -----------------------------------------------------------------------
// Lossy JPEG recompression tests
// -----------------------------------------------------------------------

#[test]
fn lossy_recompress_reduces_raw_image() {
    let pdf = make_pdf_with_image(800, 600);
    let original_size = pdf.len();

    let mut doc = Document::load_mem(&pdf).unwrap();
    let count = image_opt::recompress_images_lossy(&mut doc, 75);

    assert!(count > 0, "should have recompressed at least one image");

    let mut buf = Vec::new();
    doc.save_to(&mut buf).unwrap();
    assert!(
        buf.len() < original_size,
        "JPEG-compressed PDF ({}) should be smaller than raw ({})",
        buf.len(),
        original_size
    );
}

#[test]
fn lossy_recompress_lower_quality_is_smaller() {
    let pdf = make_pdf_with_image(800, 600);

    let mut doc_75 = Document::load_mem(&pdf).unwrap();
    image_opt::recompress_images_lossy(&mut doc_75, 75);
    let mut buf_75 = Vec::new();
    doc_75.save_to(&mut buf_75).unwrap();

    let mut doc_45 = Document::load_mem(&pdf).unwrap();
    image_opt::recompress_images_lossy(&mut doc_45, 45);
    let mut buf_45 = Vec::new();
    doc_45.save_to(&mut buf_45).unwrap();

    assert!(
        buf_45.len() < buf_75.len(),
        "quality 45 ({}) should be smaller than quality 75 ({})",
        buf_45.len(),
        buf_75.len()
    );
}

#[test]
fn lossy_recompress_skips_tiny_images() {
    // 32x32 image — too small to bother with lossy compression
    let pdf = make_pdf_with_image(32, 32);

    let mut doc = Document::load_mem(&pdf).unwrap();
    let count = image_opt::recompress_images_lossy(&mut doc, 75);

    assert_eq!(count, 0, "should skip tiny images");
}

// -----------------------------------------------------------------------
// Grayscale conversion tests
// -----------------------------------------------------------------------

#[test]
fn grayscale_converts_rgb_image() {
    let pdf = make_pdf_with_image(400, 400);
    let original_size = pdf.len();

    let mut doc = Document::load_mem(&pdf).unwrap();
    let count = image_opt::convert_images_to_grayscale(&mut doc);

    assert!(count > 0, "should have converted at least one image");

    let mut buf = Vec::new();
    doc.save_to(&mut buf).unwrap();
    assert!(
        buf.len() < original_size,
        "grayscale PDF ({}) should be smaller than color ({})",
        buf.len(),
        original_size
    );
}

// -----------------------------------------------------------------------
// DPI detection and stepping tests
// -----------------------------------------------------------------------

#[test]
fn detect_max_dpi_correct() {
    // 3000x3000 image on a 612x792 page
    // DPI_x = 3000 / (612/72) = 3000 / 8.5 = ~352.9
    // DPI_y = 3000 / (792/72) = 3000 / 11.0 = ~272.7
    // Max = ~352.9
    let pdf = make_pdf_with_image(3000, 3000);
    let doc = Document::load_mem(&pdf).unwrap();
    let images = image_opt::collect_images(&doc);
    let page_sizes = image_opt::collect_page_image_sizes(&doc);
    let max_dpi = image_opt::detect_max_dpi(&images, &page_sizes).unwrap();
    assert!(max_dpi > 340.0 && max_dpi < 360.0, "expected ~353 DPI, got {max_dpi}");
}

#[test]
fn detect_max_dpi_none_without_images() {
    let pdf = helpers::make_test_pdf(3);
    let doc = Document::load_mem(&pdf).unwrap();
    let images = image_opt::collect_images(&doc);
    let page_sizes = image_opt::collect_page_image_sizes(&doc);
    assert!(image_opt::detect_max_dpi(&images, &page_sizes).is_none());
}

#[test]
fn dpi_steps_from_high() {
    // From 350 DPI, step by 50, floor 72
    let steps = image_opt::dpi_steps(350.0, 72.0, 50.0);
    // Should be: 300, 250, 200, 150, 100, 72
    assert_eq!(steps.len(), 6, "steps: {:?}", steps);
    assert!((steps[0] - 300.0).abs() < 0.1);
    assert!((steps[1] - 250.0).abs() < 0.1);
    assert!((steps.last().unwrap() - 72.0).abs() < 0.1);
}

#[test]
fn dpi_steps_from_low() {
    // From 120 DPI — only 1 step to 72
    let steps = image_opt::dpi_steps(120.0, 72.0, 50.0);
    assert!(steps.len() >= 1, "steps: {:?}", steps);
    assert!((steps.last().unwrap() - 72.0).abs() < 0.1);
}

#[test]
fn dpi_steps_already_at_floor() {
    let steps = image_opt::dpi_steps(72.0, 72.0, 50.0);
    // No meaningful steps — first step would be 50 which is below floor
    // Should still include floor
    assert!(!steps.is_empty(), "should include at least the floor");
}

#[test]
fn downsample_with_high_preset() {
    // 3000x3000 image (~353 DPI) with High preset should downsample to 100 DPI
    let pdf = make_pdf_with_image(3000, 3000);
    let opts = CompressOptions {
        preset: CompressionPreset::High,
        ..Default::default()
    };
    let (_, result) = compress_bytes(&pdf, &opts).unwrap();

    let has_downsample = result
        .techniques_applied
        .iter()
        .any(|t| t.contains("Downsampled"));

    assert!(
        has_downsample,
        "expected downsample technique, got: {:?}",
        result.techniques_applied
    );
}

// -----------------------------------------------------------------------
// JPEG 2000 encoding tests
// -----------------------------------------------------------------------

#[test]
fn jpeg2000_recompress_reduces_raw_image() {
    let pdf = make_pdf_with_image(800, 600);
    let original_size = pdf.len();

    let mut doc = Document::load_mem(&pdf).unwrap();
    let count = image_opt::recompress_images_jpeg2000(&mut doc);

    assert!(count > 0, "should have re-encoded at least one image as JP2");

    let mut buf = Vec::new();
    doc.save_to(&mut buf).unwrap();
    assert!(
        buf.len() < original_size,
        "JP2-encoded PDF ({}) should be smaller than raw ({})",
        buf.len(),
        original_size
    );
}

#[test]
fn jpeg2000_skips_tiny_images() {
    let pdf = make_pdf_with_image(32, 32);

    let mut doc = Document::load_mem(&pdf).unwrap();
    let count = image_opt::recompress_images_jpeg2000(&mut doc);

    assert_eq!(count, 0, "should skip tiny images");
}

#[test]
fn jpeg2000_output_is_valid_pdf() {
    let pdf = make_pdf_with_image(400, 300);

    let mut doc = Document::load_mem(&pdf).unwrap();
    image_opt::recompress_images_jpeg2000(&mut doc);

    let mut buf = Vec::new();
    doc.save_to(&mut buf).unwrap();

    // Output should be parseable
    let out_doc = PdfDocument::from_bytes(&buf).unwrap();
    assert_eq!(out_doc.page_count(), 1);
}

// -----------------------------------------------------------------------
// JPEG image handling tests
// -----------------------------------------------------------------------

#[test]
fn downsample_works_on_jpeg_images() {
    // 2000x2000 JPEG on a Letter page => ~235 DPI
    let pdf = make_pdf_with_jpeg_image(2000, 2000, 90);

    let mut doc = Document::load_mem(&pdf).unwrap();
    let count = image_opt::downsample_images(&mut doc, 150.0);

    assert!(count > 0, "should downsample high-DPI JPEG image");
}

#[test]
fn lossy_recompress_jpeg_at_lower_quality() {
    // High-quality JPEG recompressed at lower quality
    let pdf = make_pdf_with_jpeg_image(800, 600, 95);
    let original_size = pdf.len();

    let mut doc = Document::load_mem(&pdf).unwrap();
    let count = image_opt::recompress_images_lossy(&mut doc, 60);

    assert!(count > 0, "should recompress JPEG at lower quality");

    let mut buf = Vec::new();
    doc.save_to(&mut buf).unwrap();
    assert!(
        buf.len() < original_size,
        "lower quality JPEG ({}) should be smaller than original ({})",
        buf.len(),
        original_size
    );
}

// -----------------------------------------------------------------------
// Oxipng lossless recompression tests
// -----------------------------------------------------------------------

#[test]
fn oxipng_recompresses_raw_rgb_image() {
    let pdf = make_pdf_with_image(800, 600);
    let original_size = pdf.len();

    let mut doc = Document::load_mem(&pdf).unwrap();
    let count = image_opt::recompress_images_oxipng(&mut doc);

    assert!(count > 0, "should have oxipng-optimized at least one image");

    let mut buf = Vec::new();
    doc.save_to(&mut buf).unwrap();
    assert!(
        buf.len() < original_size,
        "oxipng-compressed PDF ({}) should be smaller than raw ({})",
        buf.len(),
        original_size
    );
}

#[test]
fn oxipng_skips_jpeg_images() {
    let pdf = make_pdf_with_jpeg_image(800, 600, 85);

    let mut doc = Document::load_mem(&pdf).unwrap();
    let count = image_opt::recompress_images_oxipng(&mut doc);

    assert_eq!(count, 0, "should skip DCTDecode (JPEG) images");
}

#[test]
fn oxipng_output_is_valid_pdf() {
    let pdf = make_pdf_with_image(400, 300);

    let mut doc = Document::load_mem(&pdf).unwrap();
    image_opt::recompress_images_oxipng(&mut doc);

    let mut buf = Vec::new();
    doc.save_to(&mut buf).unwrap();

    // Output should be parseable
    let out_doc = PdfDocument::from_bytes(&buf).unwrap();
    assert_eq!(out_doc.page_count(), 1);
}

#[test]
fn oxipng_recompressed_image_uses_flatedecode_with_predictor() {
    let pdf = make_pdf_with_image(400, 300);

    let mut doc = Document::load_mem(&pdf).unwrap();
    let count = image_opt::recompress_images_oxipng(&mut doc);
    assert!(count > 0);

    // Find the image stream and verify it has FlateDecode + PNG predictor
    let image_stream = doc
        .objects
        .values()
        .find_map(|obj| {
            if let Object::Stream(s) = obj {
                let is_image = s
                    .dict
                    .get(b"Subtype")
                    .ok()
                    .and_then(|v| v.as_name().ok())
                    .map(|n| n == b"Image")
                    .unwrap_or(false);
                if is_image {
                    Some(s)
                } else {
                    None
                }
            } else {
                None
            }
        })
        .expect("should have an image stream");

    // Check filter is FlateDecode
    let filter = image_stream
        .dict
        .get(b"Filter")
        .unwrap()
        .as_name()
        .unwrap();
    assert_eq!(filter, b"FlateDecode");

    // Check DecodeParms has Predictor=15 (PNG)
    let parms = image_stream
        .dict
        .get(b"DecodeParms")
        .unwrap()
        .as_dict()
        .unwrap();
    let predictor = parms.get(b"Predictor").unwrap().as_i64().unwrap();
    assert_eq!(predictor, 15, "should use PNG predictor (15)");
}

#[test]
fn oxipng_appears_in_pipeline_techniques() {
    let pdf = make_pdf_with_image(800, 600);

    let (_, result) = compress_bytes(&pdf, &CompressOptions::default()).unwrap();

    let has_oxipng = result
        .techniques_applied
        .iter()
        .any(|t| t.contains("Oxipng"));
    assert!(
        has_oxipng,
        "pipeline should report oxipng technique, got: {:?}",
        result.techniques_applied
    );
}

/// Create a test PDF with a grayscale image.
fn make_pdf_with_gray_image(img_w: u32, img_h: u32) -> Vec<u8> {
    let mut doc = Document::with_version("1.7");
    let pages_id = doc.new_object_id();

    let pixel_count = (img_w * img_h) as usize;
    let mut pixels = Vec::with_capacity(pixel_count);
    for y in 0..img_h {
        for x in 0..img_w {
            pixels.push(((x + y) % 256) as u8);
        }
    }

    let img_dict = dictionary! {
        "Type" => "XObject",
        "Subtype" => "Image",
        "Width" => Object::Integer(img_w as i64),
        "Height" => Object::Integer(img_h as i64),
        "ColorSpace" => "DeviceGray",
        "BitsPerComponent" => Object::Integer(8),
        "Length" => Object::Integer(pixels.len() as i64),
    };

    let img_stream = Stream::new(img_dict, pixels);
    let img_id = doc.add_object(Object::Stream(img_stream));

    let content = format!("q {} 0 0 {} 0 0 cm /Img1 Do Q", 612, 792).into_bytes();
    let content_id = doc.add_object(Stream::new(dictionary! {}, content));

    let resources = dictionary! {
        "XObject" => dictionary! { "Img1" => Object::Reference(img_id) },
    };

    let page = dictionary! {
        "Type" => "Page",
        "Parent" => Object::Reference(pages_id),
        "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
        "Contents" => Object::Reference(content_id),
        "Resources" => resources,
    };
    let page_id = doc.add_object(page);

    let pages = dictionary! {
        "Type" => "Pages",
        "Kids" => vec![Object::Reference(page_id)],
        "Count" => Object::Integer(1),
    };
    doc.objects.insert(pages_id, Object::Dictionary(pages));

    let catalog = dictionary! {
        "Type" => "Catalog",
        "Pages" => Object::Reference(pages_id),
    };
    let catalog_id = doc.add_object(catalog);
    doc.trailer.set("Root", Object::Reference(catalog_id));

    let mut buf = Vec::new();
    doc.save_to(&mut buf).unwrap();
    buf
}

#[test]
fn oxipng_handles_grayscale_images() {
    let pdf = make_pdf_with_gray_image(400, 300);
    let original_size = pdf.len();

    let mut doc = Document::load_mem(&pdf).unwrap();
    let count = image_opt::recompress_images_oxipng(&mut doc);

    assert!(count > 0, "should optimize grayscale images");

    let mut buf = Vec::new();
    doc.save_to(&mut buf).unwrap();
    assert!(
        buf.len() < original_size,
        "oxipng grayscale ({}) should be smaller than raw ({})",
        buf.len(),
        original_size
    );
}

// -----------------------------------------------------------------------
// Full pipeline integration tests
// -----------------------------------------------------------------------

#[test]
fn full_compress_pipeline_with_images() {
    let pdf = make_pdf_with_image(2000, 1500);
    let original_size = pdf.len();

    let (output, result) = compress_bytes(&pdf, &CompressOptions::default()).unwrap();

    assert!(
        output.len() < original_size,
        "compressed ({}) should be smaller than original ({})",
        output.len(),
        original_size
    );

    // Lossless-only mode should still apply lossless image recompression
    let has_lossless_technique = result
        .techniques_applied
        .iter()
        .any(|t| t.contains("image") || t.contains("Image") || t.contains("Recompressed"));
    assert!(
        has_lossless_technique,
        "expected lossless techniques, got: {:?}",
        result.techniques_applied
    );

    // Output is valid
    let doc = PdfDocument::from_bytes(&output).unwrap();
    assert_eq!(doc.page_count(), 1);
}

#[test]
fn compress_with_medium_preset_reduces_image_heavy_pdf() {
    let pdf = make_pdf_with_image(2000, 2000);
    let original_size = pdf.len();

    let opts = CompressOptions {
        preset: CompressionPreset::Medium,
        ..Default::default()
    };
    let (output, _result) = compress_bytes(&pdf, &opts).unwrap();

    assert!(
        output.len() < original_size,
        "medium preset should reduce size: {} -> {}",
        original_size,
        output.len()
    );

    let doc = PdfDocument::from_bytes(&output).unwrap();
    assert_eq!(doc.page_count(), 1);
}

#[test]
fn compress_preserves_validity_with_jpeg_images() {
    let pdf = make_pdf_with_jpeg_image(1200, 900, 85);

    let (output, _result) = compress_bytes(&pdf, &CompressOptions::default()).unwrap();

    let doc = PdfDocument::from_bytes(&output).unwrap();
    assert_eq!(doc.page_count(), 1);
}

// -----------------------------------------------------------------------
// Parallel pipeline tests
// -----------------------------------------------------------------------

#[test]
fn parallel_pipeline_with_raw_image() {
    let pdf = make_pdf_with_image(2000, 1500);
    let opts = CompressOptions {
        preset: CompressionPreset::Medium,
        ..Default::default()
    };

    // Phase 1: should extract image tasks
    let tasks = compress_begin(&pdf, &opts).unwrap();
    assert!(tasks.is_some(), "raw image should produce tasks");
    let tasks = tasks.unwrap();
    assert!(!tasks.is_empty());

    // Simulate parallel processing: process each task
    let results: Vec<_> = tasks
        .iter()
        .filter_map(|t| image_opt::process_image_task(t))
        .collect();
    assert!(!results.is_empty(), "should produce at least one result");

    // Phase 3: apply results and finalize
    let (output, result) = compress_finish(results).unwrap();
    assert!(result.compressed_size < result.original_size);

    let doc = PdfDocument::from_bytes(&output).unwrap();
    assert_eq!(doc.page_count(), 1);
}

#[test]
fn parallel_pipeline_with_jpeg_image() {
    let pdf = make_pdf_with_jpeg_image(1200, 900, 90);
    let opts = CompressOptions {
        preset: CompressionPreset::High,
        ..Default::default()
    };

    let tasks = compress_begin(&pdf, &opts).unwrap();
    assert!(tasks.is_some(), "JPEG image should produce tasks for High preset");
    let tasks = tasks.unwrap();

    let results: Vec<_> = tasks
        .iter()
        .filter_map(|t| image_opt::process_image_task(t))
        .collect();

    let (output, result) = compress_finish(results).unwrap();
    assert!(result.compressed_size < result.original_size);

    let doc = PdfDocument::from_bytes(&output).unwrap();
    assert_eq!(doc.page_count(), 1);
}

#[test]
fn parallel_matches_sequential_output() {
    let pdf = make_pdf_with_image(1000, 800);
    let opts = CompressOptions {
        preset: CompressionPreset::Low,
        ..Default::default()
    };

    // Sequential
    let (_seq_output, seq_result) = compress_bytes(&pdf, &opts).unwrap();

    // Parallel
    let tasks = compress_begin(&pdf, &opts).unwrap().unwrap();
    let results: Vec<_> = tasks
        .iter()
        .filter_map(|t| image_opt::process_image_task(t))
        .collect();
    let (_par_output, par_result) = compress_finish(results).unwrap();

    // Both should produce similar results (not byte-identical due to different
    // serialization paths, but same technique count and comparable sizes)
    assert_eq!(
        seq_result.techniques_applied.len(),
        par_result.techniques_applied.len(),
        "sequential: {:?}, parallel: {:?}",
        seq_result.techniques_applied,
        par_result.techniques_applied,
    );
}
