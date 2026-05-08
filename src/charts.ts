import * as d3 from "d3";

export function renderDurationChart(containerId: string, data: any[]) {
  const container = d3.select(containerId);
  container.selectAll("*").remove();

  const width = (container.node() as HTMLElement)?.getBoundingClientRect().width || 600;
  const height = (container.node() as HTMLElement)?.getBoundingClientRect().height || 200;
  const margin = { top: 10, right: 10, bottom: 30, left: 40 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  if (!data || data.length === 0) {
    container.append("p").attr("class", "placeholder").text("无数据");
    return;
  }

  const svg = container.append("svg")
    .attr("width", width)
    .attr("height", height);

  const g = svg.append("g")
    .attr("transform", `translate(${margin.left},${margin.top})`);

  const x = d3.scaleLinear()
    .domain([0, d3.max(data, d => d.line) || 1])
    .range([0, innerWidth]);

  const y = d3.scaleLinear()
    .domain([0, d3.max(data, d => d.length) || 1])
    .range([innerHeight, 0]);

  const line = d3.line<{line: number, length: number}>()
    .x(d => x(d.line))
    .y(d => y(d.length))
    .curve(d3.curveMonotoneX);

  g.append("g")
    .attr("transform", `translate(0,${innerHeight})`)
    .call(d3.axisBottom(x).ticks(5));

  g.append("g")
    .call(d3.axisLeft(y).ticks(5));

  g.append("path")
    .datum(data)
    .attr("fill", "none")
    .attr("stroke", "#4a90d9")
    .attr("stroke-width", 2)
    .attr("d", line);
}

export function renderCharacterChart(containerId: string, characters: any[]) {
  const container = d3.select(containerId);
  container.selectAll("*").remove();

  const width = (container.node() as HTMLElement)?.getBoundingClientRect().width || 600;
  const height = (container.node() as HTMLElement)?.getBoundingClientRect().height || 256;
  const margin = { top: 10, right: 10, bottom: 60, left: 50 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  if (!characters || characters.length === 0) {
    container.append("p").attr("class", "placeholder").text("无角色数据");
    return;
  }

  const topChars = characters.slice(0, 10);

  const svg = container.append("svg")
    .attr("width", width)
    .attr("height", height);

  const g = svg.append("g")
    .attr("transform", `translate(${margin.left},${margin.top})`);

  const x = d3.scaleBand()
    .domain(topChars.map(d => d.name))
    .range([0, innerWidth])
    .padding(0.2);

  const y = d3.scaleLinear()
    .domain([0, d3.max(topChars, d => d.wordsSpoken) || 1])
    .range([innerHeight, 0]);

  g.append("g")
    .attr("transform", `translate(0,${innerHeight})`)
    .call(d3.axisBottom(x))
    .selectAll("text")
    .attr("transform", "rotate(-45)")
    .style("text-anchor", "end");

  g.append("g")
    .call(d3.axisLeft(y).ticks(5));

  g.selectAll(".bar")
    .data(topChars)
    .enter().append("rect")
    .attr("class", "bar")
    .attr("x", d => x(d.name) || 0)
    .attr("y", d => y(d.wordsSpoken))
    .attr("width", x.bandwidth())
    .attr("height", d => innerHeight - y(d.wordsSpoken))
    .attr("fill", d => d.color || "#4a90d9");
}

export function renderSceneChart(containerId: string, _scenes: any[], locations: any[]) {
  const container = d3.select(containerId);
  container.selectAll("*").remove();

  const width = (container.node() as HTMLElement)?.getBoundingClientRect().width || 600;
  const height = (container.node() as HTMLElement)?.getBoundingClientRect().height || 180;
  const margin = { top: 10, right: 10, bottom: 30, left: 40 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  if (!locations || locations.length === 0) {
    container.append("p").attr("class", "placeholder").text("无地点数据");
    return;
  }

  const locCounts: Record<string, number> = {};
  locations.forEach((loc: any) => {
    locCounts[loc.name] = (locCounts[loc.name] || 0) + 1;
  });

  const locData = Object.entries(locCounts).map(([name, count]) => ({ name, count }));

  const svg = container.append("svg")
    .attr("width", width)
    .attr("height", height);

  const g = svg.append("g")
    .attr("transform", `translate(${margin.left},${margin.top})`);

  const x = d3.scaleBand()
    .domain(locData.map(d => d.name))
    .range([0, innerWidth])
    .padding(0.2);

  const y = d3.scaleLinear()
    .domain([0, d3.max(locData, d => d.count) || 1])
    .range([innerHeight, 0]);

  g.append("g")
    .attr("transform", `translate(0,${innerHeight})`)
    .call(d3.axisBottom(x))
    .selectAll("text")
    .attr("transform", "rotate(-45)")
    .style("text-anchor", "end");

  g.append("g")
    .call(d3.axisLeft(y).ticks(5));

  g.selectAll(".bar")
    .data(locData)
    .enter().append("rect")
    .attr("class", "bar")
    .attr("x", d => x(d.name) || 0)
    .attr("y", d => y(d.count))
    .attr("width", x.bandwidth())
    .attr("height", d => innerHeight - y(d.count))
    .attr("fill", "#e67e22");
}