//! Full-page grayscale conversion via content stream rewriting (Approach A).
//!
//! Uses a byte-level rewriter that surgically replaces color operators in-place
//! without a full decode/encode round-trip, preserving text formatting, inline
//! images, and all non-color stream structure exactly.
//!
//! Luminance formula: L = 0.299*R + 0.587*G + 0.114*B (ITU-R BT.601)
//!
//! `convert_document_to_grayscale()` is the single entry point: it handles
//! content streams, Form XObjects, and raster images in one call.

use lopdf::{Document, Object, ObjectId};
use std::collections::{HashMap, HashSet};

/// Standard luminance weights (ITU-R BT.601).
fn rgb_to_luma(r: f64, g: f64, b: f64) -> f64 {
    (0.299 * r + 0.587 * g + 0.114 * b).clamp(0.0, 1.0)
}

/// Convert CMYK to grayscale luminance.
fn cmyk_to_luma(c: f64, m: f64, y: f64, k: f64) -> f64 {
    let r = (1.0 - c) * (1.0 - k);
    let g = (1.0 - m) * (1.0 - k);
    let b = (1.0 - y) * (1.0 - k);
    rgb_to_luma(r, g, b)
}

/// Build a map of named color spaces → component counts from a page's Resources.
/// Resolves ICCBased (/N), CalRGB (3), CalGray (1), Lab (3), Separation (1),
/// DeviceN (N), Indexed (1 index component).
fn build_color_space_map(doc: &Document, page_id: ObjectId) -> HashMap<String, u32> {
    let mut map = HashMap::new();

    // Built-in device color spaces (always available without Resources entry)
    map.insert("DeviceRGB".into(), 3);
    map.insert("DeviceCMYK".into(), 4);
    map.insert("DeviceGray".into(), 1);

    let resources = doc
        .get_object(page_id)
        .ok()
        .and_then(|o| o.as_dict().ok())
        .and_then(|d| d.get(b"Resources").ok())
        .and_then(|r| match r {
            Object::Reference(id) => doc.get_object(*id).ok(),
            other => Some(other),
        })
        .and_then(|o| o.as_dict().ok());

    let cs_dict = resources
        .and_then(|r| r.get(b"ColorSpace").ok())
        .and_then(|cs| match cs {
            Object::Reference(id) => doc.get_object(*id).ok(),
            other => Some(other),
        })
        .and_then(|o| o.as_dict().ok());

    if let Some(dict) = cs_dict {
        for (name_bytes, val) in dict.iter() {
            let name = String::from_utf8_lossy(name_bytes).into_owned();
            let components = resolve_cs_components(doc, val);
            if let Some(n) = components {
                map.insert(name, n);
            }
        }
    }

    map
}

/// Resolve a color space object to its component count.
/// Returns None for spaces we can't safely convert (Pattern, Indexed, DeviceN).
fn resolve_cs_components(doc: &Document, obj: &Object) -> Option<u32> {
    match obj {
        Object::Name(name) => match name.as_slice() {
            b"DeviceRGB" => Some(3),
            b"DeviceCMYK" => Some(4),
            b"DeviceGray" => Some(1),
            b"Pattern" => None, // patterns are not convertible
            _ => None,
        },
        Object::Reference(id) => {
            doc.get_object(*id).ok().and_then(|o| resolve_cs_components(doc, o))
        }
        Object::Array(arr) if !arr.is_empty() => {
            let cs_type = arr.first()?.as_name().ok()?;
            match cs_type {
                b"ICCBased" => {
                    // Read /N from the ICC profile stream dict
                    let n = arr.get(1)
                        .and_then(|o| if let Object::Reference(r) = o { doc.get_object(*r).ok() } else { None })
                        .and_then(|o| if let Object::Stream(s) = o { s.dict.get(b"N").ok()?.as_i64().ok() } else { None })
                        .unwrap_or(3) as u32;
                    Some(n)
                }
                b"CalRGB" => Some(3),
                b"CalGray" => Some(1),
                b"Lab" => Some(3),
                b"Separation" => Some(1), // Separation always takes 1 tint value
                b"DeviceN" => {
                    // DeviceN: second element is array of colorant names → count = len
                    arr.get(1)
                        .and_then(|o| match o {
                            Object::Array(names) => Some(names.len() as u32),
                            Object::Reference(id) => doc.get_object(*id).ok()
                                .and_then(|o| if let Object::Array(names) = o { Some(names.len() as u32) } else { None }),
                            _ => None,
                        })
                }
                b"Indexed" => None,  // palette indices — skip, not directly convertible
                b"Pattern" => None,
                _ => None,
            }
        }
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Byte-level content stream tokenizer + surgical rewriter
// ---------------------------------------------------------------------------

/// A token parsed from a PDF content stream, with its byte span.
#[derive(Debug, Clone)]
struct Token {
    start: usize,
    end: usize,
    kind: TokenKind,
}

#[derive(Debug, Clone)]
enum TokenKind {
    Number(f64),
    Name(Vec<u8>), // PDF name without leading '/'
    Operator(String),
    Other, // strings, arrays, dicts — we skip these
}

/// Minimal PDF content stream tokenizer.
/// Understands numbers, names, operators, strings, and inline images enough
/// to skip over them without corruption. Returns tokens with byte spans.
fn tokenize(bytes: &[u8]) -> Vec<Token> {
    let mut tokens = Vec::new();
    let mut i = 0;
    let len = bytes.len();

    while i < len {
        // Skip whitespace
        if bytes[i].is_ascii_whitespace() {
            i += 1;
            continue;
        }

        // Skip comments
        if bytes[i] == b'%' {
            while i < len && bytes[i] != b'\n' && bytes[i] != b'\r' {
                i += 1;
            }
            continue;
        }

        // Literal string (...)  — skip over, respecting nesting and escapes
        if bytes[i] == b'(' {
            let start = i;
            i += 1;
            let mut depth = 1;
            while i < len && depth > 0 {
                match bytes[i] {
                    b'\\' => { i += 1; } // skip escaped char
                    b'(' => depth += 1,
                    b')' => depth -= 1,
                    _ => {}
                }
                i += 1;
            }
            tokens.push(Token { start, end: i, kind: TokenKind::Other });
            continue;
        }

        // Hex string <...>  (but not dictionary <<)
        if bytes[i] == b'<' && i + 1 < len && bytes[i + 1] != b'<' {
            let start = i;
            i += 1;
            while i < len && bytes[i] != b'>' {
                i += 1;
            }
            if i < len { i += 1; }
            tokens.push(Token { start, end: i, kind: TokenKind::Other });
            continue;
        }

        // Dictionary << ... >>
        if bytes[i] == b'<' && i + 1 < len && bytes[i + 1] == b'<' {
            let start = i;
            i += 2;
            let mut depth = 1;
            while i + 1 < len && depth > 0 {
                if bytes[i] == b'<' && bytes[i + 1] == b'<' {
                    depth += 1;
                    i += 2;
                } else if bytes[i] == b'>' && bytes[i + 1] == b'>' {
                    depth -= 1;
                    i += 2;
                } else {
                    i += 1;
                }
            }
            tokens.push(Token { start, end: i, kind: TokenKind::Other });
            continue;
        }

        // >> (closing dict — shouldn't appear standalone, but skip it)
        if bytes[i] == b'>' && i + 1 < len && bytes[i + 1] == b'>' {
            let start = i;
            i += 2;
            tokens.push(Token { start, end: i, kind: TokenKind::Other });
            continue;
        }

        // Array [ ... ]
        if bytes[i] == b'[' {
            let start = i;
            i += 1;
            let mut depth = 1;
            while i < len && depth > 0 {
                match bytes[i] {
                    b'[' => depth += 1,
                    b']' => depth -= 1,
                    b'(' => {
                        // skip nested string
                        i += 1;
                        let mut sd = 1;
                        while i < len && sd > 0 {
                            match bytes[i] {
                                b'\\' => { i += 1; }
                                b'(' => sd += 1,
                                b')' => sd -= 1,
                                _ => {}
                            }
                            i += 1;
                        }
                        continue;
                    }
                    _ => {}
                }
                i += 1;
            }
            tokens.push(Token { start, end: i, kind: TokenKind::Other });
            continue;
        }

        // Name /...
        if bytes[i] == b'/' {
            let start = i;
            i += 1;
            while i < len
                && !bytes[i].is_ascii_whitespace()
                && !matches!(bytes[i], b'/' | b'(' | b')' | b'<' | b'>' | b'[' | b']' | b'{' | b'}' | b'%')
            {
                i += 1;
            }
            let name = bytes[start + 1..i].to_vec();
            tokens.push(Token { start, end: i, kind: TokenKind::Name(name) });
            continue;
        }

        // Number: optional sign, digits, optional decimal point
        if bytes[i] == b'+' || bytes[i] == b'-' || bytes[i] == b'.' || bytes[i].is_ascii_digit() {
            let start = i;
            if bytes[i] == b'+' || bytes[i] == b'-' {
                i += 1;
            }
            let mut has_digit = false;
            while i < len && bytes[i].is_ascii_digit() {
                has_digit = true;
                i += 1;
            }
            if i < len && bytes[i] == b'.' {
                i += 1;
                while i < len && bytes[i].is_ascii_digit() {
                    has_digit = true;
                    i += 1;
                }
            }
            if has_digit {
                let s = std::str::from_utf8(&bytes[start..i]).unwrap_or("0");
                let val = s.parse::<f64>().unwrap_or(0.0);
                tokens.push(Token { start, end: i, kind: TokenKind::Number(val) });
            } else {
                // Not a valid number (bare sign or dot) — treat as operator fragment
                tokens.push(Token { start, end: i, kind: TokenKind::Other });
            }
            continue;
        }

        // Operator: sequence of alphabetic chars (and possibly *)
        if bytes[i].is_ascii_alphabetic() || bytes[i] == b'\'' || bytes[i] == b'"' {
            let start = i;
            while i < len && (bytes[i].is_ascii_alphabetic() || bytes[i] == b'*' || bytes[i] == b'\'' || bytes[i] == b'"') {
                i += 1;
            }
            let op = String::from_utf8_lossy(&bytes[start..i]).into_owned();

            // Handle inline image: BI ... ID <binary data> EI
            if op == "BI" {
                // Skip to matching EI — find "ID" first, then scan for "EI"
                let bi_start = start;
                // Find ID marker
                while i + 1 < len {
                    if bytes[i] == b'I' && bytes[i + 1] == b'D'
                        && (i == 0 || bytes[i - 1].is_ascii_whitespace())
                    {
                        i += 2;
                        // Skip the single whitespace char after ID
                        if i < len && (bytes[i] == b' ' || bytes[i] == b'\n' || bytes[i] == b'\r') {
                            i += 1;
                        }
                        break;
                    }
                    i += 1;
                }
                // Now find EI — must be preceded by whitespace
                while i + 1 < len {
                    if bytes[i] == b'E' && bytes[i + 1] == b'I' {
                        // Check preceded by whitespace and followed by whitespace/EOF
                        let preceded = i > 0 && bytes[i - 1].is_ascii_whitespace();
                        let followed = i + 2 >= len || bytes[i + 2].is_ascii_whitespace();
                        if preceded && followed {
                            i += 2;
                            break;
                        }
                    }
                    i += 1;
                }
                tokens.push(Token { start: bi_start, end: i, kind: TokenKind::Other });
                continue;
            }

            tokens.push(Token { start, end: i, kind: TokenKind::Operator(op) });
            continue;
        }

        // Anything else — skip single byte
        i += 1;
    }

    tokens
}

/// A replacement to apply: replace bytes[start..end] with `replacement`.
struct Replacement {
    start: usize,
    end: usize,
    replacement: Vec<u8>,
}

/// Format a grayscale value compactly for PDF output.
fn format_gray(l: f64) -> String {
    if (l - l.round()).abs() < 0.0001 && l >= 0.0 && l <= 9.0 {
        format!("{}", l.round() as i32)
    } else {
        // 4 decimal places, strip trailing zeros
        let s = format!("{:.4}", l);
        let s = s.trim_end_matches('0');
        let s = s.trim_end_matches('.');
        s.to_string()
    }
}

/// Scan tokens for color operators and build byte-level replacements.
/// `cs_map` maps named color spaces to component counts (from page Resources).
/// Tracks cs/CS state to resolve scn/SCN with named color spaces.
/// Returns the list of replacements and the count of operators rewritten.
fn find_color_replacements(
    tokens: &[Token],
    cs_map: &HashMap<String, u32>,
) -> (Vec<Replacement>, usize) {
    let mut replacements = Vec::new();
    let mut count = 0;

    // Track current fill/stroke color space component count.
    // None means unknown (we'll fall back to arg-count heuristic).
    let mut fill_cs_components: Option<u32> = None;
    let mut stroke_cs_components: Option<u32> = None;

    for (ti, tok) in tokens.iter().enumerate() {
        let op = match &tok.kind {
            TokenKind::Operator(op) => op.as_str(),
            _ => continue,
        };

        match op {
            // Track color space changes (don't rewrite, just record state)
            "cs" if ti >= 1 => {
                if let TokenKind::Name(name) = &tokens[ti - 1].kind {
                    let name_str = String::from_utf8_lossy(name);
                    fill_cs_components = cs_map.get(name_str.as_ref()).copied();
                }
                continue;
            }
            "CS" if ti >= 1 => {
                if let TokenKind::Name(name) = &tokens[ti - 1].kind {
                    let name_str = String::from_utf8_lossy(name);
                    stroke_cs_components = cs_map.get(name_str.as_ref()).copied();
                }
                continue;
            }
            // rg/RG also implicitly set the color space
            "rg" if ti >= 3 => {
                fill_cs_components = Some(3);
                if let Some((r, g, b, span_start)) = extract_3_numbers(tokens, ti) {
                    let l = rgb_to_luma(r, g, b);
                    let repl = format!("{} g", format_gray(l));
                    replacements.push(Replacement {
                        start: span_start,
                        end: tok.end,
                        replacement: repl.into_bytes(),
                    });
                    count += 1;
                }
            }
            "RG" if ti >= 3 => {
                stroke_cs_components = Some(3);
                if let Some((r, g, b, span_start)) = extract_3_numbers(tokens, ti) {
                    let l = rgb_to_luma(r, g, b);
                    let repl = format!("{} G", format_gray(l));
                    replacements.push(Replacement {
                        start: span_start,
                        end: tok.end,
                        replacement: repl.into_bytes(),
                    });
                    count += 1;
                }
            }
            "k" if ti >= 4 => {
                fill_cs_components = Some(4);
                if let Some((c, m, y, k, span_start)) = extract_4_numbers(tokens, ti) {
                    let l = cmyk_to_luma(c, m, y, k);
                    let repl = format!("{} g", format_gray(l));
                    replacements.push(Replacement {
                        start: span_start,
                        end: tok.end,
                        replacement: repl.into_bytes(),
                    });
                    count += 1;
                }
            }
            "K" if ti >= 4 => {
                stroke_cs_components = Some(4);
                if let Some((c, m, y, k, span_start)) = extract_4_numbers(tokens, ti) {
                    let l = cmyk_to_luma(c, m, y, k);
                    let repl = format!("{} G", format_gray(l));
                    replacements.push(Replacement {
                        start: span_start,
                        end: tok.end,
                        replacement: repl.into_bytes(),
                    });
                    count += 1;
                }
            }
            "g" => { fill_cs_components = Some(1); }
            "G" => { stroke_cs_components = Some(1); }

            // sc/scn: use tracked fill color space, fall back to arg-count heuristic
            "sc" | "scn" => {
                let n = fill_cs_components;
                if let Some(repl) = try_convert_scn(tokens, ti, n, "g") {
                    replacements.push(repl);
                    count += 1;
                }
            }
            "SC" | "SCN" => {
                let n = stroke_cs_components;
                if let Some(repl) = try_convert_scn(tokens, ti, n, "G") {
                    replacements.push(repl);
                    count += 1;
                }
            }
            _ => {}
        }
    }

    (replacements, count)
}

/// Try to convert an sc/scn/SC/SCN operator to grayscale.
/// `expected_components`: from tracked cs/CS state or None if unknown.
/// `gray_op`: "g" for fill, "G" for stroke.
fn try_convert_scn(
    tokens: &[Token],
    op_index: usize,
    expected_components: Option<u32>,
    gray_op: &str,
) -> Option<Replacement> {
    let tok = &tokens[op_index];

    match expected_components {
        // Known color space — use exact component count
        Some(1) => None, // already grayscale
        Some(3) => {
            let (r, g, b, span_start) = extract_3_numbers(tokens, op_index)?;
            let l = rgb_to_luma(r, g, b);
            let repl = format!("{} {}", format_gray(l), gray_op);
            Some(Replacement { start: span_start, end: tok.end, replacement: repl.into_bytes() })
        }
        Some(4) => {
            let (c, m, y, k, span_start) = extract_4_numbers(tokens, op_index)?;
            let l = cmyk_to_luma(c, m, y, k);
            let repl = format!("{} {}", format_gray(l), gray_op);
            Some(Replacement { start: span_start, end: tok.end, replacement: repl.into_bytes() })
        }
        // Unknown color space or exotic (DeviceN, Separation with N!=1/3/4)
        // Fall back: try 3 numbers (RGB), then 4 (CMYK), else skip
        None | Some(_) => {
            if let Some((r, g, b, span_start)) = extract_3_numbers(tokens, op_index) {
                let l = rgb_to_luma(r, g, b);
                let repl = format!("{} {}", format_gray(l), gray_op);
                Some(Replacement { start: span_start, end: tok.end, replacement: repl.into_bytes() })
            } else if let Some((c, m, y, k, span_start)) = extract_4_numbers(tokens, op_index) {
                let l = cmyk_to_luma(c, m, y, k);
                let repl = format!("{} {}", format_gray(l), gray_op);
                Some(Replacement { start: span_start, end: tok.end, replacement: repl.into_bytes() })
            } else {
                None
            }
        }
    }
}

/// Extract 3 consecutive number tokens immediately before `op_index`.
/// Returns (n1, n2, n3, byte_start_of_first_number).
fn extract_3_numbers(tokens: &[Token], op_index: usize) -> Option<(f64, f64, f64, usize)> {
    if op_index < 3 { return None; }
    let t1 = &tokens[op_index - 3];
    let t2 = &tokens[op_index - 2];
    let t3 = &tokens[op_index - 1];
    match (&t1.kind, &t2.kind, &t3.kind) {
        (TokenKind::Number(a), TokenKind::Number(b), TokenKind::Number(c)) => {
            Some((*a, *b, *c, t1.start))
        }
        _ => None,
    }
}

/// Extract 4 consecutive number tokens immediately before `op_index`.
fn extract_4_numbers(tokens: &[Token], op_index: usize) -> Option<(f64, f64, f64, f64, usize)> {
    if op_index < 4 { return None; }
    let t1 = &tokens[op_index - 4];
    let t2 = &tokens[op_index - 3];
    let t3 = &tokens[op_index - 2];
    let t4 = &tokens[op_index - 1];
    match (&t1.kind, &t2.kind, &t3.kind, &t4.kind) {
        (TokenKind::Number(a), TokenKind::Number(b), TokenKind::Number(c), TokenKind::Number(d)) => {
            Some((*a, *b, *c, *d, t1.start))
        }
        _ => None,
    }
}

/// Apply byte-level replacements to produce a new byte vector.
/// Replacements must be non-overlapping and sorted by start position.
fn apply_replacements(bytes: &[u8], replacements: &[Replacement]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len());
    let mut cursor = 0;

    for r in replacements {
        // Copy everything before this replacement
        out.extend_from_slice(&bytes[cursor..r.start]);
        // Write the replacement
        out.extend_from_slice(&r.replacement);
        cursor = r.end;
    }
    // Copy remaining bytes
    out.extend_from_slice(&bytes[cursor..]);
    out
}

/// Rewrite a single content stream (by ObjectId) to grayscale using byte-level
/// surgical replacement. Does NOT use Content::decode/encode, preserving the
/// exact byte structure of everything it doesn't touch.
fn rewrite_stream_grayscale(
    doc: &mut Document,
    stream_id: ObjectId,
    cs_map: &HashMap<String, u32>,
) -> usize {
    let content_bytes = match doc.get_object(stream_id) {
        Ok(Object::Stream(s)) => match s.decompressed_content() {
            Ok(data) => data,
            Err(_) => s.content.clone(),
        },
        _ => return 0,
    };

    let tokens = tokenize(&content_bytes);
    let (replacements, count) = find_color_replacements(&tokens, cs_map);

    if count == 0 {
        return 0;
    }

    let new_bytes = apply_replacements(&content_bytes, &replacements);

    if let Some(Object::Stream(stream)) = doc.objects.get_mut(&stream_id) {
        stream.set_plain_content(new_bytes);
        let _ = stream.compress();
    }

    count
}

/// Collect Form XObject IDs referenced from a page's Resources.
fn collect_form_xobjects(doc: &Document, page_id: ObjectId) -> Vec<ObjectId> {
    let mut forms = Vec::new();

    let resources = doc
        .get_object(page_id)
        .ok()
        .and_then(|o| o.as_dict().ok())
        .and_then(|d| d.get(b"Resources").ok())
        .and_then(|r| match r {
            Object::Reference(id) => doc.get_object(*id).ok(),
            other => Some(other),
        })
        .and_then(|o| o.as_dict().ok());

    let xobjects = resources
        .and_then(|r| r.get(b"XObject").ok())
        .and_then(|x| match x {
            Object::Reference(id) => doc.get_object(*id).ok(),
            other => Some(other),
        })
        .and_then(|o| o.as_dict().ok());

    if let Some(xobj_dict) = xobjects {
        for (_name, val) in xobj_dict.iter() {
            let id = match val {
                Object::Reference(id) => *id,
                _ => continue,
            };
            // Check if this XObject is a Form (not Image)
            if let Ok(Object::Stream(s)) = doc.get_object(id) {
                if let Ok(Object::Name(subtype)) = s.dict.get(b"Subtype") {
                    if subtype == b"Form" {
                        forms.push(id);
                    }
                }
            }
        }
    }

    forms
}

/// Convert all vector/text content in a page to grayscale by rewriting
/// content stream color operators. Also processes Form XObjects.
///
/// This handles content streams only — raster images are converted by
/// `convert_document_to_grayscale` which calls this plus image conversion.
/// Returns the number of color operators rewritten.
pub fn convert_page_content_to_grayscale(doc: &mut Document, page_id: ObjectId) -> usize {
    let mut total = 0;

    // Build color space map from page Resources
    let cs_map = build_color_space_map(doc, page_id);

    // Rewrite page content streams
    let content_ids: Vec<ObjectId> = doc.get_page_contents(page_id);
    for stream_id in content_ids {
        total += rewrite_stream_grayscale(doc, stream_id, &cs_map);
    }

    // Rewrite Form XObjects referenced by this page
    let mut visited = HashSet::new();
    let form_ids = collect_form_xobjects(doc, page_id);
    for form_id in form_ids {
        if visited.insert(form_id) {
            total += rewrite_stream_grayscale(doc, form_id, &cs_map);
        }
    }

    total
}


/// Convert selected pages in a document to grayscale (content streams + images).
/// If `selected_pages` is None, all pages are converted.
/// `selected_pages` values are 0-indexed page indices.
/// Returns the total number of operators rewritten across all pages.
pub fn convert_document_to_grayscale(
    doc: &mut Document,
    selected_pages: Option<&[u32]>,
) -> usize {
    let all_pages: Vec<(u32, ObjectId)> = doc.get_pages().into_iter().collect(); // 1-indexed
    let mut total = 0;

    let selected_set: Option<HashSet<u32>> =
        selected_pages.map(|sp| sp.iter().copied().collect());

    for (page_num, page_id) in &all_pages {
        // page_num is 1-indexed; selected_pages are 0-indexed
        if let Some(ref set) = selected_set {
            if !set.contains(&(page_num - 1)) {
                continue;
            }
        }
        total += convert_page_content_to_grayscale(doc, *page_id);
    }

    // Convert raster images (filtered to selected pages)
    let img_count = crate::image_opt::convert_images_to_grayscale(doc, selected_pages);
    log::info!("[grayscale] rewrote {total} color operators, converted {img_count} images");

    total
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_cs_map() -> HashMap<String, u32> {
        let mut m = HashMap::new();
        m.insert("DeviceRGB".into(), 3);
        m.insert("DeviceCMYK".into(), 4);
        m.insert("DeviceGray".into(), 1);
        m
    }

    #[test]
    fn test_rgb_to_luma() {
        assert!((rgb_to_luma(1.0, 1.0, 1.0) - 1.0).abs() < 0.001);
        assert!((rgb_to_luma(0.0, 0.0, 0.0)).abs() < 0.001);
        assert!((rgb_to_luma(1.0, 0.0, 0.0) - 0.299).abs() < 0.001);
    }

    #[test]
    fn test_cmyk_to_luma() {
        assert!((cmyk_to_luma(0.0, 0.0, 0.0, 1.0)).abs() < 0.001);
        assert!((cmyk_to_luma(0.0, 0.0, 0.0, 0.0) - 1.0).abs() < 0.001);
    }

    #[test]
    fn test_tokenize_rgb_fill() {
        let stream = b"1 0 0 rg";
        let tokens = tokenize(stream);
        assert_eq!(tokens.len(), 4);
        assert!(matches!(&tokens[0].kind, TokenKind::Number(v) if (*v - 1.0).abs() < 0.001));
        assert!(matches!(&tokens[3].kind, TokenKind::Operator(op) if op == "rg"));
    }

    #[test]
    fn test_rewrite_rgb_fill_bytes() {
        let stream = b"BT /F1 12 Tf 1 0 0 rg (Hello) Tj ET";
        let tokens = tokenize(stream);
        let cs = empty_cs_map();
        let (replacements, count) = find_color_replacements(&tokens, &cs);
        assert_eq!(count, 1);
        let result = apply_replacements(stream, &replacements);
        let result_str = String::from_utf8_lossy(&result);
        assert!(result_str.contains(" g "), "result: {result_str}");
        assert!(result_str.contains("BT /F1 12 Tf "));
        assert!(result_str.contains("(Hello) Tj ET"));
    }

    #[test]
    fn test_rewrite_cmyk_stroke_bytes() {
        let stream = b"0 0 0 1 K";
        let tokens = tokenize(stream);
        let cs = empty_cs_map();
        let (replacements, count) = find_color_replacements(&tokens, &cs);
        assert_eq!(count, 1);
        let result = apply_replacements(stream, &replacements);
        let result_str = String::from_utf8_lossy(&result);
        assert!(result_str.contains("G"), "result: {result_str}");
    }

    #[test]
    fn test_skip_already_gray() {
        let stream = b"0.5 g";
        let tokens = tokenize(stream);
        let cs = empty_cs_map();
        let (_replacements, count) = find_color_replacements(&tokens, &cs);
        assert_eq!(count, 0);
    }

    #[test]
    fn test_preserves_text_formatting() {
        let stream = b"BT /F1 12 Tf 0 0 0 rg 1 0 0 1 72 720 Tm (Bold text) Tj /F2 10 Tf (Normal) Tj ET";
        let tokens = tokenize(stream);
        let cs = empty_cs_map();
        let (replacements, count) = find_color_replacements(&tokens, &cs);
        assert_eq!(count, 1);
        let result = apply_replacements(stream, &replacements);
        let result_str = String::from_utf8_lossy(&result);
        assert!(result_str.contains("/F1 12 Tf"));
        assert!(result_str.contains("/F2 10 Tf"));
        assert!(result_str.contains("(Bold text) Tj"));
        assert!(result_str.contains("(Normal) Tj"));
        assert!(result_str.contains("1 0 0 1 72 720 Tm"));
    }

    #[test]
    fn test_inline_image_skipped() {
        let stream = b"1 0 0 rg BI /W 1 /H 1 /CS /G /BPC 8 ID \x80 EI 0.5 0 0 rg";
        let tokens = tokenize(stream);
        let cs = empty_cs_map();
        let (replacements, count) = find_color_replacements(&tokens, &cs);
        assert_eq!(count, 2);
        let result = apply_replacements(stream, &replacements);
        let result_str = String::from_utf8_lossy(&result);
        assert!(result_str.contains("BI /W 1 /H 1 /CS /G /BPC 8 ID"));
    }

    #[test]
    fn test_cs_tracked_for_scn() {
        // /DeviceRGB cs sets fill space to RGB (3 components)
        // Then scn with 3 args should be converted using tracked state
        let stream = b"/DeviceRGB cs 0.5 0.3 0.1 scn";
        let tokens = tokenize(stream);
        let cs = empty_cs_map();
        let (replacements, count) = find_color_replacements(&tokens, &cs);
        assert_eq!(count, 1);
        let result = apply_replacements(stream, &replacements);
        let result_str = String::from_utf8_lossy(&result);
        assert!(result_str.contains("/DeviceRGB cs")); // cs not rewritten
        assert!(result_str.contains(" g")); // scn → g
    }

    #[test]
    fn test_named_icc_color_space() {
        // Simulate a named color space /Cs1 that maps to 3 components (ICCBased RGB)
        let stream = b"/Cs1 cs 0.5 0.3 0.1 scn";
        let tokens = tokenize(stream);
        let mut cs = empty_cs_map();
        cs.insert("Cs1".into(), 3); // simulate ICCBased with N=3
        let (replacements, count) = find_color_replacements(&tokens, &cs);
        assert_eq!(count, 1);
        let result = apply_replacements(stream, &replacements);
        let result_str = String::from_utf8_lossy(&result);
        assert!(result_str.contains("/Cs1 cs")); // cs not rewritten
        assert!(result_str.contains(" g")); // scn → g
    }

    #[test]
    fn test_separation_color_space() {
        // Separation always has 1 tint component — should be skipped (already scalar)
        let stream = b"/Sep1 cs 0.7 scn";
        let tokens = tokenize(stream);
        let mut cs = empty_cs_map();
        cs.insert("Sep1".into(), 1);
        let (_replacements, count) = find_color_replacements(&tokens, &cs);
        assert_eq!(count, 0); // 1-component = already gray-like, skip
    }

    #[test]
    fn test_pattern_color_space_not_rewritten() {
        let stream = b"/Pattern cs";
        let tokens = tokenize(stream);
        let cs = empty_cs_map();
        let (_replacements, count) = find_color_replacements(&tokens, &cs);
        assert_eq!(count, 0);
    }
}
