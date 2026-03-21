# pdf-rs justfile

default:
    @just --list

# Run all Rust tests
test:
    cargo test -p pdf-core

# Build WASM module (release, no wasm-opt)
build-wasm:
    wasm-pack build crates/pdf-wasm --target web --out-dir ../../packages/pdf-wasm-pkg

# Build WASM module (dev, faster)
build-wasm-dev:
    wasm-pack build crates/pdf-wasm --dev --target web --out-dir ../../packages/pdf-wasm-pkg

# Copy PDFium files: JS to src/lib (ESM import), WASM to public (fetch at runtime)
copy-wasm:
    mkdir -p apps/web/src/lib
    cp crates/pdf-wasm/pdfium/pdfium.js apps/web/src/lib/pdfium.js
    cp crates/pdf-wasm/pdfium/pdfium.wasm apps/web/public/pdfium.wasm

# Full WASM build + copy
wasm: build-wasm copy-wasm

# Dev WASM build + copy
wasm-dev: build-wasm-dev copy-wasm

# Install JS dependencies
install:
    pnpm install

# Start dev server (build WASM first)
dev: wasm-dev
    cd apps/web && pnpm dev

# Production build
build: wasm
    cd apps/web && pnpm build

# Format and lint Rust
check:
    cargo fmt --check
    cargo clippy -- -D warnings

# Preview production build locally
preview: build
    cd apps/web && pnpm preview
