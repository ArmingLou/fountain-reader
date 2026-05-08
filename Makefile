APP_NAME    := Fountain Reader
BIN_NAME    := fountain-reader
SRC_TAURI   := src-tauri
TARGET      := $(SRC_TAURI)/target
DEBUG_BIN   := $(TARGET)/debug/$(BIN_NAME)
RELEASE_BIN := $(TARGET)/release/$(BIN_NAME)
DIST        := dist

# —— 默认 ——
all: build

# —— 开发 ——
dev:
	@echo "启动 Vite dev 服务器..."
	@npm run dev & \
	sleep 3 && \
	echo "启动 Tauri..." && \
	cargo run --manifest-path $(SRC_TAURI)/Cargo.toml

# —— 构建 ——
frontend:
	npm run build

backend:
	cargo build --manifest-path $(SRC_TAURI)/Cargo.toml

backend-release:
	cargo build --release --manifest-path $(SRC_TAURI)/Cargo.toml

build: frontend backend
	@echo "✅ Build complete: $(DEBUG_BIN)"

check:
	cargo check --manifest-path $(SRC_TAURI)/Cargo.toml
	npx tsc --noEmit

release: frontend
	npm run tauri build -- --no-bundle
	@echo "✅ Release build: $(RELEASE_BIN)"

# —— 打包 ——
package: frontend
	npm run tauri build

# —— 清理 ——
clean:
	cargo clean --manifest-path $(SRC_TAURI)/Cargo.toml
	rm -rf $(DIST)
	rm -rf node_modules

# —— 安装 ——
install: release
	cp $(RELEASE_BIN) /usr/local/bin/$(BIN_NAME)
	@echo "✅ Installed to /usr/local/bin/$(BIN_NAME)"

# —— 帮助 ——
help:
	@echo "Fountain Reader"
	@echo "  make build     — debug build"
	@echo "  make dev       — dev mode (hot reload)"
	@echo "  make release   — release build"
	@echo "  make package   — macOS .app bundle"
	@echo "  make check     — type check (Rust + TS)"
	@echo "  make clean     — remove all artifacts"
	@echo "  make install   — install to /usr/local/bin"