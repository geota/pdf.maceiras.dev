use lopdf::{dictionary, Document};

use crate::error::{PdfError, Result};

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

    let mut merged = Document::with_version("1.7");

    // Set up the catalog and pages tree that Document::new() doesn't create
    let pages_id = merged.new_object_id();
    let pages = dictionary! {
        "Type" => "Pages",
        "Kids" => lopdf::Object::Array(vec![]),
        "Count" => lopdf::Object::Integer(0),
    };
    merged.objects.insert(pages_id, lopdf::Object::Dictionary(pages));

    let catalog = dictionary! {
        "Type" => "Catalog",
        "Pages" => lopdf::Object::Reference(pages_id),
    };
    let catalog_id = merged.add_object(lopdf::Object::Dictionary(catalog));
    merged.trailer.set("Root", lopdf::Object::Reference(catalog_id));

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

fn get_pages_id(doc: &Document) -> Result<lopdf::ObjectId> {
    let catalog = doc
        .catalog()
        .map_err(|e| PdfError::MergeFailed(format!("no catalog: {e}")))?;
    let pages_ref = catalog
        .get(b"Pages")
        .map_err(|e| PdfError::MergeFailed(format!("no Pages in catalog: {e}")))?;
    match pages_ref {
        lopdf::Object::Reference(id) => Ok(*id),
        _ => Err(PdfError::MergeFailed(
            "Pages is not a reference".into(),
        )),
    }
}

/// Import a single page (and its resources) from `source` into `target`.
fn import_page(
    target: &mut Document,
    source: &Document,
    page_id: lopdf::ObjectId,
) -> Result<()> {
    let mut id_map = std::collections::HashMap::new();
    let new_page_id = deep_clone_object(target, source, page_id, &mut id_map)?;

    let pages_id = get_pages_id(target)?;

    // Update the page's Parent reference
    if let Ok(page_dict) = target
        .get_object_mut(new_page_id)
        .and_then(|o| o.as_dict_mut())
    {
        page_dict.set("Parent", lopdf::Object::Reference(pages_id));
        page_dict.remove(b"Annots");
    }

    // Add page reference to the Pages Kids array and increment Count
    if let Ok(pages_dict) = target
        .get_object_mut(pages_id)
        .and_then(|o| o.as_dict_mut())
    {
        if let Ok(kids) = pages_dict.get_mut(b"Kids") {
            if let lopdf::Object::Array(ref mut arr) = kids {
                arr.push(lopdf::Object::Reference(new_page_id));
            }
        }
        if let Ok(count) = pages_dict.get(b"Count") {
            if let Ok(n) = count.as_i64() {
                pages_dict.set("Count", lopdf::Object::Integer(n + 1));
            }
        }
    }

    Ok(())
}

/// Recursively clone an object and all objects it references from source into target.
fn deep_clone_object(
    target: &mut Document,
    source: &Document,
    obj_id: lopdf::ObjectId,
    id_map: &mut std::collections::HashMap<lopdf::ObjectId, lopdf::ObjectId>,
) -> Result<lopdf::ObjectId> {
    if let Some(&mapped_id) = id_map.get(&obj_id) {
        return Ok(mapped_id);
    }

    let obj = source
        .get_object(obj_id)
        .map_err(|e| PdfError::MergeFailed(format!("cannot read object {obj_id:?}: {e}")))?
        .clone();

    let new_id = target.add_object(lopdf::Object::Null);
    id_map.insert(obj_id, new_id);

    let cloned = clone_object_refs(target, source, &obj, id_map)?;
    if let Some(entry) = target.objects.get_mut(&new_id) {
        *entry = cloned;
    }

    Ok(new_id)
}

fn clone_object_refs(
    target: &mut Document,
    source: &Document,
    obj: &lopdf::Object,
    id_map: &mut std::collections::HashMap<lopdf::ObjectId, lopdf::ObjectId>,
) -> Result<lopdf::Object> {
    match obj {
        lopdf::Object::Reference(ref_id) => {
            if is_pages_root(source, *ref_id) {
                return Ok(lopdf::Object::Null);
            }
            let new_id = deep_clone_object(target, source, *ref_id, id_map)?;
            Ok(lopdf::Object::Reference(new_id))
        }
        lopdf::Object::Array(arr) => {
            let new_arr: Vec<lopdf::Object> = arr
                .iter()
                .map(|item| clone_object_refs(target, source, item, id_map))
                .collect::<Result<Vec<_>>>()?;
            Ok(lopdf::Object::Array(new_arr))
        }
        lopdf::Object::Dictionary(dict) => {
            let mut new_dict = lopdf::Dictionary::new();
            for (key, value) in dict.iter() {
                let new_value = clone_object_refs(target, source, value, id_map)?;
                new_dict.set(key.clone(), new_value);
            }
            Ok(lopdf::Object::Dictionary(new_dict))
        }
        lopdf::Object::Stream(stream) => {
            let mut new_dict = lopdf::Dictionary::new();
            for (key, value) in stream.dict.iter() {
                let new_value = clone_object_refs(target, source, value, id_map)?;
                new_dict.set(key.clone(), new_value);
            }
            Ok(lopdf::Object::Stream(lopdf::Stream::new(
                new_dict,
                stream.content.clone(),
            )))
        }
        other => Ok(other.clone()),
    }
}

fn is_pages_root(doc: &Document, obj_id: lopdf::ObjectId) -> bool {
    doc.catalog()
        .ok()
        .and_then(|catalog| catalog.get(b"Pages").ok())
        .map(|p| matches!(p, lopdf::Object::Reference(id) if *id == obj_id))
        .unwrap_or(false)
}
