import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";

let currentFilePath: string | null = null;
let parsedData: any = null;

// ==================== 文件操作 ====================

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

async function loadAndWatch(filePath: string) {
  const content = await invoke<string>("read_file", { path: filePath });
  parsedData = JSON.parse(await invoke<string>("parse_fountain", { text: content }));
  updateAllPanels();
  await invoke("unwatch_file").catch(() => {});
  await invoke("watch_file", { path: filePath }).catch(() => {});
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
  const tokens = parsedData?.tokens || [];
  const props = parsedData?.properties || {};
  const scenes = tokens.filter((t: any) => t.type === "scene_heading").length;
  const chars = new Set(tokens.filter((t: any) => t.type === "character").map((t: any) => t.name?.())).size;
  const duration = (props.lengthAction || 0) + (props.lengthDialogue || 0);

  setText("len-pages", Math.ceil(duration / 60 / 0.7).toString());
  setText("len-scenes", (props.scenes?.length || scenes).toString());
  setText("len-words", props.lenWords || "0");
  setText("len-chars", props.lenChars || "0");
  setText("dur-total", fmtDuration(duration));
  setText("dur-action", fmtDuration(props.lengthAction || 0));
  setText("dur-dialogue", fmtDuration(props.lengthDialogue || 0));
  setText("char-count", chars.toString());

  const monologues = (props.monologues || 0);
  setText("char-monologues", monologues.toString());
  setText("scene-count", scenes.toString());
  setText("loc-count", (props.locations?.size || 0).toString());
  setText("file-name", currentFilePath?.split("/").pop() || "No file loaded");
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
    container.innerHTML = '<p class="placeholder">Open a Fountain file to see outline</p>';
    return;
  }

  const structure = parsedData.properties.structure;
  const showScenes = (document.getElementById("out-show-scenes") as HTMLInputElement)?.checked ?? true;
  const showSections = (document.getElementById("out-show-sections") as HTMLInputElement)?.checked ?? true;
  const showDialogue = (document.getElementById("out-show-dialogue") as HTMLInputElement)?.checked ?? true;
  const showSynopses = (document.getElementById("out-show-synopses") as HTMLInputElement)?.checked ?? true;
  const showNotes = (document.getElementById("out-show-notes") as HTMLInputElement)?.checked ?? true;

  const ul = document.createElement("ul");
  ul.className = "outline-list";

  for (const token of structure) {
    const li = buildOutlineItem(token, { showScenes, showSections, showDialogue, showSynopses, showNotes });
    if (li) ul.appendChild(li);
  }

  container.innerHTML = "";
  container.appendChild(ul);
}

function buildOutlineItem(token: any, opts: any): HTMLElement | null {
  const li = document.createElement("li");
  li.className = "outline-item";

  let label = "";
  let icon = "";
  let lineNum = 0;

  if (token.id) {
    const m = token.id.match(/(\d+)$/);
    if (m) lineNum = parseInt(m[1]);
  }

  if (token.section) {
    if (!opts.showSections) return passthroughChildren(token, opts);
    icon = "📁";
    label = token.text;
    li.classList.add("outline-section");
  } else if (token.isscene) {
    if (!opts.showScenes) return passthroughChildren(token, opts);
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

  const durSec = token.durationSec || 0;
  const durStr = durSec > 0 ? ` [${fmtDuration(durSec)}]` : "";

  const row = document.createElement("div");
  row.className = "outline-row";

  const span = document.createElement("span");
  span.className = "outline-label";
  span.textContent = `${icon} ${label}${durStr}`;

  row.appendChild(span);

  if (lineNum > 0) {
    const jumpBtn = document.createElement("button");
    jumpBtn.className = "outline-jump-btn";
    jumpBtn.textContent = "↗";
    jumpBtn.title = `Open in external editor at line ${lineNum}`;
    jumpBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      jumpToLine(lineNum);
    });
    row.appendChild(jumpBtn);
  }

  li.appendChild(row);

  if (token.children && token.children.length > 0) {
    const subUl = document.createElement("ul");
    for (const child of token.children) {
      const childLi = buildOutlineItem(child, opts);
      if (childLi) subUl.appendChild(childLi);
    }
    if (subUl.children.length > 0) li.appendChild(subUl);
  }

  return li;
}

function passthroughChildren(token: any, opts: any): HTMLElement | null {
  if (!token.children) return null;
  const fragment = document.createDocumentFragment();
  for (const child of token.children) {
    const childLi = buildOutlineItem(child, opts);
    if (childLi) fragment.appendChild(childLi);
  }
  const wrapper = document.createElement("div");
  wrapper.appendChild(fragment);
  return wrapper as any;
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
  if (!currentFilePath) { alert("Please open a file first"); return; }
  try {
    const content = await invoke<string>("read_file", { path: currentFilePath });
    const outputPath = currentFilePath.replace(/\.[^.]+$/, ".docx");
    const result = await invoke<string>("export_docx", { text: content, outputPath });
    alert(result.includes("successfully") ? "DOCX exported!" : "Export failed: " + result);
  } catch (e) { alert("Export failed: " + e); }
}

async function exportPdf() {
  alert("PDF export coming soon");
}

// ==================== 全部面板刷新 ====================

function updateAllPanels() {
  updateStatsOverview();
  buildOutlineTree();
}

// ==================== 启动 ====================

window.addEventListener("DOMContentLoaded", () => {
  document.getElementById("open-btn")?.addEventListener("click", openFile);
  document.getElementById("export-pdf-btn")?.addEventListener("click", exportPdf);
  document.getElementById("export-docx-btn")?.addEventListener("click", exportDocx);
  document.getElementById("refresh-btn")?.addEventListener("click", refreshFile);
  document.getElementById("settings-btn")?.addEventListener("click", () => switchTab("settings"));

  loadOutlineSettings();
  loadEditorSettings();

  listen("file-changed", () => refreshFile());

  listen<string>("cli-editor", (event) => {
    cliTempEditor = event.payload;
  });

  console.log("Fountain Reader initialized");
});
