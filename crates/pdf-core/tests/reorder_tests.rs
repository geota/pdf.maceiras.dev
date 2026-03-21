mod helpers;

use pdf_core::reorder::reorder_pages;
use pdf_core::PdfDocument;

#[test]
fn identity_reorder_preserves_pages() {
    let pdf = helpers::make_test_pdf(3);
    let result = reorder_pages(&pdf, &[0, 1, 2]).unwrap();
    let doc = PdfDocument::from_bytes(&result).unwrap();
    assert_eq!(doc.page_count(), 3);
}

#[test]
fn reverse_page_order() {
    let pdf = helpers::make_test_pdf(4);
    let result = reorder_pages(&pdf, &[3, 2, 1, 0]).unwrap();
    let doc = PdfDocument::from_bytes(&result).unwrap();
    assert_eq!(doc.page_count(), 4);
}

#[test]
fn subset_pages() {
    let pdf = helpers::make_test_pdf(5);
    let result = reorder_pages(&pdf, &[1, 3]).unwrap();
    let doc = PdfDocument::from_bytes(&result).unwrap();
    assert_eq!(doc.page_count(), 2);
}

#[test]
fn duplicate_pages() {
    let pdf = helpers::make_test_pdf(2);
    let result = reorder_pages(&pdf, &[0, 0, 1, 1, 0]).unwrap();
    let doc = PdfDocument::from_bytes(&result).unwrap();
    assert_eq!(doc.page_count(), 5);
}

#[test]
fn single_page_extract() {
    let pdf = helpers::make_test_pdf(10);
    let result = reorder_pages(&pdf, &[7]).unwrap();
    let doc = PdfDocument::from_bytes(&result).unwrap();
    assert_eq!(doc.page_count(), 1);
}

#[test]
fn out_of_bounds_fails() {
    let pdf = helpers::make_test_pdf(3);
    let result = reorder_pages(&pdf, &[0, 5]);
    assert!(result.is_err());
}

#[test]
fn empty_order_fails() {
    let pdf = helpers::make_test_pdf(3);
    let result = reorder_pages(&pdf, &[]);
    assert!(result.is_err());
}

#[test]
fn reorder_roundtrip_is_valid_pdf() {
    let pdf = helpers::make_test_pdf(4);
    let reordered = reorder_pages(&pdf, &[2, 0, 3, 1]).unwrap();
    // Should be loadable and re-reorderable
    let re_reordered = reorder_pages(&reordered, &[1, 3, 0, 2]).unwrap();
    let doc = PdfDocument::from_bytes(&re_reordered).unwrap();
    assert_eq!(doc.page_count(), 4);
}
