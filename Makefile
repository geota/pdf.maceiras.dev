.PHONY: help dev build test lint fmt check clean wasm wasm-dev install preview typecheck

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-18s\033[0m %s\n", $$1, $$2}'

# ---------------------------------------------------------------------------
# Development
# ---------------------------------------------------------------------------

install: ## Install JS dependencies
	pnpm install

dev: wasm-dev ## Start dev server (builds WASM first)
	cd apps/web && pnpm dev

preview: build ## Preview production build locally
	cd apps/web && pnpm preview

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

wasm: ## Build WASM module (release)
	wasm-pack build crates/pdf-wasm --target web --out-dir ../../packages/pdf-wasm-pkg
	@$(MAKE) copy-wasm

wasm-dev: ## Build WASM module (dev, faster)
	wasm-pack build crates/pdf-wasm --dev --target web --out-dir ../../packages/pdf-wasm-pkg
	@$(MAKE) copy-wasm

copy-wasm:
	@mkdir -p apps/web/src/lib
	@cp crates/pdf-wasm/pdfium/pdfium.js apps/web/src/lib/pdfium.js
	@cp crates/pdf-wasm/pdfium/pdfium.wasm apps/web/public/pdfium.wasm

build: wasm ## Full production build (WASM + Vite)
	cd apps/web && pnpm build

# ---------------------------------------------------------------------------
# Test
# ---------------------------------------------------------------------------

test: test-rust test-web ## Run all tests

test-rust: ## Run Rust tests
	cargo test -p pdf-core

test-web: ## Run web (vitest) tests
	cd apps/web && pnpm test

# ---------------------------------------------------------------------------
# Lint & Format
# ---------------------------------------------------------------------------

lint: lint-rust lint-web ## Run all linters

lint-rust: ## Run clippy on Rust code
	cargo clippy -p pdf-core -- -D warnings
	cargo clippy -p pdf-wasm --target wasm32-unknown-unknown -- -D warnings

lint-web: ## Run Biome lint + TypeScript typecheck
	npx biome check
	cd apps/web && pnpm typecheck

fmt: ## Format all code (Rust + TypeScript)
	cargo fmt --all
	npx biome check --fix

fmt-check: ## Check formatting without modifying files
	cargo fmt --all --check
	npx biome check

check: fmt-check lint test-rust ## Full CI check: format, lint, test

# ---------------------------------------------------------------------------
# Clean
# ---------------------------------------------------------------------------

clean: ## Remove build artifacts
	cargo clean
	rm -rf apps/web/dist apps/web/node_modules/.vite packages/pdf-wasm-pkg
