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
    var card = document.querySelector('[data-key="' + cardKey + '"]');
    if (card) {
      card.scrollIntoView({ behavior: "smooth", block: "center" });
      card.classList.add("kcard--highlight");
      setTimeout(function () { card.classList.remove("kcard--highlight"); }, 2000);
    }
  }

  function openSSE() {
    if (typeof EventSource === "undefined") return;
    var source = new EventSource("/api/kanban/stream");

    source.addEventListener("agent.started", function (e) {
      try {
        var data = JSON.parse(e.data);
        if (data.agent) addTile(data.agent);
      } catch (ex) { /* ignore */ }
    });

    source.addEventListener("agent.step", function (e) {
      try {
        var data = JSON.parse(e.data);
        updateTile(data.agentRunId, data.toolName, data.stepOrder);
      } catch (ex) { /* ignore */ }
    });

    source.addEventListener("agent.completed", function (e) {
      try {
        var data = JSON.parse(e.data);
        removeTile(data.agentRunId);
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
        '<span class="kcard-deps" title="' + escapeHtml(depTitle) + '">' +
          (depCount > 0 ? depCount + ' deps' : 'no deps') +
        '</span>' +
      '</footer>';

    return article;
  }

  // ─── Board rendering ───────────────────────────────────────────────────────

  function renderBoard(data) {
    clearColumns();

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
  }

  // ─── Data fetch ────────────────────────────────────────────────────────────

  function fetchBoard() {
    hideError();
    loadingEl.style.display = "block";
    boardEl.style.display = "none";
    emptyEl.style.display = "none";

    return fetch("/api/kanban/board")
      .then(function (res) {
        if (!res.ok) {
          throw new Error("HTTP " + res.status + " " + res.statusText);
        }
        return res.json();
      })
      .then(function (data) {
        loadingEl.style.display = "none";
        renderBoard(data);
      })
      .catch(function (err) {
        loadingEl.style.display = "none";
        emptyEl.style.display = "none";
        showError("Failed to load board: " + err.message);
      });
  }

  // ─── Init ──────────────────────────────────────────────────────────────────

  refreshBtn.addEventListener("click", function () {
    fetchBoard().then(function () { fetchAgents(); });
  });

  fetchBoard().then(function () { fetchAgents(); });
  openSSE();
})();
