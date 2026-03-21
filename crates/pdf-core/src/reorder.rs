use lopdf::Document;

use crate::error::{PdfError, Result};
use crate::page_utils::{create_empty_document, import_page};

/// Reorder (and optionally subset/duplicate) pages in a PDF.
///
/// `page_order` is a slice of 0-indexed page indices in the desired output order.
/// Indices may be repeated (to duplicate pages) or omitted (to delete pages).
pub fn reorder_pages(data: &[u8], page_order: &[u32]) -> Result<Vec<u8>> {
    if page_order.is_empty() {
        return Err(PdfError::ReorderFailed("page_order is empty".into()));
    }

    let source = Document::load_mem(data)
        .map_err(|e| PdfError::InvalidPdf(e.to_string()))?;

    let pages_map = source.get_pages();
    let total_pages = pages_map.len() as u32;

    // Build sorted list of (1-indexed page number, ObjectId)
    let mut page_entries: Vec<(u32, lopdf::ObjectId)> = pages_map.into_iter().collect();
    page_entries.sort_by_key(|(num, _)| *num);

    // Validate all indices
    for &idx in page_order {
        if idx >= total_pages {
            return Err(PdfError::PageOutOfRange {
                requested: idx,
                total: total_pages,
            });
        }
    }

    let (mut result, _pages_id) = create_empty_document();

    for &idx in page_order {
        let (_, page_id) = page_entries[idx as usize];
        import_page(&mut result, &source, page_id)?;
    }

    result.compress();
    let mut buf = Vec::new();
    result.save_to(&mut buf)?;
    Ok(buf)
}
