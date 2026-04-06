use std::path::PathBuf;

use pdf_core::merge::merge_bytes;
use pdf_core::repair::load_or_repair;

fn scans_dir() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap()).join("Downloads/scans")
}

fn has_scans() -> bool {
    scans_dir().is_dir()
}

fn read_scan(name: &str) -> Vec<u8> {
    std::fs::read(scans_dir().join(name)).unwrap()
}

#[test]
fn scanner_pdfs_load_with_repair() {
    if !has_scans() {
        eprintln!("skipping: ~/Downloads/scans not found");
        return;
    }

    for entry in std::fs::read_dir(scans_dir()).unwrap() {
        let entry = entry.unwrap();
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("pdf") {
            continue;
        }
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        let data = std::fs::read(&path).unwrap();

        // Confirm normal load fails (demonstrating the bug)
        let normal = lopdf::Document::load_mem(&data);
        assert!(
            normal.is_err(),
            "{name}: expected normal load to fail, but it succeeded"
        );

        // Confirm repair succeeds
        let doc = load_or_repair(&data);
        assert!(
            doc.is_ok(),
            "{name}: repair failed: {}",
            doc.unwrap_err()
        );

        let doc = doc.unwrap();
        let pages = doc.get_pages().len();
        assert!(pages > 0, "{name}: repaired PDF has 0 pages");
        eprintln!("{name}: OK ({pages} pages)");
    }
}

#[test]
fn scanner_pdfs_merge_after_repair() {
    if !has_scans() {
        eprintln!("skipping: ~/Downloads/scans not found");
        return;
    }

    let scan1 = read_scan("Scan_20260405.pdf");
    let scan2 = read_scan("Scan_20260405 (2).pdf");

    let merged = merge_bytes(&[&scan1, &scan2]);
    assert!(merged.is_ok(), "merge failed: {}", merged.unwrap_err());

    let doc = lopdf::Document::load_mem(&merged.unwrap()).unwrap();
    assert!(doc.get_pages().len() >= 2);
}

#[test]
fn scanner_pdfs_merge_all() {
    if !has_scans() {
        eprintln!("skipping: ~/Downloads/scans not found");
        return;
    }

    let mut pdfs: Vec<Vec<u8>> = Vec::new();
    for entry in std::fs::read_dir(scans_dir()).unwrap() {
        let entry = entry.unwrap();
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("pdf") {
            pdfs.push(std::fs::read(&path).unwrap());
        }
    }

    let refs: Vec<&[u8]> = pdfs.iter().map(|v| v.as_slice()).collect();
    let merged = merge_bytes(&refs);
    assert!(
        merged.is_ok(),
        "merge all scans failed: {}",
        merged.unwrap_err()
    );

    let doc = lopdf::Document::load_mem(&merged.unwrap()).unwrap();
    eprintln!("merged all scans: {} pages", doc.get_pages().len());
}
