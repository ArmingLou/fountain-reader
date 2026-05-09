import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { renderAsync } from "docx-preview";
import * as pdfjsLib from "pdfjs-dist";
import { adaptParseOutput } from "./adapter";
import { renderDurationChart, renderCharacterChart, renderSceneChart } from "./charts";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

let currentFilePath: string | null = null;
let parsedData: any = null;
let rawScriptContent: string = "";

// 暴露给 charts.ts 用于点击跳转
(window as any).jumpToLine = null;
(window as any).__sceneData = [];
let docxZoomLevel = 100;

// 文件刷新限流
let lastRefreshTime = 0;
let pendingRefreshCount = 0;
let refreshTimer: number | null = null;
let isRefreshing = false;  // 防止并发刷新

// 自动刷新配置
interface AutoRefreshConfig {
  enabled: boolean;
  interval: number;  // 秒
}

let autoRefreshConfig: AutoRefreshConfig = {
  enabled: true,
  interval: 1
};

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
  
  // 检查是否启用自动刷新
  if (!autoRefreshConfig.enabled) {
    console.log("[自动刷新] 已禁用，跳过刷新");
    return;
  }
  
  // 防止并发刷新
  if (isRefreshing) {
    console.log("[限流] 正在刷新中，跳过本次请求");
    pendingRefreshCount++;
    return;
  }
  
  const now = Date.now();
  const intervalMs = autoRefreshConfig.interval * 1000;
  const timeSinceLastRefresh = now - lastRefreshTime;
  
  // 如果距离上次刷新不到配置的时间间隔，累计刷新请求
  if (timeSinceLastRefresh < intervalMs) {
    pendingRefreshCount++;
    
    // 清除之前的定时器
    if (refreshTimer !== null) {
      clearTimeout(refreshTimer);
    }
    
    // 设置延迟刷新
    refreshTimer = window.setTimeout(async () => {
      if (pendingRefreshCount > 0) {
        console.log(`[限流] 执行延迟刷新，累计请求次数: ${pendingRefreshCount}`);
        pendingRefreshCount = 0;
        lastRefreshTime = Date.now();
        isRefreshing = true;
        try {
          await loadAndWatch(currentFilePath!);
        } finally {
          isRefreshing = false;
        }
      }
      refreshTimer = null;
    }, intervalMs - timeSinceLastRefresh);
    
    return;
  }
  
  // 立即刷新
  lastRefreshTime = now;
  pendingRefreshCount = 0;
  isRefreshing = true;
  try {
    await loadAndWatch(currentFilePath);
  } finally {
    isRefreshing = false;
  }
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

function reRenderCharts() {
  if (!parsedData || !parsedData.statistics) return;
  const stats = parsedData.statistics;
  const { characterStats, durationStats } = stats;
  (window as any).__sceneData = durationStats.scenes || [];
  renderDurationChart("#dur-chart", durationStats.lengthchart_action, durationStats.lengthchart_dialogue, durationStats.total);
  const chars = characterStats.characters.map((c: any) => {
    const idx = durationStats.characternames.indexOf(c.name);
    return { ...c, timeline: idx >= 0 ? durationStats.characters[idx] : [] };
  });
  renderCharacterChart("#char-chart", chars, durationStats.total);
  renderSceneChart("#scene-chart", durationStats.scenes, durationStats.total);
  setupTableChartInteraction();
}

// ==================== 统计面板 ====================

function updateStatsOverview() {
  if (!parsedData) {
    setText("file-name", "No file loaded");
    return;
  }

  if (!parsedData.statistics) {
    console.error("统计数据缺失");
    return;
  }

  const stats = parsedData.statistics;
  const { characterStats, sceneStats, locationStats, durationStats } = stats;

  setText("len-pages", Math.ceil(durationStats.total / 60 / 0.7).toString());
  setText("len-scenes", sceneStats.scenes.length.toString());
  setText("len-words", (rawScriptContent.split(/\s+/).filter(w => w.length > 0).length).toString());
  setText("len-chars", rawScriptContent.length.toString());
  setText("dur-total", fmtDuration(durationStats.total));
  setText("dur-action", fmtDuration(durationStats.action));
  setText("dur-dialogue", fmtDuration(durationStats.dialogue));
  
  updateDurationSummary(durationStats);
  setText("char-count", characterStats.characterCount.toString());
  setText("char-monologues", characterStats.monologues.toString());
  setText("scene-count", sceneStats.scenes.length.toString());
  setText("loc-count", locationStats.locationsCount.toString());
  setText("file-name", currentFilePath?.split("/").pop() || "No file loaded");

  updateSceneDetails(durationStats);

  (window as any).__sceneData = durationStats.scenes || [];
  renderDurationChart("#dur-chart", durationStats.lengthchart_action, durationStats.lengthchart_dialogue, durationStats.total);
  
  // 构建角色时间线数据
  const charactersWithTimeline = characterStats.characters.map((char: any) => {
    const idx = durationStats.characternames.indexOf(char.name);
    return {
      ...char,
      timeline: idx >= 0 ? durationStats.characters[idx] : [],
    };
  });
  renderCharacterChart("#char-chart", charactersWithTimeline, durationStats.total);
  renderSceneChart("#scene-chart", durationStats.scenes, durationStats.total);

  // 填充表格
  populateCharacterTable(characterStats.characters);
  populateSceneTable(locationStats.locations);
  setupTableChartInteraction();

  // 初次加载容器可能未就绪，延迟重绘自适应
  requestAnimationFrame(() => requestAnimationFrame(() => reRenderCharts()));
}

// ==================== 表格填充与图表联动 ====================

function populateCharacterTable(characters: any[]) {
  const table = document.getElementById("char-table") as HTMLTableElement;
  if (!table || !characters || characters.length === 0) {
    if (table) table.innerHTML = "";
    return;
  }

  // 按 speakingParts 降序排列
  const sorted = [...characters].sort((a, b) => (b.speakingParts || 0) - (a.speakingParts || 0));

  const thead = document.createElement("thead");
  thead.innerHTML = `<tr>
    <th>角色</th>
    <th>场景数</th>
    <th>对白时长</th>
    <th>总时长</th>
    <th>对白片段</th>
    <th>词数</th>
    <th>独白</th>
  </tr>`;

  const tbody = document.createElement("tbody");
  sorted.forEach((char: any, idx: number) => {
    const tr = document.createElement("tr");
    tr.dataset.charName = char.name;
    tr.dataset.charIndex = String(idx);
    tr.innerHTML = `
      <td><span class="char-dot" style="background:${char.color || "#4a90d9"}"></span>${char.name}</td>
      <td data-sort="${char.numberOfScenes || 0}">${char.numberOfScenes || 0}</td>
      <td data-sort="${char.secondsSpoken || 0}">${fmtDuration(char.secondsSpoken || 0)}</td>
      <td data-sort="${char.secondsTotal || 0}">${fmtDuration(char.secondsTotal || 0)}</td>
      <td data-sort="${char.speakingParts || 0}">${char.speakingParts || 0}</td>
      <td data-sort="${char.wordsSpoken || 0}">${char.wordsSpoken || 0}</td>
      <td data-sort="${char.monologues || 0}">${char.monologues || 0}</td>
    `;
    tbody.appendChild(tr);
  });

  table.innerHTML = "";
  table.appendChild(thead);
  table.appendChild(tbody);
  makeTableSortable(table, [0]); // 不能按名称排序
  // 默认按总时长降序
  const charTbody = table.querySelector("tbody");
  if (charTbody) {
    const rows = Array.from(charTbody.querySelectorAll("tr"));
    rows.sort((a, b) => {
      const aVal = parseFloat(a.children[3]?.getAttribute("data-sort") || "0");
      const bVal = parseFloat(b.children[3]?.getAttribute("data-sort") || "0");
      return bVal - aVal;
    });
    rows.forEach(r => charTbody.appendChild(r));
  }
}

function populateSceneTable(locations: any[]) {
  const table = document.getElementById("loc-table") as HTMLTableElement;
  if (!table || !locations || locations.length === 0) {
    if (table) table.innerHTML = "";
    return;
  }

  const thead = document.createElement("thead");
  thead.innerHTML = `<tr>
    <th>地点</th>
    <th>场数</th>
    <th>类型</th>
    <th>时间</th>
  </tr>`;

  const tbody = document.createElement("tbody");
  locations.forEach((loc: any, idx: number) => {
    const tr = document.createElement("tr");
    tr.dataset.locationIndex = String(idx);
    tr.dataset.locationName = loc.name || "";

    const typeLabel = loc.interiorExterior === "int" ? "内景" :
      loc.interiorExterior === "ext" ? "外景" :
      loc.interiorExterior === "ie" ? "内外景" :
      loc.interiorExterior === "multiple" ? "混合" : (loc.interiorExterior || "未知");

    const times = (loc.timesOfDay || []).map((t: string) => {
      if (t === "dawn") return "黎明";
      if (t === "morning") return "早晨";
      if (t === "day") return "白天";
      if (t === "dusk" || t === "evening") return "黄昏";
      if (t === "night") return "夜晚";
      return t;
    }).join("、");

    tr.innerHTML = `
      <td>${loc.name || "未命名"}</td>
      <td data-sort="${loc.numberOfScenes || 0}">${loc.numberOfScenes || 0}</td>
      <td>${typeLabel}</td>
      <td>${times || "未指定"}</td>
    `;
    tbody.appendChild(tr);
  });

  table.innerHTML = "";
  table.appendChild(thead);
  table.appendChild(tbody);
  // 默认按场数降序排列
  const locTbody = table.querySelector("tbody");
  if (locTbody) {
    const rows = Array.from(locTbody.querySelectorAll("tr"));
    rows.sort((a, b) => {
      const aVal = parseFloat(a.children[1]?.getAttribute("data-sort") || a.children[1]?.textContent || "0");
      const bVal = parseFloat(b.children[1]?.getAttribute("data-sort") || b.children[1]?.textContent || "0");
      return bVal - aVal;
    });
    rows.forEach(r => locTbody.appendChild(r));
  }
makeTableSortable(table, [0, 2, 3]); // 名称、类型、时间不排序，只按场数排
}

function makeTableSortable(table: HTMLTableElement, skipCols: number[]) {
  const ths = table.querySelectorAll("th");
  ths.forEach((th, colIdx) => {
    if (skipCols.includes(colIdx)) return;
    th.addEventListener("click", () => {
      const tbody = table.querySelector("tbody");
      if (!tbody) return;
      const rows = Array.from(tbody.querySelectorAll("tr"));
      const asc = th.dataset.sortDir !== "asc";
      th.dataset.sortDir = asc ? "asc" : "desc";
      ths.forEach(t => { delete t.dataset.sortDir; });
      th.dataset.sortDir = asc ? "asc" : "desc";
      rows.sort((a, b) => {
        const aVal = a.children[colIdx]?.getAttribute("data-sort") || a.children[colIdx]?.textContent?.trim() || "";
        const bVal = b.children[colIdx]?.getAttribute("data-sort") || b.children[colIdx]?.textContent?.trim() || "";
        const aNum = parseFloat(aVal);
        const bNum = parseFloat(bVal);
        if (!isNaN(aNum) && !isNaN(bNum)) return asc ? aNum - bNum : bNum - aNum;
        return asc ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      });
      rows.forEach(r => tbody.appendChild(r));
    });
  });
}

function setupTableChartInteraction() {
  // 角色表格 hover → 角色图表高亮
  const charTable = document.getElementById("char-table") as HTMLTableElement;
  const charChartSvg = document.querySelector("#char-chart svg") as SVGSVGElement;

  if (charTable && charChartSvg) {
    charTable.addEventListener("mouseover", (e: MouseEvent) => {
      const tr = (e.target as HTMLElement).closest("tr") as HTMLTableRowElement;
      if (!tr || !tr.dataset.charName) return;

      const charName = tr.dataset.charName;
      const allLines = charChartSvg.querySelectorAll('.chart-data[data-label]');

      allLines.forEach((line) => {
        const label = decodeURIComponent((line as SVGPathElement).getAttribute('data-label') || '');
        if (label === charName) {
          (line as SVGPathElement).style.stroke = "#ffffff";
          (line as SVGPathElement).style.strokeWidth = "2";
          (line as SVGPathElement).style.opacity = "1";
        } else {
          (line as SVGPathElement).style.opacity = "0.4";
        }
      });
    });

    charTable.addEventListener("mouseout", (e: MouseEvent) => {
      const tr = (e.target as HTMLElement).closest("tr") as HTMLTableRowElement;
      if (!tr || !tr.dataset.charName) return;

      const allLines = charChartSvg.querySelectorAll('.chart-data[data-label]');
      allLines.forEach((line) => {
        (line as SVGPathElement).style.stroke = "";
        (line as SVGPathElement).style.strokeWidth = "";
        (line as SVGPathElement).style.opacity = "";
      });
    });
  }

  // 地点表格 hover → 条形码图高亮
  const locTable = document.getElementById("loc-table") as HTMLTableElement;
  const sceneChartSvg = document.querySelector("#scene-chart svg") as SVGSVGElement;

  if (locTable && sceneChartSvg) {
    locTable.addEventListener("mouseover", (e: MouseEvent) => {
      const tr = (e.target as HTMLElement).closest("tr") as HTMLTableRowElement;
      if (!tr || tr.dataset.locationName === undefined) return;

      const locName = tr.dataset.locationName || "";
      const allBars = sceneChartSvg.querySelectorAll('.chart-data-barcode');

      allBars.forEach((bar) => {
        const sceneText = decodeURIComponent((bar as SVGRectElement).getAttribute('data-scene-text') || '');
        if (sceneText.includes(locName)) {
          (bar as SVGRectElement).style.fillOpacity = "1";
          (bar as SVGRectElement).style.stroke = "#fff";
          (bar as SVGRectElement).style.strokeWidth = "2";
        } else {
          (bar as SVGRectElement).style.opacity = "0.4";
        }
      });
    });

    locTable.addEventListener("mouseout", (e: MouseEvent) => {
      const tr = (e.target as HTMLElement).closest("tr") as HTMLTableRowElement;
      if (!tr || tr.dataset.locationName === undefined) return;

      const allBars = sceneChartSvg.querySelectorAll('.chart-data-barcode');
      allBars.forEach((bar) => {
        (bar as SVGRectElement).style.fillOpacity = "";
        (bar as SVGRectElement).style.stroke = "";
        (bar as SVGRectElement).style.strokeWidth = "";
        (bar as SVGRectElement).style.opacity = "";
      });
    });
  }
}

function updateDurationSummary(durationStats: any) {
  const summaryEl = document.getElementById("dur-summary");
  if (!summaryEl) return;

  const runtime = durationStats.total / 60;
  const actionPercent = Math.round((100 * durationStats.action) / durationStats.total);
  const dialoguePercent = 100 - actionPercent;

  let summary = "剧本时长";
  
  if (runtime > 260) summary += "相当于超长故事片";
  else if (runtime > 240) summary += "相当于极长故事片";
  else if (runtime > 180) summary += "相当于很长故事片";
  else if (runtime > 140) summary += "相当于长故事片";
  else if (runtime > 85) summary += "相当于标准故事片";
  else if (runtime > 50) summary += "相当于短故事片";
  else if (runtime > 40) summary += "介于短片和故事片之间";
  else if (runtime > 25) summary += "相当于中型短片";
  else if (runtime > 15) summary += "相当于中等长度短片";
  else if (runtime > 3) summary += "相当于短片";
  else if (runtime > 0.5) summary += "相当于小型短片";
  else summary += "相当于极小短片";

  if (actionPercent > 90) summary += `。动作戏占绝对主导（${actionPercent}%）`;
  else if (actionPercent > 75) summary += `。动作戏占很大比重（${actionPercent}%）`;
  else if (actionPercent > 60) summary += `。动作戏较多（${actionPercent}%）`;
  else if (actionPercent > 55) summary += `。动作戏（${actionPercent}%）和对白（${dialoguePercent}%）较为均衡`;
  else if (actionPercent > 50) summary += `。动作戏（${actionPercent}%）和对白（${dialoguePercent}%）均衡`;
  else if (dialoguePercent > 90) summary += `。对白戏占绝对主导（${dialoguePercent}%）`;
  else if (dialoguePercent > 75) summary += `。对白戏占很大比重（${dialoguePercent}%）`;
  else if (dialoguePercent > 60) summary += `。对白戏较多（${dialoguePercent}%）`;
  else if (dialoguePercent > 55) summary += `。对白戏（${dialoguePercent}%）和动作戏（${actionPercent}%）较为均衡`;
  else if (dialoguePercent > 50) summary += `。对白戏（${dialoguePercent}%）和动作戏（${actionPercent}%）均衡`;
  else if (dialoguePercent === 50) summary += `。对白和动作戏各占一半（50%）`;

  summaryEl.textContent = summary;
}

function updateSceneDetails(durationStats: any) {
  const propMap: Record<string, string> = {
    'type_int': 'scene-int',
    'type_ext': 'scene-ext',
    'type_ie': 'scene-ie',
    'type_multiple': 'scene-multiple',
    'time_dawn': 'scene-dawn',
    'time_morning': 'scene-morning',
    'time_day': 'scene-day',
    'time_dusk': 'scene-dusk',
    'time_night': 'scene-night',
  };

  for (const prop of Object.keys(propMap)) {
    setText(propMap[prop], "0");
  }

  if (durationStats.durationBySceneProp) {
    const mergedProps: Record<string, number> = {};
    
    for (const item of durationStats.durationBySceneProp) {
      if (item.prop === 'time_evening') {
        mergedProps['time_dusk'] = (mergedProps['time_dusk'] || 0) + item.duration;
      } else {
        mergedProps[item.prop] = item.duration;
      }
    }

    for (const prop of Object.keys(mergedProps)) {
      const elementId = propMap[prop];
      if (elementId && mergedProps[prop] > 0) {
        setText(elementId, fmtDuration(mergedProps[prop]));
      }
    }
  }

  const summaryEl = document.getElementById("scene-summary");
  if (summaryEl && durationStats.durationBySceneProp) {
    const typeProps = durationStats.durationBySceneProp.filter((p: any) => p.prop.startsWith('type_'));
    const timeProps = durationStats.durationBySceneProp.filter((p: any) => p.prop.startsWith('time_'));

    let summary = "";
    if (typeProps.length > 0) {
      typeProps.sort((a: any, b: any) => b.duration - a.duration);
      const top = typeProps[0];
      const percent = Math.round((top.duration * 100) / durationStats.total);
      const typeLabel = top.prop.replace('type_', '').replace('_', ' ').toUpperCase();
      summary += `大部分场景为${typeLabel}（${percent}%）`;
    }

    if (timeProps.length > 0) {
      const mergedTimeProps: Record<string, number> = {};
      for (const p of timeProps) {
        const key = p.prop === 'time_evening' ? 'time_dusk' : p.prop;
        mergedTimeProps[key] = (mergedTimeProps[key] || 0) + p.duration;
      }
      
      const sortedTimeProps = Object.entries(mergedTimeProps)
        .map(([prop, duration]) => ({ prop, duration }))
        .sort((a, b) => b.duration - a.duration);
      
      if (sortedTimeProps.length > 0) {
        const top = sortedTimeProps[0];
        const percent = Math.round((top.duration * 100) / durationStats.total);
        const timeLabel = top.prop.replace('time_', '').toUpperCase();
        summary += `，主要发生在${timeLabel}（${percent}%）`;
      }
    }

    summaryEl.textContent = summary || "暂无场景统计信息";
  }
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


function sumChildrenDuration(children: any[]): number {
  let total = 0;
  for (const child of children) {
    const own = child.durationSec || child.duration_sec || child.duration || 0;
    const sub = child.children ? sumChildrenDuration(child.children) : 0;
    total += child.section ? sub : (own || sub);
  }
  return total;
}

function buildOutlineTree() {
  const container = document.getElementById("outline-tree");
  if (!container) return;
  if (!parsedData?.properties?.structure) {
    container.innerHTML = '<p class="placeholder">打开 Fountain 文件以查看大纲</p>';
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
    const items = buildOutlineItems(token, { showScenes, showSections, showDialogue, showSynopses, showNotes }, 0);
    for (const li of items) {
      if (li) ul.appendChild(li);
    }
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
    span.innerHTML = "📝 NOTES";
    row.appendChild(span);
    
    noteGroup.appendChild(row);
    
    const noteUl = document.createElement("ul");
    for (const note of noteNodes) {
      const noteLi = buildOutlineItemSimple(note, { showScenes, showSections, showDialogue, showSynopses, showNotes }, 0);
      if (noteLi) noteUl.appendChild(noteLi);
    }
    noteGroup.appendChild(noteUl);
    
    ul.appendChild(noteGroup);
  }

  container.innerHTML = "";
  container.appendChild(ul);
}

// 返回元素数组（场景会返回 [场景元素, 概要元素1, 概要元素2, ...]）
function buildOutlineItems(token: any, opts: any, depth: number): (HTMLElement | null)[] {
  const results: (HTMLElement | null)[] = [];
  
  // 章节或场景
  if (token.section) {
    if (!opts.showSections) {
      // 章节被隐藏，透传子节点
      if (token.children) {
        for (const child of token.children) {
          results.push(...buildOutlineItems(child, opts, depth));
        }
      }
      return results;
    }
    // 章节正常渲染，概要作为子节点
    results.push(buildSectionElement(token, opts, depth));
  } else if (token.isscene) {
    if (!opts.showScenes) {
      // 场景被隐藏，透传子节点
      if (token.children) {
        for (const child of token.children) {
          results.push(...buildOutlineItems(child, opts, depth));
        }
      }
      // 场景的概要也要返回
      if (opts.showSynopses && token.synopses) {
        for (const syn of token.synopses) {
          results.push(createSynopsisElement(syn, depth));
        }
      }
      return results;
    }
    // 场景正常渲染
    results.push(buildSceneElement(token, opts, depth));
    // 场景的概要和场景并列
    if (opts.showSynopses && token.synopses) {
      for (const syn of token.synopses) {
        results.push(createSynopsisElement(syn, depth));
      }
    }
  } else if (token.ischartor) {
    if (!opts.showDialogue) return results;
    results.push(buildOutlineItemSimple(token, opts, depth));
  } else if (token.isnote) {
    if (!opts.showNotes) return results;
    results.push(buildOutlineItemSimple(token, opts, depth));
  }
  
  return results;
}

function buildSectionElement(token: any, opts: any, depth: number): HTMLElement {
  const li = document.createElement("li");
  li.className = "outline-item outline-section";
  li.style.paddingLeft = `${depth * 40}px`;

  let lineNum = 0;
  if (token.id) {
    const m = token.id.match(/(\d+)$/);
    if (m) lineNum = parseInt(m[1]);
  }

  const childrenDur = token.children ? sumChildrenDuration(token.children) : 0;
  const durStr = childrenDur > 0 ? ` <span class="outline-duration">[${fmtDuration(childrenDur)}]</span>` : "";

  const row = document.createElement("div");
  row.className = "outline-row";

  const hasChildren = token.children && token.children.length > 0;
  const hasSynopses = opts.showSynopses && token.synopses && token.synopses.length > 0;
  
  if (hasChildren || hasSynopses) {
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
  span.innerHTML = `📁 ${token.text}${durStr}`;
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

  // 章节的概要和子节点混合排序
  if (hasChildren || hasSynopses) {
    const subUl = document.createElement("ul");
    
    const allItems: Array<{type: "synopsis", data: any} | {type: "child", data: any}> = [];
    
    if (hasSynopses) {
      for (const syn of token.synopses) {
        allItems.push({type: "synopsis", data: syn});
      }
    }
    
    if (hasChildren) {
      for (const child of token.children) {
        allItems.push({type: "child", data: child});
      }
    }
    
    allItems.sort((a, b) => {
      const lineA = a.type === "synopsis" ? a.data.line : (a.data.id ? parseInt(a.data.id.match(/(\d+)$/)?.[1] || "0") : 0);
      const lineB = b.type === "synopsis" ? b.data.line : (b.data.id ? parseInt(b.data.id.match(/(\d+)$/)?.[1] || "0") : 0);
      return lineA - lineB;
    });
    
    for (const item of allItems) {
      if (item.type === "synopsis") {
        subUl.appendChild(createSynopsisElement(item.data, depth + 1));
      } else {
        const childItems = buildOutlineItems(item.data, opts, depth + 1);
        for (const childLi of childItems) {
          if (childLi) subUl.appendChild(childLi);
        }
      }
    }
    
    if (subUl.children.length > 0) li.appendChild(subUl);
  }

  return li;
}

function buildSceneElement(token: any, opts: any, depth: number): HTMLElement {
  const li = document.createElement("li");
  li.className = "outline-item outline-scene";
  li.style.paddingLeft = `${depth * 40}px`;

  let lineNum = 0;
  if (token.id) {
    const m = token.id.match(/(\d+)$/);
    if (m) lineNum = parseInt(m[1]);
  }

  const ownDur = token.durationSec || token.duration_sec || token.duration || 0;
  const durStr = ownDur > 0 ? ` <span class="outline-duration">[${fmtDuration(ownDur)}]</span>` : "";

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
  span.innerHTML = `🎬 ${token.text}${durStr}`;
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

  // 场景的子节点（不包含概要）
  if (hasChildren) {
    const subUl = document.createElement("ul");
    for (const child of token.children) {
      const childItems = buildOutlineItems(child, opts, depth + 1);
      for (const childLi of childItems) {
        if (childLi) subUl.appendChild(childLi);
      }
    }
    if (subUl.children.length > 0) li.appendChild(subUl);
  }

  return li;
}

function buildOutlineItemSimple(token: any, _opts: any, depth: number): HTMLElement | null {
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

  if (token.ischartor) {
    icon = "👤";
    label = token.text;
    li.classList.add("outline-character");
  } else if (token.isnote) {
    icon = "📝";
    label = token.text;
    li.classList.add("outline-note");
  } else {
    return null;
  }

  const row = document.createElement("div");
  row.className = "outline-row";

  const span = document.createElement("span");
  span.className = "outline-label";
  span.innerHTML = `${icon} ${label}`;
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
  return li;
}

function createSynopsisElement(syn: any, depth: number): HTMLElement {
  const synLi = document.createElement("li");
  synLi.className = "outline-item outline-synopsis";
  synLi.style.paddingLeft = `${depth * 40}px`;
  
  const synRow = document.createElement("div");
  synRow.className = "outline-row";
  
  const synSpan = document.createElement("span");
  synSpan.className = "outline-label";
  synSpan.innerHTML = `📝 ${syn.synopsis}`;
  
  synRow.appendChild(synSpan);
  
  if (syn.line && syn.line > 0) {
    const jumpBtn = document.createElement("button");
    jumpBtn.className = "outline-jump-btn";
    jumpBtn.textContent = "↗";
    jumpBtn.title = `跳转到第 ${syn.line} 行`;
    jumpBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      jumpToLine(syn.line);
    });
    synRow.appendChild(jumpBtn);
  }
  
  synLi.appendChild(synRow);
  return synLi;
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
(window as any).jumpToLine = jumpToLine;

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
    // 切换后重绘图表以适配新尺寸
    requestAnimationFrame(() => requestAnimationFrame(() => reRenderCharts()));
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

// ==================== 自动刷新配置 ====================

function loadAutoRefreshSettings() {
  const raw = localStorage.getItem("auto-refresh-config");
  if (raw) {
    try {
      const cfg = JSON.parse(raw);
      autoRefreshConfig = {
        enabled: cfg.enabled !== undefined ? cfg.enabled : true,
        interval: cfg.interval || 1
      };
    } catch {}
  }
  
  const enabledCheckbox = document.getElementById("auto-refresh-enabled") as HTMLInputElement;
  const intervalInput = document.getElementById("auto-refresh-interval") as HTMLInputElement;
  
  if (enabledCheckbox) enabledCheckbox.checked = autoRefreshConfig.enabled;
  if (intervalInput) intervalInput.value = String(autoRefreshConfig.interval);
}

function saveAutoRefreshSettings() {
  const enabledCheckbox = document.getElementById("auto-refresh-enabled") as HTMLInputElement;
  const intervalInput = document.getElementById("auto-refresh-interval") as HTMLInputElement;
  
  autoRefreshConfig.enabled = enabledCheckbox?.checked ?? true;
  autoRefreshConfig.interval = parseFloat(intervalInput?.value || "1") || 1;
  
  localStorage.setItem("auto-refresh-config", JSON.stringify(autoRefreshConfig));
}

document.getElementById("auto-refresh-enabled")?.addEventListener("change", saveAutoRefreshSettings);
document.getElementById("auto-refresh-interval")?.addEventListener("input", saveAutoRefreshSettings);

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
  document.getElementById("refresh-btn")?.addEventListener("click", () => {
    if (!currentFilePath) return;
    loadAndWatch(currentFilePath);
  });
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
  loadAutoRefreshSettings();
  setupDocxZoomControls();
  setupPdfControls();

  listen("file-changed", () => refreshFile());

  listen<string>("cli-editor", (event) => {
    cliTempEditor = event.payload;
  });

  // 图表自适应：窗口 resize 时重绘
  let resizeTimer: number | null = null;
  window.addEventListener("resize", () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      reRenderCharts();
    }, 200);
  });

  console.log("Fountain Reader 已初始化");
});
