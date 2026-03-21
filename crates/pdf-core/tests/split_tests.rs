mod helpers;

use pdf_core::split::split_bytes;
use pdf_core::types::PageRange;
use pdf_core::PdfDocument;

#[test]
fn split_first_half() {
    let pdf = helpers::make_test_pdf(4);
    let results = split_bytes(&pdf, &[PageRange::new(0, 2)]).expect("split should succeed");
    assert_eq!(results.len(), 1);

    let doc = PdfDocument::from_bytes(&results[0]).unwrap();
    assert_eq!(doc.page_count(), 2);
}

#[test]
fn split_into_individual_pages() {
    let pdf = helpers::make_test_pdf(3);
    let ranges = vec![
        PageRange::new(0, 1),
        PageRange::new(1, 2),
        PageRange::new(2, 3),
    ];
    let results = split_bytes(&pdf, &ranges).expect("split should succeed");
    assert_eq!(results.len(), 3);

    for result in &results {
        let doc = PdfDocument::from_bytes(result).unwrap();
        assert_eq!(doc.page_count(), 1);
    }
}

#[test]
fn split_entire_document() {
    let pdf = helpers::make_test_pdf(5);
    let results = split_bytes(&pdf, &[PageRange::new(0, 5)]).expect("split should succeed");
    assert_eq!(results.len(), 1);

    let doc = PdfDocument::from_bytes(&results[0]).unwrap();
    assert_eq!(doc.page_count(), 5);
}

#[test]
fn split_multiple_ranges() {
    let pdf = helpers::make_test_pdf(6);
    let ranges = vec![PageRange::new(0, 2), PageRange::new(3, 6)];
    let results = split_bytes(&pdf, &ranges).expect("split should succeed");
    assert_eq!(results.len(), 2);

    let doc1 = PdfDocument::from_bytes(&results[0]).unwrap();
    assert_eq!(doc1.page_count(), 2);

    let doc2 = PdfDocument::from_bytes(&results[1]).unwrap();
    assert_eq!(doc2.page_count(), 3);
}

#[test]
fn split_empty_ranges_fails() {
    let pdf = helpers::make_test_pdf(3);
    let result = split_bytes(&pdf, &[]);
    assert!(result.is_err());
}

#[test]
fn split_out_of_range_fails() {
    let pdf = helpers::make_test_pdf(3);
    let result = split_bytes(&pdf, &[PageRange::new(0, 10)]);
    assert!(result.is_err());
}

#[test]
fn split_start_equals_end_fails() {
    let pdf = helpers::make_test_pdf(3);
    let result = split_bytes(&pdf, &[PageRange::new(2, 2)]);
    assert!(result.is_err());
}

#[test]
fn split_invalid_pdf_fails() {
    let result = split_bytes(b"not a pdf", &[PageRange::new(0, 1)]);
    assert!(result.is_err());
}

#[test]
fn split_output_is_valid_for_further_operations() {
    let pdf = helpers::make_test_pdf(4);
    let results = split_bytes(&pdf, &[PageRange::new(1, 3)]).unwrap();

    // The split output should be valid enough to merge
    let other = helpers::make_test_pdf(1);
    let merged =
        pdf_core::merge::merge_bytes(&[&results[0], &other]).expect("merge after split should work");
    let doc = PdfDocument::from_bytes(&merged).unwrap();
    assert_eq!(doc.page_count(), 3);
}
