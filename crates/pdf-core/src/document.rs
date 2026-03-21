use lopdf::Document;

use crate::error::{PdfError, Result};
use crate::types::PdfMetadata;

pub struct PdfDocument {
    pub(crate) inner: Document,
}

impl PdfDocument {
    pub fn from_bytes(data: &[u8]) -> Result<Self> {
        let inner = Document::load_mem(data)
            .map_err(|e| PdfError::InvalidPdf(e.to_string()))?;
        Ok(Self { inner })
    }

    pub fn page_count(&self) -> u32 {
        self.inner.get_pages().len() as u32
    }

    pub fn metadata(&self) -> PdfMetadata {
        let page_count = self.page_count();

        let (title, author) = self
            .inner
            .trailer
            .get(b"Info")
            .ok()
            .and_then(|info_ref| {
                if let lopdf::Object::Reference(id) = info_ref {
                    self.inner.get_object(*id).ok()
                } else {
                    Some(info_ref)
                }
            })
            .and_then(|obj| obj.as_dict().ok())
            .map(|info| {
                let title = info
                    .get(b"Title")
                    .ok()
                    .and_then(|v| v.as_string().ok())
                    .map(|s| s.to_string());
                let author = info
                    .get(b"Author")
                    .ok()
                    .and_then(|v| v.as_string().ok())
                    .map(|s| s.to_string());
                (title, author)
            })
            .unwrap_or((None, None));

        PdfMetadata {
            page_count,
            title,
            author,
        }
    }

    pub fn to_bytes(&self) -> Result<Vec<u8>> {
        let mut buf = Vec::new();
        self.inner.clone().save_to(&mut buf)?;
        Ok(buf)
    }
}
