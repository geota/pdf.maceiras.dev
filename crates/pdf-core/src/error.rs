use thiserror::Error;

#[derive(Error, Debug)]
pub enum PdfError {
    #[error("invalid PDF: {0}")]
    InvalidPdf(String),

    #[error("page {requested} out of range (document has {total} pages)")]
    PageOutOfRange { requested: u32, total: u32 },

    #[error("merge failed: {0}")]
    MergeFailed(String),

    #[error("split failed: {0}")]
    SplitFailed(String),

    #[error("reorder failed: {0}")]
    ReorderFailed(String),

    #[error("empty input: at least one PDF is required")]
    EmptyInput,

    #[error(transparent)]
    Lopdf(#[from] lopdf::Error),

    #[error(transparent)]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, PdfError>;
