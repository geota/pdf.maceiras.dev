use lopdf::Document;

use crate::error::{PdfError, Result};
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
    let mut page_numbers: Vec<u32> = pages_map.keys().copied().collect();
    page_numbers.sort();

    let mut results = Vec::with_capacity(ranges.len());

    for range in ranges {
        let mut new_doc = doc.clone();

        // Collect 1-indexed page numbers to delete (pages outside the range)
        let pages_to_delete: Vec<u32> = page_numbers
            .iter()
            .enumerate()
            .filter_map(|(idx, &page_num)| {
                let idx = idx as u32;
                if idx < range.start || idx >= range.end {
                    Some(page_num)
                } else {
                    None
                }
            })
            .collect();

        new_doc.delete_pages(&pages_to_delete);
        new_doc.prune_objects();
        new_doc.compress();

        let mut buf = Vec::new();
        new_doc.save_to(&mut buf)?;
        results.push(buf);
    }

    Ok(results)
}
