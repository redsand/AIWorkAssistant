// Capabilities page — loads /api/tools, /api/tools/categories, /api/agents

const CATEGORY_LABELS = {
  calendar: "Calendar",
  github: "GitHub",
  gitlab: "GitLab",
  jira: "Jira",
  jitbit: "Jitbit (ITSM)",
  hawk_ir: "HAWK IR",
  engineering: "Engineering",
  productivity: "Productivity",
  personal_os: "Personal OS",
  cto: "CTO",
  product: "Product",
  code_review: "Code Review",
  roadmap: "Roadmap",
  todo: "Todo",
  knowledge: "Knowledge",
  graph: "Knowledge Graph",
  web: "Web",
  local: "Local Files",
  lsp: "Language Server",
  mcp: "MCP",
  codex: "Codex",
  codebase: "Codebase",
  memory: "Memory",
  workflow: "Workflow",
  work_items: "Work Items",
  system: "System",
  agent: "Agent",
  discover: "Tool Discovery",
};

let allTools = [];
let activeCategory = null;

async function loadAll() {
  try {
    const [agentsRes, toolsRes, catsRes] = await Promise.all([
      fetch("/api/agents"),
      fetch("/api/tools"),
      fetch("/api/tools/categories"),
    ]);

    if (!agentsRes.ok || !toolsRes.ok || !catsRes.ok) {
      throw new Error("API request failed");
    }

    const [agents, toolsData, catsData] = await Promise.all([
      agentsRes.json(),
      toolsRes.json(),
      catsRes.json(),
    ]);

    allTools = toolsData.tools;

    renderStats(agents.length, toolsData.total, catsData.totalCategories);
    renderAgents(agents);
    renderCategories(catsData.categories);
    renderTools(allTools);
  } catch (err) {
    document.getElementById("error-banner").textContent =
      "Failed to load capabilities: " + err.message;
    document.getElementById("error-banner").style.display = "block";
  }
}

function renderStats(agentCount, toolCount, catCount) {
  document.getElementById("stat-agents").textContent = agentCount;
  document.getElementById("stat-tools").textContent = toolCount;
  document.getElementById("stat-cats").textContent = catCount;
  document.getElementById("agent-count-badge").textContent = agentCount;
  document.getElementById("tool-count-badge").textContent = toolCount;
  document.getElementById("cat-count-badge").textContent = catCount;
}

function renderAgents(agents) {
  const el = document.getElementById("agent-grid");
  el.innerHTML = agents.map((a) => `
    <div class="agent-card">
      <div class="agent-card-header">
        <div class="agent-name">${esc(a.name)}</div>
        <span class="agent-type-badge ${a.type === "chat_mode" ? "badge-chat" : "badge-api"}">
          ${a.type === "chat_mode" ? "Chat Mode" : "Specialized API"}
        </span>
      </div>
      <p class="agent-desc">${esc(a.description)}</p>
      <div class="agent-meta">
        <span class="agent-tool-count">${a.toolCount} tools</span>
        ${a.endpoint ? `<span class="agent-endpoint" title="${esc(a.endpoint)}">${esc(a.endpoint)}</span>` : ""}
        ${a.mode ? `<span class="agent-endpoint">mode: ${esc(a.mode)}</span>` : ""}
      </div>
      <div class="features-list">
        <ul>${a.features.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>
      </div>
    </div>
  `).join("");
}

function renderCategories(categories) {
  const el = document.getElementById("cat-grid");
  const sorted = Object.keys(categories).sort();
  el.innerHTML = sorted.map((cat) => `
    <div class="cat-chip" data-cat="${esc(cat)}" onclick="filterByCategory('${esc(cat)}')">
      <span class="cat-name">${esc(CATEGORY_LABELS[cat] || cat)}</span>
      <span class="cat-cnt">${categories[cat].length}</span>
    </div>
  `).join("");
}

function filterByCategory(cat) {
  if (activeCategory === cat) {
    activeCategory = null;
  } else {
    activeCategory = cat;
  }

  document.querySelectorAll(".cat-chip").forEach((chip) => {
    chip.classList.toggle("active", chip.dataset.cat === activeCategory);
  });

  applyFilters();
}

function applyFilters() {
  const query = document.getElementById("search-input").value.toLowerCase().trim();
  const risk = document.getElementById("risk-filter").value;

  let filtered = allTools;

  if (activeCategory) {
    filtered = filtered.filter((t) => t.category === activeCategory);
  }
  if (risk) {
    filtered = filtered.filter((t) => t.riskLevel === risk);
  }
  if (query) {
    filtered = filtered.filter(
      (t) =>
        t.name.toLowerCase().includes(query) ||
        t.description.toLowerCase().includes(query) ||
        t.category.toLowerCase().includes(query),
    );
  }

  renderTools(filtered);
}

function clearFilters() {
  document.getElementById("search-input").value = "";
  document.getElementById("risk-filter").value = "";
  activeCategory = null;
  document.querySelectorAll(".cat-chip").forEach((c) => c.classList.remove("active"));
  renderTools(allTools);
}

function renderTools(tools) {
  const tbody = document.getElementById("tools-tbody");
  const label = document.getElementById("tool-count-label");
  label.textContent = `${tools.length} tool${tools.length !== 1 ? "s" : ""}`;

  if (tools.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="no-results">No tools match the current filters.</td></tr>`;
    return;
  }

  tbody.innerHTML = tools.map((t) => {
    const params = t.params
      .map(
        (p) =>
          `<span class="param-pill ${p.required ? "required" : ""}" title="${esc(p.description)}">${esc(p.name)}</span>`,
      )
      .join("");

    return `
      <tr>
        <td><span class="tool-name">${esc(t.name)}</span></td>
        <td><span class="cat-tag">${esc(CATEGORY_LABELS[t.category] || t.category)}</span></td>
        <td class="tool-desc">${esc(t.description)}</td>
        <td><span class="risk-badge risk-${t.riskLevel}">${t.riskLevel}</span></td>
        <td>${params || '<span style="color:#d1d5db">—</span>'}</td>
      </tr>
    `;
  }).join("");
}

function esc(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

document.addEventListener("DOMContentLoaded", () => {
  loadAll();

  document.getElementById("search-input").addEventListener("input", applyFilters);
  document.getElementById("risk-filter").addEventListener("change", applyFilters);
});
