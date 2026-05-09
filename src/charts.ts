import * as d3 from "d3";

function secondsToString(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function renderDurationChart(
  containerId: string,
  actionData: any[],
  dialogueData: any[],
  totalTime: number
) {
  const container = d3.select(containerId);
  container.selectAll("*").remove();

  const width = (container.node() as HTMLElement)?.getBoundingClientRect().width || 600;
  const height = (container.node() as HTMLElement)?.getBoundingClientRect().height || 200;
  const headerHeight = 0;
  const footerHeight = 0;
  const innerHeight = height - headerHeight - footerHeight;
  const padding = 4;

  if (!actionData || actionData.length === 0) {
    container.append("p").attr("class", "placeholder").text("无数据");
    return;
  }

  const svg = container
    .append("svg")
    .attr("width", "100%")
    .attr("height", "100%")
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("preserveAspectRatio", "xMidYMid meet");

  svg
    .append("rect")
    .attr("width", width)
    .attr("height", innerHeight)
    .attr("fill", "none")
    .attr("class", "chart-container")
    .attr("y", headerHeight);

  const maxAction = d3.max(actionData, (d: any) => d.length) || 1;
  const maxDialogue = d3.max(dialogueData, (d: any) => d.length) || 1;
  const max = Math.max(maxAction, maxDialogue);

  const x = d3
    .scaleLinear()
    .domain([0, Math.round(totalTime * 1.003)])
    .range([0, width]);

  const y = d3
    .scaleLinear()
    .domain([0, max])
    .range([innerHeight - padding + headerHeight, padding + headerHeight]);

  const line = d3
    .line<any>()
    .x((d) => x(d.playTimeSec))
    .y((d) => y(d.length))
    .curve(d3.curveLinear);

  const linecontainer = svg.append("g").attr("class", "chart-linecontainer");

  linecontainer
    .append("path")
    .datum(actionData)
    .attr("d", line)
    .attr("fill", "none")
    .attr("class", "chart-data")
    .attr("data-line", "0")
    .attr("stroke", "var(--vscode-symbolIcon-constructorForeground, #4a90d9)")
    .attr("stroke-width", 1);

  linecontainer
    .append("path")
    .datum(dialogueData)
    .attr("d", line)
    .attr("fill", "none")
    .attr("class", "chart-data")
    .attr("data-line", "1")
    .attr("stroke", "var(--vscode-symbolIcon-fieldForeground, #e67e22)")
    .attr("stroke-width", 1);

  const mouseG = svg.append("g").attr("class", "mouse-over-effects");

  mouseG
    .append("rect")
    .attr("class", "mouse-line")
    .attr("width", "1px")
    .attr("y", headerHeight)
    .attr("height", innerHeight)
    .style("opacity", "0");

  // 鼠标交互 overlay
  const overlay = svg
    .append("rect")
    .attr("class", "overlay")
    .attr("width", width)
    .attr("height", innerHeight)
    .attr("y", headerHeight)
    .attr("fill", "none")
    .attr("pointer-events", "all");

  const durTooltip = createTooltip(container);

  overlay
    .on("mouseout", () => {
      mouseG.select(".mouse-line").style("opacity", "0");
      hideTooltip(durTooltip);
    })
    .on("mouseover", () => {
      mouseG.select(".mouse-line").style("opacity", "1");
    })
    .on("mousemove", function (event: MouseEvent) {
      const [mx, my] = d3.pointer(event);
      const xval = x.invert(mx);
      mouseG.select(".mouse-line").attr("x", mx);

      const bisect = d3.bisector((d: any) => d.playTimeSec).left;
      const actionIndex = bisect(actionData, xval, 1);
      const dialogueIndex = bisect(dialogueData, xval, 1);

      const actionPoint =
        actionIndex < actionData.length ? actionData[actionIndex] : actionData[actionData.length - 1];
      const dialoguePoint =
        dialogueIndex < dialogueData.length
          ? dialogueData[dialogueIndex]
          : dialogueData[dialogueData.length - 1];

      const sceneName = actionPoint?.scene || dialoguePoint?.scene || "";

      showTooltip(durTooltip, mx, my, `
        <div class="chart-tooltip-time">${secondsToString(Math.floor(xval))}</div>
        <div class="chart-tooltip-scene">${sceneName}</div>
      `);
    });
}

function createTooltip(container: d3.Selection<any, unknown, any, any>): d3.Selection<HTMLDivElement, unknown, any, any> {
  const tooltip = container
    .append("div")
    .attr("class", "chart-tooltip")
    .style("position", "absolute")
    .style("pointer-events", "none")
    .style("opacity", "0")
    .style("z-index", "100");
  return tooltip;
}

function showTooltip(
  tooltip: d3.Selection<HTMLDivElement, unknown, any, any>,
  mx: number,
  my: number,
  html: string
) {
  const tooltipEl = tooltip.node() as HTMLElement;
  tooltip.html(html).style("opacity", "1");

  const tipRect = tooltipEl.getBoundingClientRect();
  let left = mx + 8;
  let top = my - tipRect.height - 4;

  const containerEl = (tooltip.node() as HTMLElement).parentElement!;
  const containerWidth = containerEl.getBoundingClientRect().width;

  if (left + tipRect.width > containerWidth) {
    left = mx - tipRect.width - 8;
  }
  if (top < 0) {
    top = my + 8;
  }

  tooltip.style("left", `${left}px`).style("top", `${top}px`);
}

function hideTooltip(tooltip: d3.Selection<HTMLDivElement, unknown, any, any>) {
  tooltip.style("opacity", "0");
}

export function renderCharacterChart(containerId: string, characters: any[], totalTime: number) {
  const container = d3.select(containerId);
  container.selectAll("*").remove();

  const width = (container.node() as HTMLElement)?.getBoundingClientRect().width || 600;
  const height = (container.node() as HTMLElement)?.getBoundingClientRect().height || 256;
  const headerHeight = 0;
  const footerHeight = 0;
  const innerHeight = height - headerHeight - footerHeight;
  const padding = 4;

  if (!characters || characters.length === 0) {
    container.append("p").attr("class", "placeholder").text("无角色数据");
    return;
  }

  const tooltip = createTooltip(container);

  const svg = container
    .append("svg")
    .attr("width", "100%")
    .attr("height", "100%")
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("preserveAspectRatio", "xMidYMid meet");

  svg
    .append("rect")
    .attr("width", width)
    .attr("height", innerHeight)
    .attr("fill", "none")
    .attr("class", "chart-container")
    .attr("y", headerHeight);

  const topChars = characters.slice(0, 10);

  const x = d3
    .scaleLinear()
    .domain([0, Math.round(totalTime * 1.003)])
    .range([0, width]);

  const maxTime = d3.max(topChars, (d: any) => {
    if (d.timeline && d.timeline.length > 0) {
      return d3.max(d.timeline, (t: any) => t.cumulativeTime) || d.secondsTotal || 0;
    }
    return d.secondsTotal || d.secondsSpoken || 1;
  }) || 1;
  const y = d3
    .scaleLinear()
    .domain([0, maxTime])
    .range([innerHeight - padding + headerHeight, padding + headerHeight]);

  const linecontainer = svg.append("g").attr("class", "chart-linecontainer");

  topChars.forEach((char: any) => {
    if (char.timeline && char.timeline.length > 0) {
      const line = d3
        .line<any>()
        .x((d) => x(d.playTimeSec))
        .y((d) => y(d.cumulativeTime))
        .curve(d3.curveLinear);

      linecontainer
        .append("path")
        .datum(char.timeline)
        .attr("d", line)
        .attr("fill", "none")
        .attr("class", "chart-data")
        .attr("data-label", encodeURIComponent(char.name))
        .attr("stroke", char.color || "#4a90d9")
        .attr("stroke-width", 1);
    }
  });

  // 鼠标悬停交互 — 收集所有数据点用于查找
  const allPoints: Array<{ playTimeSec: number; scene: string; cumulativeTime: number; charName: string }> = [];
  topChars.forEach((char: any) => {
    if (char.timeline) {
      char.timeline.forEach((pt: any) => {
        allPoints.push({
          playTimeSec: pt.playTimeSec,
          scene: pt.scene || "",
          cumulativeTime: pt.cumulativeTime,
          charName: char.name,
        });
      });
    }
  });
  allPoints.sort((a, b) => a.playTimeSec - b.playTimeSec);

  // 垂直参考线
  const mouseG = svg.append("g").attr("class", "mouse-over-effects");
  mouseG
    .append("rect")
    .attr("class", "mouse-line")
    .attr("width", "1px")
    .attr("y", headerHeight)
    .attr("height", innerHeight)
    .style("opacity", "0");

  svg
    .append("rect")
    .attr("class", "overlay")
    .attr("width", width)
    .attr("height", innerHeight)
    .attr("y", headerHeight)
    .attr("fill", "none")
    .attr("pointer-events", "all")
    .on("mouseout", () => {
      mouseG.select(".mouse-line").style("opacity", "0");
      hideTooltip(tooltip);
    })
    .on("mouseover", () => {
      mouseG.select(".mouse-line").style("opacity", "1");
    })
    .on("mousemove", function (event: MouseEvent) {
      const mouse = d3.pointer(event, this);
      const xval = x.invert(mouse[0]);
      mouseG.select(".mouse-line").attr("x", mouse[0]);

      // 二分查找最近的场景点
      const bisect = d3.bisector((d: any) => d.playTimeSec).left;
      const idx = bisect(allPoints, xval, 1);
      const point = idx < allPoints.length ? allPoints[idx] : allPoints[allPoints.length - 1];

      if (point) {
        const timeStr = secondsToString(Math.floor(point.playTimeSec));
        const sceneName = point.scene || "未知场景";
        showTooltip(tooltip, mouse[0], mouse[1], `
          <div class="chart-tooltip-time">${timeStr}</div>
          <div class="chart-tooltip-scene">${sceneName}</div>
        `);
      }
    })
    .on("click", function (event: MouseEvent) {
      const mouse = d3.pointer(event, this);
      const xval = x.invert(mouse[0]);

      const bisect = d3.bisector((d: any) => d.playTimeSec).left;
      const idx = bisect(allPoints, xval, 1);
      const point = idx < allPoints.length ? allPoints[idx] : allPoints[allPoints.length - 1];

      if (point && (window as any).jumpToLine) {
        // 从场景名查找行号 — 通过场景数据反向查找
        const scenes = (window as any).__sceneData || [];
        const scene = scenes.find((s: any) => s.scene === point.scene);
        if (scene && scene.line) {
          (window as any).jumpToLine(scene.line);
        }
      }
    });
}

function sceneTypeLabel(type: string): string {
  if (type === "int") return "内景";
  if (type === "ext") return "外景";
  if (type === "ie") return "内外景";
  return type || "未知";
}

function sceneTimeLabel(time: string): string {
  if (time === "dawn") return "黎明";
  if (time === "morning") return "早晨";
  if (time === "day") return "白天";
  if (time === "dusk" || time === "evening") return "黄昏";
  if (time === "night") return "夜晚";
  return time || "未知";
}

export function renderSceneChart(containerId: string, scenes: any[], totalTime: number) {
  const container = d3.select(containerId);
  container.selectAll("*").remove();

  const width = (container.node() as HTMLElement)?.getBoundingClientRect().width || 600;
  const height = (container.node() as HTMLElement)?.getBoundingClientRect().height || (container.node() as HTMLElement)?.offsetHeight || 90;
  const headerHeight = 0;
  const footerHeight = 0;
  const innerHeight = height - headerHeight - footerHeight;

  if (!scenes || scenes.length === 0) {
    container.append("p").attr("class", "placeholder").text("无场景数据");
    return;
  }

  const tooltip = createTooltip(container);

  const svg = container
    .append("svg")
    .attr("width", "100%")
    .attr("height", "100%")
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("preserveAspectRatio", "xMidYMid meet");

  svg
    .append("rect")
    .attr("width", width)
    .attr("height", innerHeight)
    .attr("fill", "none")
    .attr("class", "chart-container")
    .attr("y", headerHeight);

  const x = d3
    .scaleLinear()
    .domain([0, Math.round(totalTime * 1.003)])
    .range([0, width]);

  const barcodecontainer = svg.append("g").attr("class", "chart-barcodecontainer")
    .on("mousemove", function (event: MouseEvent) {
      const [mx] = d3.pointer(event, this);
      mouseLine.attr("x", mx).style("opacity", "1");
    })
    .on("mouseout", function () {
      mouseLine.style("opacity", "0");
    });

  // 鼠标竖线
  const mouseLine = svg.append("rect")
    .attr("class", "mouse-line")
    .attr("width", 1)
    .attr("y", headerHeight)
    .attr("height", innerHeight)
    .style("opacity", "0")
    .style("pointer-events", "none");

  scenes.forEach((scene: any) => {
    const xPos = x(scene.line);
    const widthRect = x(scene.endline) - x(scene.line);
    
    let sceneType = scene.type;
    if (scene.time === 'evening') {
      sceneType = 'dusk';
    }

    const sceneName = scene.scene || "未命名场景";
    const typeStr = sceneTypeLabel(scene.type);
    const timeStr = sceneTimeLabel(scene.time);

    // 内外景层
    barcodecontainer
      .append("rect")
      .attr("class", "chart-data-barcode")
      .attr("x", xPos)
      .attr("width", Math.max(widthRect, 1))
      .attr("height", innerHeight / 2)
      .attr("data-x", scene.line)
      .attr("data-xend", scene.endline)
      .attr("data-y", sceneType)
      .attr("data-scene-text", encodeURIComponent(scene.scene || ""))
      .attr("y", headerHeight)
      .on("mouseover", function (event: MouseEvent) {
        const [mx, my] = d3.pointer(event, this);
        showTooltip(tooltip, mx, my, `
          <div class="chart-tooltip-scene">${sceneName}</div>
          <div class="chart-tooltip-type">${typeStr} · ${timeStr}</div>
          <div class="chart-tooltip-time">${secondsToString(Math.floor(scene.line || 0))}</div>
        `);
      })
      .on("mousemove", function (event: MouseEvent) {
        const [mx, my] = d3.pointer(event, this);
        showTooltip(tooltip, mx, my, `
          <div class="chart-tooltip-scene">${sceneName}</div>
          <div class="chart-tooltip-type">${typeStr} · ${timeStr}</div>
          <div class="chart-tooltip-time">${secondsToString(Math.floor(scene.line || 0))}</div>
        `);
      })
      .on("mouseout", function () {
        hideTooltip(tooltip);
      });

    // 时间段层
    const timeVal = scene.time === 'evening' ? 'dusk' : (scene.time || 'unspecified');
    barcodecontainer
      .append("rect")
      .attr("class", "chart-data-barcode")
      .attr("x", xPos)
      .attr("width", Math.max(widthRect, 1))
      .attr("height", innerHeight / 2)
      .attr("data-x", scene.line)
      .attr("data-xend", scene.endline)
      .attr("data-y", timeVal)
      .attr("data-scene-text", encodeURIComponent(scene.scene || ""))
      .attr("y", headerHeight + innerHeight / 2)
      .on("mouseover", function (event: MouseEvent) {
        const [mx, my] = d3.pointer(event, this);
        showTooltip(tooltip, mx, my, `
          <div class="chart-tooltip-scene">${sceneName}</div>
          <div class="chart-tooltip-type">${typeStr} · ${timeStr}</div>
          <div class="chart-tooltip-time">${secondsToString(Math.floor(scene.line || 0))}</div>
        `);
      })
      .on("mousemove", function (event: MouseEvent) {
        const [mx, my] = d3.pointer(event, this);
        showTooltip(tooltip, mx, my, `
          <div class="chart-tooltip-scene">${sceneName}</div>
          <div class="chart-tooltip-type">${typeStr} · ${timeStr}</div>
          <div class="chart-tooltip-time">${secondsToString(Math.floor(scene.line || 0))}</div>
        `);
      })
      .on("mouseout", function () {
        hideTooltip(tooltip);
      });
  });
}
