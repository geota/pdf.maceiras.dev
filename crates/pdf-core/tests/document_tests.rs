mod helpers;

use pdf_core::PdfDocument;

#[test]
fn open_valid_pdf() {
    let data = helpers::make_test_pdf(3);
    let doc = PdfDocument::from_bytes(&data).expect("should open valid PDF");
    assert_eq!(doc.page_count(), 3);
}

#[test]
fn open_single_page_pdf() {
    let data = helpers::make_test_pdf(1);
    let doc = PdfDocument::from_bytes(&data).expect("should open single page PDF");
    assert_eq!(doc.page_count(), 1);
}

#[test]
fn open_invalid_pdf_fails() {
    let result = PdfDocument::from_bytes(b"not a pdf");
    assert!(result.is_err());
}

#[test]
fn open_empty_data_fails() {
    let result = PdfDocument::from_bytes(b"");
    assert!(result.is_err());
}

#[test]
fn metadata_returns_page_count() {
    let data = helpers::make_test_pdf(5);
    let doc = PdfDocument::from_bytes(&data).unwrap();
    let meta = doc.metadata();
    assert_eq!(meta.page_count, 5);
}

#[test]
fn roundtrip_preserves_pages() {
    let data = helpers::make_test_pdf(4);
    let doc = PdfDocument::from_bytes(&data).unwrap();
    let output = doc.to_bytes().unwrap();

    let doc2 = PdfDocument::from_bytes(&output).unwrap();
    assert_eq!(doc2.page_count(), 4);
}
