use lopdf::{Dictionary, Document, Object, Stream};

use crate::error::{PdfError, Result};

/// Rotate a single page by `angle` degrees (must be a multiple of 90).
/// The rotation is additive: if the page already has /Rotate 90 and you
/// pass angle=90, the result is /Rotate 180.
pub fn rotate_page(data: &[u8], page_index: u32, angle: i32) -> Result<Vec<u8>> {
    let mut doc = Document::load_mem(data)
        .map_err(|e| PdfError::InvalidPdf(e.to_string()))?;

    let pages_map = doc.get_pages();
    let total = pages_map.len() as u32;
    let page_num = page_index + 1; // lopdf uses 1-indexed page numbers

    let page_id = pages_map
        .get(&page_num)
        .copied()
        .ok_or(PdfError::PageOutOfRange {
            requested: page_index,
            total,
        })?;

    let page_obj = doc
        .get_object_mut(page_id)
        .map_err(|e| PdfError::InvalidPdf(format!("cannot access page {page_index}: {e}")))?;

    let page_dict = page_obj
        .as_dict_mut()
        .map_err(|e| PdfError::InvalidPdf(format!("page {page_index} is not a dict: {e}")))?;

    // Read existing rotation (default 0)
    let existing = page_dict
        .get(b"Rotate")
        .ok()
        .and_then(|o| o.as_i64().ok())
        .unwrap_or(0);

    let new_rotation = ((existing + angle as i64) % 360 + 360) % 360;
    page_dict.set("Rotate", Object::Integer(new_rotation));

    let mut buf = Vec::new();
    doc.save_to(&mut buf)?;
    Ok(buf)
}

/// Set /CropBox on a single page. Non-destructive — /MediaBox is preserved.
/// `crop_box` is [llx, lly, urx, ury] in PDF points (72 per inch).
pub fn crop_page(data: &[u8], page_index: u32, crop_box: [f32; 4]) -> Result<Vec<u8>> {
    let mut doc = Document::load_mem(data)
        .map_err(|e| PdfError::InvalidPdf(e.to_string()))?;

    let pages_map = doc.get_pages();
    let total = pages_map.len() as u32;
    let page_num = page_index + 1;

    let page_id = pages_map
        .get(&page_num)
        .copied()
        .ok_or(PdfError::PageOutOfRange {
            requested: page_index,
            total,
        })?;

    let page_obj = doc
        .get_object_mut(page_id)
        .map_err(|e| PdfError::InvalidPdf(format!("cannot access page {page_index}: {e}")))?;

    let page_dict = page_obj
        .as_dict_mut()
        .map_err(|e| PdfError::InvalidPdf(format!("page {page_index} is not a dict: {e}")))?;

    page_dict.set(
        "CropBox",
        Object::Array(crop_box.iter().map(|&v| Object::Real(v)).collect()),
    );

    let mut buf = Vec::new();
    doc.save_to(&mut buf)?;
    Ok(buf)
}

/// Scale a single page to `new_width` × `new_height` (PDF points, 72/inch).
/// Wraps existing content in a CTM that scales uniformly, updates MediaBox,
/// and removes any CropBox.
pub fn scale_page(data: &[u8], page_index: u32, new_width: f32, new_height: f32) -> Result<Vec<u8>> {
    let mut doc = Document::load_mem(data)
        .map_err(|e| PdfError::InvalidPdf(e.to_string()))?;

    let pages_map = doc.get_pages();
    let total = pages_map.len() as u32;
    let page_num = page_index + 1;

    let page_id = pages_map
        .get(&page_num)
        .copied()
        .ok_or(PdfError::PageOutOfRange {
            requested: page_index,
            total,
        })?;

    // Read current MediaBox dimensions
    let (old_width, old_height) = {
        let page_dict = doc
            .get_object(page_id)
            .map_err(|e| PdfError::InvalidPdf(format!("cannot access page {page_index}: {e}")))?
            .as_dict()
            .map_err(|e| PdfError::InvalidPdf(format!("page {page_index} is not a dict: {e}")))?;

        let media_box = page_dict
            .get(b"MediaBox")
            .map_err(|_| PdfError::InvalidPdf("page has no MediaBox".into()))?
            .as_array()
            .map_err(|_| PdfError::InvalidPdf("MediaBox is not an array".into()))?;

        let num = |i: usize| -> Result<f32> {
            match &media_box[i] {
                Object::Real(v) => Ok(*v),
                Object::Integer(v) => Ok(*v as f32),
                _ => Err(PdfError::InvalidPdf("MediaBox element not numeric".into())),
            }
        };
        let llx = num(0)?;
        let lly = num(1)?;
        let urx = num(2)?;
        let ury = num(3)?;
        (urx - llx, ury - lly)
    };

    if old_width <= 0.0 || old_height <= 0.0 {
        return Err(PdfError::InvalidPdf("page has zero dimensions".into()));
    }

    let sx = new_width / old_width;
    let sy = new_height / old_height;

    // Wrap existing content stream with a scaling CTM
    let prefix = format!("q {} 0 0 {} 0 0 cm\n", sx, sy);
    let prefix_id = doc.add_object(Object::Stream(Stream::new(
        Dictionary::new(),
        prefix.into_bytes(),
    )));
    let suffix_id = doc.add_object(Object::Stream(Stream::new(
        Dictionary::new(),
        b"\nQ".to_vec(),
    )));

    let page_obj = doc
        .get_object_mut(page_id)
        .map_err(|e| PdfError::InvalidPdf(format!("cannot access page {page_index}: {e}")))?;
    let page_dict = page_obj
        .as_dict_mut()
        .map_err(|e| PdfError::InvalidPdf(format!("page {page_index} is not a dict: {e}")))?;

    // Build new Contents array: [prefix, ...existing, suffix]
    let existing = page_dict.get(b"Contents").ok().cloned();
    let new_contents = match existing {
        Some(Object::Reference(id)) => Object::Array(vec![
            Object::Reference(prefix_id),
            Object::Reference(id),
            Object::Reference(suffix_id),
        ]),
        Some(Object::Array(arr)) => {
            let mut v = vec![Object::Reference(prefix_id)];
            v.extend(arr);
            v.push(Object::Reference(suffix_id));
            Object::Array(v)
        }
        _ => Object::Array(vec![
            Object::Reference(prefix_id),
            Object::Reference(suffix_id),
        ]),
    };

    page_dict.set("Contents", new_contents);
    page_dict.set(
        "MediaBox",
        Object::Array(vec![
            Object::Real(0.0),
            Object::Real(0.0),
            Object::Real(new_width),
            Object::Real(new_height),
        ]),
    );
    // Remove CropBox — it would clip at old dimensions
    let _ = page_dict.remove(b"CropBox");

    let mut buf = Vec::new();
    doc.save_to(&mut buf)?;
    Ok(buf)
}
