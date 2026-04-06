//! PDF repair: rebuild cross-reference table by scanning for objects.
//!
//! Some scanners produce PDFs with corrupt or non-standard xref tables.
//! This module provides a fallback that scans the raw bytes for `N N obj`
//! markers, extracts each object, and rebuilds a valid PDF that lopdf
//! can parse.

use lopdf::Document;

use crate::error::{PdfError, Result};

/// Try to load a PDF, repairing a broken xref table if the first attempt fails.
///
/// First attempts a quick fix for `/Prev 0` trailers (common in Windows
/// scanner output), then falls back to a full xref rebuild.
pub fn load_or_repair(data: &[u8]) -> Result<Document> {
    match Document::load_mem(data) {
        Ok(doc) => Ok(doc),
        Err(_first_err) => {
            // Quick fix: some scanners write `/Prev 0` in the trailer which
            // sends lopdf to byte 0 (the PDF header) looking for a prev xref.
            if let Some(patched) = patch_prev_zero(data) {
                if let Ok(doc) = Document::load_mem(&patched) {
                    return Ok(doc);
                }
            }
            // Full rebuild as last resort
            let repaired = rebuild_pdf(data)?;
            Document::load_mem(&repaired)
                .map_err(|e| PdfError::InvalidPdf(format!("repair failed: {e}")))
        }
    }
}

/// Patch `/Prev 0` entries in trailer dictionaries.
///
/// Some scanners (notably Windows Scan) write `/Prev 0` meaning "no previous
/// xref", but the PDF spec says `/Prev` must point to a valid xref offset.
/// Offset 0 is the file header, causing a parse error. We replace the `0`
/// after `/Prev` with a space so lopdf ignores it.
fn patch_prev_zero(data: &[u8]) -> Option<Vec<u8>> {
    let needle = b"/Prev 0";
    // Only patch if the pattern exists
    if find_subsequence(data, needle).is_none() {
        return None;
    }
    let mut patched = data.to_vec();
    let mut pos = 0;
    let mut changed = false;
    while pos < patched.len() {
        if let Some(idx) = find_subsequence(&patched[pos..], needle) {
            let abs = pos + idx;
            let after = abs + needle.len();
            // Make sure the 0 is not part of a larger number (e.g. "/Prev 01234")
            if after >= patched.len() || !patched[after].is_ascii_digit() {
                // Replace "/Prev 0" with "/Prev  " (space out the value)
                // Actually safer: replace just the "0" with a space so the
                // key effectively has no value and lopdf skips it, OR
                // remove the whole /Prev entry. Let's overwrite with spaces.
                for b in &mut patched[abs..abs + needle.len()] {
                    *b = b' ';
                }
                changed = true;
            }
            pos = after;
        } else {
            break;
        }
    }
    if changed { Some(patched) } else { None }
}

/// Rebuild a PDF by scanning for objects and writing a fresh xref table.
///
/// Strategy:
/// 1. Find the `%PDF-` header and copy the version line.
/// 2. Scan for every `N N obj ... endobj` block.
/// 3. Write them sequentially into a new buffer.
/// 4. Build a traditional xref table from the recorded offsets.
/// 5. Write a trailer with /Size and /Root pointing to the catalog.
fn rebuild_pdf(data: &[u8]) -> Result<Vec<u8>> {
    // Find PDF header
    let header_pos = find_subsequence(data, b"%PDF-")
        .ok_or_else(|| PdfError::InvalidPdf("no %PDF- header found".into()))?;

    // Extract version line (up to first newline)
    let header_end = data[header_pos..]
        .iter()
        .position(|&b| b == b'\n' || b == b'\r')
        .unwrap_or(8);
    let version_line = &data[header_pos..header_pos + header_end];

    // Scan for all object positions: look for `N N obj` pattern
    let objects = scan_objects(data);
    if objects.is_empty() {
        return Err(PdfError::InvalidPdf("no objects found during repair".into()));
    }

    // Find the Root (catalog) object ID from any trailer in the original
    let root_id = find_root_reference(data);

    let mut out = Vec::with_capacity(data.len());

    // Write header
    out.extend_from_slice(version_line);
    out.extend_from_slice(b"\n%\xe2\xe3\xcf\xd3\n");

    // Write each object and record its offset
    let mut offsets: Vec<(u32, u16, usize)> = Vec::new(); // (obj_num, gen, offset)
    for &(obj_num, gen_num, start, end) in &objects {
        let offset = out.len();
        out.extend_from_slice(&data[start..end]);
        // Ensure newline after endobj
        if !out.ends_with(b"\n") {
            out.push(b'\n');
        }
        offsets.push((obj_num, gen_num, offset));
    }

    // Build xref table
    let xref_offset = out.len();
    let max_obj = offsets.iter().map(|&(n, _, _)| n).max().unwrap_or(0);

    out.extend_from_slice(b"xref\n");
    out.extend_from_slice(format!("0 {}\n", max_obj + 1).as_bytes());
    // Entry for object 0 (free head)
    out.extend_from_slice(b"0000000000 65535 f \n");

    // Build a map for quick lookup
    let mut offset_map = std::collections::HashMap::new();
    for &(obj_num, gen_num, offset) in &offsets {
        offset_map.insert(obj_num, (gen_num, offset));
    }

    for obj_num in 1..=max_obj {
        if let Some(&(gen, offset)) = offset_map.get(&obj_num) {
            out.extend_from_slice(format!("{:010} {:05} n \n", offset, gen).as_bytes());
        } else {
            out.extend_from_slice(b"0000000000 00000 f \n");
        }
    }

    // Write trailer
    out.extend_from_slice(b"trailer\n<<\n");
    out.extend_from_slice(format!("/Size {}\n", max_obj + 1).as_bytes());

    // Set /Root reference
    if let Some((root_num, root_gen)) = root_id {
        out.extend_from_slice(format!("/Root {} {} R\n", root_num, root_gen).as_bytes());
    } else {
        // Try to find the Catalog object by scanning object types
        if let Some((cat_num, cat_gen)) = find_catalog_object(data, &objects) {
            out.extend_from_slice(format!("/Root {} {} R\n", cat_num, cat_gen).as_bytes());
        } else {
            return Err(PdfError::InvalidPdf("cannot find document catalog".into()));
        }
    }

    // Copy /Info reference if present
    if let Some((info_num, info_gen)) = find_trailer_ref(data, b"/Info") {
        out.extend_from_slice(format!("/Info {} {} R\n", info_num, info_gen).as_bytes());
    }

    out.extend_from_slice(b">>\n");
    out.extend_from_slice(b"startxref\n");
    out.extend_from_slice(format!("{}\n", xref_offset).as_bytes());
    out.extend_from_slice(b"%%EOF\n");

    Ok(out)
}

/// Scan for `N N obj ... endobj` blocks in the raw PDF bytes.
/// Returns (object_number, generation, byte_start, byte_end) for each object.
fn scan_objects(data: &[u8]) -> Vec<(u32, u16, usize, usize)> {
    let mut objects = Vec::new();
    let mut pos = 0;

    while pos < data.len() {
        // Look for a pattern like: digits, space, digits, space, "obj"
        if let Some(obj_start) = find_obj_marker(data, pos) {
            let (obj_num, gen_num, marker_end) = obj_start;

            // Find the matching endobj
            if let Some(endobj_pos) = find_endobj(data, marker_end) {
                let end = endobj_pos + b"endobj".len();
                objects.push((obj_num, gen_num, obj_start.0 as usize, end));

                // Recompute: the start of this object in bytes
                // We need to find where the "N N obj" text starts
                let text_start = find_obj_text_start(data, marker_end, obj_num, gen_num);
                objects.last_mut().unwrap().2 = text_start;

                pos = end;
            } else {
                pos = marker_end;
            }
        } else {
            break;
        }
    }

    objects
}

/// Find the next `N N obj` marker starting from `pos`.
/// Returns (obj_num, gen_num, position_after_obj_keyword).
fn find_obj_marker(data: &[u8], start: usize) -> Option<(u32, u16, usize)> {
    // Search for " obj" or "\nobj" or "\robj" preceded by digits
    let needle = b" obj";
    let mut pos = start;

    while pos + needle.len() < data.len() {
        if let Some(idx) = find_subsequence(&data[pos..], needle) {
            let abs_idx = pos + idx;

            // Check that after "obj" there's whitespace or end
            let after_obj = abs_idx + needle.len();
            if after_obj < data.len() && !is_pdf_whitespace(data[after_obj]) && data[after_obj] != b'<' {
                pos = abs_idx + 1;
                continue;
            }

            // Parse backwards from the space before "obj" to find "gen_num obj_num"
            if let Some((obj_num, gen_num, _line_start)) = parse_obj_id_backwards(data, abs_idx) {
                return Some((obj_num, gen_num, after_obj));
            }
            pos = abs_idx + 1;
        } else {
            break;
        }
    }

    None
}

/// Parse object ID by reading backwards from the position before " obj".
fn parse_obj_id_backwards(data: &[u8], before_obj_space: usize) -> Option<(u32, u16, usize)> {
    // We're at the space in "N N obj", scan back to find gen_num and obj_num
    if before_obj_space == 0 {
        return None;
    }

    // The pattern in the file is:
    // <whitespace> obj_num <space> gen_num <space> obj
    // before_obj_space points to the " " in " obj"

    // Read gen_num (digits going backwards from position before the space)
    let gen_end = before_obj_space;
    let mut gen_start = gen_end;
    while gen_start > 0 && data[gen_start - 1].is_ascii_digit() {
        gen_start -= 1;
    }
    if gen_start == gen_end {
        return None;
    }
    let gen_str = std::str::from_utf8(&data[gen_start..gen_end]).ok()?;
    let gen_num: u16 = gen_str.parse().ok()?;

    // Skip whitespace between obj_num and gen_num
    let mut j = gen_start;
    while j > 0 && is_pdf_whitespace(data[j - 1]) {
        j -= 1;
    }

    // Read obj_num (digits going backwards)
    let obj_end = j;
    let mut obj_start = obj_end;
    while obj_start > 0 && data[obj_start - 1].is_ascii_digit() {
        obj_start -= 1;
    }
    if obj_start == obj_end {
        return None;
    }
    let obj_str = std::str::from_utf8(&data[obj_start..obj_end]).ok()?;
    let obj_num: u32 = obj_str.parse().ok()?;

    // Verify obj_start is preceded by whitespace or start of file
    if obj_start > 0 && !is_pdf_whitespace(data[obj_start - 1]) {
        return None;
    }

    Some((obj_num, gen_num, obj_start))
}

/// Find the start of the object text (the "N N obj" line).
fn find_obj_text_start(data: &[u8], _marker_end: usize, obj_num: u32, gen_num: u16) -> usize {
    // Search backwards from marker_end for the beginning of "obj_num gen_num obj"
    let pattern = format!("{} {} obj", obj_num, gen_num);
    let pattern_bytes = pattern.as_bytes();
    // Search in the last 50 bytes before marker_end
    let search_start = _marker_end.saturating_sub(pattern_bytes.len() + 10);
    find_subsequence(&data[search_start..], pattern_bytes)
        .map(|idx| search_start + idx)
        .unwrap_or(search_start)
}

/// Find `endobj` after the given position.
fn find_endobj(data: &[u8], start: usize) -> Option<usize> {
    find_subsequence(&data[start..], b"endobj").map(|idx| start + idx)
}

/// Find the /Root reference in any trailer dictionary.
fn find_root_reference(data: &[u8]) -> Option<(u32, u16)> {
    find_trailer_ref(data, b"/Root")
}

/// Find a reference value for a given key in any trailer dictionary in the PDF.
fn find_trailer_ref(data: &[u8], key: &[u8]) -> Option<(u32, u16)> {
    // Search for the key in trailer sections
    let mut pos = 0;
    while pos < data.len() {
        if let Some(idx) = find_subsequence(&data[pos..], key) {
            let abs = pos + idx + key.len();
            if let Some((obj_num, gen_num)) = parse_reference_forward(data, abs) {
                return Some((obj_num, gen_num));
            }
            pos = abs;
        } else {
            break;
        }
    }
    None
}

/// Parse "N N R" reference starting from given position (after key).
fn parse_reference_forward(data: &[u8], start: usize) -> Option<(u32, u16)> {
    let mut i = start;
    // Skip whitespace
    while i < data.len() && is_pdf_whitespace(data[i]) {
        i += 1;
    }
    // Read obj_num
    let num_start = i;
    while i < data.len() && data[i].is_ascii_digit() {
        i += 1;
    }
    if i == num_start {
        return None;
    }
    let obj_num: u32 = std::str::from_utf8(&data[num_start..i]).ok()?.parse().ok()?;

    // Skip whitespace
    while i < data.len() && is_pdf_whitespace(data[i]) {
        i += 1;
    }
    // Read gen_num
    let gen_start = i;
    while i < data.len() && data[i].is_ascii_digit() {
        i += 1;
    }
    if i == gen_start {
        return None;
    }
    let gen_num: u16 = std::str::from_utf8(&data[gen_start..i]).ok()?.parse().ok()?;

    // Skip whitespace and expect 'R'
    while i < data.len() && is_pdf_whitespace(data[i]) {
        i += 1;
    }
    if i < data.len() && data[i] == b'R' {
        Some((obj_num, gen_num))
    } else {
        None
    }
}

/// Find the Catalog object among scanned objects by looking for `/Type /Catalog`.
fn find_catalog_object(data: &[u8], objects: &[(u32, u16, usize, usize)]) -> Option<(u32, u16)> {
    for &(obj_num, gen_num, start, end) in objects {
        let slice = &data[start..end.min(data.len())];
        if find_subsequence(slice, b"/Type").is_some()
            && (find_subsequence(slice, b"/Catalog").is_some()
                || find_subsequence(slice, b"/Catalog ").is_some())
        {
            return Some((obj_num, gen_num));
        }
    }
    None
}

fn is_pdf_whitespace(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\n' | b'\r' | 0x00 | 0x0C)
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::dictionary;

    #[test]
    fn valid_pdf_passes_through() {
        // A minimal valid PDF should load without repair
        let mut doc = Document::with_version("1.4");
        let pages_id = doc.new_object_id();
        let page_id = doc.new_object_id();
        let content_id = doc.new_object_id();

        doc.objects.insert(
            content_id,
            lopdf::Object::Stream(lopdf::Stream::new(
                lopdf::Dictionary::new(),
                Vec::new(),
            )),
        );
        doc.objects.insert(
            page_id,
            lopdf::Object::Dictionary(lopdf::dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
                "Contents" => lopdf::Object::Reference(content_id),
            }),
        );
        doc.objects.insert(
            pages_id,
            lopdf::Object::Dictionary(lopdf::dictionary! {
                "Type" => "Pages",
                "Kids" => vec![lopdf::Object::Reference(page_id)],
                "Count" => 1,
            }),
        );
        let catalog_id = doc.add_object(lopdf::dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        doc.trailer.set("Root", lopdf::Object::Reference(catalog_id));

        let mut buf = Vec::new();
        doc.save_to(&mut buf).unwrap();

        let loaded = load_or_repair(&buf).unwrap();
        assert_eq!(loaded.get_pages().len(), 1);
    }

    #[test]
    fn corrupted_xref_is_repaired() {
        // Create a valid PDF first
        let mut doc = Document::with_version("1.4");
        let pages_id = doc.new_object_id();
        let page_id = doc.new_object_id();
        let content_id = doc.new_object_id();

        doc.objects.insert(
            content_id,
            lopdf::Object::Stream(lopdf::Stream::new(
                lopdf::Dictionary::new(),
                Vec::new(),
            )),
        );
        doc.objects.insert(
            page_id,
            lopdf::Object::Dictionary(lopdf::dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
                "Contents" => lopdf::Object::Reference(content_id),
            }),
        );
        doc.objects.insert(
            pages_id,
            lopdf::Object::Dictionary(lopdf::dictionary! {
                "Type" => "Pages",
                "Kids" => vec![lopdf::Object::Reference(page_id)],
                "Count" => 1,
            }),
        );
        let catalog_id = doc.add_object(lopdf::dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        doc.trailer.set("Root", lopdf::Object::Reference(catalog_id));

        let mut buf = Vec::new();
        doc.save_to(&mut buf).unwrap();

        // Corrupt the xref table by replacing "xref" keyword with garbage
        if let Some(xref_pos) = find_subsequence(&buf, b"xref\n") {
            buf[xref_pos] = b'X';
            buf[xref_pos + 1] = b'X';
        }

        // Normal load should fail
        assert!(Document::load_mem(&buf).is_err());

        // Repair should succeed
        let repaired = load_or_repair(&buf).unwrap();
        assert_eq!(repaired.get_pages().len(), 1);
    }
}
