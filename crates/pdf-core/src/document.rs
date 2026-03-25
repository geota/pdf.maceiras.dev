use lopdf::{dictionary, Document, Object};

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

        let info_dict = self
            .inner
            .trailer
            .get(b"Info")
            .ok()
            .and_then(|info_ref| {
                if let Object::Reference(id) = info_ref {
                    self.inner.get_object(*id).ok()
                } else {
                    Some(info_ref)
                }
            })
            .and_then(|obj| obj.as_dict().ok());

        let get_str = |key: &[u8]| -> Option<String> {
            info_dict?
                .get(key)
                .ok()
                .and_then(|v| v.as_str().ok())
                .map(|s| String::from_utf8_lossy(s).into_owned())
        };

        PdfMetadata {
            page_count,
            title: get_str(b"Title"),
            author: get_str(b"Author"),
            subject: get_str(b"Subject"),
            keywords: get_str(b"Keywords"),
        }
    }

    /// Set metadata fields on the PDF. `None` values leave existing values unchanged.
    pub fn set_metadata(
        &mut self,
        title: Option<&str>,
        author: Option<&str>,
        subject: Option<&str>,
        keywords: Option<&str>,
    ) -> Result<()> {
        // Find or create the Info dictionary
        let info_id = match self.inner.trailer.get(b"Info") {
            Ok(Object::Reference(id)) => *id,
            _ => {
                let id = self
                    .inner
                    .add_object(Object::Dictionary(dictionary! {}));
                self.inner
                    .trailer
                    .set("Info", Object::Reference(id));
                id
            }
        };

        let info = self
            .inner
            .get_object_mut(info_id)
            .map_err(|e| PdfError::InvalidPdf(format!("cannot access Info dict: {e}")))?
            .as_dict_mut()
            .map_err(|e| PdfError::InvalidPdf(format!("Info is not a dict: {e}")))?;

        if let Some(t) = title {
            info.set("Title", Object::String(t.as_bytes().to_vec(), lopdf::StringFormat::Literal));
        }
        if let Some(a) = author {
            info.set("Author", Object::String(a.as_bytes().to_vec(), lopdf::StringFormat::Literal));
        }
        if let Some(s) = subject {
            info.set("Subject", Object::String(s.as_bytes().to_vec(), lopdf::StringFormat::Literal));
        }
        if let Some(k) = keywords {
            info.set("Keywords", Object::String(k.as_bytes().to_vec(), lopdf::StringFormat::Literal));
        }

        Ok(())
    }

    pub fn to_bytes(&mut self) -> Result<Vec<u8>> {
        let mut buf = Vec::new();
        self.inner.save_to(&mut buf)?;
        Ok(buf)
    }
}
