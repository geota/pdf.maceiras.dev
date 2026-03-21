mod helpers;

use pdf_core::merge::merge_bytes;
use pdf_core::PdfDocument;

#[test]
fn merge_two_pdfs() {
    let pdf1 = helpers::make_test_pdf(2);
    let pdf2 = helpers::make_test_pdf(3);

    let merged = merge_bytes(&[&pdf1, &pdf2]).expect("merge should succeed");
    let doc = PdfDocument::from_bytes(&merged).unwrap();
    assert_eq!(doc.page_count(), 5);
}

#[test]
fn merge_single_pdf_is_identity() {
    let pdf = helpers::make_test_pdf(3);
    let merged = merge_bytes(&[&pdf]).expect("single merge should succeed");
    let doc = PdfDocument::from_bytes(&merged).unwrap();
    assert_eq!(doc.page_count(), 3);
}

#[test]
fn merge_three_pdfs() {
    let pdf1 = helpers::make_test_pdf(1);
    let pdf2 = helpers::make_test_pdf(2);
    let pdf3 = helpers::make_test_pdf(4);

    let merged = merge_bytes(&[&pdf1, &pdf2, &pdf3]).expect("triple merge should succeed");
    let doc = PdfDocument::from_bytes(&merged).unwrap();
    assert_eq!(doc.page_count(), 7);
}

#[test]
fn merge_empty_input_fails() {
    let result = merge_bytes(&[]);
    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(err.contains("empty input"), "got: {err}");
}

#[test]
fn merge_invalid_pdf_fails() {
    let valid = helpers::make_test_pdf(1);
    let invalid = b"not a pdf";
    let result = merge_bytes(&[&valid, invalid.as_slice()]);
    assert!(result.is_err());
}

#[test]
fn merged_pdf_is_valid_and_reopenable() {
    let pdf1 = helpers::make_test_pdf(2);
    let pdf2 = helpers::make_test_pdf(2);

    let merged = merge_bytes(&[&pdf1, &pdf2]).unwrap();

    // Verify the merged PDF can be re-merged (validates it's well-formed)
    let pdf3 = helpers::make_test_pdf(1);
    let double_merged = merge_bytes(&[&merged, &pdf3]).expect("re-merge should work");
    let doc = PdfDocument::from_bytes(&double_merged).unwrap();
    assert_eq!(doc.page_count(), 5);
}
