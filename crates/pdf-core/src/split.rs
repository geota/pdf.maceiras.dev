use lopdf::Document;

use crate::error::{PdfError, Result};
use crate::page_utils::{create_empty_document, import_pages};
use crate::types::PageRange;

/// Split a PDF into multiple PDFs based on page ranges.
/// Each range produces one output PDF.
/// Pages are 0-indexed, ranges are [start, end).
pub fn split_bytes(data: &[u8], ranges: &[PageRange]) -> Result<Vec<Vec<u8>>> {
    if ranges.is_empty() {
        return Err(PdfError::EmptyInput);
    }

    let doc = Document::load_mem(data)
        .map_err(|e| PdfError::InvalidPdf(e.to_string()))?;

    let total_pages = doc.get_pages().len() as u32;

    // Validate all ranges upfront
    for range in ranges {
        if range.start >= total_pages {
            return Err(PdfError::PageOutOfRange {
                requested: range.start,
                total: total_pages,
            });
        }
        if range.end > total_pages {
            return Err(PdfError::PageOutOfRange {
                requested: range.end - 1,
                total: total_pages,
            });
        }
        if range.is_empty() {
            return Err(PdfError::SplitFailed("empty page range".into()));
        }
        if range.start >= range.end {
            return Err(PdfError::SplitFailed(format!(
                "invalid range: start ({}) >= end ({})",
                range.start, range.end
            )));
        }
    }

    let pages_map = doc.get_pages();
    let mut page_entries: Vec<(u32, lopdf::ObjectId)> = pages_map.into_iter().collect();
    page_entries.sort_by_key(|(num, _)| *num);

    let mut results = Vec::with_capacity(ranges.len());

    for range in ranges {
        // Build a new document with only the needed pages
        let (mut new_doc, _pages_id) = create_empty_document();

        let page_ids: Vec<_> = (range.start..range.end)
            .map(|idx| page_entries[idx as usize].1)
            .collect();
        import_pages(&mut new_doc, &doc, &page_ids)?;

        new_doc.compress();
        let mut buf = Vec::new();
        new_doc.save_to(&mut buf)?;
        results.push(buf);
    }

    Ok(results)
}
