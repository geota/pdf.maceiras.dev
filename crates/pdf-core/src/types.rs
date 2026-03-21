use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PageRange {
    /// 0-indexed start page (inclusive)
    pub start: u32,
    /// 0-indexed end page (exclusive)
    pub end: u32,
}

impl PageRange {
    pub fn new(start: u32, end: u32) -> Self {
        Self { start, end }
    }

    pub fn len(&self) -> u32 {
        self.end.saturating_sub(self.start)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[derive(Debug, Clone)]
pub struct PdfMetadata {
    pub page_count: u32,
    pub title: Option<String>,
    pub author: Option<String>,
}
