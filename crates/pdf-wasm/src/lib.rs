use wasm_bindgen::prelude::*;

// Note: pdfium-render auto-exports `initialize_pdfium_render(pdfiumModule, rustModule, debug)`
// via #[wasm_bindgen]. It also initializes console_log and console_error_panic_hook.
// Do NOT duplicate those initializations here.

// --- PDF Manipulation (lopdf-based, via pdf-core) ---

#[wasm_bindgen(js_name = "getPageCountLopdf")]
pub fn get_page_count_lopdf(data: &[u8]) -> Result<u32, JsError> {
    let doc =
        pdf_core::PdfDocument::from_bytes(data).map_err(|e| JsError::new(&e.to_string()))?;
    Ok(doc.page_count())
}

#[wasm_bindgen(js_name = "mergePdfs")]
pub fn merge_pdfs(pdfs: Vec<js_sys::Uint8Array>) -> Result<Vec<u8>, JsError> {
    let byte_vecs: Vec<Vec<u8>> = pdfs.iter().map(|a| a.to_vec()).collect();
    let slices: Vec<&[u8]> = byte_vecs.iter().map(|v| v.as_slice()).collect();
    pdf_core::merge::merge_bytes(&slices).map_err(|e| JsError::new(&e.to_string()))
}

#[wasm_bindgen(js_name = "splitPdf")]
pub fn split_pdf(data: &[u8], ranges: JsValue) -> Result<JsValue, JsError> {
    let ranges: Vec<pdf_core::types::PageRange> =
        serde_wasm_bindgen::from_value(ranges).map_err(|e| JsError::new(&e.to_string()))?;
    let results =
        pdf_core::split::split_bytes(data, &ranges).map_err(|e| JsError::new(&e.to_string()))?;
    // Return as Array<Uint8Array> so JS gets proper binary buffers
    let arr = js_sys::Array::new_with_length(results.len() as u32);
    for (i, pdf_bytes) in results.iter().enumerate() {
        let typed = js_sys::Uint8Array::from(pdf_bytes.as_slice());
        arr.set(i as u32, typed.into());
    }
    Ok(arr.into())
}

// --- PDF Rendering (pdfium-render) ---

#[wasm_bindgen(js_name = "getPageCount")]
pub fn get_page_count(data: &[u8]) -> Result<u32, JsError> {
    let pdfium = pdfium_render::prelude::Pdfium::default();
    let doc = pdfium
        .load_pdf_from_byte_slice(data, None)
        .map_err(|e| JsError::new(&e.to_string()))?;
    Ok(doc.pages().len() as u32)
}

#[wasm_bindgen(js_name = "renderPage")]
pub fn render_page(data: &[u8], page_index: u16, width: i32) -> Result<JsValue, JsError> {
    use pdfium_render::prelude::*;

    let pdfium = Pdfium::default();
    let doc = pdfium
        .load_pdf_from_byte_slice(data, None)
        .map_err(|e| JsError::new(&e.to_string()))?;
    let page = doc
        .pages()
        .get(page_index)
        .map_err(|e| JsError::new(&e.to_string()))?;

    let config = PdfRenderConfig::new()
        .set_target_width(width)
        .render_form_data(true);

    let bitmap = page
        .render_with_config(&config)
        .map_err(|e| JsError::new(&e.to_string()))?;

    let image_data = bitmap
        .as_image_data()
        .map_err(|e| JsError::new(&format!("ImageData error: {e:?}")))?;

    Ok(image_data.into())
}

/// Get the dimensions (width_pts, height_pts) of a page.
#[wasm_bindgen(js_name = "getPageDimensions")]
pub fn get_page_dimensions(data: &[u8], page_index: u16) -> Result<JsValue, JsError> {
    use pdfium_render::prelude::*;

    let pdfium = Pdfium::default();
    let doc = pdfium
        .load_pdf_from_byte_slice(data, None)
        .map_err(|e| JsError::new(&e.to_string()))?;
    let page = doc
        .pages()
        .get(page_index)
        .map_err(|e| JsError::new(&e.to_string()))?;

    let width = page.width().value;
    let height = page.height().value;

    let arr = js_sys::Array::new();
    arr.push(&JsValue::from_f64(width as f64));
    arr.push(&JsValue::from_f64(height as f64));
    Ok(arr.into())
}
