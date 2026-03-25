mod helpers;

use pdf_core::compress::{compress_bytes, analyze_pdf, AdvancedMode, CompressOptions, CompressionPreset};
use pdf_core::PdfDocument;

#[test]
fn compress_reduces_size_or_stays_same() {
    let pdf = helpers::make_test_pdf(10);
    let original_size = pdf.len();

    let (output, result) = compress_bytes(&pdf, &CompressOptions::default()).unwrap();

    assert_eq!(result.original_size, original_size);
    assert!(result.compressed_size <= original_size);
    assert!(!result.techniques_applied.is_empty());

    let doc = PdfDocument::from_bytes(&output).unwrap();
    assert_eq!(doc.page_count(), 10);
}

#[test]
fn compress_with_text_content() {
    let pdf = helpers::make_test_pdf_with_text(5, Some("Hello, this is test content on every page"));
    let original_size = pdf.len();

    let (output, result) = compress_bytes(&pdf, &CompressOptions::default()).unwrap();
    assert_eq!(result.original_size, original_size);

    let doc = PdfDocument::from_bytes(&output).unwrap();
    assert_eq!(doc.page_count(), 5);
}

#[test]
fn compress_with_low_preset() {
    let pdf = helpers::make_test_pdf(5);

    let opts = CompressOptions {
        preset: CompressionPreset::Low,
        ..Default::default()
    };
    let (_output, result) = compress_bytes(&pdf, &opts).unwrap();
    assert!(!result.techniques_applied.is_empty());

    let doc = PdfDocument::from_bytes(&_output).unwrap();
    assert_eq!(doc.page_count(), 5);
}

#[test]
fn compress_with_advanced_direct() {
    let pdf = helpers::make_test_pdf(5);

    let opts = CompressOptions {
        preset: CompressionPreset::Advanced,
        advanced: Some(AdvancedMode::Direct {
            dpi: Some(150.0),
            jpeg_quality: Some(70),
            jp2: false,
        }),
        ..Default::default()
    };
    let (_output, result) = compress_bytes(&pdf, &opts).unwrap();
    assert!(!result.techniques_applied.is_empty());

    let doc = PdfDocument::from_bytes(&_output).unwrap();
    assert_eq!(doc.page_count(), 5);
}

#[test]
fn compress_with_advanced_target_size() {
    let pdf = helpers::make_test_pdf(1);

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
    let (_output, result) = compress_bytes(&pdf, &opts).unwrap();
    assert!(result.target_met);
}

#[test]
fn compress_preserves_page_count() {
    for num_pages in [1, 3, 10, 20] {
        let pdf = helpers::make_test_pdf(num_pages);
        let (output, _result) = compress_bytes(&pdf, &CompressOptions::default()).unwrap();
        let doc = PdfDocument::from_bytes(&output).unwrap();
        assert_eq!(doc.page_count(), num_pages, "page count mismatch for {num_pages}-page PDF");
    }
}

#[test]
fn compress_strips_annotations() {
    use lopdf::{dictionary, Document, Object, Stream};

    let mut doc = Document::with_version("1.7");
    let pages_id = doc.new_object_id();
    let content_id = doc.add_object(Stream::new(dictionary! {}, b"".to_vec()));
    let annot = dictionary! {
        "Type" => "Annot",
        "Subtype" => "Link",
        "Rect" => vec![0.into(), 0.into(), 100.into(), 100.into()],
    };
    let annot_id = doc.add_object(annot);
    let page = dictionary! {
        "Type" => "Page",
        "Parent" => Object::Reference(pages_id),
        "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
        "Contents" => Object::Reference(content_id),
        "Annots" => vec![Object::Reference(annot_id)],
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

    let (output, result) = compress_bytes(&buf, &CompressOptions::default()).unwrap();

    let has_strip = result
        .techniques_applied
        .iter()
        .any(|t| t.contains("metadata") || t.contains("annotation"));
    assert!(has_strip, "expected metadata/annotation stripping, got: {:?}", result.techniques_applied);

    let doc = PdfDocument::from_bytes(&output).unwrap();
    assert_eq!(doc.page_count(), 1);
}

#[test]
fn compress_strips_bookmarks() {
    use lopdf::{dictionary, Document, Object, Stream};

    let mut doc = Document::with_version("1.7");
    let pages_id = doc.new_object_id();
    let content_id = doc.add_object(Stream::new(dictionary! {}, b"".to_vec()));
    let page = dictionary! {
        "Type" => "Page",
        "Parent" => Object::Reference(pages_id),
        "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
        "Contents" => Object::Reference(content_id),
    };
    let page_id = doc.add_object(page);
    let pages = dictionary! {
        "Type" => "Pages",
        "Kids" => vec![Object::Reference(page_id)],
        "Count" => Object::Integer(1),
    };
    doc.objects.insert(pages_id, Object::Dictionary(pages));
    let outlines = dictionary! {
        "Type" => "Outlines",
        "Count" => Object::Integer(0),
    };
    let outlines_id = doc.add_object(outlines);
    let catalog = dictionary! {
        "Type" => "Catalog",
        "Pages" => Object::Reference(pages_id),
        "Outlines" => Object::Reference(outlines_id),
    };
    let catalog_id = doc.add_object(catalog);
    doc.trailer.set("Root", Object::Reference(catalog_id));

    let mut buf = Vec::new();
    doc.save_to(&mut buf).unwrap();

    let (output, result) = compress_bytes(&buf, &CompressOptions::default()).unwrap();

    let compressed_doc = Document::load_mem(&output).unwrap();
    let catalog = compressed_doc.catalog().unwrap();
    assert!(
        catalog.get(b"Outlines").is_err(),
        "Outlines should be removed after compression"
    );

    assert_eq!(PdfDocument::from_bytes(&output).unwrap().page_count(), 1);
    assert!(!result.techniques_applied.is_empty());
}

#[test]
fn compress_result_fields_are_consistent() {
    let pdf = helpers::make_test_pdf(3);
    let (output, result) = compress_bytes(&pdf, &CompressOptions::default()).unwrap();

    assert_eq!(result.original_size, pdf.len());
    assert_eq!(result.compressed_size, output.len());
}

#[test]
fn compress_empty_pdf_succeeds() {
    use lopdf::{dictionary, Document, Object};

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

    let (output, _result) = compress_bytes(&buf, &CompressOptions::default()).unwrap();
    let doc = PdfDocument::from_bytes(&output).unwrap();
    assert_eq!(doc.page_count(), 0);
}

#[test]
fn analyze_pdf_on_empty_pdf() {
    let pdf = helpers::make_test_pdf(1);
    let analysis = analyze_pdf(&pdf).unwrap();
    assert_eq!(analysis.total_image_count, 0);
    assert!(analysis.max_dpi.is_none());
    assert!(analysis.estimated_jpeg_quality.is_none());
}
