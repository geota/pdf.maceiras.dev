use lopdf::dictionary;
use lopdf::{Document, Object, Stream};

/// Create a minimal valid PDF with `num_pages` blank pages.
/// Each page is Letter size (612 x 792 points).
pub fn make_test_pdf(num_pages: u32) -> Vec<u8> {
    make_test_pdf_with_text(num_pages, None)
}

/// Create a minimal valid PDF with optional text content on each page.
pub fn make_test_pdf_with_text(num_pages: u32, text: Option<&str>) -> Vec<u8> {
    let mut doc = Document::with_version("1.7");

    let pages_id = doc.new_object_id();
    let mut kids = Vec::new();

    for _ in 0..num_pages {
        let content_bytes = if let Some(t) = text {
            format!(
                "BT /F1 12 Tf 72 720 Td ({}) Tj ET",
                t.replace('(', "\\(").replace(')', "\\)")
            )
            .into_bytes()
        } else {
            b"".to_vec()
        };

        let content_id = doc.add_object(Stream::new(dictionary! {}, content_bytes));

        let font_dict = dictionary! {
            "Type" => "Font",
            "Subtype" => "Type1",
            "BaseFont" => "Helvetica",
        };
        let font_id = doc.add_object(font_dict);

        let resources = dictionary! {
            "Font" => dictionary! {
                "F1" => Object::Reference(font_id),
            },
        };

        let page = dictionary! {
            "Type" => "Page",
            "Parent" => Object::Reference(pages_id),
            "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
            "Contents" => Object::Reference(content_id),
            "Resources" => resources,
        };
        let page_id = doc.add_object(page);
        kids.push(Object::Reference(page_id));
    }

    let pages = dictionary! {
        "Type" => "Pages",
        "Kids" => Object::Array(kids),
        "Count" => Object::Integer(num_pages as i64),
    };
    doc.objects.insert(pages_id, Object::Dictionary(pages));

    let catalog = dictionary! {
        "Type" => "Catalog",
        "Pages" => Object::Reference(pages_id),
    };
    let catalog_id = doc.add_object(catalog);
    doc.trailer.set("Root", Object::Reference(catalog_id));

    let mut buf = Vec::new();
    doc.save_to(&mut buf).expect("failed to save test PDF");
    buf
}
