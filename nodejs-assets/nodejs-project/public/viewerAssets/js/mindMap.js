// ======================================================
//  MIND MAP VIEW (js/mindMap.js)
// ======================================================
// Converts a note's heading structure into an interactive radial mind map.
// The center node is the note title (H1), with branches for each H2, and
// sub-branches for H3+. Click a node to collapse/expand its children.
//
// Opens as a full-screen overlay. Uses D3.js for the force-directed layout.
// Exported function setupMindMap() adds a button to the outline rail.
//
// PERFORMANCE (T3-2): D3 (~270KB) is lazy-loaded on first open via
// `ensureD3()` instead of being included synchronously in <head>.

let mindMapOverlay = null;

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

export function setupMindMap() {
  // Add a mind-map button to the outline rail header
  const rail = document.getElementById("outline-rail");
  if (!rail) return;
  const header = rail.querySelector(".outline-rail-header");
  if (!header) return;

  const btn = document.createElement("button");
  btn.className = "outline-icon-btn mindmap-toggle-btn";
  btn.title = "Mind Map View";
  btn.setAttribute("aria-label", "Open mind map view");
  btn.innerHTML = `<i class="fas fa-project-diagram"></i>`;
  btn.addEventListener("click", openMindMap);

  // Insert before the focus button (or collapse button)
  const focusBtn = header.querySelector(".focus-toggle-btn");
  if (focusBtn) {
    header.insertBefore(btn, focusBtn);
  } else {
    const collapseBtn = header.querySelector("#outline-collapse-btn");
    if (collapseBtn) header.insertBefore(btn, collapseBtn);
    else header.appendChild(btn);
  }
}

function buildTreeFromNote() {
  // Get the current note's content area
  const content = document.getElementById("content");
  if (!content) return null;

  const title = content.querySelector("h1")?.textContent || "Note";
  const root = { name: title, children: [] };
  const stack = [{ node: root, level: 0 }];

  // Walk through all headings (h2-h6) and build a tree
  const headings = content.querySelectorAll("h2, h3, h4, h5, h6");
  headings.forEach((h) => {
    const level = parseInt(h.tagName[1], 10);
    const text = h.textContent.trim() || "(untitled)";

    // Pop stack until we find a parent with a lower level
    while (stack.length > 1 && stack[stack.length - 1].level >= level) {
      stack.pop();
    }

    const parent = stack[stack.length - 1].node;
    const newNode = { name: text, children: [] };
    parent.children.push(newNode);
    stack.push({ node: newNode, level });
  });

  // If no children, return null (can't make a mind map)
  if (root.children.length === 0) return null;
  return root;
}

export async function openMindMap() {
  const tree = buildTreeFromNote();
  if (!tree) {
    window.showErrorModal("No Headings Found", "This note has no headings (H2+) to build a mind map from. Add some ## headings first.");
    return;
  }

  closeMindMap();

  mindMapOverlay = document.createElement("div");
  mindMapOverlay.className = "mindmap-overlay";
  mindMapOverlay.innerHTML = `
    <div class="mindmap-header">
      <span class="mindmap-title">🧠 Mind Map: ${escapeHtml(tree.name)}</span>
      <div class="mindmap-controls">
        <button id="mindmapExpandAll" class="mindmap-btn">Expand All</button>
        <button id="mindmapCollapseAll" class="mindmap-btn">Collapse All</button>
        <button id="mindmapClose" class="mindmap-btn mindmap-close-btn">✕ Close</button>
      </div>
    </div>
    <div class="mindmap-canvas" id="mindmapCanvas">
      <div class="mindmap-loading">Loading mind map engine…</div>
    </div>
    <div class="mindmap-hint">Click a node to collapse/expand · Drag nodes to reposition · Scroll to zoom</div>
  `;
  document.body.appendChild(mindMapOverlay);

  // Lazy-load D3 before rendering.
  try {
    await ensureD3();
  } catch (e) {
    const canvas = mindMapOverlay.querySelector("#mindmapCanvas");
    if (canvas) canvas.innerHTML = `<div class="mindmap-loading">⚠️ Failed to load D3: ${escapeHtml(e.message)}</div>`;
    return;
  }

  renderMindMap(tree);

  mindMapOverlay.querySelector("#mindmapClose").addEventListener("click", closeMindMap);
  mindMapOverlay.querySelector("#mindmapExpandAll").addEventListener("click", () => {
    mindMapOverlay._svg.selectAll(".mindmap-node").each(function (d) {
      d._collapsed = false;
    });
    renderMindMap(tree);
  });
  mindMapOverlay.querySelector("#mindmapCollapseAll").addEventListener("click", () => {
    mindMapOverlay._svg.selectAll(".mindmap-node").each(function (d) {
      if (d.depth >= 1) d._collapsed = true;
    });
    renderMindMap(tree);
  });
}

function renderMindMap(treeData) {
  const canvas = mindMapOverlay.querySelector("#mindmapCanvas");
  canvas.innerHTML = "";

  const width = canvas.clientWidth;
  const height = canvas.clientHeight;

  // D3 force-directed tree layout
  const svg = d3.select(canvas).append("svg")
    .attr("width", "100%")
    .attr("height", "100%")
    .attr("viewBox", [-width / 2, -height / 2, width, height])
    .style("background", "#0d0d0d");

  // Add a zoom/pan group
  const g = svg.append("g");

  // Zoom support
  const zoom = d3.zoom()
    .scaleExtent([0.2, 4])
    .on("zoom", (event) => {
      g.attr("transform", event.transform);
    });
  svg.call(zoom);

  mindMapOverlay._svg = svg;

  // Build the hierarchy
  const root = d3.hierarchy(treeData);

  // Collapse all depth-2+ nodes by default for large maps
  if (root.descendants().length > 30) {
    root.descendants().forEach((d) => {
      if (d.depth >= 2) d._collapsed = true;
    });
  }

  // Keep track of collapsed state across re-renders
  function applyCollapsed(d) {
    if (d._collapsed && d.children) {
      d._children = d.children;
      d.children = null;
    } else if (!d._collapsed && d._children) {
      d.children = d._children;
      d._children = null;
    }
    if (d.children) d.children.forEach(applyCollapsed);
  }
  applyCollapsed(root);

  // Tree layout
  const treeLayout = d3.tree()
    .size([2 * Math.PI, Math.min(width, height) / 2 - 80])
    .separation((a, b) => (a.parent === b.parent ? 1 : 2) / a.depth);

  treeLayout(root);

  // Links
  const link = g.selectAll(".mindmap-link")
    .data(root.links())
    .join("path")
    .attr("class", "mindmap-link")
    .attr("d", d3.linkRadial()
      .angle((d) => d.x)
      .radius((d) => d.y));

  // Nodes
  const node = g.selectAll(".mindmap-node")
    .data(root.descendants())
    .join("g")
    .attr("class", "mindmap-node")
    .attr("transform", (d) => `
      rotate(${(d.x * 180) / Math.PI - 90})
      translate(${d.y},0)
    `);

  node.append("circle")
    .attr("r", (d) => d.depth === 0 ? 8 : d.depth === 1 ? 6 : 4)
    .attr("fill", (d) => {
      const colors = ["#4099ff", "#2d7d46", "#e67e22", "#9b59b6", "#e74c3c"];
      return colors[d.depth % colors.length];
    })
    .attr("stroke", "#fff")
    .attr("stroke-width", 1.5)
    .style("cursor", "pointer");

  node.append("text")
    .attr("dy", "0.31em")
    .attr("x", (d) => d.x >= Math.PI ? 8 : -8)
    .attr("text-anchor", (d) => d.x >= Math.PI ? "start" : "end")
    .attr("transform", (d) => d.x >= Math.PI ? "rotate(180)" : null)
    .text((d) => {
      const name = d.data.name;
      return name.length > 30 ? name.substring(0, 28) + "…" : name;
    })
    .style("font-size", (d) => d.depth === 0 ? "14px" : d.depth === 1 ? "12px" : "11px")
    .style("font-weight", (d) => d.depth <= 1 ? "bold" : "normal")
    .style("fill", "#f8f8f8")
    .style("pointer-events", "none");

  // Click to collapse/expand
  node.on("click", (event, d) => {
    if (d.children || d._children) {
      d._collapsed = !d._collapsed;
      renderMindMap(treeData);
    }
  });

  // Hover effect
  node.style("cursor", "pointer")
    .on("mouseover", function () {
      d3.select(this).select("circle").attr("r", (d) => (d.depth === 0 ? 10 : d.depth === 1 ? 8 : 6));
    })
    .on("mouseout", function () {
      d3.select(this).select("circle").attr("r", (d) => d.depth === 0 ? 8 : d.depth === 1 ? 6 : 4);
    });
}

export function closeMindMap() {
  if (mindMapOverlay) {
    mindMapOverlay.remove();
    mindMapOverlay = null;
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = String(str);
  return div.innerHTML;
}
