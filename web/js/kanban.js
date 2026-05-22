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

  // ─── DOM refs ──────────────────────────────────────────────────────────────

  var loadingEl = document.getElementById("kanban-loading");
  var emptyEl = document.getElementById("kanban-empty");
  var boardEl = document.getElementById("kanban-board");
  var errorBanner = document.getElementById("error-banner");
  var refreshBtn = document.getElementById("refresh-btn");
  var agentsRail = document.getElementById("agents-rail");
  var repoSelect = document.getElementById("repo-select");
  var sprintSelect = document.getElementById("sprint-select");

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

  // ─── Dependency arrow state ────────────────────────────────────────────────

  var depOverlay = document.getElementById("dep-overlay");
  var boardEdges = [];             // saved from API response
  var boardGhostNodes = [];        // saved from API response
  var depRafId = null;             // rAF handle for resize debounce
  var ghostAnchorMap = {};         // ghostKey → anchor element

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

  // ─── Dependency arrows ─────────────────────────────────────────────────────

  function ensureGhostAnchors(ghostNodes) {
    // Remove stale anchors
    Object.keys(ghostAnchorMap).forEach(function (key) {
      if (!ghostNodes.some(function (g) { return g.key === key; })) {
        if (ghostAnchorMap[key].parentNode) ghostAnchorMap[key].parentNode.removeChild(ghostAnchorMap[key]);
        delete ghostAnchorMap[key];
      }
    });

    ghostNodes.forEach(function (ghost) {
      if (ghostAnchorMap[ghost.key]) return;

      // Anchor to the repo chip in the header if platform:repo matches
      var repoChip = document.getElementById("repo-chip");
      var anchor = document.createElement("div");
      anchor.className = "dep-ghost-anchor";
      anchor.setAttribute("data-ghost-key", ghost.key);

      // Place anchor inside the board so SVG coords are relative
      boardEl.appendChild(anchor);

      // Position near the repo chip or fallback to top-left
      if (repoChip) {
        var chipRect = repoChip.getBoundingClientRect();
        var boardRect = boardEl.getBoundingClientRect();
        anchor.style.left = (chipRect.left - boardRect.left + chipRect.width / 2) + "px";
        anchor.style.top = (chipRect.top - boardRect.top + chipRect.height) + "px";
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
    if (!depOverlay) return;

    // Clear existing paths (keep <defs>)
    var existing = depOverlay.querySelectorAll(".dep-path");
    for (var i = 0; i < existing.length; i++) {
      existing[i].parentNode.removeChild(existing[i]);
    }

    if (boardEdges.length === 0) return;

    var boardRect = boardEl.getBoundingClientRect();

    boardEdges.forEach(function (edge) {
      var fromEl, toEl;

      if (edge.fromGhost) {
        fromEl = ghostAnchorMap[edge.fromKey];
      } else {
        fromEl = cardIndex.get(edge.fromKey) || safeFindByDataKey(boardEl, edge.fromKey);
      }

      toEl = cardIndex.get(edge.toKey) || safeFindByDataKey(boardEl, edge.toKey);

      // Skip if both endpoints are missing
      if (!fromEl && !toEl) return;
      // If only one endpoint is missing, skip (per acceptance: no arrows where both are missing —
      // but also skip if only one is missing since we can't draw a complete arrow)
      if (!fromEl || !toEl) return;

      var from = getCardCenter(fromEl, boardRect);
      var to = getCardCenter(toEl, boardRect);

      var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", buildEdgePath(from, to));
      path.setAttribute("marker-end", edge.fromGhost ? "url(#dep-arrowhead-ghost)" : "url(#dep-arrowhead)");
      path.classList.add("dep-path");
      if (edge.fromGhost) path.classList.add("dep-path--ghost");
      path.setAttribute("data-from", edge.fromKey);
      path.setAttribute("data-to", edge.toKey);

      // Set stroke-dasharray to actual path length for correct draw animation
      depOverlay.appendChild(path);
      if (typeof path.getTotalLength === "function") {
        var totalLen = path.getTotalLength();
        if (!edge.fromGhost) {
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
    fetch("/api/kanban/agents")
      .then(function (res) { return res.ok ? res.json() : []; })
      .then(function (agents) {
        agents.forEach(function (a) { addTile(a); });
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
      headers: { "Content-Type": "application/json" },
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
    if (typeof EventSource === "undefined") return;
    var source = new EventSource("/api/kanban/stream");

    source.addEventListener("agent.started", function (e) {
      try {
        var data = JSON.parse(e.data);
        if (data.agent) {
          addTile(data.agent);

          // Card live-status: pulse + optimistic move
          var agent = data.agent;
          var cardKey = agent.cardKey;
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

        // Card live-status: update tool chip
        var cardKey = agentRunToCardKey[data.agentRunId];
        if (cardKey) {
          var cardEl = cardIndex.get(cardKey);
          if (cardEl) {
            var toolEl = cardEl.querySelector(".kcard-tool");
            if (toolEl) toolEl.textContent = data.toolName;
          }
        }
      } catch (ex) { /* ignore */ }
    });

    source.addEventListener("agent.completed", function (e) {
      try {
        var data = JSON.parse(e.data);
        removeTile(data.agentRunId);

        // Card live-status: remove pulse, optimistic move to Done
        var cardKey = agentRunToCardKey[data.agentRunId];
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

    source.onerror = function () {
      source.close();
      setTimeout(openSSE, 5000);
    };
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

    var article = document.createElement("article");
    article.className = "kcard";
    article.setAttribute("data-key", card.key);
    article.setAttribute("id", "card-" + card.key);

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

    cardIndex.set(card.key, article);

    return article;
  }

  // ─── Board rendering ───────────────────────────────────────────────────────

  function renderBoard(data) {
    clearColumns();
    cardIndex.clear();

    var cards = data.cards || [];
    var columnCounts = { backlog: 0, in_flight: 0, blocked: 0, done: 0 };

    if (cards.length === 0) {
      boardEl.style.display = "none";
      emptyEl.style.display = "block";
      return;
    }

    emptyEl.style.display = "none";
    boardEl.style.display = "grid";

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
    drawDepArrows();
  }

  // ─── Repo / sprint filter helpers ─────────────────────────────────────────

  function populateRepoSelect(repos) {
    var current = repoSelect.value;
    repoSelect.innerHTML = '<option value="">— All Repos —</option>';
    (repos || []).forEach(function (r) {
      var val = r.platform + ":" + r.repo;
      var opt = document.createElement("option");
      opt.value = val;
      opt.textContent = r.repo + " (" + r.cardCount + ")";
      if (val === current) opt.selected = true;
      repoSelect.appendChild(opt);
    });
  }

  function populateSprintSelect(cards) {
    var repoVal = repoSelect.value;
    var currentSprint = sprintSelect.value;

    var subset = repoVal
      ? cards.filter(function (c) { return (c.platform + ":" + c.repo) === repoVal; })
      : cards;

    var seen = {};
    var sprints = [];
    subset.forEach(function (c) {
      if (c.sprint && !seen[c.sprint]) {
        seen[c.sprint] = true;
        sprints.push(c.sprint);
      }
    });

    // Natural sort so "sprint-2" < "sprint-10"
    sprints.sort(function (a, b) {
      var na = parseInt(a.replace(/\D+/g, ""), 10);
      var nb = parseInt(b.replace(/\D+/g, ""), 10);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return a.localeCompare(b);
    });

    sprintSelect.innerHTML = '<option value="">— All Sprints —</option>';
    sprints.forEach(function (s) {
      var opt = document.createElement("option");
      opt.value = s;
      opt.textContent = s;
      if (s === currentSprint) opt.selected = true;
      sprintSelect.appendChild(opt);
    });

    sprintSelect.disabled = sprints.length === 0;
  }

  function applyFilters() {
    var repoVal = repoSelect.value;
    var sprintVal = sprintSelect.value;

    var filtered = allCards.filter(function (c) {
      if (repoVal && (c.platform + ":" + c.repo) !== repoVal) return false;
      if (sprintVal && c.sprint !== sprintVal) return false;
      return true;
    });

    // Re-derive edges for visible cards only
    var visibleKeys = new Set(filtered.map(function (c) { return c.key; }));
    var filteredEdges = allEdges.filter(function (e) {
      return visibleKeys.has(e.fromKey) || visibleKeys.has(e.toKey);
    });

    populateSprintSelect(allCards);
    renderBoard({ cards: filtered, edges: filteredEdges, ghostNodes: allGhostNodes });
  }

  // ─── Data fetch ────────────────────────────────────────────────────────────

  function fetchBoard() {
    hideError();
    loadingEl.style.display = "block";
    boardEl.style.display = "none";
    emptyEl.style.display = "none";

    fetch("/api/kanban/board")
      .then(function (res) {
        if (!res.ok) {
          throw new Error("HTTP " + res.status + " " + res.statusText);
        }
        return res.json();
      })
      .then(function (data) {
        loadingEl.style.display = "none";
        allCards = data.cards || [];
        allEdges = data.edges || [];
        allGhostNodes = data.ghostNodes || [];
        populateRepoSelect(data.repos || []);
        populateSprintSelect(allCards);
        applyFilters();
      })
      .catch(function (err) {
        loadingEl.style.display = "none";
        emptyEl.style.display = "none";
        showError("Failed to load board: " + err.message);
      });
  }

  // ─── Init ──────────────────────────────────────────────────────────────────

  repoSelect.addEventListener("change", function () {
    // Reset sprint when repo changes so stale sprint from prior repo isn't carried over
    sprintSelect.value = "";
    applyFilters();
  });

  sprintSelect.addEventListener("change", applyFilters);

  refreshBtn.addEventListener("click", fetchBoard);

  window.addEventListener("resize", scheduleDepRedraw);

  fetchBoard();
  fetchAgents();
  openSSE();
})();
