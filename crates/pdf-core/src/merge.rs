use lopdf::Document;

use crate::error::{PdfError, Result};
use crate::page_utils::{create_empty_document, import_page};

/// Merge multiple PDFs (as byte slices) into a single PDF.
/// Pages appear in the order of the input documents.
pub fn merge_bytes(pdfs: &[&[u8]]) -> Result<Vec<u8>> {
    if pdfs.is_empty() {
        return Err(PdfError::EmptyInput);
    }

    if pdfs.len() == 1 {
        let mut doc = Document::load_mem(pdfs[0])
            .map_err(|e| PdfError::InvalidPdf(e.to_string()))?;
        let mut buf = Vec::new();
        doc.save_to(&mut buf)?;
        return Ok(buf);
    }

    let documents: Vec<Document> = pdfs
        .iter()
        .enumerate()
        .map(|(i, data)| {
            Document::load_mem(data)
                .map_err(|e| PdfError::MergeFailed(format!("document {i}: {e}")))
        })
        .collect::<Result<Vec<_>>>()?;

    let (mut merged, _pages_id) = create_empty_document();

    for doc in &documents {
        let pages = doc.get_pages();
        let mut page_numbers: Vec<u32> = pages.keys().copied().collect();
        page_numbers.sort();

        for page_num in page_numbers {
            if let Some(&page_id) = pages.get(&page_num) {
                import_page(&mut merged, doc, page_id)?;
            }
        }
    }

    let mut buf = Vec::new();
    merged.save_to(&mut buf)?;
    Ok(buf)
}
