use lopdf::Document;

use crate::error::{PdfError, Result};
use crate::page_utils::{create_empty_document, import_pages};
use crate::repair::load_or_repair;

/// Merge multiple PDFs (as byte slices) into a single PDF.
/// Pages appear in the order of the input documents.
pub fn merge_bytes(pdfs: &[&[u8]]) -> Result<Vec<u8>> {
    if pdfs.is_empty() {
        return Err(PdfError::EmptyInput);
    }

    if pdfs.len() == 1 {
        let mut doc =
            load_or_repair(pdfs[0]).map_err(|e| PdfError::InvalidPdf(e.to_string()))?;
        let mut buf = Vec::new();
        doc.save_to(&mut buf)?;
        return Ok(buf);
    }

    let documents: Vec<Document> = pdfs
        .iter()
        .enumerate()
        .map(|(i, data)| {
            load_or_repair(data)
                .map_err(|e| PdfError::MergeFailed(format!("document {i}: {e}")))
        })
        .collect::<Result<Vec<_>>>()?;

    let (mut merged, _pages_id) = create_empty_document();

    for doc in &documents {
        let pages = doc.get_pages();
        let mut page_numbers: Vec<u32> = pages.keys().copied().collect();
        page_numbers.sort();

        // Collect page ObjectIds in order for batch import
        let page_ids: Vec<_> = page_numbers
            .iter()
            .filter_map(|num| pages.get(num).copied())
            .collect();
        // import_pages shares the id_map across all pages from this source,
        // so shared resources (fonts, images) are cloned only once.
        import_pages(&mut merged, doc, &page_ids)?;
    }

    let mut buf = Vec::new();
    merged.save_to(&mut buf)?;
    Ok(buf)
}
