pub mod compress;
pub mod document;
pub mod error;
pub mod image_opt;
pub mod merge;
pub mod page_ops;
pub mod page_utils;
pub mod reorder;
pub mod split;
pub mod types;

pub use compress::{AdvancedMode, CompressOptions, CompressionPreset, CompressionResult, PdfAnalysis};
pub use image_opt::{ImageTask, ImageTaskResult};
pub use document::PdfDocument;
pub use error::PdfError;
pub use types::{PageRange, PdfMetadata};
