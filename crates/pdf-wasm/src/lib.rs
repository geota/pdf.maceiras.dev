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
    let slices: Vec<&[u8]> = byte_vecs.iter().map(|v| v.as_ref()).collect();
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

#[wasm_bindgen(js_name = "reorderPages")]
pub fn reorder_pages(data: &[u8], page_order: Vec<u32>) -> Result<Vec<u8>, JsError> {
    pdf_core::reorder::reorder_pages(data, &page_order)
        .map_err(|e| JsError::new(&e.to_string()))
}

#[wasm_bindgen(js_name = "rotatePage")]
pub fn rotate_page(data: &[u8], page_index: u32, angle: i32) -> Result<Vec<u8>, JsError> {
    pdf_core::page_ops::rotate_page(data, page_index, angle)
        .map_err(|e| JsError::new(&e.to_string()))
}

#[wasm_bindgen(js_name = "cropPage")]
pub fn crop_page(data: &[u8], page_index: u32, crop_box: Vec<f32>) -> Result<Vec<u8>, JsError> {
    if crop_box.len() != 4 {
        return Err(JsError::new("crop_box must have exactly 4 elements [llx, lly, urx, ury]"));
    }
    let cb: [f32; 4] = [crop_box[0], crop_box[1], crop_box[2], crop_box[3]];
    pdf_core::page_ops::crop_page(data, page_index, cb)
        .map_err(|e| JsError::new(&e.to_string()))
}

#[wasm_bindgen(js_name = "scalePage")]
pub fn scale_page(data: &[u8], page_index: u32, new_width: f32, new_height: f32) -> Result<Vec<u8>, JsError> {
    pdf_core::page_ops::scale_page(data, page_index, new_width, new_height)
        .map_err(|e| JsError::new(&e.to_string()))
}

#[wasm_bindgen(js_name = "getMetadata")]
pub fn get_metadata(data: &[u8]) -> Result<JsValue, JsError> {
    let doc =
        pdf_core::PdfDocument::from_bytes(data).map_err(|e| JsError::new(&e.to_string()))?;
    let meta = doc.metadata();
    serde_wasm_bindgen::to_value(&meta).map_err(|e| JsError::new(&e.to_string()))
}

#[wasm_bindgen(js_name = "setMetadata")]
pub fn set_metadata(data: &[u8], metadata: JsValue) -> Result<Vec<u8>, JsError> {
    let meta: pdf_core::PdfMetadata =
        serde_wasm_bindgen::from_value(metadata).map_err(|e| JsError::new(&e.to_string()))?;
    let mut doc =
        pdf_core::PdfDocument::from_bytes(data).map_err(|e| JsError::new(&e.to_string()))?;
    doc.set_metadata(
        meta.title.as_deref(),
        meta.author.as_deref(),
        meta.subject.as_deref(),
        meta.keywords.as_deref(),
    )
    .map_err(|e| JsError::new(&e.to_string()))?;
    doc.to_bytes().map_err(|e| JsError::new(&e.to_string()))
}

#[wasm_bindgen(js_name = "compressPdf")]
pub fn compress_pdf(data: &[u8], options: JsValue) -> Result<JsValue, JsError> {
    let opts: pdf_core::CompressOptions = if options.is_null() || options.is_undefined() {
        pdf_core::CompressOptions::default()
    } else {
        serde_wasm_bindgen::from_value(options).map_err(|e| JsError::new(&e.to_string()))?
    };

    let (compressed_bytes, result) =
        pdf_core::compress::compress_bytes(data, &opts).map_err(|e| JsError::new(&e.to_string()))?;

    // Return { data: Uint8Array, result: CompressionResult }
    let obj = js_sys::Object::new();
    let typed = js_sys::Uint8Array::from(compressed_bytes.as_slice());
    js_sys::Reflect::set(&obj, &"data".into(), &typed).unwrap();
    let result_js =
        serde_wasm_bindgen::to_value(&result).map_err(|e| JsError::new(&e.to_string()))?;
    js_sys::Reflect::set(&obj, &"result".into(), &result_js).unwrap();
    Ok(obj.into())
}

#[wasm_bindgen(js_name = "analyzePdf")]
pub fn analyze_pdf(data: &[u8]) -> Result<JsValue, JsError> {
    let analysis =
        pdf_core::compress::analyze_pdf(data).map_err(|e| JsError::new(&e.to_string()))?;
    serde_wasm_bindgen::to_value(&analysis).map_err(|e| JsError::new(&e.to_string()))
}

#[wasm_bindgen(js_name = "analyzePdfDetailed")]
pub fn analyze_pdf_detailed(data: &[u8]) -> Result<JsValue, JsError> {
    let analysis =
        pdf_core::compress::analyze_pdf_detailed(data).map_err(|e| JsError::new(&e.to_string()))?;
    serde_wasm_bindgen::to_value(&analysis).map_err(|e| JsError::new(&e.to_string()))
}

// --- Parallel Compression ---

/// Phase 1: structural lossless + extract image tasks.
/// Returns { complete: boolean, imageTasks?: ImageTask[] }
/// If complete=true, call compressFinish([]) to get the result.
/// If complete=false, process imageTasks in parallel, then call compressFinish(results).
#[wasm_bindgen(js_name = "compressBegin")]
pub fn compress_begin(data: &[u8], options: JsValue) -> Result<JsValue, JsError> {
    let opts: pdf_core::CompressOptions = if options.is_null() || options.is_undefined() {
        pdf_core::CompressOptions::default()
    } else {
        serde_wasm_bindgen::from_value(options).map_err(|e| JsError::new(&e.to_string()))?
    };

    let tasks = pdf_core::compress::compress_begin(data, &opts)
        .map_err(|e| JsError::new(&e.to_string()))?;

    let obj = js_sys::Object::new();
    match tasks {
        None => {
            js_sys::Reflect::set(&obj, &"complete".into(), &true.into()).unwrap();
        }
        Some(tasks) => {
            js_sys::Reflect::set(&obj, &"complete".into(), &false.into()).unwrap();
            let tasks_js = serde_wasm_bindgen::to_value(&tasks)
                .map_err(|e| JsError::new(&e.to_string()))?;
            js_sys::Reflect::set(&obj, &"imageTasks".into(), &tasks_js).unwrap();
        }
    }
    Ok(obj.into())
}

/// Process a single image task. Called by pool workers.
#[wasm_bindgen(js_name = "processImageTask")]
pub fn process_image_task(task: JsValue) -> Result<JsValue, JsError> {
    let task: pdf_core::ImageTask =
        serde_wasm_bindgen::from_value(task).map_err(|e| JsError::new(&e.to_string()))?;
    match pdf_core::image_opt::process_image_task(&task) {
        Some(result) => {
            serde_wasm_bindgen::to_value(&result).map_err(|e| JsError::new(&e.to_string()))
        }
        None => Ok(JsValue::NULL),
    }
}

/// Target-size step: apply previous results, return next step's tasks or null if done.
/// Returns { complete: boolean, imageTasks?: ImageTask[] }
#[wasm_bindgen(js_name = "compressTargetStep")]
pub fn compress_target_step(results: JsValue) -> Result<JsValue, JsError> {
    let results: Vec<pdf_core::ImageTaskResult> = if results.is_null() || results.is_undefined() {
        Vec::new()
    } else {
        serde_wasm_bindgen::from_value(results).map_err(|e| JsError::new(&e.to_string()))?
    };

    let tasks = pdf_core::compress::compress_target_step(results)
        .map_err(|e| JsError::new(&e.to_string()))?;

    let obj = js_sys::Object::new();
    match tasks {
        None => {
            js_sys::Reflect::set(&obj, &"complete".into(), &true.into()).unwrap();
        }
        Some(tasks) => {
            js_sys::Reflect::set(&obj, &"complete".into(), &false.into()).unwrap();
            let tasks_js = serde_wasm_bindgen::to_value(&tasks)
                .map_err(|e| JsError::new(&e.to_string()))?;
            js_sys::Reflect::set(&obj, &"imageTasks".into(), &tasks_js).unwrap();
        }
    }
    Ok(obj.into())
}

/// Phase 3: apply image results and finalize.
/// Pass the results from processImageTask calls (or empty array if phase1 was complete).
#[wasm_bindgen(js_name = "compressFinish")]
pub fn compress_finish(results: JsValue) -> Result<JsValue, JsError> {
    let results: Vec<pdf_core::ImageTaskResult> = if results.is_null() || results.is_undefined() {
        Vec::new()
    } else {
        serde_wasm_bindgen::from_value(results).map_err(|e| JsError::new(&e.to_string()))?
    };

    let (compressed_bytes, result) = pdf_core::compress::compress_finish(results)
        .map_err(|e| JsError::new(&e.to_string()))?;

    let obj = js_sys::Object::new();
    let typed = js_sys::Uint8Array::from(compressed_bytes.as_slice());
    js_sys::Reflect::set(&obj, &"data".into(), &typed).unwrap();
    let result_js =
        serde_wasm_bindgen::to_value(&result).map_err(|e| JsError::new(&e.to_string()))?;
    js_sys::Reflect::set(&obj, &"result".into(), &result_js).unwrap();
    Ok(obj.into())
}

// --- PDF Rendering (pdfium-render) ---

// Cache Pdfium instance — WASM is single-threaded so this is safe.
// Avoids re-initializing Pdfium bindings on every call.
use std::cell::RefCell;
thread_local! {
    static PDFIUM: RefCell<Option<pdfium_render::prelude::Pdfium>> = const { RefCell::new(None) };
}

fn with_pdfium<T>(f: impl FnOnce(&pdfium_render::prelude::Pdfium) -> T) -> T {
    PDFIUM.with(|cell| {
        let mut opt = cell.borrow_mut();
        if opt.is_none() {
            *opt = Some(pdfium_render::prelude::Pdfium::default());
        }
        f(opt.as_ref().unwrap())
    })
}

#[wasm_bindgen(js_name = "getPageCount")]
pub fn get_page_count(data: &[u8]) -> Result<u32, JsError> {
    with_pdfium(|pdfium| {
        let doc = pdfium
            .load_pdf_from_byte_slice(data, None)
            .map_err(|e| JsError::new(&e.to_string()))?;
        Ok(doc.pages().len() as u32)
    })
}

#[wasm_bindgen(js_name = "renderPage")]
pub fn render_page(data: &[u8], page_index: u16, width: i32) -> Result<JsValue, JsError> {
    use pdfium_render::prelude::*;

    with_pdfium(|pdfium| {
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
    })
}

/// Render multiple pages in a single call — parses the PDF once.
/// Returns an Array of { width, height, data: Uint8ClampedArray } objects (or null).
/// Pixel data is copied per page since pdfium reuses its internal buffer.
#[wasm_bindgen(js_name = "renderPages")]
pub fn render_pages(data: &[u8], page_indices: Vec<u16>, width: i32) -> Result<JsValue, JsError> {
    use pdfium_render::prelude::*;

    with_pdfium(|pdfium| {
        let doc = pdfium
            .load_pdf_from_byte_slice(data, None)
            .map_err(|e| JsError::new(&e.to_string()))?;

        let config = PdfRenderConfig::new()
            .set_target_width(width)
            .render_form_data(true);

        let pages = doc.pages();
        let result = js_sys::Array::new_with_length(page_indices.len() as u32);

        for (i, &page_index) in page_indices.iter().enumerate() {
            let val = match pages.get(page_index) {
                Ok(page) => match page.render_with_config(&config) {
                    Ok(bitmap) => match bitmap.as_image_data() {
                        Ok(img) => {
                            let w = img.width();
                            let h = img.height();
                            let pixels = img.data();
                            let js_pixels = js_sys::Uint8ClampedArray::new_with_length(pixels.0.len() as u32);
                            js_pixels.copy_from(&pixels.0);
                            match web_sys::ImageData::new_with_js_u8_clamped_array_and_sh(
                                &js_pixels, w, h,
                            ) {
                                Ok(image_data) => image_data.into(),
                                Err(_) => JsValue::NULL,
                            }
                        }
                        Err(_) => JsValue::NULL,
                    },
                    Err(_) => JsValue::NULL,
                },
                Err(_) => JsValue::NULL,
            };
            result.set(i as u32, val);
        }

        Ok(result.into())
    })
}

/// Get the dimensions (width_pts, height_pts) of a page.
#[wasm_bindgen(js_name = "getPageDimensions")]
pub fn get_page_dimensions(data: &[u8], page_index: u16) -> Result<JsValue, JsError> {
    with_pdfium(|pdfium| {
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
    })
}
