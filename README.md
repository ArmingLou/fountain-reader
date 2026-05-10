# Fountain Reader

> 跨平台 Fountain 格式剧本阅读器 — 解析、分析、预览、导出，一套工具完成。

[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux%20%7C%20iOS%20%7C%20Android-lightgrey)](https://github.com/ArmingLou/fountain-reader)
[![Tauri](https://img.shields.io/badge/built%20with-Tauri%202-blue)](https://tauri.app)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

---

## 简介

Fountain Reader 是一个轻量级的跨平台桌面/移动端应用，专为 **Fountain 格式剧本** 提供全方位的阅读、分析和导出体验。

只需打开一个 `.fountain` 文件，即可获得：

- 📊 **深度统计** — 角色出镜率、场景分布、地点热力图、时长预估
- 🧭 **结构大纲** — 场景/角色/章节层级树，点击直接跳转
- 📄 **即时预览** — PDF / DOCX 实时渲染
- 📦 **一键导出** — PDF / DOCX 格式导出，适合打印和交付

---

## 核心功能

### 统计面板
- 角色分析：台词统计、出场频率、角色对比
- 场景统计：场景数量、长度分布、场景分类
- 地点分析：场景位置分布及热力图
- 时长预估：基于剧本格式自动计算预估时长
- 可视化图表：D3.js 驱动的折线图、条形码图、数据表

### 大纲面板
- 场景结构树：Synopsis → Scene Heading → Action → Dialogue 层级展示
- 角色列表：剧中角色一览，支持跳转到首次出场位置
- 章节导航：`#` 和 `##` 标记的章节结构
- 点击跳转：点击任意节点 → 外部编辑器打开源文件并定位到对应行

### 实时预览
- PDF 预览：基于 pdf.js 的即时 PDF 渲染，所见即所得
- DOCX 预览：基于 docx-preview 的 Word 文档预览
- 源文件修改后自动刷新

### 导出
- PDF 导出：完整剧本排版，支持 Courier Prime 字体嵌入
- DOCX 导出：标准 Word 格式，适配打印和分发

### 热更新
- 监听 `.fountain` 源文件变化
- 修改保存后自动刷新统计、大纲、预览所有面板

### 外部编辑器集成
- 支持配置任意第三方编辑器（Zed、VSCode、Sublime Text 等）
- 通过大纲点击直接唤起编辑器并跳转到对应行
- CLI 可指定编辑器：`fountain-reader ./script.fountain -e zed`

### 文件加载
- **CLI 模式**：命令行直接指定文件路径
- **GUI 模式**：系统原生文件选择对话框或拖放打开

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面框架 | Tauri 2 |
| Fountain 解析 | Rust (`betterfountain-rust`) |
| DOCX 生成 | Rust (`docx-rs` via betterfountain-rust) |
| PDF 生成 | TypeScript + pdfkit |
| PDF 预览 | pdf.js |
| 统计界面 | HTML + D3.js + DataTables |
| 文件监听 | Rust (`notify` crate) |
| CLI 参数 | Tauri CLI Plugin |

---

## 快速开始

### 前置要求

| 工具 | 版本 |
|------|------|
| Node.js | ≥ 18 |
| Rust | ≥ 1.88 (stable) |
| OS | macOS / Windows / Linux |

### 克隆 + 安装

```bash
git clone https://github.com/ArmingLou/fountain-reader.git
cd fountain-reader
npm install
```

### 构建

```bash
make build       # debug 构建，产物 src-tauri/target/debug/fountain-reader
make release     # release 构建
make package     # 打包 macOS .app（需 release 先构建）
make check       # Rust + TypeScript 类型检查
make help        # 查看所有命令
```

> 也可直接用 `npm run tauri dev` 启动开发模式（热更新）。

### 手动构建步骤

```bash
# 1. 前端
npm run build

# 2. Rust 后端
cargo build --manifest-path src-tauri/Cargo.toml

# 产物: src-tauri/target/debug/fountain-reader
```

### 打包 macOS .app

```bash
make release    # 先 release 构建
make package    # 打包 → src-tauri/target/release/bundle/macos/
```

等价于手动执行 `npm run tauri build`。

---

## 使用说明

### GUI 模式

直接双击应用，或终端启动：

```bash
./src-tauri/target/debug/fountain-reader
```

通过 `📂 Open` 按钮选择 `.fountain` 文件，即可在 4 个 Tab 之间切换：

| Tab | 功能 |
|-----|------|
| PDF Preview | pdf.js 渲染预览 |
| DOCX Preview | docx-preview 渲染预览 |
| Statistics | 角色/场景/地点/时长统计 + 图表 |
| Outline | 场景树形大纲，点击 ↗ 跳转外部编辑器 |

### CLI 模式

```bash
# 打开文件
fountain-reader ./script.fountain

# 临时指定编辑器（仅本次会话有效）
fountain-reader ./script.fountain -e zed
fountain-reader ./script.fountain -e code
```

### 外部编辑器配置

应用内 `⚙️ Settings` Tab 可配置：

| 编辑器 | 命令模板 |
|--------|----------|
| Zed | `zed --add {file}:{line}` |
| VSCode | `code --goto {file}:{line}` |
| Sublime Text | `subl {file}:{line}` |
| 自定义 | 任意支持 `{file}` `{line}` 变量的命令 |

点击大纲面板的 `↗` 按钮即可在配置的编辑器中打开源文件并跳转到对应行。

### 单实例机制

重复执行命令不会多开窗口——新参数转发到已有实例（TCP port 16658）。临时编辑器 `-e` 仅当前会话有效，关闭后恢复默认配置。

### macOS 打包后命令行启动

`.app` 包内部二进制和 debug 构建是同一个可执行文件，CLI 参数完全兼容：

```bash
# 方式 1 — 直接调二进制（推荐给脚本/编辑器集成）
/Applications/Fountain\ Reader.app/Contents/MacOS/fountain-reader ./script.fountain -e zed

# 方式 2 — 用 open 命令传参 （不兼容 open 传参）
# open -a "Fountain Reader" --args ./script.fountain -e zed 

# 方式 3 — 建 alias（最方便）
echo 'alias fr="/Applications/Fountain\ Reader.app/Contents/MacOS/fountain-reader"' >> ~/.zshrc
fr ./script.fountain -e zed
```

---

## 项目结构

```
fountain-reader/
├── src/                    # 前端 TypeScript 源码
│   ├── main.ts             # 应用入口
│   └── styles.css          # 全局样式
├── src-tauri/              # Rust 后端
│   ├── src/
│   │   ├── lib.rs          # Tauri 命令注册
│   │   └── main.rs         # 二进制入口
│   ├── Cargo.toml          # Rust 依赖
│   └── tauri.conf.json     # Tauri 配置（窗口/CLI/打包）
├── webview/                # 统计/大纲面板 UI
├── assets/                 # 静态资源
├── dist/                   # 前端构建产物
├── Makefile                # 构建/打包脚本
├── package.json            # 前端依赖
└── AGENTS.md               # 开发者架构文档
```

---

## 外部编辑器配置

在设置面板中配置编辑器命令模板，支持变量替换：

| 编辑器 | 命令模板 |
|--------|----------|
| VSCode | `code --goto {file}:{line}` |
| Zed | `zed --add {file}:{line}` |
| Sublime Text | `subl {file}:{line}` |
| 自定义 | 任意支持文件+行号参数的命令 |

---

## 许可

[MIT](./LICENSE)
