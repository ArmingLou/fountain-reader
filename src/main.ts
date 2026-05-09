import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { renderAsync } from "docx-preview";
import * as pdfjsLib from "pdfjs-dist";
import { adaptParseOutput } from "./adapter";
import { createStatistics } from "./statistics";
import { renderDurationChart, renderCharacterChart, renderSceneChart } from "./charts";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

let currentFilePath: string | null = null;
let parsedData: any = null;
let rawScriptContent: string = "";
let docxZoomLevel = 100;

let pdfDoc: any = null;
let pdfPageNum = 1;
let pdfTotalPages = 0;
let pdfZoomLevel = 100;
let pdfRendering = false;
let pdfPageCache: Map<number, HTMLCanvasElement> = new Map();

async function loadAndWatch(filePath: string) {
  const content = await invoke<string>("read_file", { path: filePath });
  rawScriptContent = content;
  const rawData = JSON.parse(await invoke<string>("parse_fountain", { text: content }));
  parsedData = adaptParseOutput(rawData);
  updateAllPanels();
  await invoke("unwatch_file").catch(() => {});
  await invoke("watch_file", { path: filePath }).catch(() => {});
}

async function openFile() {
  const selected = await open({
    multiple: false,
    filters: [{ name: "Fountain", extensions: ["fountain", "spmd", "txt"] }],
  });
  if (selected) {
    currentFilePath = selected as string;
    await loadAndWatch(currentFilePath);
  }
}

async function refreshFile() {
  if (!currentFilePath) return;
  await loadAndWatch(currentFilePath);
}

// ==================== Tab 切换 ====================

function switchTab(tabName: string) {
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
  document.querySelector(`[data-tab="${tabName}"]`)?.classList.add("active");
  document.getElementById(`${tabName}-panel`)?.classList.add("active");
}

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => switchTab((btn as HTMLElement).dataset.tab!));
});

// ==================== 统计面板 ====================

function updateStatsOverview() {
  if (!parsedData) {
    setText("file-name", "No file loaded");
    return;
  }

  const stats = createStatistics(parsedData);
  const { characterStats, sceneStats, locationStats, durationStats } = stats;

  setText("len-pages", Math.ceil(durationStats.total / 60 / 0.7).toString());
  setText("len-scenes", sceneStats.scenes.length.toString());
  setText("len-words", (rawScriptContent.split(/\s+/).filter(w => w.length > 0).length).toString());
  setText("len-chars", rawScriptContent.length.toString());
  setText("dur-total", fmtDuration(durationStats.total));
  setText("dur-action", fmtDuration(durationStats.action));
  setText("dur-dialogue", fmtDuration(durationStats.dialogue));
  setText("char-count", characterStats.characterCount.toString());
  setText("char-monologues", characterStats.monologues.toString());
  setText("scene-count", sceneStats.scenes.length.toString());
  setText("loc-count", locationStats.locationsCount.toString());
  setText("file-name", currentFilePath?.split("/").pop() || "No file loaded");

  renderDurationChart("#dur-chart", durationStats.lengthchart_action);
  renderCharacterChart("#char-chart", characterStats.characters);
  renderSceneChart("#scene-chart", sceneStats.scenes, locationStats.locations);
}

function fmtDuration(sec: number) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function setText(id: string, text: string) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

// ==================== 大纲面板 ====================

function buildOutlineTree() {
  const container = document.getElementById("outline-tree");
  if (!container) return;
  if (!parsedData?.properties?.structure) {
    container.innerHTML = '<p class="placeholder">打开 Fountain 文件以查看大纲</p>';
    return;
  }

  const structure = parsedData.properties.structure;
  
  // 调试时长 - 打印完整第一个场景节点
  const firstScene = structure.find((t: any) => t.isscene);
  if (firstScene) {
    console.log("第一个场景节点完整数据:", JSON.stringify(firstScene));
  }
  
  const showScenes = (document.getElementById("out-show-scenes") as HTMLInputElement)?.checked ?? true;
  const showSections = (document.getElementById("out-show-sections") as HTMLInputElement)?.checked ?? true;
  const showDialogue = (document.getElementById("out-show-dialogue") as HTMLInputElement)?.checked ?? true;
  const showSynopses = (document.getElementById("out-show-synopses") as HTMLInputElement)?.checked ?? true;
  const showNotes = (document.getElementById("out-show-notes") as HTMLInputElement)?.checked ?? true;

  const ul = document.createElement("ul");
  ul.className = "outline-list";

  // 分离备注节点和其他节点
  const noteNodes: any[] = [];
  const otherNodes: any[] = [];
  for (const token of structure) {
    if (token.isnote) {
      noteNodes.push(token);
    } else {
      otherNodes.push(token);
    }
  }

  // 渲染非备注节点
  for (const token of otherNodes) {
    const li = buildOutlineItem(token, { showScenes, showSections, showDialogue, showSynopses, showNotes }, 0);
    if (li) ul.appendChild(li);
  }

  // 如果有备注节点，创建统一的 NOTE 节点
  if (showNotes && noteNodes.length > 0) {
    const noteGroup = document.createElement("li");
    noteGroup.className = "outline-item outline-note-group";
    
    const row = document.createElement("div");
    row.className = "outline-row";
    
    const toggle = document.createElement("span");
    toggle.className = "outline-toggle";
    toggle.textContent = "▶";
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      noteGroup.classList.toggle("collapsed");
    });
    row.appendChild(toggle);
    
    const span = document.createElement("span");
    span.className = "outline-label";
    span.textContent = `📝 NOTE (${noteNodes.length})`;
    row.appendChild(span);
    
    noteGroup.appendChild(row);
    
    const subUl = document.createElement("ul");
    for (const note of noteNodes) {
      const li = buildOutlineItem(note, { showScenes, showSections, showDialogue, showSynopses, showNotes }, 1);
      if (li) subUl.appendChild(li);
    }
    noteGroup.appendChild(subUl);
    ul.appendChild(noteGroup);
  }

  container.innerHTML = "";
  container.appendChild(ul);
}

function sumChildrenDuration(children: any[]): number {
  let total = 0;
  for (const child of children) {
    const own = child.durationSec || child.duration_sec || child.duration || 0;
    const sub = child.children ? sumChildrenDuration(child.children) : 0;
    total += child.section ? sub : (own || sub);
  }
  return total;
}

function buildOutlineItem(token: any, opts: any, depth: number): HTMLElement | null {
  const li = document.createElement("li");
  li.className = "outline-item";
  li.style.paddingLeft = `${depth * 40}px`;

  let label = "";
  let icon = "";
  let lineNum = 0;

  if (token.id) {
    const m = token.id.match(/(\d+)$/);
    if (m) lineNum = parseInt(m[1]);
  }

  if (token.section) {
    if (!opts.showSections) return passthroughChildren(token, opts, depth);
    icon = "📁";
    label = token.text;
    li.classList.add("outline-section");
  } else if (token.isscene) {
    if (!opts.showScenes) return passthroughChildren(token, opts, depth);
    icon = "🎬";
    label = token.text;
    li.classList.add("outline-scene");
  } else if (token.ischartor) {
    if (!opts.showDialogue) return null;
    icon = "👤";
    label = token.text;
    li.classList.add("outline-character");
  } else if (token.isnote) {
    if (!opts.showNotes) return null;
    icon = "📝";
    label = token.text;
    li.classList.add("outline-note");
  } else {
    return null;
  }

  const ownDur = token.durationSec || token.duration_sec || token.duration || 0;
  const childrenDur = token.children ? sumChildrenDuration(token.children) : 0;
  const durSec = token.section ? childrenDur : (ownDur || childrenDur);
  const durStr = durSec > 0 ? ` <span class="outline-duration">[${fmtDuration(durSec)}]</span>` : "";

  const row = document.createElement("div");
  row.className = "outline-row";

  const hasChildren = token.children && token.children.length > 0;
  if (hasChildren) {
    const toggle = document.createElement("span");
    toggle.className = "outline-toggle";
    toggle.textContent = "▶";
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      li.classList.toggle("collapsed");
    });
    row.appendChild(toggle);
  }

  const span = document.createElement("span");
  span.className = "outline-label";
  span.innerHTML = `${icon} ${label}${durStr}`;

  row.appendChild(span);

  if (lineNum > 0) {
    const jumpBtn = document.createElement("button");
    jumpBtn.className = "outline-jump-btn";
    jumpBtn.textContent = "↗";
    jumpBtn.title = `跳转到第 ${lineNum} 行`;
    jumpBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      jumpToLine(lineNum);
    });
    row.appendChild(jumpBtn);
  }

  li.appendChild(row);

  if (hasChildren) {
    const subUl = document.createElement("ul");
    for (const child of token.children) {
      const childLi = buildOutlineItem(child, opts, depth + 1);
      if (childLi) subUl.appendChild(childLi);
    }
    if (subUl.children.length > 0) li.appendChild(subUl);
  }

  return li;
}

function passthroughChildren(token: any, opts: any, depth: number): HTMLElement | null {
  if (!token.children) return null;
  const fragment = document.createDocumentFragment();
  for (const child of token.children) {
    const childLi = buildOutlineItem(child, opts, depth);
    if (childLi) fragment.appendChild(childLi);
  }
  const wrapper = document.createElement("div");
  wrapper.appendChild(fragment);
  return wrapper as any;
}

function expandAll() {
  document.querySelectorAll("#outline-tree .collapsed").forEach(el => el.classList.remove("collapsed"));
}

function collapseAll() {
  document.querySelectorAll("#outline-tree .outline-item").forEach(el => {
    if (el.querySelector("ul")) el.classList.add("collapsed");
  });
}

const EDITOR_PRESETS: Record<string, string> = {
  zed: "zed --add {file}:{line}",
  code: "code --goto {file}:{line}",
  vscode: "code --goto {file}:{line}",
  subl: "subl {file}:{line}",
  sublime: "subl {file}:{line}",
  atom: "atom {file}:{line}",
  custom: "{file}:{line}",
};

function getEditorTemplate(): string {
  const stored = localStorage.getItem("editor-config");
  if (stored) {
    try {
      const cfg = JSON.parse(stored);
      if (cfg.template) return cfg.template;
      if (cfg.name && EDITOR_PRESETS[cfg.name]) return EDITOR_PRESETS[cfg.name];
    } catch {}
  }
  return EDITOR_PRESETS["zed"];
}

function getEditorName(): string {
  const stored = localStorage.getItem("editor-config");
  if (stored) {
    try {
      const cfg = JSON.parse(stored);
      return cfg.name || "zed";
    } catch {}
  }
  return "zed";
}

let cliTempEditor: string | null = null;

async function jumpToLine(lineNum: number) {
  if (!currentFilePath) return;
  const name = cliTempEditor || getEditorName();
  const template = getEditorTemplate();
  await invoke("open_in_editor", {
    filePath: currentFilePath,
    line: lineNum,
    editor: name,
    template: template,
  }).catch(() => {});
}

// ==================== 大纲可见性切换 ====================

["out-show-scenes", "out-show-sections", "out-show-dialogue", "out-show-synopses", "out-show-notes"].forEach((id) => {
  document.getElementById(id)?.addEventListener("change", () => {
    buildOutlineTree();
    saveOutlineSettings();
  });
});

function saveOutlineSettings() {
  const settings = {
    showScenes: (document.getElementById("out-show-scenes") as HTMLInputElement)?.checked,
    showSections: (document.getElementById("out-show-sections") as HTMLInputElement)?.checked,
    showDialogue: (document.getElementById("out-show-dialogue") as HTMLInputElement)?.checked,
    showSynopses: (document.getElementById("out-show-synopses") as HTMLInputElement)?.checked,
    showNotes: (document.getElementById("out-show-notes") as HTMLInputElement)?.checked,
  };
  localStorage.setItem("outline-settings", JSON.stringify(settings));
}

function loadOutlineSettings() {
  const raw = localStorage.getItem("outline-settings");
  if (!raw) return;
  try {
    const s = JSON.parse(raw);
    setCheckbox("out-show-scenes", s.showScenes);
    setCheckbox("out-show-sections", s.showSections);
    setCheckbox("out-show-dialogue", s.showDialogue);
    setCheckbox("out-show-synopses", s.showSynopses);
    setCheckbox("out-show-notes", s.showNotes);
  } catch {}
}

function setCheckbox(id: string, val: boolean | undefined) {
  const el = document.getElementById(id) as HTMLInputElement;
  if (el && val !== undefined) el.checked = val;
}

// ==================== 统计侧栏切换 ====================

document.querySelectorAll(".stats-nav li").forEach((li) => {
  li.addEventListener("click", () => {
    const group = (li as HTMLElement).dataset.group;
    document.querySelectorAll(".stats-nav li").forEach((l) => l.classList.remove("active"));
    document.querySelectorAll(".stats-group").forEach((g) => g.classList.remove("active"));
    li.classList.add("active");
    document.querySelector(`.stats-group[data-group="${group}"]`)?.classList.add("active");
  });
});

// ==================== 设置面板 ====================

const editorSelect = document.getElementById("editor-select") as HTMLSelectElement;
const editorTemplate = document.getElementById("editor-template") as HTMLInputElement;

function loadEditorSettings() {
  const raw = localStorage.getItem("editor-config");
  let cfg: any = {};
  if (raw) {
    try { cfg = JSON.parse(raw); } catch {}
  }
  const name = cfg.name || "zed";
  if (editorSelect) editorSelect.value = EDITOR_PRESETS[name] ? name : "custom";
  if (editorTemplate) editorTemplate.value = cfg.template || EDITOR_PRESETS[name] || "";
}

function saveEditorSettings() {
  const name = editorSelect?.value || "zed";
  const template = editorTemplate?.value || "";
  localStorage.setItem("editor-config", JSON.stringify({ name, template }));
}

editorSelect?.addEventListener("change", () => {
  const preset = EDITOR_PRESETS[editorSelect.value];
  if (preset && editorTemplate) editorTemplate.value = preset;
  saveEditorSettings();
});
editorTemplate?.addEventListener("input", saveEditorSettings);

// ==================== 导出 ====================

async function exportDocx() {
  if (!currentFilePath) { alert("请先打开文件"); return; }
  try {
    const defaultName = currentFilePath.split("/").pop()?.replace(/\.[^.]+$/, ".docx") || "script.docx";
    const outputPath = await save({
      defaultPath: defaultName,
      filters: [{ name: "Word 文档", extensions: ["docx"] }],
    });
    if (!outputPath) return;
    const content = await invoke<string>("read_file", { path: currentFilePath });
    const result = await invoke<string>("export_docx", { text: content, outputPath });
    alert(result.includes("success") ? `已导出到: ${outputPath}` : "导出失败：" + result);
  } catch (e) { alert("导出失败：" + e); }
}

async function exportPdf() {
  if (!currentFilePath) { alert("请先打开文件"); return; }
  try {
    const defaultName = currentFilePath.split("/").pop()?.replace(/\.[^.]+$/, ".pdf") || "script.pdf";
    const outputPath = await save({
      defaultPath: defaultName,
      filters: [{ name: "PDF 文档", extensions: ["pdf"] }],
    });
    if (!outputPath) return;
    const content = await invoke<string>("read_file", { path: currentFilePath });
    const result = await invoke<string>("export_pdf", { text: content, outputPath });
    alert(result.includes("success") ? `已导出到: ${outputPath}` : "导出失败：" + result);
  } catch (e) { alert("导出失败：" + e); }
}

// ==================== PDF 预览 ====================

async function updatePdfPreview() {
  const viewer = document.getElementById("pdf-viewer");
  const loading = document.getElementById("pdf-loading") as HTMLElement;
  const placeholder = viewer?.querySelector(".placeholder") as HTMLElement;
  
  if (!currentFilePath || !viewer) return;
  
  if (loading) loading.style.display = "flex";
  if (placeholder) placeholder.style.display = "none";
  
  try {
    const content = await invoke<string>("read_file", { path: currentFilePath });
    const base64 = await invoke<string>("export_pdf_base64", { text: content });
    
    const pdfData = base64.split(",")[1];
    const binaryString = atob(pdfData);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    
    const loadingTask = pdfjsLib.getDocument({ data: bytes });
    pdfDoc = await loadingTask.promise;
    pdfTotalPages = pdfDoc.numPages;
    pdfPageNum = 1;
    pdfPageCache.clear();
    
    updatePdfPageInfo();
    await renderPdfPage(pdfPageNum);
    
    if (loading) loading.style.display = "none";
  } catch (e) {
    console.error("PDF 预览生成失败:", e);
    viewer.innerHTML = `<p class="error">预览生成失败: ${e}</p>`;
    if (loading) loading.style.display = "none";
  }
}

async function renderPdfPage(pageNum: number) {
  if (!pdfDoc || pdfRendering) return;
  
  const viewer = document.getElementById("pdf-viewer");
  if (!viewer) return;
  
  pdfRendering = true;
  
  try {
    let page = pdfPageCache.get(pageNum);
    
    if (!page) {
      const pdfPage = await pdfDoc.getPage(pageNum);
      const scale = pdfZoomLevel / 100;
      const viewport = pdfPage.getViewport({ scale: scale * 1.5 });
      
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      canvas.height = viewport.height;
      canvas.width = viewport.width;
      
      await pdfPage.render({
        canvasContext: context,
        viewport: viewport,
      }).promise;
      
      page = canvas;
      pdfPageCache.set(pageNum, page);
    }
    
    viewer.innerHTML = "";
    viewer.appendChild(page);
    
    updatePdfPageInfo();
  } catch (e) {
    console.error("PDF 页面渲染失败:", e);
  } finally {
    pdfRendering = false;
  }
}

function updatePdfPageInfo() {
  const pageInfo = document.getElementById("pdf-page-info");
  const zoomLevel = document.getElementById("pdf-zoom-level");
  
  if (pageInfo) pageInfo.textContent = `${pdfPageNum} / ${pdfTotalPages}`;
  if (zoomLevel) zoomLevel.textContent = `${pdfZoomLevel}%`;
}

function setupPdfControls() {
  const prevBtn = document.getElementById("pdf-prev-page");
  const nextBtn = document.getElementById("pdf-next-page");
  const zoomSlider = document.getElementById("pdf-zoom") as HTMLInputElement;
  const zoomIn = document.getElementById("pdf-zoom-in");
  const zoomOut = document.getElementById("pdf-zoom-out");
  const fitWidth = document.getElementById("pdf-fit-width");
  
  prevBtn?.addEventListener("click", () => {
    if (pdfPageNum > 1) {
      pdfPageNum--;
      renderPdfPage(pdfPageNum);
    }
  });
  
  nextBtn?.addEventListener("click", () => {
    if (pdfPageNum < pdfTotalPages) {
      pdfPageNum++;
      renderPdfPage(pdfPageNum);
    }
  });
  
  if (zoomSlider) {
    zoomSlider.addEventListener("input", () => {
      pdfZoomLevel = parseInt(zoomSlider.value);
      pdfPageCache.clear();
      updatePdfPageInfo();
      renderPdfPage(pdfPageNum);
    });
  }
  
  zoomIn?.addEventListener("click", () => {
    pdfZoomLevel = Math.min(200, pdfZoomLevel + 25);
    if (zoomSlider) zoomSlider.value = pdfZoomLevel.toString();
    pdfPageCache.clear();
    updatePdfPageInfo();
    renderPdfPage(pdfPageNum);
  });
  
  zoomOut?.addEventListener("click", () => {
    pdfZoomLevel = Math.max(50, pdfZoomLevel - 25);
    if (zoomSlider) zoomSlider.value = pdfZoomLevel.toString();
    pdfPageCache.clear();
    updatePdfPageInfo();
    renderPdfPage(pdfPageNum);
  });
  
  fitWidth?.addEventListener("click", () => {
    pdfZoomLevel = 100;
    if (zoomSlider) zoomSlider.value = "100";
    pdfPageCache.clear();
    updatePdfPageInfo();
    renderPdfPage(pdfPageNum);
  });
}

// ==================== DOCX 预览 ====================

async function updateDocxPreview() {
  const viewer = document.getElementById("docx-viewer");
  const loading = document.getElementById("docx-loading") as HTMLElement;
  const placeholder = viewer?.querySelector(".placeholder") as HTMLElement;
  
  if (!currentFilePath || !viewer) return;
  
  if (loading) loading.style.display = "flex";
  if (placeholder) placeholder.style.display = "none";
  
  try {
    const content = await invoke<string>("read_file", { path: currentFilePath });
    const base64 = await invoke<string>("export_docx_base64", { text: content });
    
    // 转换 Base64 为 ArrayBuffer
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    
    // 使用 docx-preview 渲染
    viewer.innerHTML = "";
    await renderAsync(bytes, viewer, undefined, {
      className: "docx-preview-content",
      inWrapper: true,
      ignoreWidth: false,
      ignoreHeight: false,
      ignoreFonts: false,
      breakPages: true,
      ignoreLastRenderedPageBreak: false,
      experimental: false,
      trimXmlDeclaration: true,
      renderChanges: false,
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: true,
      renderEndnotes: true,
      useBase64URL: false,
      renderComments: false,
      renderAltChunks: true,
    });
    
    // 延迟重置滚动位置，等待内容完全渲染
    requestAnimationFrame(() => {
      viewer.scrollTop = 0;
      requestAnimationFrame(() => {
        viewer.scrollTop = 0;
      });
    });
    
    // 应用缩放
    applyDocxZoom();
    
    if (loading) loading.style.display = "none";
  } catch (e) {
    console.error("DOCX 预览生成失败:", e);
    viewer.innerHTML = `<p class="error">预览生成失败: ${e}</p>`;
    if (loading) loading.style.display = "none";
  }
}

function applyDocxZoom() {
  const content = document.querySelector(".docx-preview-content") as HTMLElement;
  if (content) {
    content.style.width = `${docxZoomLevel}%`;
  }
}

function setupDocxZoomControls() {
  const zoomSlider = document.getElementById("docx-zoom") as HTMLInputElement;
  const zoomLevel = document.getElementById("docx-zoom-level");
  const zoomIn = document.getElementById("docx-zoom-in");
  const zoomOut = document.getElementById("docx-zoom-out");
  const fitWidth = document.getElementById("docx-fit-width");
  
  if (zoomSlider) {
    zoomSlider.addEventListener("input", () => {
      docxZoomLevel = parseInt(zoomSlider.value);
      if (zoomLevel) zoomLevel.textContent = docxZoomLevel + "%";
      applyDocxZoom();
    });
  }
  
  if (zoomIn) {
    zoomIn.addEventListener("click", () => {
      docxZoomLevel = Math.min(200, docxZoomLevel + 25);
      if (zoomSlider) zoomSlider.value = docxZoomLevel.toString();
      if (zoomLevel) zoomLevel.textContent = docxZoomLevel + "%";
      applyDocxZoom();
    });
  }
  
  if (zoomOut) {
    zoomOut.addEventListener("click", () => {
      docxZoomLevel = Math.max(25, docxZoomLevel - 25);
      if (zoomSlider) zoomSlider.value = docxZoomLevel.toString();
      if (zoomLevel) zoomLevel.textContent = docxZoomLevel + "%";
      applyDocxZoom();
    });
  }
  
  if (fitWidth) {
    fitWidth.addEventListener("click", () => {
      const content = document.querySelector(".docx-preview-content") as HTMLElement;
      if (content) {
        docxZoomLevel = 100;
        if (zoomSlider) zoomSlider.value = "100";
        if (zoomLevel) zoomLevel.textContent = "100%";
        applyDocxZoom();
      }
    });
  }
}

// ==================== 全部面板刷新 ====================

function updateAllPanels() {
  updateStatsOverview();
  buildOutlineTree();
  updateDocxPreview();
  updatePdfPreview();
}

// ==================== 启动 ====================

window.addEventListener("DOMContentLoaded", () => {
  document.getElementById("open-btn")?.addEventListener("click", openFile);
  document.getElementById("export-pdf-btn")?.addEventListener("click", exportPdf);
  document.getElementById("export-docx-btn")?.addEventListener("click", exportDocx);
  document.getElementById("refresh-btn")?.addEventListener("click", refreshFile);
  document.getElementById("settings-btn")?.addEventListener("click", () => {
  document.getElementById("settings-modal")!.style.display = "flex";
});
document.getElementById("settings-close")?.addEventListener("click", () => {
  document.getElementById("settings-modal")!.style.display = "none";
});
document.getElementById("settings-modal")?.addEventListener("click", (e) => {
  if (e.target === document.getElementById("settings-modal")) {
    document.getElementById("settings-modal")!.style.display = "none";
  }
});

  document.getElementById("outline-expand-all")?.addEventListener("click", expandAll);
  document.getElementById("outline-collapse-all")?.addEventListener("click", collapseAll);

  loadOutlineSettings();
  loadEditorSettings();
  setupDocxZoomControls();
  setupPdfControls();

  listen("file-changed", () => refreshFile());

  listen<string>("cli-editor", (event) => {
    cliTempEditor = event.payload;
  });

  console.log("Fountain Reader 已初始化");
});
