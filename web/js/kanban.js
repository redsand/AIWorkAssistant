/**
 * @module kanban
 * Kanban board types — mirrors src/kanban/types.ts for editor IntelliSense.
 */

/**
 * @typedef {"backlog"|"in_flight"|"blocked"|"done"} KanbanColumn
 */

/**
 * @typedef {object} KanbanCard
 * @property {string} key - "<platform>:<repo>:<id>"
 * @property {"github"|"gitlab"|"jira"|"work_items"} platform
 * @property {string} repo
 * @property {string} id
 * @property {string} externalId
 * @property {string} title
 * @property {string} url
 * @property {string} status
 * @property {KanbanColumn} column
 * @property {"critical"|"high"|"medium"|"low"|"unknown"} priority
 * @property {string|null} assignee
 * @property {string[]} labels
 * @property {string} [sprint]
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {string[]} dependencyKeys
 * @property {string|null} activeAgentRunId
 */

/**
 * @typedef {object} KanbanAgent
 * @property {string} agentRunId
 * @property {"claude"|"codex"|"opencode"} agent
 * @property {string|null} model
 * @property {"running"|"completed"|"failed"} status
 * @property {string|null} cardKey
 * @property {string} startedAt
 * @property {string} lastActivityAt
 * @property {number} toolLoopCount
 * @property {string|null} lastTool
 * @property {string} [checkpoint]
 */

/**
 * @typedef {object} KanbanEdge
 * @property {string} fromKey
 * @property {string} toKey
 * @property {boolean} fromGhost
 * @property {"depends_on"|"blocks"} kind
 * @property {string} label
 */

/**
 * @typedef {object} KanbanGhostNode
 * @property {string} key
 * @property {string} platform
 * @property {string} repo
 * @property {string} id
 * @property {string} label
 */

/**
 * @typedef {object} KanbanBoardResponse
 * @property {KanbanCard[]} cards
 * @property {KanbanEdge[]} edges
 * @property {KanbanGhostNode[]} ghostNodes
 * @property {KanbanAgent[]} agents
 * @property {Array<{platform:string,repo:string,cardCount:number}>} repos
 * @property {string} generatedAt
 */

/**
 * @typedef {object} KanbanSSEEventCardUpdated
 * @property {"card.updated"} type
 * @property {KanbanCard} card
 */

/**
 * @typedef {object} KanbanSSEEventAgentStarted
 * @property {"agent.started"} type
 * @property {KanbanAgent} agent
 */

/**
 * @typedef {object} KanbanSSEEventAgentStep
 * @property {"agent.step"} type
 * @property {string} agentRunId
 * @property {string} toolName
 * @property {number} stepOrder
 */

/**
 * @typedef {object} KanbanSSEEventAgentCompleted
 * @property {"agent.completed"} type
 * @property {string} agentRunId
 * @property {"completed"|"failed"} status
 * @property {string} [errorMessage]
 */

/**
 * @typedef {object} KanbanSSEEventDependencyUnblocked
 * @property {"dependency.unblocked"} type
 * @property {string} blockerKey
 * @property {string[]} unblockedKeys
 */

/**
 * @typedef {object} KanbanSSEEventWorktreeChanged
 * @property {"worktree.changed"} type
 * @property {string} path
 * @property {"active"|"removed"} status
 */

/**
 * @typedef {KanbanSSEEventCardUpdated|KanbanSSEEventAgentStarted|KanbanSSEEventAgentStep|KanbanSSEEventAgentCompleted|KanbanSSEEventDependencyUnblocked|KanbanSSEEventWorktreeChanged} KanbanSSEEvent
 */

/**
 * Kanban Board — portfolio-level view
 *
 * Fetches data from /api/kanban/board and renders cards into four columns.
 * Agents Rail renders running agents with live SSE updates.
 */
(function () {
  "use strict";

  // ─── Auth helper ───────────────────────────────────────────────────────────
  function getAuthHeaders() {
    var token = localStorage.getItem("authToken");
    return token ? { Authorization: "Bearer " + token } : {};
  }

  // ─── DOM refs ──────────────────────────────────────────────────────────────

  var loadingEl = document.getElementById("kanban-loading");
  var emptyEl = document.getElementById("kanban-empty");
  var boardEl = document.getElementById("kanban-board");
  var errorBanner = document.getElementById("error-banner");
  var refreshBtn = document.getElementById("refresh-btn");
  var agentsRail = document.getElementById("agents-rail");
  var sprintSelect = document.getElementById("sprint-select");
  var viewToggle = document.getElementById("view-toggle");
  var viewStatusBtn = document.getElementById("view-status");
  var viewSwimlaneBtn = document.getElementById("view-swimlane");
  var swimlanesEl = document.getElementById("kanban-swimlanes");
  var depOverlaySwim = document.getElementById("dep-overlay-swim");

  var columns = {
    backlog: document.getElementById("col-backlog"),
    in_flight: document.getElementById("col-in_flight"),
    blocked: document.getElementById("col-blocked"),
    done: document.getElementById("col-done"),
  };

  var counts = {
    backlog: document.getElementById("count-backlog"),
    in_flight: document.getElementById("count-in_flight"),
    blocked: document.getElementById("count-blocked"),
    done: document.getElementById("count-done"),
  };

  var PLATFORM_LABELS = {
    github: "GH",
    gitlab: "GL",
    jira: "JI",
    work_items: "WI",
  };

  // ─── Agents Rail state ─────────────────────────────────────────────────────

  var tileMap = {};      // agentRunId → { el, startedAt, interval }
  var cardTitleMap = {}; // cardKey → title (populated from board data)

  // ─── Card live-status state ────────────────────────────────────────────────

  var cardIndex = new Map();       // cardKey → HTMLElement (O(1) lookup)
  var agentRunToCardKey = {};      // agentRunId → cardKey (for step/completed events)
  var pendingMoves = new Map();    // cardKey → timeoutId (debounce optimistic moves)

  // ─── Unfiltered board state (full data from last fetch) ───────────────────

  var allCards = [];
  var allEdges = [];
  var allGhostNodes = [];

  // ─── Drag-and-drop state ────────────────────────────────────────────────────

  var COLUMN_ORDER = ["backlog", "in_flight", "blocked", "done"];
  var READONLY_PLATFORMS = {};    // platform → true if no token configured
  var boardCards = [];            // saved from last render for keyboard nav
  var toastEl = null;             // toast notification element

  // ─── Dependency arrow state ────────────────────────────────────────────────

  var depOverlay = document.getElementById("dep-overlay");
  var boardEdges = [];             // saved from API response
  var boardGhostNodes = [];        // saved from API response
  var depRafId = null;             // rAF handle for resize debounce
  var ghostAnchorMap = {};         // ghostKey → anchor element
  var resolvedEdgeTimers = [];    // timers for resolved edge fade-out removal

  // ─── Accessibility helpers ─────────────────────────────────────────────────

  var a11yLiveEl = document.getElementById("a11y-live");
  var agentsPill = document.getElementById("agents-pill");
  var agentsPillLabel = document.getElementById("agents-pill-label");

  function announce(msg) {
    if (!a11yLiveEl) return;
    a11yLiveEl.textContent = "";
    requestAnimationFrame(function () { a11yLiveEl.textContent = msg; });
  }

  function updateAgentsPill() {
    if (!agentsPill || !agentsPillLabel) return;
    var count = Object.keys(tileMap).length;
    agentsPillLabel.textContent = count + " agent" + (count !== 1 ? "s" : "") + " running";
  }

  // ─── Keyboard shortcuts modal ──────────────────────────────────────────────

  var shortcutsBackdrop = document.getElementById("shortcuts-modal-backdrop");
  var shortcutsClose = document.getElementById("shortcuts-modal-close");

  function openShortcutsModal() {
    if (shortcutsBackdrop) {
      shortcutsBackdrop.classList.add("kmodal-backdrop--active");
      if (shortcutsClose) shortcutsClose.focus();
    }
  }

  function closeShortcutsModal() {
    if (shortcutsBackdrop) {
      shortcutsBackdrop.classList.remove("kmodal-backdrop--active");
    }
  }

  if (shortcutsClose) {
    shortcutsClose.addEventListener("click", closeShortcutsModal);
  }
  if (shortcutsBackdrop) {
    shortcutsBackdrop.addEventListener("click", function (e) {
      if (e.target === shortcutsBackdrop) closeShortcutsModal();
    });
  }

  // ─── Mobile agents pill toggle ─────────────────────────────────────────────

  if (agentsPill) {
    agentsPill.addEventListener("click", function () {
      var isOpen = agentsRail.classList.contains("k-agents-rail--open");
      if (isOpen) {
        agentsRail.classList.remove("k-agents-rail--open");
        agentsPill.setAttribute("aria-expanded", "false");
      } else {
        agentsRail.classList.add("k-agents-rail--open");
        agentsPill.setAttribute("aria-expanded", "true");
      }
    });

    // Close dropdown on outside click
    document.addEventListener("click", function (e) {
      if (!agentsPill.contains(e.target) && !agentsRail.contains(e.target)) {
        agentsRail.classList.remove("k-agents-rail--open");
        agentsPill.setAttribute("aria-expanded", "false");
      }
    });
  }

  // ─── View mode state ────────────────────────────────────────────────────────

  var VIEW_STATUS = "status";
  var VIEW_SWIMLANE = "swimlane";
  var currentView = localStorage.getItem("kanban-view") || VIEW_STATUS;

  // Agent data cache: agentRunId → { agent, model, startedAt, cardKey }
  var agentCache = {};

  // ─── Filter state ───────────────────────────────────────────────────────────

  var FILTER_STORAGE_KEY = "kanban-filters";
  var filterState = {
    repos: [],      // selected repo identifiers
    agents: [],     // selected agent types: claude, codex, opencode
    priority: null,  // selected priority: critical, high, medium, low
  };
  var boardRepos = [];  // repos from last board response

  var filterStrip = document.getElementById("filter-strip");
  var filterRepoBtn = document.getElementById("filter-repo-btn");
  var filterRepoCount = document.getElementById("filter-repo-count");
  var filterRepoDropdown = document.getElementById("filter-repo-dropdown");
  var filterClearBtn = document.getElementById("filter-clear");
  var filterAgentBtns = document.querySelectorAll("#filter-agents-group .k-filter-chip");
  var filterPriorityBtns = document.querySelectorAll("#filter-priority-group .k-filter-chip");

  // ─── Filter helpers ─────────────────────────────────────────────────────────

  function loadFiltersFromURL() {
    var params = new URLSearchParams(window.location.search);
    var repos = params.get("repos");
    var agents = params.get("agents");
    var priority = params.get("priority");

    if (repos) filterState.repos = repos.split(",").filter(Boolean);
    if (agents) filterState.agents = agents.split(",").filter(Boolean);
    if (priority) filterState.priority = priority;
  }

  function loadFiltersFromStorage() {
    try {
      var stored = localStorage.getItem(FILTER_STORAGE_KEY);
      if (stored) {
        var parsed = JSON.parse(stored);
        if (parsed.repos) filterState.repos = parsed.repos;
        if (parsed.agents) filterState.agents = parsed.agents;
        if (parsed.priority) filterState.priority = parsed.priority;
      }
    } catch (e) { /* ignore */ }
  }

  function saveFilters() {
    try {
      localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(filterState));
    } catch (e) { /* ignore */ }
  }

  function updateURL() {
    var params = new URLSearchParams();
    if (filterState.repos.length > 0) params.set("repos", filterState.repos.join(","));
    if (filterState.agents.length > 0) params.set("agents", filterState.agents.join(","));
    if (filterState.priority) params.set("priority", filterState.priority);
    var qs = params.toString();
    var newURL = window.location.pathname + (qs ? "?" + qs : "");
    history.replaceState(null, "", newURL);
  }

  function syncFilterUI() {
    // Agent chips
    filterAgentBtns.forEach(function (btn) {
      var agent = btn.getAttribute("data-agent");
      btn.setAttribute("aria-pressed", filterState.agents.indexOf(agent) >= 0 ? "true" : "false");
    });

    // Priority chips
    filterPriorityBtns.forEach(function (btn) {
      var pri = btn.getAttribute("data-priority");
      btn.setAttribute("aria-pressed", filterState.priority === pri ? "true" : "false");
    });

    // Repo button
    var repoCount = filterState.repos.length;
    if (repoCount > 0) {
      filterRepoBtn.setAttribute("aria-pressed", "true");
      filterRepoBtn.innerHTML = repoCount + " repo" + (repoCount > 1 ? "s" : "") +
        ' <span class="k-filter-count">' + repoCount + "</span>";
    } else {
      filterRepoBtn.setAttribute("aria-pressed", "false");
      filterRepoBtn.innerHTML = 'All Repos <span class="k-filter-count"></span>';
    }

    // Clear button visibility
    var hasFilters = filterState.repos.length > 0 || filterState.agents.length > 0 || filterState.priority;
    filterClearBtn.style.display = hasFilters ? "" : "none";
  }

  function clearAllFilters() {
    filterState.repos = [];
    filterState.agents = [];
    filterState.priority = null;
    saveFilters();
    updateURL();
    syncFilterUI();
    syncRepoDropdownCheckboxes();
    fetchBoard();
  }

  function toggleFilterChip(type, value) {
    if (type === "agent") {
      var idx = filterState.agents.indexOf(value);
      if (idx >= 0) {
        filterState.agents.splice(idx, 1);
      } else {
        filterState.agents.push(value);
      }
    } else if (type === "priority") {
      filterState.priority = filterState.priority === value ? null : value;
    }
    saveFilters();
    updateURL();
    syncFilterUI();
    fetchBoard();
  }

  // ─── Repo dropdown ──────────────────────────────────────────────────────────

  function buildRepoDropdown(repos) {
    boardRepos = repos || [];
    boardRepos.sort(function (a, b) { return b.cardCount - a.cardCount; });

    filterRepoDropdown.innerHTML = "";
    boardRepos.forEach(function (repo) {
      var item = document.createElement("button");
      item.className = "k-filter-dropdown-item";
      item.setAttribute("role", "option");
      item.setAttribute("data-repo", repo.repo);
      var checked = filterState.repos.indexOf(repo.repo) >= 0;
      item.setAttribute("aria-selected", checked ? "true" : "false");
      item.innerHTML =
        '<input type="checkbox"' + (checked ? " checked" : "") + ' tabindex="-1">' +
        '<span>' + escapeHtml(repo.repo) + '</span>' +
        '<span class="k-filter-repo-platform">' + escapeHtml(repo.platform) + '</span>' +
        '<span class="k-filter-repo-count">' + repo.cardCount + '</span>';
      item.addEventListener("click", function () {
        toggleRepoFilter(repo.repo);
      });
      filterRepoDropdown.appendChild(item);
    });
  }

  function syncRepoDropdownCheckboxes() {
    var items = filterRepoDropdown.querySelectorAll(".k-filter-dropdown-item");
    items.forEach(function (item) {
      var repo = item.getAttribute("data-repo");
      var checked = filterState.repos.indexOf(repo) >= 0;
      item.setAttribute("aria-selected", checked ? "true" : "false");
      var cb = item.querySelector("input[type='checkbox']");
      if (cb) cb.checked = checked;
    });
  }

  function toggleRepoFilter(repoName) {
    var idx = filterState.repos.indexOf(repoName);
    if (idx >= 0) {
      filterState.repos.splice(idx, 1);
    } else {
      filterState.repos.push(repoName);
    }
    saveFilters();
    updateURL();
    syncFilterUI();
    syncRepoDropdownCheckboxes();
    fetchBoard();
  }

  function toggleRepoDropdown() {
    var isOpen = filterRepoDropdown.style.display !== "none";
    if (isOpen) {
      filterRepoDropdown.style.display = "none";
      filterRepoBtn.setAttribute("aria-expanded", "false");
    } else {
      filterRepoDropdown.style.display = "block";
      filterRepoBtn.setAttribute("aria-expanded", "true");
    }
  }

  // Close dropdown on outside click
  document.addEventListener("click", function (e) {
    if (filterRepoDropdown.style.display !== "none" &&
        !filterRepoBtn.contains(e.target) &&
        !filterRepoDropdown.contains(e.target)) {
      filterRepoDropdown.style.display = "none";
      filterRepoBtn.setAttribute("aria-expanded", "false");
    }
  });

  // ─── Filter event wiring ────────────────────────────────────────────────────

  filterRepoBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    toggleRepoDropdown();
  });

  filterAgentBtns.forEach(function (btn) {
    btn.addEventListener("click", function () {
      toggleFilterChip("agent", btn.getAttribute("data-agent"));
    });
  });

  filterPriorityBtns.forEach(function (btn) {
    btn.addEventListener("click", function () {
      toggleFilterChip("priority", btn.getAttribute("data-priority"));
    });
  });

  filterClearBtn.addEventListener("click", clearAllFilters);

  // ─── Helpers ───────────────────────────────────────────────────────────────

  function showError(msg) {
    errorBanner.textContent = msg;
    errorBanner.style.display = "block";
  }

  function hideError() {
    errorBanner.style.display = "none";
  }

  function clearColumns() {
    Object.keys(columns).forEach(function (key) {
      columns[key].innerHTML = "";
      counts[key].textContent = "0";
    });
  }

  function platformLabel(platform) {
    return PLATFORM_LABELS[platform] || platform.toUpperCase().slice(0, 2);
  }

  function escapeHtml(str) {
    var div = document.createElement("div");
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  function formatElapsed(ms) {
    var totalSec = Math.floor(ms / 1000);
    var m = Math.floor(totalSec / 60);
    var s = totalSec % 60;
    return m + "m " + (s < 10 ? "0" : "") + s + "s";
  }

  function showToast(msg, duration) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "k-toast";
      toastEl.style.cssText = "position:fixed;bottom:20px;left:50%;transform:translateX(-50%);" +
        "background:#1f2937;color:#f9fafb;padding:8px 16px;border-radius:6px;" +
        "font-size:13px;z-index:9999;transition:opacity 0.3s;pointer-events:none;";
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.style.opacity = "1";
    clearTimeout(toastEl._timer);
    toastEl._timer = setTimeout(function () {
      toastEl.style.opacity = "0";
    }, duration || 3000);
  }

  function isPlatformReadonly(platform) {
    return !!READONLY_PLATFORMS[platform];
  }

  function moveCardViaApi(cardKey, targetColumn) {
    var parts = cardKey.split(":");
    if (parts.length < 3) return Promise.reject(new Error("Invalid card key"));
    var platform = parts[0];
    var id = parts.slice(2).join(":");
    var repo = parts.slice(1, -1).join(":");

    return fetch("/api/kanban/cards/" + encodeURIComponent(platform) + "/" +
      encodeURIComponent(repo) + "/" + encodeURIComponent(id) + "/move", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getAuthHeaders() },
      body: JSON.stringify({ column: targetColumn }),
    });
  }

  // ─── Dependency arrows ─────────────────────────────────────────────────────

  function ensureGhostAnchors(ghostNodes) {
    // Remove stale anchors
    Object.keys(ghostAnchorMap).forEach(function (key) {
      if (!ghostNodes.some(function (g) { return g.key === key; })) {
        if (ghostAnchorMap[key].parentNode) ghostAnchorMap[key].parentNode.removeChild(ghostAnchorMap[key]);
        delete ghostAnchorMap[key];
      }
    });

    var container = currentView === VIEW_SWIMLANE ? swimlanesEl : boardEl;

    ghostNodes.forEach(function (ghost) {
      if (ghostAnchorMap[ghost.key]) return;

      var repoChip = document.getElementById("filter-strip");
      var anchor = document.createElement("div");
      anchor.className = "dep-ghost-anchor";
      anchor.setAttribute("data-ghost-key", ghost.key);

      container.appendChild(anchor);

      if (repoChip) {
        var chipRect = repoChip.getBoundingClientRect();
        var containerRect = container.getBoundingClientRect();
        anchor.style.left = (chipRect.left - containerRect.left + chipRect.width / 2) + "px";
        anchor.style.top = (chipRect.top - containerRect.top + chipRect.height) + "px";
      } else {
        anchor.style.left = "0px";
        anchor.style.top = "0px";
      }

      ghostAnchorMap[ghost.key] = anchor;
    });
  }

  var getCardCenter = KanbanDepUtils.getCardCenter;
  var buildEdgePath = KanbanDepUtils.buildEdgePath;
  var safeFindByDataKey = KanbanDepUtils.safeFindByDataKey;

  function drawDepArrows() {
    if (currentView === VIEW_SWIMLANE) {
      drawDepArrowsInto(depOverlaySwim, swimlanesEl, "dep-arrowhead-swim", "dep-arrowhead-ghost-swim");
    } else {
      drawDepArrowsInto(depOverlay, boardEl, "dep-arrowhead", "dep-arrowhead-ghost");
    }
  }

  function drawDepArrowsInto(overlay, container, arrowheadId, ghostArrowheadId) {
    if (!overlay) return;

    // Clear existing paths (keep <defs>)
    var existing = overlay.querySelectorAll(".dep-path");
    for (var i = 0; i < existing.length; i++) {
      existing[i].parentNode.removeChild(existing[i]);
    }

    if (boardEdges.length === 0) return;

    var containerRect = container.getBoundingClientRect();

    // Build card column lookup for edge state computation
    var cardColumnMap = {};
    boardCards.forEach(function (c) { cardColumnMap[c.key] = c.column; });

    boardEdges.forEach(function (edge) {
      var fromEl, toEl;

      if (edge.fromGhost) {
        fromEl = ghostAnchorMap[edge.fromKey];
      } else {
        fromEl = cardIndex.get(edge.fromKey) || safeFindByDataKey(container, edge.fromKey);
      }

      toEl = cardIndex.get(edge.toKey) || safeFindByDataKey(container, edge.toKey);

      if (!fromEl && !toEl) return;
      if (!fromEl || !toEl) return;

      var from = getCardCenter(fromEl, containerRect);
      var to = getCardCenter(toEl, containerRect);

      var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", buildEdgePath(from, to));

      // Determine edge state from blocker column
      var blockerColumn = cardColumnMap[edge.fromKey];
      var edgeState = "pending";
      if (blockerColumn === "done") edgeState = "resolved";
      else if (blockerColumn === "in_flight") edgeState = "in_progress";
      else if (blockerColumn === "blocked") edgeState = "blocked";

      // Critical path overrides (on top visually via CSS)
      var isCritical = !!edge.onCriticalPath;

      // Pick arrowhead color based on state
      var markerId;
      if (edge.fromGhost) {
        markerId = ghostArrowheadId;
      } else if (isCritical) {
        markerId = arrowheadId + "-critical";
      } else {
        markerId = arrowheadId + "-" + edgeState;
      }
      // Fall back to default if state-specific marker not found
      var markerEl = overlay.querySelector("#" + markerId);
      path.setAttribute("marker-end", markerEl ? ("url(#" + markerId + ")") : ("url(#" + arrowheadId + ")"));

      path.classList.add("dep-path");
      if (edge.fromGhost) path.classList.add("dep-path--ghost");
      path.classList.add("dep-edge--" + edgeState);
      if (isCritical) path.classList.add("dep-edge--critical");
      path.setAttribute("data-from", edge.fromKey);
      path.setAttribute("data-to", edge.toKey);
      path.setAttribute("data-state", edgeState);

      overlay.appendChild(path);
      if (typeof path.getTotalLength === "function") {
        var totalLen = path.getTotalLength();
        if (!edge.fromGhost && edgeState !== "resolved") {
          path.style.strokeDasharray = totalLen;
          path.style.strokeDashoffset = totalLen;
        }
      }

      // Hover highlighting
      path.addEventListener("mouseenter", function () {
        var fromCard = cardIndex.get(edge.fromKey);
        var toCard = cardIndex.get(edge.toKey);
        if (fromCard) fromCard.classList.add("kcard--edge-hover");
        if (toCard) toCard.classList.add("kcard--edge-hover");
      });
      path.addEventListener("mouseleave", function () {
        var fromCard = cardIndex.get(edge.fromKey);
        var toCard = cardIndex.get(edge.toKey);
        if (fromCard) fromCard.classList.remove("kcard--edge-hover");
        if (toCard) toCard.classList.remove("kcard--edge-hover");
      });
    });
  }

  function scheduleDepRedraw() {
    if (depRafId) return;
    depRafId = requestAnimationFrame(function () {
      depRafId = null;
      drawDepArrows();
    });
  }

  // ─── Agents Rail ───────────────────────────────────────────────────────────

  function fetchAgents() {
    fetch("/api/kanban/agents", { headers: getAuthHeaders() })
      .then(function (res) { return res.ok ? res.json() : []; })
      .then(function (agents) {
        agents.forEach(function (a) {
          addTile(a);
          agentCache[a.agentRunId] = {
            agent: a.agent,
            model: a.model,
            startedAt: a.startedAt,
            cardKey: a.cardKey,
          };
        });
      })
      .catch(function () { /* non-critical */ });
  }

  function addTile(agent) {
    if (tileMap[agent.agentRunId]) return;

    var cardTitle = cardTitleMap[agent.cardKey] || agent.cardKey || "Unknown";
    var modelLabel = agent.model || "";
    var elapsed = Date.now() - new Date(agent.startedAt).getTime();

    var tile = document.createElement("div");
    tile.className = "krun";
    tile.setAttribute("data-run-id", agent.agentRunId);
    tile.setAttribute("data-card-key", agent.cardKey || "");

    tile.innerHTML =
      '<div class="krun-head">' +
        '<img class="krun-icon" src="/img/agent-' + escapeHtml(agent.agent) + '.svg" alt="" onerror="this.style.display=\'none\'">' +
        escapeHtml(agent.agent) + (modelLabel ? " · " + escapeHtml(modelLabel) : "") +
      '</div>' +
      '<a class="krun-card" href="#card-' + escapeHtml(agent.cardKey || "") + '">' + escapeHtml(cardTitle) + '</a>' +
      '<div class="krun-meta">' +
        '<span class="krun-elapsed">' + formatElapsed(elapsed) + '</span>' +
        '<span class="krun-tool">' + (agent.lastTool ? escapeHtml(agent.lastTool) + " · " + agent.toolLoopCount : "—") + '</span>' +
      '</div>' +
      '<button class="krun-stop">Stop</button>';

    tile.querySelector(".krun-stop").addEventListener("click", function () {
      stopAgent(agent);
    });

    tile.querySelector(".krun-card").addEventListener("click", function (e) {
      e.preventDefault();
      scrollToCard(agent.cardKey);
    });

    agentsRail.appendChild(tile);

    var state = {
      el: tile,
      startedAt: new Date(agent.startedAt).getTime(),
      lastTool: agent.lastTool,
      toolLoopCount: agent.toolLoopCount || 0,
      interval: null,
    };

    state.interval = setInterval(function () {
      var el = state.el.querySelector(".krun-elapsed");
      if (el) el.textContent = formatElapsed(Date.now() - state.startedAt);
    }, 1000);

    tileMap[agent.agentRunId] = state;
  }

  function updateTile(agentRunId, toolName, stepOrder) {
    var state = tileMap[agentRunId];
    if (!state) return;
    state.lastTool = toolName;
    state.toolLoopCount = stepOrder;
    var toolEl = state.el.querySelector(".krun-tool");
    if (toolEl) toolEl.textContent = toolName + " · " + stepOrder;
  }

  function removeTile(agentRunId) {
    var state = tileMap[agentRunId];
    if (!state) return;
    clearInterval(state.interval);
    state.el.classList.add("krun--fading");
    setTimeout(function () {
      if (state.el.parentNode) state.el.parentNode.removeChild(state.el);
      delete tileMap[agentRunId];
    }, 5000);
  }

  function stopAgent(agent) {
    var cardKey = agent.cardKey || "";
    var parts = cardKey.split(":");
    if (parts.length < 3) return;
    var platform = parts[0];
    var id = parts.slice(2).join(":");
    var repo = parts.slice(1, -1).join(":");

    fetch("/api/kanban/cards/" + encodeURIComponent(platform) + "/" + encodeURIComponent(id) + "/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getAuthHeaders() },
      body: JSON.stringify({ repo: repo }),
    }).catch(function () { /* UI will update via SSE */ });
  }

  function scrollToCard(cardKey) {
    if (!cardKey) return;
    var card = cardIndex.get(cardKey) || safeFindByDataKey(document.body, cardKey);
    if (card) {
      card.scrollIntoView({ behavior: "smooth", block: "center" });
      card.classList.add("kcard--highlight");
      setTimeout(function () { card.classList.remove("kcard--highlight"); }, 2000);
    }
  }

  // ─── Card live-status helpers ───────────────────────────────────────────────

  function updateColumnCounts() {
    Object.keys(columns).forEach(function (col) {
      counts[col].textContent = columns[col].children.length;
    });
  }

  function moveCardToColumn(cardEl, targetCol) {
    var currentParent = cardEl.parentElement;
    if (!currentParent) return;
    var currentCol = currentParent.getAttribute("data-column");
    if (currentCol === targetCol) return;

    cardEl.classList.add("kcard--moving");
    setTimeout(function () {
      columns[targetCol].appendChild(cardEl);
      cardEl.classList.remove("kcard--moving");
      updateColumnCounts();
      scheduleDepRedraw();
    }, 250);
  }

  function debounceMoveCard(cardKey, targetCol) {
    if (pendingMoves.has(cardKey)) {
      clearTimeout(pendingMoves.get(cardKey));
    }
    pendingMoves.set(cardKey, setTimeout(function () {
      pendingMoves.delete(cardKey);
      var cardEl = cardIndex.get(cardKey);
      if (cardEl) moveCardToColumn(cardEl, targetCol);
    }, 50));
  }

  function openSSE() {
    // Replaced by drawer-aware version below
  }

  // ─── Card rendering ────────────────────────────────────────────────────────

  function renderCard(card) {
    var pl = platformLabel(card.platform);
    var pri = card.priority || "unknown";
    var depCount = (card.dependencyKeys && card.dependencyKeys.length) || 0;
    var depTitle = depCount > 0 ? card.dependencyKeys.join(", ") : "";
    var assignee = card.assignee ? escapeHtml(card.assignee) : "unassigned";
    var externalId = escapeHtml(card.externalId || card.id);
    var title = escapeHtml(card.title);

    // Track card titles for the agents rail
    cardTitleMap[card.key] = card.title;

    var readonly = isPlatformReadonly(card.platform);

    var article = document.createElement("article");
    article.className = "kcard" + (readonly ? " kcard--readonly" : "");
    article.setAttribute("data-key", card.key);
    article.setAttribute("id", "card-" + card.key);
    article.setAttribute("tabindex", "0");
    article.setAttribute("role", "button");
    article.setAttribute("aria-label", "Open details for " + card.title);

    if (readonly) {
      article.setAttribute("data-readonly-tooltip",
        "Read-only — set " + card.platform + " token to enable");
    } else {
      article.setAttribute("draggable", "true");
    }

    article.innerHTML =
      '<header>' +
        '<span class="kbadge kbadge-platform">' + pl + '</span>' +
        '<span class="kbadge kbadge-priority kbadge-priority-' + pri + '">' + pri + '</span>' +
        '<span class="kcard-external">' + externalId + '</span>' +
      '</header>' +
      '<h3 class="kcard-title">' + title + '</h3>' +
      '<footer>' +
        '<span class="kcard-assignee">@' + assignee + '</span>' +
        '<span class="kcard-tool"></span>' +
        '<span class="kcard-deps" title="' + escapeHtml(depTitle) + '">' +
          (depCount > 0 ? depCount + ' deps' : 'no deps') +
        '</span>' +
      '</footer>';

    article.addEventListener("click", function (e) {
      if (article._isDragging) return;
      openDrawer(card);
    });

    article.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        openDrawer(card);
      } else if (e.key === " ") {
        e.preventDefault();
        article.classList.toggle("kcard--running");
        var isRunning = article.classList.contains("kcard--running");
        announce((isRunning ? "Selected" : "Deselected") + " " + card.title);
      } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        navigateCardVertical(article, e.key === "ArrowUp" ? -1 : 1);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        navigateCardHorizontal(article, e.key === "ArrowLeft" ? -1 : 1);
      } else if (e.key === "]" || e.key === "[") {
        e.preventDefault();
        var currentCol = article.parentElement
          ? article.parentElement.getAttribute("data-column")
          : null;
        if (!currentCol) return;
        var idx = COLUMN_ORDER.indexOf(currentCol);
        var nextIdx = e.key === "]" ? idx + 1 : idx - 1;
        if (nextIdx < 0 || nextIdx >= COLUMN_ORDER.length) return;
        var targetCol = COLUMN_ORDER[nextIdx];
        performMove(card, article, targetCol);
        announce("Moved " + card.title + " to " + targetCol.replace("_", " "));
      }
    });

    // Drag start
    if (!readonly) {
      article.addEventListener("dragstart", function (e) {
        e.dataTransfer.setData("text/plain", card.key);
        e.dataTransfer.effectAllowed = "move";
        article._isDragging = true;
        requestAnimationFrame(function () {
          article.classList.add("kcard--dragging");
        });
      });

      article.addEventListener("dragend", function () {
        article._isDragging = false;
        article.classList.remove("kcard--dragging");
        removeColumnHighlights();
        // Clear drag state after a tick so click handler sees false
        setTimeout(function () { article._isDragging = false; }, 0);
      });
    }

    cardIndex.set(card.key, article);

    return article;
  }

  function performMove(card, cardEl, targetColumn) {
    var currentParent = cardEl.parentElement;
    var prevColumn = currentParent ? currentParent.getAttribute("data-column") : null;

    // Optimistic move
    moveCardToColumn(cardEl, targetColumn);

    moveCardViaApi(card.key, targetColumn)
      .then(function (res) {
        if (!res.ok) {
          // Rollback
          if (prevColumn && columns[prevColumn]) {
            moveCardToColumn(cardEl, prevColumn);
          }
          return res.json().then(function (data) {
            showToast("Move failed: " + (data.error || "Unknown error"));
          });
        }
        showToast("Moved to " + targetColumn.replace("_", " "));
      })
      .catch(function () {
        if (prevColumn && columns[prevColumn]) {
          moveCardToColumn(cardEl, prevColumn);
        }
        showToast("Move failed — network error");
      });
  }

  // ─── Arrow key navigation helpers ─────────────────────────────────────────

  function navigateCardVertical(cardEl, direction) {
    var colItems = cardEl.parentElement;
    if (!colItems) return;
    var siblings = Array.prototype.slice.call(colItems.querySelectorAll(".kcard"));
    var idx = siblings.indexOf(cardEl);
    var next = idx + direction;
    if (next < 0 || next >= siblings.length) return;
    siblings[next].focus();
  }

  function navigateCardHorizontal(cardEl, direction) {
    var colItems = cardEl.parentElement;
    if (!colItems) return;
    var colEl = colItems.parentElement;
    var currentCol = colEl.getAttribute("data-column");
    var colIdx = COLUMN_ORDER.indexOf(currentCol);
    var nextColIdx = colIdx + direction;
    if (nextColIdx < 0 || nextColIdx >= COLUMN_ORDER.length) return;
    var targetCol = COLUMN_ORDER[nextColIdx];

    // Find same index card in target column
    var currentSiblings = Array.prototype.slice.call(colItems.querySelectorAll(".kcard"));
    var currentIdx = currentSiblings.indexOf(cardEl);
    var targetColItems = columns[targetCol];
    if (!targetColItems) return;
    var targetCards = targetColItems.querySelectorAll(".kcard");
    if (targetCards.length === 0) return;
    var targetIdx = Math.min(currentIdx, targetCards.length - 1);
    targetCards[targetIdx].focus();
  }

  function removeColumnHighlights() {
    Object.keys(columns).forEach(function (col) {
      columns[col].parentElement.classList.remove("kcol--target");
    });
  }

  function setupColumnDropZones() {
    Object.keys(columns).forEach(function (col) {
      var colItems = columns[col];
      var colEl = colItems.parentElement;

      colEl.addEventListener("dragover", function (e) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        colEl.classList.add("kcol--target");
      });

      colEl.addEventListener("dragleave", function (e) {
        if (!colEl.contains(e.relatedTarget)) {
          colEl.classList.remove("kcol--target");
        }
      });

      colEl.addEventListener("drop", function (e) {
        e.preventDefault();
        colEl.classList.remove("kcol--target");

        var cardKey = e.dataTransfer.getData("text/plain");
        if (!cardKey) return;

        var cardEl = cardIndex.get(cardKey);
        if (!cardEl) return;

        var card = boardCards.find(function (c) { return c.key === cardKey; });
        if (!card) return;

        var targetColumn = col;
        performMove(card, cardEl, targetColumn);
      });
    });
  }

  // ─── Board rendering ───────────────────────────────────────────────────────

  function renderBoard(data) {
    clearColumns();
    cardIndex.clear();

    var cards = data.cards || [];
    boardCards = cards;
    var columnCounts = { backlog: 0, in_flight: 0, blocked: 0, done: 0 };

    if (cards.length === 0) {
      boardEl.style.display = "none";
      swimlanesEl.style.display = "none";
      emptyEl.style.display = "block";
      return;
    }

    emptyEl.style.display = "none";

    // Set up drop zones once
    if (!renderBoard._dropZonesReady) {
      setupColumnDropZones();
      renderBoard._dropZonesReady = true;
    }

    cards.forEach(function (card) {
      var col = card.column || "backlog";
      if (!columns[col]) {
        col = "backlog";
      }
      columns[col].appendChild(renderCard(card));
      columnCounts[col]++;
    });

    Object.keys(counts).forEach(function (key) {
      counts[key].textContent = columnCounts[key];
    });

    // Store edges/ghostNodes and draw dependency arrows
    boardEdges = data.edges || [];
    boardGhostNodes = data.ghostNodes || [];
    ensureGhostAnchors(boardGhostNodes);

    // Populate agentCache from board data so swimlanes can group cards by agent
    var agents = data.agents || [];
    agents.forEach(function (a) {
      agentCache[a.agentRunId] = {
        agent: a.agent,
        model: a.model,
        startedAt: a.startedAt,
        cardKey: a.cardKey,
      };
    });

    // Render swimlanes too (so switching views doesn't require a refetch)
    renderSwimlanes(data);

    applyViewToContainers();
    drawDepArrows();
  }

  // ─── Swimlane rendering ────────────────────────────────────────────────────

  function renderSwimlanes(data) {
    // Clear previous swimlane content (keep SVG overlay)
    var lanes = swimlanesEl.querySelectorAll(".k-swimlane");
    for (var i = 0; i < lanes.length; i++) {
      lanes[i].parentNode.removeChild(lanes[i]);
    }
    // Clear stale ghost anchors from swimlane container
    var oldAnchors = swimlanesEl.querySelectorAll(".dep-ghost-anchor");
    for (var j = 0; j < oldAnchors.length; j++) {
      oldAnchors[j].parentNode.removeChild(oldAnchors[j]);
    }

    var cards = data.cards || [];

    if (cards.length === 0) {
      boardEl.style.display = "none";
      swimlanesEl.style.display = "none";
      emptyEl.style.display = "block";
      return;
    }

    emptyEl.style.display = "none";

    // Build lookup: agentRunId → agent info from cache
    // Group cards by activeAgentRunId
    var groups = {};   // agentRunId → [card, ...]
    var unassigned = [];

    cards.forEach(function (card) {
      cardTitleMap[card.key] = card.title;
      if (card.activeAgentRunId && agentCache[card.activeAgentRunId]) {
        if (!groups[card.activeAgentRunId]) {
          groups[card.activeAgentRunId] = [];
        }
        groups[card.activeAgentRunId].push(card);
      } else {
        unassigned.push(card);
      }
    });

    // Sort agent lanes by elapsed-since-started descending
    var sortedAgentIds = Object.keys(groups).sort(function (a, b) {
      var aStarted = agentCache[a] ? new Date(agentCache[a].startedAt).getTime() : 0;
      var bStarted = agentCache[b] ? new Date(agentCache[b].startedAt).getTime() : 0;
      // More recently started first (higher timestamp = more recent = first)
      return bStarted - aStarted;
    });

    // Render agent lanes
    sortedAgentIds.forEach(function (agentRunId) {
      var agentInfo = agentCache[agentRunId] || {};
      var agentCards = groups[agentRunId];

      var lane = document.createElement("div");
      lane.className = "k-swimlane";
      lane.setAttribute("data-agent-run-id", agentRunId);

      var agentName = agentInfo.agent || "unknown";
      var modelLabel = agentInfo.model || "";
      var elapsed = agentInfo.startedAt ? Date.now() - new Date(agentInfo.startedAt).getTime() : 0;

      lane.innerHTML =
        '<div class="k-swimlane-header">' +
          '<img class="k-swimlane-icon" src="/img/agent-' + escapeHtml(agentName) + '.svg" alt="" onerror="this.style.display=\'none\'">' +
          '<span class="k-swimlane-label">' + escapeHtml(agentName) + '</span>' +
          (modelLabel ? '<span class="k-swimlane-model">· ' + escapeHtml(modelLabel) + '</span>' : '') +
          '<span class="k-swimlane-elapsed">' + formatElapsed(elapsed) + '</span>' +
          '<span class="k-swimlane-count">' + agentCards.length + '</span>' +
        '</div>' +
        '<div class="k-swimlane-cards"></div>';

      var cardsContainer = lane.querySelector(".k-swimlane-cards");
      agentCards.forEach(function (card) {
        cardsContainer.appendChild(renderCard(card));
      });

      swimlanesEl.appendChild(lane);
    });

    // Render Unassigned lane
    if (unassigned.length > 0) {
      var unassignedLane = document.createElement("div");
      unassignedLane.className = "k-swimlane k-swimlane--unassigned";

      unassignedLane.innerHTML =
        '<div class="k-swimlane-header">' +
          '<span class="k-swimlane-label">Unassigned</span>' +
          '<span class="k-swimlane-count">' + unassigned.length + '</span>' +
        '</div>' +
        '<div class="k-swimlane-cards"></div>';

      var unassignedCards = unassignedLane.querySelector(".k-swimlane-cards");
      unassigned.forEach(function (card) {
        unassignedCards.appendChild(renderCard(card));
      });

      swimlanesEl.appendChild(unassignedLane);
    }

    // Store edges/ghostNodes and draw dependency arrows
    boardEdges = data.edges || [];
    boardGhostNodes = data.ghostNodes || [];
    ensureGhostAnchors(boardGhostNodes);
    drawDepArrows();
  }

  // ─── View toggle ───────────────────────────────────────────────────────────

  function switchView(view) {
    currentView = view;
    localStorage.setItem("kanban-view", view);

    if (view === VIEW_SWIMLANE) {
      viewStatusBtn.classList.remove("active");
      viewSwimlaneBtn.classList.add("active");
    } else {
      viewSwimlaneBtn.classList.remove("active");
      viewStatusBtn.classList.add("active");
    }

    applyViewToContainers();
    scheduleDepRedraw();
  }

  function applyViewToContainers() {
    if (currentView === VIEW_SWIMLANE) {
      boardEl.style.display = "none";
      swimlanesEl.style.display = "flex";
    } else {
      boardEl.style.display = "grid";
      swimlanesEl.style.display = "none";
    }
  }

  // ─── Data fetch ────────────────────────────────────────────────────────────

  function fetchBoard() {
    hideError();
    loadingEl.style.display = "block";
    boardEl.style.display = "none";
    emptyEl.style.display = "none";

    // Build query params from filter state
    var params = new URLSearchParams();
    filterState.repos.forEach(function (r) { params.append("repos[]", r); });
    filterState.agents.forEach(function (a) { params.append("agents[]", a); });
    if (filterState.priority) params.set("priority", filterState.priority);
    var qs = params.toString();
    var url = "/api/kanban/board" + (qs ? "?" + qs : "");

    fetch(url)
      .then(function (res) {
        if (!res.ok) {
          throw new Error("HTTP " + res.status + " " + res.statusText);
        }
        return res.json();
      })
      .then(function (data) {
        loadingEl.style.display = "none";
        // Store full board data for client-side sprint filtering
        allCards = data.cards || [];
        allEdges = data.edges || [];
        allGhostNodes = data.ghostNodes || [];
        // Populate repo dropdown on first load
        if (data.repos) {
          buildRepoDropdown(data.repos);
        }
        // Populate sprint select scoped to currently selected repos
        populateSprintSelect(allCards);
        renderBoard(data);
      })
      .catch(function (err) {
        loadingEl.style.display = "none";
        emptyEl.style.display = "none";
        showError("Failed to load board: " + err.message);
      });
  }

  // ─── Card Detail Drawer ─────────────────────────────────────────────────────

  var drawer = document.getElementById("kanban-drawer");
  var drawerBackdrop = document.getElementById("drawer-backdrop");
  var drawerTitle = document.getElementById("drawer-title");
  var drawerExternalLink = document.getElementById("drawer-external-link");
  var drawerCloseBtn = document.getElementById("drawer-close");
  var drawerTabs = document.getElementById("drawer-tabs");
  var drawerMeta = document.getElementById("drawer-meta");
  var drawerLabels = document.getElementById("drawer-labels");
  var drawerDeps = document.getElementById("drawer-deps");
  var drawerDescription = document.getElementById("drawer-description");
  var drawerCommentsList = document.getElementById("drawer-comments-list");
  var drawerAgentContent = document.getElementById("drawer-agent-content");
  var drawerWorktreeContent = document.getElementById("drawer-worktree-content");
  var drawerDiffContent = document.getElementById("drawer-diff-content");

  var drawerState = {
    open: false,
    card: null,
    cardData: null,
    activeTab: "overview",
    diffLoaded: false,
    scrollPositions: { overview: 0, agent: 0, worktree: 0, diff: 0 },
    pendingSteps: [],  // steps buffered before drawer opened
    previousFocus: null, // element focused before drawer opened
  };

  function getFocusableDrawerElements() {
    if (!drawer) return [];
    var sel = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
    return Array.prototype.slice.call(drawer.querySelectorAll(sel))
      .filter(function (el) { return !el.disabled && el.offsetParent !== null; });
  }

  function trapDrawerFocus(e) {
    if (e.key !== "Tab") return;
    var focusable = getFocusableDrawerElements();
    if (focusable.length === 0) return;
    var first = focusable[0];
    var last = focusable[focusable.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  function openDrawer(card) {
    drawerState.previousFocus = document.activeElement;
    drawerState.card = card;
    drawerState.diffLoaded = false;
    drawerState.activeTab = "overview";
    drawerState.scrollPositions = { overview: 0, agent: 0, worktree: 0, diff: 0 };

    drawerTitle.textContent = card.title;
    drawerExternalLink.href = card.url || "#";

    // Reset tabs
    var tabs = drawerTabs.querySelectorAll(".kdrawer-tab");
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle("active", tabs[i].getAttribute("data-tab") === "overview");
    }
    var sections = drawer.querySelectorAll(".kdrawer-section");
    for (var j = 0; j < sections.length; j++) {
      sections[j].style.display = sections[j].getAttribute("data-tab") === "overview" ? "" : "none";
    }

    // Show drawer
    drawer.setAttribute("aria-hidden", "false");
    drawerBackdrop.classList.add("kdrawer-backdrop--active");
    drawerState.open = true;

    // Focus the close button
    if (drawerCloseBtn) drawerCloseBtn.focus();

    // Add focus trap
    document.addEventListener("keydown", trapDrawerFocus);

    // Fetch detail data
    var platform = card.platform;
    var repo = card.repo;
    var id = card.id;

    var url = "/api/kanban/cards/" + encodeURIComponent(platform) + "/" + encodeURIComponent(repo) + "/" + encodeURIComponent(id);

    fetch(url, { headers: getAuthHeaders() })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data) return;
        drawerState.cardData = data;
        renderDrawerOverview(data);
        renderDrawerAgent(data);
        renderDrawerWorktree(data);
        drawerState.pendingSteps = [];
      })
      .catch(function () { /* ignore */ });
  }

  function closeDrawer() {
    drawer.setAttribute("aria-hidden", "true");
    drawerBackdrop.classList.remove("kdrawer-backdrop--active");
    drawerState.open = false;
    drawerState.card = null;
    drawerState.cardData = null;

    // Remove focus trap
    document.removeEventListener("keydown", trapDrawerFocus);

    // Restore focus
    if (drawerState.previousFocus && typeof drawerState.previousFocus.focus === "function") {
      drawerState.previousFocus.focus();
      drawerState.previousFocus = null;
    }
  }

  function switchDrawerTab(tabName) {
    if (drawerState.activeTab === tabName) return;

    // Save scroll position of current tab
    var body = drawer.querySelector(".kdrawer-body");
    drawerState.scrollPositions[drawerState.activeTab] = body.scrollTop;

    drawerState.activeTab = tabName;

    // Update tab buttons
    var tabs = drawerTabs.querySelectorAll(".kdrawer-tab");
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle("active", tabs[i].getAttribute("data-tab") === tabName);
    }

    // Show/hide sections
    var sections = drawer.querySelectorAll(".kdrawer-section");
    for (var j = 0; j < sections.length; j++) {
      sections[j].style.display = sections[j].getAttribute("data-tab") === tabName ? "" : "none";
    }

    // Restore scroll position
    body.scrollTop = drawerState.scrollPositions[tabName] || 0;

    // Lazy-load diff
    if (tabName === "diff" && !drawerState.diffLoaded && drawerState.card) {
      fetchDiff();
    }
  }

  function renderDrawerOverview(data) {
    var card = data.card;

    // Meta badges
    var pl = platformLabel(card.platform);
    var pri = card.priority || "unknown";
    drawerMeta.innerHTML =
      '<span class="kbadge kbadge-platform">' + pl + '</span>' +
      '<span class="kbadge kbadge-priority kbadge-priority-' + pri + '">' + pri + '</span>' +
      '<span class="kcard-external">' + escapeHtml(card.externalId || card.id) + '</span>' +
      (card.assignee ? '<span class="kbadge" style="background:#eef2ff;color:#4338ca;">@' + escapeHtml(card.assignee) + '</span>' : '');

    // Labels
    if (card.labels && card.labels.length > 0) {
      drawerLabels.innerHTML = card.labels.map(function (l) {
        return '<span class="kdrawer-label">' + escapeHtml(l) + '</span>';
      }).join("");
    } else {
      drawerLabels.innerHTML = "";
    }

    // Dependencies
    if (card.dependencyKeys && card.dependencyKeys.length > 0) {
      drawerDeps.innerHTML =
        '<div class="kdrawer-deps-title">Dependencies (' + card.dependencyKeys.length + ')</div>' +
        card.dependencyKeys.map(function (dk) {
          return '<span class="kdrawer-label" style="background:#fef3c7;color:#92400e;">' + escapeHtml(dk) + '</span>';
        }).join(" ");
    } else {
      drawerDeps.innerHTML = "";
    }

    // Description (markdown)
    if (data.description && typeof renderMarkdown === "function") {
      drawerDescription.innerHTML = renderMarkdown(data.description);
    } else if (data.description) {
      drawerDescription.innerHTML = "<p>" + escapeHtml(data.description).replace(/\n/g, "<br>") + "</p>";
    } else {
      drawerDescription.innerHTML = '<p style="color:#9ca3af">No description</p>';
    }

    // Comments
    if (data.comments && data.comments.length > 0) {
      drawerCommentsList.innerHTML = data.comments.map(function (c) {
        return '<div class="kdrawer-comment">' +
          '<span class="kdrawer-comment-author">' + escapeHtml(c.author) + '</span>' +
          '<span class="kdrawer-comment-date">' + (c.createdAt ? new Date(c.createdAt).toLocaleString() : "") + '</span>' +
          '<div class="kdrawer-comment-body">' + escapeHtml(c.body).replace(/\n/g, "<br>") + '</div>' +
        '</div>';
      }).join("");
    } else {
      drawerCommentsList.innerHTML = '<p style="color:#9ca3af;font-size:12px">No comments yet.</p>';
    }
  }

  function renderDrawerAgent(data) {
    var agentRun = data.agentRun;
    if (!agentRun) {
      drawerAgentContent.innerHTML = '<p class="kdrawer-empty-tab">No agent run for this card.</p>';
      return;
    }

    var statusClass = agentRun.status === "running" ? "running" :
                      agentRun.status === "completed" ? "completed" : "failed";
    var statusLabel = agentRun.status.charAt(0).toUpperCase() + agentRun.status.slice(1);

    var html =
      '<div class="kdrawer-agent-status">' +
        '<span class="kdrawer-agent-status-dot ' + statusClass + '"></span>' +
        '<span>' + statusLabel + '</span>' +
      '</div>' +
      '<dl class="kdrawer-agent-meta">' +
        '<dt>Run ID</dt><dd>' + escapeHtml(agentRun.id.slice(0, 8)) + '</dd>' +
        '<dt>Model</dt><dd>' + escapeHtml(agentRun.model || "—") + '</dd>' +
        '<dt>Started</dt><dd>' + new Date(agentRun.startedAt).toLocaleString() + '</dd>' +
        (agentRun.completedAt ? '<dt>Completed</dt><dd>' + new Date(agentRun.completedAt).toLocaleString() + '</dd>' : '') +
        '<dt>Steps</dt><dd>' + (agentRun.steps ? agentRun.steps.length : 0) + '</dd>' +
      '</dl>';

    // Steps timeline
    if (agentRun.steps && agentRun.steps.length > 0) {
      html += '<div class="kdrawer-agent-steps"><h4>Steps</h4>';
      agentRun.steps.forEach(function (step) {
        html +=
          '<div class="kdrawer-step">' +
            '<span class="kdrawer-step-order">' + step.stepOrder + '</span>' +
            '<span class="kdrawer-step-type">' + escapeHtml(step.stepType) + '</span>' +
            (step.toolName ? '<span class="kdrawer-step-tool">' + escapeHtml(step.toolName) + '</span>' : '') +
          '</div>';
      });
      html += '</div>';
    }

    // Actions
    html += '<div class="kdrawer-agent-actions">';
    if (agentRun.status === "running") {
      html += '<button class="kdrawer-btn kdrawer-btn--danger" id="drawer-agent-stop">Stop Agent</button>';
    }
    html += '</div>';

    drawerAgentContent.innerHTML = html;

    // Wire Stop button
    var stopBtn = document.getElementById("drawer-agent-stop");
    if (stopBtn && drawerState.card) {
      stopBtn.addEventListener("click", function () {
        var c = drawerState.card;
        stopAgent({
          agentRunId: agentRun.id,
          cardKey: c.key,
        });
        closeDrawer();
      });
    }
  }

  function renderDrawerWorktree(data) {
    var wt = data.worktree;
    if (!wt) {
      drawerWorktreeContent.innerHTML = '<p class="kdrawer-empty-tab">No worktree for this card.</p>';
      return;
    }

    var cleanLabel = wt.isClean ? "Clean" : "Dirty";
    var cleanClass = wt.isClean ? "clean" : "dirty";

    var html =
      '<div class="kdrawer-worktree-status ' + cleanClass + '">' +
        cleanLabel +
      '</div>' +
      '<dl class="kdrawer-worktree-info">' +
        '<dt>Path</dt><dd>' + escapeHtml(wt.path) + '</dd>' +
        '<dt>Branch</dt><dd>' + escapeHtml(wt.branch) + '</dd>' +
      '</dl>' +
      '<div class="kdrawer-agent-actions">' +
        '<button class="kdrawer-btn" id="drawer-wt-reveal" title="Open in file explorer">Reveal</button>' +
        '<button class="kdrawer-btn kdrawer-btn--danger" id="drawer-wt-cleanup">Cleanup</button>' +
      '</div>';

    drawerWorktreeContent.innerHTML = html;

    // Reveal button (best-effort: copy path to clipboard)
    var revealBtn = document.getElementById("drawer-wt-reveal");
    if (revealBtn) {
      revealBtn.addEventListener("click", function () {
        navigator.clipboard.writeText(wt.path).catch(function () {});
      });
    }

    // Cleanup button
    var cleanupBtn = document.getElementById("drawer-wt-cleanup");
    if (cleanupBtn && data.agentRun) {
      cleanupBtn.addEventListener("click", function () {
        if (!confirm("Remove this worktree?")) return;
        fetch("/api/kanban/worktrees/" + encodeURIComponent(data.agentRun.id), {
          method: "DELETE",
        })
          .then(function (res) {
            if (res.ok) {
              drawerWorktreeContent.innerHTML = '<p class="kdrawer-empty-tab">Worktree removed.</p>';
            }
          })
          .catch(function () {});
      });
    }
  }

  function fetchDiff() {
    if (!drawerState.card) return;
    drawerState.diffLoaded = true;

    var card = drawerState.card;
    var url = "/api/kanban/cards/" + encodeURIComponent(card.platform) + "/" + encodeURIComponent(card.repo) + "/" + encodeURIComponent(card.id) + "/diff";

    drawerDiffContent.innerHTML = '<p class="kdrawer-empty-tab">Loading diff…</p>';

    fetch(url, { headers: getAuthHeaders() })
      .then(function (res) {
        if (!res.ok) throw new Error("No diff");
        return res.text();
      })
      .then(function (text) {
        if (!text || text.trim() === "") {
          drawerDiffContent.innerHTML = '<p class="kdrawer-empty-tab">No changes in diff.</p>';
          return;
        }
        renderDiff(text);
      })
      .catch(function () {
        drawerDiffContent.innerHTML = '<p class="kdrawer-empty-tab">No diff available. Start an agent to generate changes.</p>';
      });
  }

  function renderDiff(text) {
    var lines = text.split("\n");
    var html = '<div class="kdrawer-diff">';
    var inHunk = false;
    var hunkIdx = 0;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var escaped = escapeHtml(line);

      if (line.startsWith("@@")) {
        // Close previous hunk comment area
        if (inHunk) html += '</div>';
        inHunk = true;
        html += '<div class="diff-hunk">' + escaped + '</div>';
        hunkIdx++;
        // Add comment button for each hunk
        html += '<div class="kdrawer-hunk-comment" data-hunk="' + hunkIdx + '">';
        html += '<button class="kdrawer-hunk-comment-btn" data-hunk="' + hunkIdx + '">Comment</button>';
        html += '<div class="kdrawer-hunk-comment-form" id="hunk-form-' + hunkIdx + '">';
        html += '<textarea placeholder="Write a comment…"></textarea>';
        html += '<div class="kdrawer-hunk-comment-form-actions">';
        html += '<button class="kdrawer-btn kdrawer-btn--primary kdrawer-hunk-submit" data-hunk="' + hunkIdx + '">Submit</button>';
        html += '<button class="kdrawer-btn kdrawer-hunk-cancel" data-hunk="' + hunkIdx + '">Cancel</button>';
        html += '</div></div></div>';
      } else if (line.startsWith("+")) {
        html += '<div><span class="diff-add">' + escaped + '</span></div>';
      } else if (line.startsWith("-")) {
        html += '<div><span class="diff-remove">' + escaped + '</span></div>';
      } else {
        html += '<div>' + escaped + '</div>';
      }
    }

    if (inHunk) html += '</div>';
    html += '</div>';

    drawerDiffContent.innerHTML = html;

    // Wire up comment buttons
    var commentBtns = drawerDiffContent.querySelectorAll(".kdrawer-hunk-comment-btn");
    for (var b = 0; b < commentBtns.length; b++) {
      commentBtns[b].addEventListener("click", function () {
        var hunkId = this.getAttribute("data-hunk");
        var form = document.getElementById("hunk-form-" + hunkId);
        if (form) form.classList.add("active");
      });
    }

    var cancelBtns = drawerDiffContent.querySelectorAll(".kdrawer-hunk-cancel");
    for (var c = 0; c < cancelBtns.length; c++) {
      cancelBtns[c].addEventListener("click", function () {
        var hunkId = this.getAttribute("data-hunk");
        var form = document.getElementById("hunk-form-" + hunkId);
        if (form) {
          form.classList.remove("active");
          var ta = form.querySelector("textarea");
          if (ta) ta.value = "";
        }
      });
    }

    var submitBtns = drawerDiffContent.querySelectorAll(".kdrawer-hunk-submit");
    for (var s = 0; s < submitBtns.length; s++) {
      submitBtns[s].addEventListener("click", function () {
        var hunkId = this.getAttribute("data-hunk");
        var form = document.getElementById("hunk-form-" + hunkId);
        if (!form) return;
        var ta = form.querySelector("textarea");
        var body = ta ? ta.value.trim() : "";
        if (!body || !drawerState.card) return;

        var card = drawerState.card;
        var commentUrl = "/api/kanban/cards/" + encodeURIComponent(card.platform) + "/" + encodeURIComponent(card.repo) + "/" + encodeURIComponent(card.id) + "/comment";

        fetch(commentUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...getAuthHeaders() },
          body: JSON.stringify({ body: body }),
        })
          .then(function (res) {
            if (res.ok) {
              form.classList.remove("active");
              if (ta) ta.value = "";
              // Refresh comments in overview tab
              var url2 = "/api/kanban/cards/" + encodeURIComponent(card.platform) + "/" + encodeURIComponent(card.repo) + "/" + encodeURIComponent(card.id);
              fetch(url2, { headers: getAuthHeaders() })
                .then(function (r2) { return r2.ok ? r2.json() : null; })
                .then(function (d2) {
                  if (d2 && d2.comments) {
                    renderDrawerCommentsOnly(d2.comments);
                  }
                })
                .catch(function () {});
            }
          })
          .catch(function () {});
      });
    }
  }

  function renderDrawerCommentsOnly(comments) {
    if (comments && comments.length > 0) {
      drawerCommentsList.innerHTML = comments.map(function (c) {
        return '<div class="kdrawer-comment">' +
          '<span class="kdrawer-comment-author">' + escapeHtml(c.author) + '</span>' +
          '<span class="kdrawer-comment-date">' + (c.createdAt ? new Date(c.createdAt).toLocaleString() : "") + '</span>' +
          '<div class="kdrawer-comment-body">' + escapeHtml(c.body).replace(/\n/g, "<br>") + '</div>' +
        '</div>';
      }).join("");
    } else {
      drawerCommentsList.innerHTML = '<p style="color:#9ca3af;font-size:12px">No comments yet.</p>';
    }
  }

  // Drawer event wiring
  drawerCloseBtn.addEventListener("click", closeDrawer);
  drawerBackdrop.addEventListener("click", closeDrawer);

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      if (shortcutsBackdrop && shortcutsBackdrop.classList.contains("kmodal-backdrop--active")) {
        closeShortcutsModal();
        return;
      }
      if (drawerState.open) {
        closeDrawer();
      }
    }
    // ? opens shortcuts (only when not typing in an input)
    if (e.key === "?" && !isEditableTarget(e.target)) {
      e.preventDefault();
      openShortcutsModal();
    }
  });

  function isEditableTarget(el) {
    var tag = (el.tagName || "").toUpperCase();
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
  }

  drawerTabs.addEventListener("click", function (e) {
    var tab = e.target.closest(".kdrawer-tab");
    if (tab) {
      switchDrawerTab(tab.getAttribute("data-tab"));
    }
  });

  // ─── SSE step replay for drawer agent tab ──────────────────────────────────

  openSSE = function () {
    if (typeof EventSource === "undefined") return;
    var source = new EventSource("/api/kanban/stream");

    source.addEventListener("agent.started", function (e) {
      try {
        var data = JSON.parse(e.data);
        if (data.agent) {
          addTile(data.agent);
          var agent = data.agent;
          var cardKey = agent.cardKey;
          var cardTitle = cardTitleMap[cardKey] || cardKey || "unknown card";
          announce("Started " + agent.agent + " on " + cardTitle);
          if (cardKey) {
            agentRunToCardKey[agent.agentRunId] = cardKey;
            var cardEl = cardIndex.get(cardKey);
            if (cardEl) {
              cardEl.classList.add("kcard--running");
              debounceMoveCard(cardKey, "in_flight");
            }
          }
        }
      } catch (ex) { /* ignore */ }
    });

    source.addEventListener("agent.step", function (e) {
      try {
        var data = JSON.parse(e.data);
        updateTile(data.agentRunId, data.toolName, data.stepOrder);

        var cardKey = agentRunToCardKey[data.agentRunId];
        if (cardKey) {
          var cardEl = cardIndex.get(cardKey);
          if (cardEl) {
            var toolEl = cardEl.querySelector(".kcard-tool");
            if (toolEl) toolEl.textContent = data.toolName;
          }
        }

        // Live step in drawer
        if (drawerState.open && drawerState.cardData &&
            drawerState.cardData.agentRun &&
            drawerState.cardData.agentRun.id === data.agentRunId) {
          appendDrawerStep(data);
        } else {
          drawerState.pendingSteps.push(data);
        }
      } catch (ex) { /* ignore */ }
    });

    source.addEventListener("agent.completed", function (e) {
      try {
        var data = JSON.parse(e.data);
        removeTile(data.agentRunId);

        var cardKey = agentRunToCardKey[data.agentRunId];
        var cardTitle = cardTitleMap[cardKey] || cardKey || "unknown card";
        var statusVerb = data.status === "completed" ? "completed" : "failed";
        announce("Agent " + statusVerb + " on " + cardTitle);

        if (cardKey) {
          var cardEl = cardIndex.get(cardKey);
          if (cardEl) {
            cardEl.classList.remove("kcard--running");
            var toolEl = cardEl.querySelector(".kcard-tool");
            if (toolEl) toolEl.textContent = "";
            if (data.status === "completed") {
              debounceMoveCard(cardKey, "done");
            }
          }
          delete agentRunToCardKey[data.agentRunId];
        }
      } catch (ex) { /* ignore */ }
    });

    source.addEventListener("card.updated", function (e) {
      try {
        var data = JSON.parse(e.data);
        if (data.card) {
          var card = data.card;
          var cardEl = cardIndex.get(card.key);
          if (cardEl) {
            debounceMoveCard(card.key, card.column || "backlog");
          }
        }
      } catch (ex) { /* ignore */ }
    });

    source.addEventListener("dependency.unblocked", function (e) {
      try {
        var data = JSON.parse(e.data);
        var blockerKey = data.blockerKey;
        var unblockedKeys = data.unblockedKeys || [];

        // Transition affected edges to resolved state
        var affectedFromKeys = [blockerKey];
        unblockedKeys.forEach(function (k) { affectedFromKeys.push(k); });

        boardEdges.forEach(function (edge) {
          if (affectedFromKeys.indexOf(edge.fromKey) !== -1) {
            edge._resolved = true;
          }
        });

        // Update rendered arrows
        var overlays = [depOverlay, depOverlaySwim];
        overlays.forEach(function (overlay) {
          if (!overlay) return;
          var paths = overlay.querySelectorAll(".dep-path");
          for (var i = 0; i < paths.length; i++) {
            var p = paths[i];
            var fromKey = p.getAttribute("data-from");
            if (affectedFromKeys.indexOf(fromKey) !== -1) {
              // Remove old state classes, add resolved
              p.classList.remove("dep-edge--pending", "dep-edge--in_progress", "dep-edge--blocked");
              p.classList.add("dep-edge--resolved");
              p.setAttribute("data-state", "resolved");

              // Schedule removal after 5s fade
              (function (pathEl) {
                var timer = setTimeout(function () {
                  pathEl.classList.add("dep-path--removing");
                  setTimeout(function () {
                    if (pathEl.parentNode) pathEl.parentNode.removeChild(pathEl);
                  }, 400);
                }, 5000);
                resolvedEdgeTimers.push(timer);
              })(p);
            }
          }
        });
      } catch (ex) { /* ignore */ }
    });

    source.onerror = function () {
      source.close();
      setTimeout(openSSE, 5000);
    };
  };

  function appendDrawerStep(stepData) {
    var stepsContainer = drawerAgentContent.querySelector(".kdrawer-agent-steps");
    if (!stepsContainer) {
      // Create steps container if it doesn't exist
      stepsContainer = document.createElement("div");
      stepsContainer.className = "kdrawer-agent-steps";
      stepsContainer.innerHTML = "<h4>Live Steps</h4>";
      drawerAgentContent.appendChild(stepsContainer);
    }
    var stepEl = document.createElement("div");
    stepEl.className = "kdrawer-step";
    stepEl.innerHTML =
      '<span class="kdrawer-step-order">' + stepData.stepOrder + '</span>' +
      '<span class="kdrawer-step-type">' + escapeHtml(stepData.toolName || "output") + '</span>';
    stepsContainer.appendChild(stepEl);
    stepsContainer.scrollTop = stepsContainer.scrollHeight;
  }

  // ─── Worktree Admin Modal ──────────────────────────────────────────────────

  var worktreeBtn = document.getElementById("worktree-admin-btn");
  var worktreeCount = document.getElementById("worktree-count");
  var worktreeBackdrop = document.getElementById("worktree-modal-backdrop");
  var worktreeClose = document.getElementById("worktree-modal-close");
  var worktreeTbody = document.getElementById("worktree-tbody");

  function fetchWorktreeCount() {
    fetch("/api/kanban/worktrees", { headers: getAuthHeaders() })
      .then(function (res) { return res.ok ? res.json() : []; })
      .then(function (entries) {
        worktreeCount.textContent = entries.length;
      })
      .catch(function () { /* non-critical */ });
  }

  function openWorktreeModal() {
    worktreeBackdrop.classList.add("kmodal-backdrop--active");
    loadWorktreeModal();
  }

  function closeWorktreeModal() {
    worktreeBackdrop.classList.remove("kmodal-backdrop--active");
  }

  function loadWorktreeModal() {
    worktreeTbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#9ca3af;padding:20px;">Loading…</td></tr>';

    fetch("/api/kanban/worktrees", { headers: getAuthHeaders() })
      .then(function (res) { return res.ok ? res.json() : []; })
      .then(function (entries) {
        worktreeCount.textContent = entries.length;
        renderWorktreeTable(entries);
      })
      .catch(function () {
        worktreeTbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#ef4444;padding:20px;">Failed to load worktrees</td></tr>';
      });
  }

  function renderWorktreeTable(entries) {
    if (!entries || entries.length === 0) {
      worktreeTbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#9ca3af;padding:20px;">No worktrees found</td></tr>';
      return;
    }

    var html = "";
    entries.forEach(function (wt) {
      var stateClass, stateLabel;
      if (wt.state === "orphan") {
        stateClass = "kmodal-state--orphan";
        stateLabel = "Orphan";
      } else if (wt.state === "ghost") {
        stateClass = "kmodal-state--ghost";
        stateLabel = "Ghost";
      } else if (wt.isClean === false) {
        stateClass = "kmodal-state--dirty";
        stateLabel = "Dirty";
      } else {
        stateClass = "kmodal-state--active";
        stateLabel = "Clean";
      }

      var cardLink = "";
      if (wt.cardKey) {
        var parts = wt.cardKey.split(":");
        var externalId = parts.length >= 3 ? parts.slice(2).join(":") : wt.cardKey;
        cardLink = '<a class="kmodal-card-link" href="#card-' + escapeHtml(wt.cardKey) + '">' + escapeHtml(externalId) + '</a>';
      }

      // Shorten path for display
      var shortPath = wt.path;
      var kanbanIdx = shortPath.indexOf(".kanban-worktrees");
      if (kanbanIdx > 0) {
        shortPath = "../" + shortPath.substring(kanbanIdx);
      }

      html += "<tr>" +
        "<td title=\"" + escapeHtml(wt.path) + "\">" + escapeHtml(shortPath) + "</td>" +
        "<td>" + escapeHtml(wt.branch || "—") + "</td>" +
        "<td><span class=\"kmodal-state " + stateClass + "\"><span class=\"kmodal-state-dot\"></span>" + stateLabel + "</span></td>" +
        "<td>" + cardLink + "</td>" +
        "<td>" + (wt.agentRunId ? "<button class=\"kmodal-remove-btn\" data-run-id=\"" + escapeHtml(wt.agentRunId) + "\" data-clean=\"" + (wt.isClean ? "1" : "0") + "\">✕</button>" : "") + "</td>" +
        "</tr>";
    });

    worktreeTbody.innerHTML = html;

    // Wire remove buttons
    var removeBtns = worktreeTbody.querySelectorAll(".kmodal-remove-btn");
    for (var i = 0; i < removeBtns.length; i++) {
      removeBtns[i].addEventListener("click", function () {
        var btn = this;
        var runId = btn.getAttribute("data-run-id");
        var isClean = btn.getAttribute("data-clean") === "1";

        if (!isClean && !confirm("This worktree has uncommitted changes. Remove anyway?")) return;

        btn.disabled = true;
        btn.textContent = "…";

        var url = "/api/kanban/worktrees/" + encodeURIComponent(runId);
        if (!isClean) url += "?force=true";

        fetch(url, { method: "DELETE", headers: getAuthHeaders() })
          .then(function (res) {
            if (res.ok) {
              loadWorktreeModal();
            } else {
              return res.json().then(function (data) {
                showToast("Cleanup failed: " + (data.error || "Unknown error"));
                btn.disabled = false;
                btn.textContent = "✕";
              });
            }
          })
          .catch(function () {
            showToast("Cleanup failed — network error");
            btn.disabled = false;
            btn.textContent = "✕";
          });
      });
    }

    // Wire card links to scroll and close modal
    var cardLinks = worktreeTbody.querySelectorAll(".kmodal-card-link");
    for (var j = 0; j < cardLinks.length; j++) {
      cardLinks[j].addEventListener("click", function (e) {
        e.preventDefault();
        var cardKey = this.getAttribute("href").replace("#card-", "");
        closeWorktreeModal();
        scrollToCard(cardKey);
      });
    }
  }

  // ─── Sprint filter (client-side, second-level after repo filter) ──────────

  function populateSprintSelect(cards) {
    if (!sprintSelect) return;
    var currentSprint = sprintSelect.value;
    // Scope to repos selected in the chip filter strip
    var selectedRepos = filterState ? filterState.repos : [];
    var subset = selectedRepos.length > 0
      ? cards.filter(function (c) { return selectedRepos.indexOf(c.repo) >= 0; })
      : cards;

    var seen = {};
    var sprints = [];
    subset.forEach(function (c) {
      if (c.sprint && !seen[c.sprint]) { seen[c.sprint] = true; sprints.push(c.sprint); }
    });
    sprints.sort(function (a, b) {
      var na = parseInt(a.replace(/\D+/g, ""), 10);
      var nb = parseInt(b.replace(/\D+/g, ""), 10);
      return (!isNaN(na) && !isNaN(nb)) ? na - nb : a.localeCompare(b);
    });

    sprintSelect.innerHTML = '<option value="">— All Sprints —</option>';
    sprints.forEach(function (s) {
      var opt = document.createElement("option");
      opt.value = s; opt.textContent = s;
      if (s === currentSprint) opt.selected = true;
      sprintSelect.appendChild(opt);
    });
    sprintSelect.disabled = sprints.length === 0;
  }

  function applySprintFilter() {
    if (!sprintSelect) return;
    var sprintVal = sprintSelect.value;
    if (!sprintVal) { renderBoard({ cards: allCards, edges: allEdges, ghostNodes: allGhostNodes }); return; }
    var filtered = allCards.filter(function (c) { return c.sprint === sprintVal; });
    var visibleKeys = new Set(filtered.map(function (c) { return c.key; }));
    var filteredEdges = allEdges.filter(function (e) {
      return visibleKeys.has(e.fromKey) || visibleKeys.has(e.toKey);
    });
    renderBoard({ cards: filtered, edges: filteredEdges, ghostNodes: allGhostNodes });
  }

  worktreeBtn.addEventListener("click", openWorktreeModal);
  worktreeClose.addEventListener("click", closeWorktreeModal);
  worktreeBackdrop.addEventListener("click", function (e) {
    if (e.target === worktreeBackdrop) closeWorktreeModal();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && worktreeBackdrop.classList.contains("kmodal-backdrop--active")) {
      closeWorktreeModal();
    }
  });

  // ─── Settings Modal ──────────────────────────────────────────────────────────

  var settingsBtn = document.getElementById("settings-btn");
  var settingsBackdrop = document.getElementById("settings-modal-backdrop");
  var settingsClose = document.getElementById("settings-modal-close");
  var settingAutoCommit = document.getElementById("setting-auto-commit");
  var settingAutoPR = document.getElementById("setting-auto-pr");
  var settingAutoCleanup = document.getElementById("setting-auto-cleanup-hours");

  function openSettingsModal() {
    settingsBackdrop.classList.add("kmodal-backdrop--active");
    fetch("/api/kanban/settings", { headers: getAuthHeaders() })
      .then(function (res) { return res.ok ? res.json() : {}; })
      .then(function (s) {
        settingAutoCommit.checked = !!s.autoCommit;
        settingAutoPR.checked = !!s.autoPR;
        settingAutoCleanup.value = s.autoCleanupHours ?? 24;
      })
      .catch(function () { /* non-critical */ });
  }

  function closeSettingsModal() {
    settingsBackdrop.classList.remove("kmodal-backdrop--active");
  }

  function saveSettings() {
    fetch("/api/kanban/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...getAuthHeaders() },
      body: JSON.stringify({
        autoCommit: settingAutoCommit.checked,
        autoPR: settingAutoPR.checked,
        autoCleanupHours: parseInt(settingAutoCleanup.value, 10),
      }),
    })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (data) {
          settingAutoCleanup.value = data.autoCleanupHours;
          showToast("Settings saved");
        }
      })
      .catch(function () {
        showToast("Failed to save settings");
      });
  }

  if (settingsBtn) {
    settingsBtn.addEventListener("click", openSettingsModal);
  }
  if (settingsClose) {
    settingsClose.addEventListener("click", closeSettingsModal);
  }
  if (settingsBackdrop) {
    settingsBackdrop.addEventListener("click", function (e) {
      if (e.target === settingsBackdrop) closeSettingsModal();
    });
  }
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && settingsBackdrop && settingsBackdrop.classList.contains("kmodal-backdrop--active")) {
      closeSettingsModal();
    }
  });
  if (settingAutoCommit) settingAutoCommit.addEventListener("change", saveSettings);
  if (settingAutoPR) settingAutoPR.addEventListener("change", saveSettings);
  if (settingAutoCleanup) settingAutoCleanup.addEventListener("change", saveSettings);

  // ─── Sidebar Chat (Task Breakdown) ────────────────────────────────────────

  var sidechatAside = document.getElementById("kanban-sidechat");
  var sidechatToggle = document.getElementById("sidechat-toggle");
  var sidechatCloseBtn = document.getElementById("sidechat-close");
  var sidechatTranscript = document.getElementById("sidechat-transcript");
  var sidechatInput = document.getElementById("sidechat-input");
  var sidechatSubmit = document.getElementById("sidechat-submit");
  var SIDECHAT_OPEN_KEY = "kanban-sidechat-open";
  var sidechatState = {
    open: false,
    lastCheckboxItems: null,   // parsed checkbox items from last assistant response
  };

  // Bail out silently if sidechat elements are missing (e.g. different page layout)
  if (!sidechatAside || !sidechatToggle || !sidechatTranscript || !sidechatInput || !sidechatSubmit) {
    console.warn("[Sidechat] Required DOM elements not found — sidechat disabled.");
  } else {

  function openSidechat() {
    sidechatAside.setAttribute("aria-hidden", "false");
    sidechatToggle.classList.add("active");
    sidechatState.open = true;
    localStorage.setItem(SIDECHAT_OPEN_KEY, "true");
    sidechatInput.focus();
  }

  function closeSidechat() {
    sidechatAside.setAttribute("aria-hidden", "true");
    sidechatToggle.classList.remove("active");
    sidechatState.open = false;
    localStorage.setItem(SIDECHAT_OPEN_KEY, "false");
  }

  function toggleSidechat() {
    if (sidechatState.open) {
      closeSidechat();
    } else {
      openSidechat();
    }
  }

  function appendSidechatMsg(role, html) {
    var div = document.createElement("div");
    div.className = "k-sidechat-msg k-sidechat-msg--" + role;
    div.innerHTML = html;
    sidechatTranscript.appendChild(div);
    sidechatTranscript.scrollTop = sidechatTranscript.scrollHeight;
    return div;
  }

  function detectCheckboxItems(text) {
    // Match lines like "- [ ] Task title" and extract the titles
    var items = [];
    var lines = text.split("\n");
    for (var i = 0; i < lines.length; i++) {
      var match = lines[i].match(/^[-*]\s*\[[ x]\]\s*(.+)$/);
      if (match) {
        var title = match[1].trim();
        if (title.length > 0 && title.length <= 256) {
          items.push({ title: title });
        }
      }
    }
    return items.length >= 2 ? items : null;
  }

  function handleSidechatSubmit() {
    var message = (sidechatInput.value || "").trim();
    if (!message) return;

    // Determine platform + repo from first selected repo filter, or first board repo
    var targetRepo = "";
    var targetPlatform = "";
    if (filterState.repos.length > 0) {
      targetRepo = filterState.repos[0];
      // Find matching repo in boardRepos to get platform
      for (var i = 0; i < boardRepos.length; i++) {
        if (boardRepos[i].repo === targetRepo) {
          targetPlatform = boardRepos[i].platform;
          break;
        }
      }
    } else if (boardRepos.length > 0) {
      targetRepo = boardRepos[0].repo;
      targetPlatform = boardRepos[0].platform;
    }

    if (!targetPlatform || !targetRepo) {
      appendSidechatMsg("assistant", '<div class="k-sidechat-error">Select a repository first — no platform/repo available.</div>');
      return;
    }

    // Add user message
    appendSidechatMsg("user", escapeHtml(message));
    sidechatInput.value = "";
    sidechatInput.style.height = "auto";
    sidechatState.lastCheckboxItems = null;

    // Show loading
    var loadingHtml = '<span class="k-sidechat-spinner"></span> Breaking down tasks…';
    var loadingEl = appendSidechatMsg("assistant", loadingHtml);

    sidechatSubmit.disabled = true;

    var systemPrompt =
      "You are a planning assistant. Break the user's intent into 3-10 atomic engineering tasks.\n" +
      "Output ONLY a markdown checkbox list, one task per line, prefixed with \"- [ ] \".\n" +
      "Each task title is imperative form and <70 chars.";

    fetch("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getAuthHeaders() },
      body: JSON.stringify({
        message: message,
        includeTools: false,
        includeMemory: false,
        systemPrompt: systemPrompt,
        model: "haiku",
      }),
    })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        sidechatSubmit.disabled = false;
        var content = data.content || "";
        if (!content.trim()) {
          loadingEl.innerHTML = '<span style="color:#9ca3af">No response from assistant.</span>';
          return;
        }

        // Render markdown
        var rendered = typeof renderMarkdown === "function" ? renderMarkdown(content) : "<p>" + escapeHtml(content).replace(/\n/g, "<br>") + "</p>";
        loadingEl.innerHTML = rendered;

        // Detect checkbox items
        var items = detectCheckboxItems(content);
        if (items) {
          sidechatState.lastCheckboxItems = items;
          var btnHtml = '<button class="k-sidechat-bulk-btn" data-count="' + items.length + '">Create ' + items.length + ' cards</button>';
          var btnWrapper = document.createElement("div");
          btnWrapper.innerHTML = btnHtml;
          loadingEl.appendChild(btnWrapper);

          var bulkBtn = btnWrapper.querySelector(".k-sidechat-bulk-btn");
          bulkBtn.addEventListener("click", function () {
            performBulkCreate(items, targetPlatform, targetRepo, bulkBtn);
          });
        }
      })
      .catch(function (err) {
        sidechatSubmit.disabled = false;
        loadingEl.innerHTML = '<div class="k-sidechat-error">Request failed: ' + escapeHtml(err.message) + '</div>';
      });
  }

  function performBulkCreate(items, platform, repo, btnEl) {
    btnEl.classList.add("k-sidechat-bulk-btn--creating");
    btnEl.textContent = "Creating…";

    fetch("/api/kanban/cards/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getAuthHeaders() },
      body: JSON.stringify({
        items: items,
        platform: platform,
        repo: repo,
      }),
    })
      .then(function (res) {
        if (!res.ok) {
          return res.json().then(function (d) { throw new Error(d.error || "Unknown error"); });
        }
        return res.json();
      })
      .then(function (data) {
        var created = data.created || [];
        var errors = data.errors || [];

        if (created.length > 0) {
          var ids = created.map(function (c) { return "#" + c.id; }).join(", ");
          showToast("Created " + created.length + " card" + (created.length > 1 ? "s" : "") + ": " + ids);
          btnEl.textContent = "Created " + created.length + " card" + (created.length > 1 ? "s" : "") + "!";
          btnEl.disabled = true;
          sidechatState.lastCheckboxItems = null;

          // Refresh the board
          fetchBoard();
        }

        if (errors.length > 0) {
          var errMsg = errors.map(function (e) { return e.error; }).join("; ");
          appendSidechatMsg("assistant", '<div class="k-sidechat-error">Some items failed: ' + escapeHtml(errMsg) + '</div>');
        }
      })
      .catch(function (err) {
        btnEl.classList.remove("k-sidechat-bulk-btn--creating");
        btnEl.textContent = "Create " + items.length + " cards";
        appendSidechatMsg("assistant", '<div class="k-sidechat-error">Bulk create failed: ' + escapeHtml(err.message) + '</div>');
      });
  }

  // Wire sidebar chat events
  if (sidechatToggle) sidechatToggle.addEventListener("click", toggleSidechat);
  if (sidechatCloseBtn) sidechatCloseBtn.addEventListener("click", closeSidechat);

  if (sidechatSubmit) sidechatSubmit.addEventListener("click", handleSidechatSubmit);
  if (sidechatInput) sidechatInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSidechatSubmit();
    }
  });

  // Auto-resize textarea
  if (sidechatInput) sidechatInput.addEventListener("input", function () {
    this.style.height = "auto";
    this.style.height = Math.min(this.scrollHeight, 120) + "px";
  });

  // Restore sidebar open state from localStorage
  if (localStorage.getItem(SIDECHAT_OPEN_KEY) === "true") {
    openSidechat();
  }

  } // end sidechat guard — all sidechat code runs only when DOM elements exist

  // ─── Init ──────────────────────────────────────────────────────────────────

  // Restore filter state: URL params override localStorage
  loadFiltersFromStorage();
  loadFiltersFromURL();
  syncFilterUI();

  if (sprintSelect) {
    sprintSelect.addEventListener("change", applySprintFilter);
  }

  refreshBtn.addEventListener("click", fetchBoard);

  viewStatusBtn.addEventListener("click", function () { switchView(VIEW_STATUS); });
  viewSwimlaneBtn.addEventListener("click", function () { switchView(VIEW_SWIMLANE); });

  window.addEventListener("resize", scheduleDepRedraw);

  // Fetch token status to determine read-only platforms
  fetch("/api/kanban/token-status", { headers: getAuthHeaders() })
    .then(function (res) { return res.ok ? res.json() : {}; })
    .then(function (status) {
      Object.keys(status).forEach(function (platform) {
        if (!status[platform]) {
          READONLY_PLATFORMS[platform] = true;
        }
      });
    })
    .catch(function () { /* non-critical */ })
    .then(function () {
      fetchBoard();
    });

  fetchAgents();
  openSSE();
  fetchWorktreeCount();
})();
