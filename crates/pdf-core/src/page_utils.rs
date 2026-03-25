use lopdf::{dictionary, Document, Object, ObjectId};
use std::collections::HashMap;

use crate::error::{PdfError, Result};

/// Create a new empty PDF document with a proper catalog and pages tree.
pub fn create_empty_document() -> (Document, ObjectId) {
    let mut doc = Document::with_version("1.7");

    let pages_id = doc.new_object_id();
    let pages = dictionary! {
        "Type" => "Pages",
        "Kids" => Object::Array(vec![]),
        "Count" => Object::Integer(0),
    };
    doc.objects.insert(pages_id, Object::Dictionary(pages));

    let catalog = dictionary! {
        "Type" => "Catalog",
        "Pages" => Object::Reference(pages_id),
    };
    let catalog_id = doc.add_object(Object::Dictionary(catalog));
    doc.trailer.set("Root", Object::Reference(catalog_id));

    (doc, pages_id)
}

/// Get the ObjectId of the Pages dictionary from a document's catalog.
pub fn get_pages_id(doc: &Document) -> Result<ObjectId> {
    let catalog = doc
        .catalog()
        .map_err(|e| PdfError::MergeFailed(format!("no catalog: {e}")))?;
    let pages_ref = catalog
        .get(b"Pages")
        .map_err(|e| PdfError::MergeFailed(format!("no Pages in catalog: {e}")))?;
    match pages_ref {
        Object::Reference(id) => Ok(*id),
        _ => Err(PdfError::MergeFailed("Pages is not a reference".into())),
    }
}

/// Import multiple pages from the same source, sharing the object id map.
/// Shared resources (fonts, images) are cloned once and reused across pages.
pub fn import_pages(
    target: &mut Document,
    source: &Document,
    page_ids: &[ObjectId],
) -> Result<Vec<ObjectId>> {
    let mut id_map = HashMap::new();
    let mut result = Vec::with_capacity(page_ids.len());
    for &page_id in page_ids {
        let new_page_id = deep_clone_object(target, source, page_id, &mut id_map)?;
        finalize_imported_page(target, new_page_id)?;
        result.push(new_page_id);
    }
    Ok(result)
}

/// Import a single page (and its resources) from `source` into `target`.
/// Sets the page's Parent to target's Pages, removes Annots, and updates Kids/Count.
pub fn import_page(
    target: &mut Document,
    source: &Document,
    page_id: ObjectId,
) -> Result<ObjectId> {
    let mut id_map = HashMap::new();
    let new_page_id = deep_clone_object(target, source, page_id, &mut id_map)?;
    finalize_imported_page(target, new_page_id)?;
    Ok(new_page_id)
}

/// Set Parent, remove Annots, and add to Pages Kids/Count.
fn finalize_imported_page(target: &mut Document, new_page_id: ObjectId) -> Result<()> {
    let pages_id = get_pages_id(target)?;

    if let Ok(page_dict) = target
        .get_object_mut(new_page_id)
        .and_then(|o| o.as_dict_mut())
    {
        page_dict.set("Parent", Object::Reference(pages_id));
        page_dict.remove(b"Annots");
    }

    if let Ok(pages_dict) = target
        .get_object_mut(pages_id)
        .and_then(|o| o.as_dict_mut())
    {
        if let Ok(Object::Array(ref mut arr)) = pages_dict.get_mut(b"Kids") {
            arr.push(Object::Reference(new_page_id));
        }
        if let Ok(count) = pages_dict.get(b"Count") {
            if let Ok(n) = count.as_i64() {
                pages_dict.set("Count", Object::Integer(n + 1));
            }
        }
    }

    Ok(())
}

/// Recursively clone an object and all objects it references from source into target.
pub fn deep_clone_object(
    target: &mut Document,
    source: &Document,
    obj_id: ObjectId,
    id_map: &mut HashMap<ObjectId, ObjectId>,
) -> Result<ObjectId> {
    if let Some(&mapped_id) = id_map.get(&obj_id) {
        return Ok(mapped_id);
    }

    let obj = source
        .get_object(obj_id)
        .map_err(|e| PdfError::MergeFailed(format!("cannot read object {obj_id:?}: {e}")))?
        .clone();

    let new_id = target.add_object(Object::Null);
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
    obj: &Object,
    id_map: &mut HashMap<ObjectId, ObjectId>,
) -> Result<Object> {
    match obj {
        Object::Reference(ref_id) => {
            if is_pages_root(source, *ref_id) {
                return Ok(Object::Null);
            }
            let new_id = deep_clone_object(target, source, *ref_id, id_map)?;
            Ok(Object::Reference(new_id))
        }
        Object::Array(arr) => {
            let new_arr: Vec<Object> = arr
                .iter()
                .map(|item| clone_object_refs(target, source, item, id_map))
                .collect::<Result<Vec<_>>>()?;
            Ok(Object::Array(new_arr))
        }
        Object::Dictionary(dict) => {
            let mut new_dict = lopdf::Dictionary::new();
            for (key, value) in dict.iter() {
                let new_value = clone_object_refs(target, source, value, id_map)?;
                new_dict.set(key.clone(), new_value);
            }
            Ok(Object::Dictionary(new_dict))
        }
        Object::Stream(stream) => {
            let mut new_dict = lopdf::Dictionary::new();
            for (key, value) in stream.dict.iter() {
                let new_value = clone_object_refs(target, source, value, id_map)?;
                new_dict.set(key.clone(), new_value);
            }
            Ok(Object::Stream(lopdf::Stream::new(
                new_dict,
                stream.content.clone(),
            )))
        }
        other => Ok(other.clone()),
    }
}

fn is_pages_root(doc: &Document, obj_id: ObjectId) -> bool {
    doc.catalog()
        .ok()
        .and_then(|catalog| catalog.get(b"Pages").ok())
        .map(|p| matches!(p, Object::Reference(id) if *id == obj_id))
        .unwrap_or(false)
}
