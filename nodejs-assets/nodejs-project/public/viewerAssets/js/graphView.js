// ======================================================
//  GRAPH VIEW (js/graphView.js)
// ======================================================
// Interactive force-directed graph of all notes and their [[wikilinks]].
// Each node is a note; each edge is a link from one note to another.
// Click a node to navigate to that note. Drag nodes to reposition.
// Uses D3.js force simulation.
//
// PERFORMANCE (T3-2): D3 (~270KB) is lazy-loaded on first open via
// `ensureD3()` instead of being included synchronously in <head>.
// PERFORMANCE (P7): The D3 force simulation is stored in `currentSimulation`
// and explicitly `.stop()`-ed on close to free its timer + listeners.

let graphOverlay = null;
let currentSimulation = null;

// Lazy-load D3 from CDN. Deduped: if the script tag already exists, resolves
// immediately. Returns once `window.d3` is available.
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve();
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

async function ensureD3() {
  if (window.d3) return;
  await loadScript("https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js");
}

export function setupGraphView() {
  // Add a graph button to the outline rail header
  const rail = document.getElementById("outline-rail");
  if (!rail) return;
  const header = rail.querySelector(".outline-rail-header");
  if (!header) return;

  const btn = document.createElement("button");
  btn.className = "outline-icon-btn graph-toggle-btn";
  btn.title = "Graph View";
  btn.setAttribute("aria-label", "Open graph view");
  btn.innerHTML = `<i class="fas fa-sitemap"></i>`;
  btn.addEventListener("click", openGraphView);

  // Insert before the mind map button
  const mindMapBtn = header.querySelector(".mindmap-toggle-btn");
  if (mindMapBtn) {
    header.insertBefore(btn, mindMapBtn);
  } else {
    const collapseBtn = header.querySelector("#outline-collapse-btn");
    if (collapseBtn) header.insertBefore(btn, collapseBtn);
    else header.appendChild(btn);
  }
}

// Build the graph data from the vault's noteMap + nameToPath
function buildGraphData() {
  // noteMap is { path: content }
  // nameToPath is { lowercasename: path }
  const noteMap = window._getNoteContent ? null : null;
  // Access noteMap via the global (set in vault.js)
  // We'll dispatch an event to get the data, or read from a global
  const allNotes = window._allNotes || {};
  const nameToPath = window._nameToPath || {};

  const nodes = [];
  const nodePaths = new Set();
  const links = [];

  // Create a node for each note
  for (const path of Object.keys(allNotes)) {
    const content = allNotes[path];
    if (!content) continue;
    const name = path.split("/").pop();
    nodes.push({ id: path, name, path });
    nodePaths.add(path);
  }

  // Find [[wikilinks]] in each note's content
  const linkRegex = /\[\[([^\]]+)\]\]/g;
  for (const path of Object.keys(allNotes)) {
    const content = allNotes[path];
    if (!content) continue;

    let match;
    while ((match = linkRegex.exec(content)) !== null) {
      const linkText = match[1].trim();
      // Try to resolve the link to a path via nameToPath
      const targetPath = nameToPath[linkText.toLowerCase()];
      if (targetPath && targetPath !== path && nodePaths.has(targetPath)) {
        // Avoid duplicate links
        const exists = links.some(
          (l) => l.source === path && l.target === targetPath
        );
        if (!exists) {
          links.push({ source: path, target: targetPath });
        }
      }
    }
  }

  return { nodes, links };
}

export async function openGraphView() {
  // Populate the global note data if not done yet
  if (!window._allNotes) {
    window.showModal("Notes Still Loading", "Notes are still loading. Please try again in a moment.", { icon: "⏳" });
    return;
  }

  closeGraphView();

  const data = buildGraphData();
  if (data.nodes.length === 0) {
    window.showErrorModal("No Notes Found", "No notes found to build a graph.");
    return;
  }

  graphOverlay = document.createElement("div");
  graphOverlay.className = "graph-overlay";
  graphOverlay.innerHTML = `
    <div class="graph-header">
      <span class="graph-title">🌐 Note Graph</span>
      <div class="graph-controls">
        <span class="graph-stats" id="graphStats">${data.nodes.length} notes · ${data.links.length} links</span>
        <button id="graphClose" class="graph-btn graph-close-btn">✕ Close</button>
      </div>
    </div>
    <div class="graph-canvas" id="graphCanvas"></div>
    <div class="graph-hint">Click a node to open · Drag to reposition · Scroll to zoom · Hover to highlight</div>
  `;
  document.body.appendChild(graphOverlay);

  // Lazy-load D3 before rendering. Show a loading indicator while we wait.
  const canvas = graphOverlay.querySelector("#graphCanvas");
  canvas.innerHTML = `<div class="graph-loading">Loading graph engine…</div>`;
  try {
    await ensureD3();
  } catch (e) {
    canvas.innerHTML = `<div class="graph-loading">⚠️ Failed to load D3: ${escapeHtml(e.message)}</div>`;
    return;
  }
  canvas.innerHTML = "";

  renderGraph(data);

  graphOverlay.querySelector("#graphClose").addEventListener("click", closeGraphView);
}

function renderGraph(data) {
  const canvas = graphOverlay.querySelector("#graphCanvas");
  canvas.innerHTML = "";

  const width = canvas.clientWidth;
  const height = canvas.clientHeight;

  const svg = d3.select(canvas).append("svg")
    .attr("width", "100%")
    .attr("height", "100%")
    .style("background", "#0d0d0d");

  // Zoom group
  const g = svg.append("g");
  const zoom = d3.zoom()
    .scaleExtent([0.1, 8])
    .on("zoom", (event) => {
      g.attr("transform", event.transform);
    });
  svg.call(zoom);

  // Force simulation
  currentSimulation = d3.forceSimulation(data.nodes)
    .force("link", d3.forceLink(data.links).id((d) => d.id).distance(80).strength(0.3))
    .force("charge", d3.forceManyBody().strength(-200))
    .force("center", d3.forceCenter(0, 0))
    .force("collision", d3.forceCollide().radius((d) => d.degree ? d.degree * 2 + 8 : 10));

  // Calculate node degrees (number of connections)
  const degreeMap = {};
  data.links.forEach((l) => {
    const s = typeof l.source === "object" ? l.source.id : l.source;
    const t = typeof l.target === "object" ? l.target.id : l.target;
    degreeMap[s] = (degreeMap[s] || 0) + 1;
    degreeMap[t] = (degreeMap[t] || 0) + 1;
  });
  data.nodes.forEach((n) => { n.degree = degreeMap[n.id] || 0; });

  // Links
  const link = g.append("g")
    .attr("stroke", "#ffffff20")
    .attr("stroke-width", 1)
    .selectAll("line")
    .data(data.links)
    .join("line");

  // Nodes
  const node = g.append("g")
    .selectAll("circle")
    .data(data.nodes)
    .join("circle")
    .attr("r", (d) => Math.max(5, Math.min(20, 5 + d.degree * 1.5)))
    .attr("fill", (d) => {
      // Color by folder
      const folder = d.path.includes("/") ? d.path.split("/").slice(0, -1).join("/") : "root";
      // Hash folder name to a color
      let hash = 0;
      for (let i = 0; i < folder.length; i++) {
        hash = ((hash << 5) - hash) + folder.charCodeAt(i);
        hash |= 0;
      }
      const hue = Math.abs(hash) % 360;
      return `hsl(${hue}, 60%, 55%)`;
    })
    .attr("stroke", "#fff")
    .attr("stroke-width", 1.5)
    .style("cursor", "pointer");

  // Labels (only for nodes with degree > 0 or on hover)
  const label = g.append("g")
    .selectAll("text")
    .data(data.nodes)
    .join("text")
    .text((d) => d.name)
    .attr("font-size", "11px")
    .attr("fill", "#adadad")
    .attr("text-anchor", "middle")
    .attr("dy", "0.31em")
    .attr("pointer-events", "none")
    .style("opacity", (d) => d.degree > 0 ? 0.8 : 0.4);

  // Hover: highlight node + its links
  node.on("mouseover", function (event, d) {
    // Highlight connected links
    link.attr("stroke", (l) => {
      const s = typeof l.source === "object" ? l.source.id : l.source;
      const t = typeof l.target === "object" ? l.target.id : l.target;
      return s === d.id || t === d.id ? "#4099ff" : "#ffffff20";
    }).attr("stroke-width", (l) => {
      const s = typeof l.source === "object" ? l.source.id : l.source;
      const t = typeof l.target === "object" ? l.target.id : l.target;
      return s === d.id || t === d.id ? 2 : 1;
    });
    // Highlight connected nodes
    node.attr("opacity", (n) => {
      if (n === d) return 1;
      const connected = data.links.some((l) => {
        const s = typeof l.source === "object" ? l.source.id : l.source;
        const t = typeof l.target === "object" ? l.target.id : l.target;
        return (s === d.id && t === n.id) || (t === d.id && s === n.id);
      });
      return connected ? 1 : 0.2;
    });
    label.attr("opacity", (n) => {
      if (n === d) return 1;
      const connected = data.links.some((l) => {
        const s = typeof l.source === "object" ? l.source.id : l.source;
        const t = typeof l.target === "object" ? l.target.id : l.target;
        return (s === d.id && t === n.id) || (t === d.id && s === n.id);
      });
      return connected ? 1 : 0.1;
    }).attr("fill", (n) => n === d ? "#4099ff" : "#adadad").attr("font-weight", (n) => n === d ? "bold" : "normal");
  })
  .on("mouseout", function () {
    link.attr("stroke", "#ffffff20").attr("stroke-width", 1);
    node.attr("opacity", 1);
    label.attr("opacity", (d) => d.degree > 0 ? 0.8 : 0.4).attr("fill", "#adadad").attr("font-weight", "normal");
  });

  // Click: navigate to the note
  node.on("click", (event, d) => {
    closeGraphView();
    document.dispatchEvent(new CustomEvent("navigate", {
      detail: { path: d.path, pushHistory: true },
    }));
  });

  // Drag behavior
  const drag = d3.drag()
    .on("start", (event, d) => {
      if (!event.active) currentSimulation.alphaTarget(0.3).restart();
      d.fx = d.x;
      d.fy = d.y;
    })
    .on("drag", (event, d) => {
      d.fx = event.x;
      d.fy = event.y;
    })
    .on("end", (event, d) => {
      if (!event.active) currentSimulation.alphaTarget(0);
      d.fx = null;
      d.fy = null;
    });
  node.call(drag);

  // Tick: update positions
  currentSimulation.on("tick", () => {
    link
      .attr("x1", (d) => d.source.x)
      .attr("y1", (d) => d.source.y)
      .attr("x2", (d) => d.target.x)
      .attr("y2", (d) => d.target.y);
    node
      .attr("cx", (d) => d.x)
      .attr("cy", (d) => d.y);
    label
      .attr("x", (d) => d.x)
      .attr("y", (d) => d.y - 12);
  });

  // Center the view initially
  setTimeout(() => {
    if (!graphOverlay) return; // closed before timer fired
    const bounds = g.node().getBBox();
    const fullWidth = bounds.width;
    const fullHeight = bounds.height;
    const midX = bounds.x + fullWidth / 2;
    const midY = bounds.y + fullHeight / 2;
    if (fullWidth > 0 && fullHeight > 0) {
      const scale = Math.min(0.8, 0.9 / Math.max(fullWidth / width, fullHeight / height));
      svg.call(zoom.transform, d3.zoomIdentity
        .translate(width / 2 - midX * scale, height / 2 - midY * scale)
        .scale(scale));
    }
  }, 500);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = String(str);
  return div.innerHTML;
}

export function closeGraphView() {
  // Stop the D3 force simulation (frees its internal timer + tick listeners).
  if (currentSimulation) {
    currentSimulation.stop();
    currentSimulation = null;
  }
  if (graphOverlay) {
    graphOverlay.remove();
    graphOverlay = null;
  }
}
