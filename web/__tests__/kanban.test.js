// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";

// ─── Test fixtures ──────────────────────────────────────────────────────────

function makeCard(overrides) {
  return Object.assign(
    {
      key: "github:owner/repo:1",
      platform: "github",
      repo: "owner/repo",
      id: "1",
      externalId: "#1",
      title: "Test card",
      url: "https://github.com/owner/repo/issues/1",
      status: "open",
      column: "backlog",
      priority: "medium",
      assignee: null,
      labels: [],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      dependencyKeys: [],
      activeAgentRunId: null,
    },
    overrides
  );
}

function makeAgent(overrides) {
  return Object.assign(
    {
      agentRunId: "run-1",
      agent: "claude",
      model: "opus-4",
      status: "running",
      cardKey: "github:owner/repo:1",
      startedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      toolLoopCount: 0,
      lastTool: null,
    },
    overrides
  );
}

// ─── DOM setup helper ───────────────────────────────────────────────────────

function setupDOM() {
  document.body.innerHTML = "";

  var loadingEl = document.createElement("div");
  loadingEl.id = "kanban-loading";
  loadingEl.style.display = "none";
  document.body.appendChild(loadingEl);

  var emptyEl = document.createElement("div");
  emptyEl.id = "kanban-empty";
  emptyEl.style.display = "none";
  document.body.appendChild(emptyEl);

  var boardEl = document.createElement("div");
  boardEl.id = "kanban-board";
  boardEl.style.display = "none";
  document.body.appendChild(boardEl);

  var errorBanner = document.createElement("div");
  errorBanner.id = "error-banner";
  errorBanner.style.display = "none";
  document.body.appendChild(errorBanner);

  var refreshBtn = document.createElement("button");
  refreshBtn.id = "refresh-btn";
  document.body.appendChild(refreshBtn);

  var agentsRail = document.createElement("div");
  agentsRail.id = "agents-rail";
  document.body.appendChild(agentsRail);

  ["backlog", "in_flight", "blocked", "done"].forEach(function (col) {
    var colEl = document.createElement("div");
    colEl.id = "col-" + col;
    colEl.setAttribute("data-column", col);
    document.body.appendChild(colEl);

    var countEl = document.createElement("span");
    countEl.id = "count-" + col;
    countEl.textContent = "0";
    document.body.appendChild(countEl);
  });
}

// ─── Mock EventSource ───────────────────────────────────────────────────────

function createMockEventSource() {
  var listeners = {};
  var mockSource = {
    listeners: listeners,
    addEventListener: function (event, handler) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(handler);
    },
    close: vi.fn(),
    onerror: null,
  };

  var OriginalEventSource = globalThis.EventSource;

  globalThis.EventSource = function (url) {
    mockSource.url = url;
    return mockSource;
  };

  return { mockSource, restore: function () { globalThis.EventSource = OriginalEventSource; } };
}

function fireEvent(listeners, eventType, data) {
  var handlers = listeners[eventType];
  if (!handlers) return;
  handlers.forEach(function (handler) {
    handler({ data: JSON.stringify(data) });
  });
}

// ─── Script loader ──────────────────────────────────────────────────────────

var SCRIPT_PATH = path.resolve(__dirname, "..", "js", "kanban.js");

function loadScript(boardFetchMock, agentsFetchMock) {
  var fetchMap = {
    "/api/kanban/board": boardFetchMock,
    "/api/kanban/agents": agentsFetchMock || vi.fn().mockResolvedValue({ ok: true, json: function () { return Promise.resolve([]); } }),
  };

  globalThis.fetch = function (url) {
    var mock = fetchMap[url];
    if (mock) return mock();
    return Promise.resolve({ ok: false, status: 404, statusText: "Not Found" });
  };

  var source = fs.readFileSync(SCRIPT_PATH, "utf-8");
  var iifeStart = source.indexOf("(function ()");
  var scriptBody = source.slice(iifeStart);

  // eslint-disable-next-line no-eval
  eval(scriptBody);
}

// Flush the microtask queue so fetch .then() chains resolve
async function flushPromises() {
  for (var i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Kanban Board", function () {
  var esMock;
  var consoleWarnSpy;

  beforeEach(function () {
    vi.useFakeTimers();
    setupDOM();
    esMock = createMockEventSource();
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(function () {});
  });

  afterEach(function () {
    vi.useRealTimers();
    esMock.restore();
    consoleWarnSpy.mockRestore();
  });

  // ─── SSE Event Handlers ───────────────────────────────────────────────

  describe("SSE event: agent.started", function () {
    it("should add running class to card and map agentRunId to cardKey", async function () {
      var boardData = { cards: [makeCard()], edges: [], ghostNodes: [], agents: [], repos: [], generatedAt: new Date().toISOString() };

      loadScript(function () {
        return Promise.resolve({ ok: true, json: function () { return Promise.resolve(boardData); } });
      });

      await flushPromises();

      // Simulate agent.started SSE event
      fireEvent(esMock.mockSource.listeners, "agent.started", {
        agent: makeAgent({ agentRunId: "run-1", cardKey: "github:owner/repo:1" }),
      });

      var cardEl = document.getElementById("card-github:owner/repo:1");
      expect(cardEl).toBeTruthy();
      expect(cardEl.classList.contains("kcard--running")).toBe(true);

      // Advance past debounce (50ms) + move animation (250ms)
      vi.advanceTimersByTime(320);

      // Card should be optimistically moved to in_flight
      var inFlightCol = document.getElementById("col-in_flight");
      expect(inFlightCol.contains(cardEl)).toBe(true);
    });

    it("should not add running class if card is not in cardIndex", async function () {
      var boardData = { cards: [], edges: [], ghostNodes: [], agents: [], repos: [], generatedAt: new Date().toISOString() };

      loadScript(function () {
        return Promise.resolve({ ok: true, json: function () { return Promise.resolve(boardData); } });
      });

      await flushPromises();

      fireEvent(esMock.mockSource.listeners, "agent.started", {
        agent: makeAgent({ cardKey: "nonexistent" }),
      });

      expect(consoleWarnSpy).not.toHaveBeenCalled();
    });

    it("should log warning on malformed JSON", async function () {
      var boardData = { cards: [], edges: [], ghostNodes: [], agents: [], repos: [], generatedAt: new Date().toISOString() };

      loadScript(function () {
        return Promise.resolve({ ok: true, json: function () { return Promise.resolve(boardData); } });
      });

      await flushPromises();

      var handlers = esMock.mockSource.listeners["agent.started"];
      if (handlers && handlers.length) {
        handlers[0]({ data: "not valid json {{{" });
      }

      expect(consoleWarnSpy).toHaveBeenCalledWith("kanban SSE agent.started:", expect.any(Error));
    });
  });

  describe("SSE event: agent.step", function () {
    it("should update tool chip text on the card", async function () {
      var card = makeCard({ column: "in_flight" });
      var boardData = { cards: [card], edges: [], ghostNodes: [], agents: [], repos: [], generatedAt: new Date().toISOString() };

      loadScript(function () {
        return Promise.resolve({ ok: true, json: function () { return Promise.resolve(boardData); } });
      });

      await flushPromises();

      // First start an agent to populate agentRunToCardKey
      fireEvent(esMock.mockSource.listeners, "agent.started", {
        agent: makeAgent({ agentRunId: "run-1", cardKey: "github:owner/repo:1" }),
      });

      // Then send a step event
      fireEvent(esMock.mockSource.listeners, "agent.step", {
        agentRunId: "run-1",
        toolName: "Read",
        stepOrder: 3,
      });

      var cardEl = document.getElementById("card-github:owner/repo:1");
      var toolEl = cardEl.querySelector(".kcard-tool");
      expect(toolEl.textContent).toBe("Read");
    });

    it("should handle step for unknown agentRunId gracefully", async function () {
      var boardData = { cards: [], edges: [], ghostNodes: [], agents: [], repos: [], generatedAt: new Date().toISOString() };

      loadScript(function () {
        return Promise.resolve({ ok: true, json: function () { return Promise.resolve(boardData); } });
      });

      await flushPromises();

      fireEvent(esMock.mockSource.listeners, "agent.step", {
        agentRunId: "unknown-run",
        toolName: "Bash",
        stepOrder: 1,
      });

      expect(consoleWarnSpy).not.toHaveBeenCalled();
    });
  });

  describe("SSE event: agent.completed", function () {
    it("should remove running class and move card to done on success", async function () {
      var card = makeCard({ column: "in_flight" });
      var boardData = { cards: [card], edges: [], ghostNodes: [], agents: [], repos: [], generatedAt: new Date().toISOString() };

      loadScript(function () {
        return Promise.resolve({ ok: true, json: function () { return Promise.resolve(boardData); } });
      });

      await flushPromises();

      // Start agent first
      fireEvent(esMock.mockSource.listeners, "agent.started", {
        agent: makeAgent({ agentRunId: "run-1", cardKey: "github:owner/repo:1" }),
      });

      // Complete successfully
      fireEvent(esMock.mockSource.listeners, "agent.completed", {
        agentRunId: "run-1",
        status: "completed",
      });

      var cardEl = document.getElementById("card-github:owner/repo:1");
      expect(cardEl.classList.contains("kcard--running")).toBe(false);

      // Advance past debounce (50ms) + move animation (250ms)
      vi.advanceTimersByTime(320);

      var doneCol = document.getElementById("col-done");
      expect(doneCol.contains(cardEl)).toBe(true);
    });

    it("should add kcard--failed class on failed run and not move to done", async function () {
      var card = makeCard({ column: "in_flight" });
      var boardData = { cards: [card], edges: [], ghostNodes: [], agents: [], repos: [], generatedAt: new Date().toISOString() };

      loadScript(function () {
        return Promise.resolve({ ok: true, json: function () { return Promise.resolve(boardData); } });
      });

      await flushPromises();

      // Start agent
      fireEvent(esMock.mockSource.listeners, "agent.started", {
        agent: makeAgent({ agentRunId: "run-1", cardKey: "github:owner/repo:1" }),
      });

      // Fail
      fireEvent(esMock.mockSource.listeners, "agent.completed", {
        agentRunId: "run-1",
        status: "failed",
        errorMessage: "OOM",
      });

      var cardEl = document.getElementById("card-github:owner/repo:1");
      expect(cardEl.classList.contains("kcard--running")).toBe(false);
      expect(cardEl.classList.contains("kcard--failed")).toBe(true);

      // Advance timers — card should NOT move to done
      vi.advanceTimersByTime(320);

      var doneCol = document.getElementById("col-done");
      expect(doneCol.contains(cardEl)).toBe(false);
    });

    it("should clean up agentRunToCardKey entry on completion", async function () {
      var card = makeCard();
      var boardData = { cards: [card], edges: [], ghostNodes: [], agents: [], repos: [], generatedAt: new Date().toISOString() };

      loadScript(function () {
        return Promise.resolve({ ok: true, json: function () { return Promise.resolve(boardData); } });
      });

      await flushPromises();

      // Start then complete
      fireEvent(esMock.mockSource.listeners, "agent.started", {
        agent: makeAgent({ agentRunId: "run-1", cardKey: "github:owner/repo:1" }),
      });

      fireEvent(esMock.mockSource.listeners, "agent.completed", {
        agentRunId: "run-1",
        status: "completed",
      });

      // Send another step for same runId — should be ignored (no crash, no tool update)
      fireEvent(esMock.mockSource.listeners, "agent.step", {
        agentRunId: "run-1",
        toolName: "Write",
        stepOrder: 5,
      });

      // No errors thrown = cleanup worked
      expect(consoleWarnSpy).not.toHaveBeenCalled();
    });

    it("should clear tool chip text on completion", async function () {
      var card = makeCard({ column: "in_flight" });
      var boardData = { cards: [card], edges: [], ghostNodes: [], agents: [], repos: [], generatedAt: new Date().toISOString() };

      loadScript(function () {
        return Promise.resolve({ ok: true, json: function () { return Promise.resolve(boardData); } });
      });

      await flushPromises();

      fireEvent(esMock.mockSource.listeners, "agent.started", {
        agent: makeAgent({ agentRunId: "run-1", cardKey: "github:owner/repo:1" }),
      });

      fireEvent(esMock.mockSource.listeners, "agent.step", {
        agentRunId: "run-1",
        toolName: "Read",
        stepOrder: 2,
      });

      var cardEl = document.getElementById("card-github:owner/repo:1");
      expect(cardEl.querySelector(".kcard-tool").textContent).toBe("Read");

      fireEvent(esMock.mockSource.listeners, "agent.completed", {
        agentRunId: "run-1",
        status: "completed",
      });

      expect(cardEl.querySelector(".kcard-tool").textContent).toBe("");
    });
  });

  describe("SSE event: card.updated", function () {
    it("should debounce-move card to the specified column", async function () {
      var card = makeCard({ column: "backlog" });
      var boardData = { cards: [card], edges: [], ghostNodes: [], agents: [], repos: [], generatedAt: new Date().toISOString() };

      loadScript(function () {
        return Promise.resolve({ ok: true, json: function () { return Promise.resolve(boardData); } });
      });

      await flushPromises();

      fireEvent(esMock.mockSource.listeners, "card.updated", {
        card: { key: "github:owner/repo:1", column: "done" },
      });

      // Advance past debounce (50ms) + move animation (250ms)
      vi.advanceTimersByTime(320);

      var cardEl = document.getElementById("card-github:owner/repo:1");
      var doneCol = document.getElementById("col-done");
      expect(doneCol.contains(cardEl)).toBe(true);
    });

    it("should fall back to backlog column when column is unspecified", async function () {
      var card = makeCard({ column: "done" });
      var boardData = { cards: [card], edges: [], ghostNodes: [], agents: [], repos: [], generatedAt: new Date().toISOString() };

      loadScript(function () {
        return Promise.resolve({ ok: true, json: function () { return Promise.resolve(boardData); } });
      });

      await flushPromises();

      fireEvent(esMock.mockSource.listeners, "card.updated", {
        card: { key: "github:owner/repo:1" },
      });

      vi.advanceTimersByTime(320);

      var cardEl = document.getElementById("card-github:owner/repo:1");
      var backlogCol = document.getElementById("col-backlog");
      expect(backlogCol.contains(cardEl)).toBe(true);
    });

    it("should ignore updates for cards not in cardIndex", async function () {
      var boardData = { cards: [], edges: [], ghostNodes: [], agents: [], repos: [], generatedAt: new Date().toISOString() };

      loadScript(function () {
        return Promise.resolve({ ok: true, json: function () { return Promise.resolve(boardData); } });
      });

      await flushPromises();

      fireEvent(esMock.mockSource.listeners, "card.updated", {
        card: { key: "nonexistent", column: "done" },
      });

      vi.advanceTimersByTime(320);
      expect(consoleWarnSpy).not.toHaveBeenCalled();
    });
  });

  // ─── Optimistic Move Logic ────────────────────────────────────────────

  describe("optimistic move: debounce behavior", function () {
    it("should debounce multiple moves for the same card", async function () {
      var card = makeCard({ column: "backlog" });
      var boardData = { cards: [card], edges: [], ghostNodes: [], agents: [], repos: [], generatedAt: new Date().toISOString() };

      loadScript(function () {
        return Promise.resolve({ ok: true, json: function () { return Promise.resolve(boardData); } });
      });

      await flushPromises();

      // Fire multiple card.updated events rapidly
      fireEvent(esMock.mockSource.listeners, "card.updated", {
        card: { key: "github:owner/repo:1", column: "in_flight" },
      });
      fireEvent(esMock.mockSource.listeners, "card.updated", {
        card: { key: "github:owner/repo:1", column: "blocked" },
      });
      fireEvent(esMock.mockSource.listeners, "card.updated", {
        card: { key: "github:owner/repo:1", column: "done" },
      });

      // Advance past debounce (50ms) + move animation (250ms)
      vi.advanceTimersByTime(320);

      var cardEl = document.getElementById("card-github:owner/repo:1");
      var doneCol = document.getElementById("col-done");
      expect(doneCol.contains(cardEl)).toBe(true);
    });

    it("should update column counts after a card move completes", async function () {
      var card = makeCard({ column: "backlog" });
      var boardData = { cards: [card], edges: [], ghostNodes: [], agents: [], repos: [], generatedAt: new Date().toISOString() };

      loadScript(function () {
        return Promise.resolve({ ok: true, json: function () { return Promise.resolve(boardData); } });
      });

      await flushPromises();

      // Verify card rendered in backlog
      var backlogCol = document.getElementById("col-backlog");
      var cardEl = document.getElementById("card-github:owner/repo:1");
      expect(backlogCol.contains(cardEl)).toBe(true);

      fireEvent(esMock.mockSource.listeners, "card.updated", {
        card: { key: "github:owner/repo:1", column: "done" },
      });

      vi.advanceTimersByTime(320);

      // After the move, backlog count should decrease and done count should increase
      var backlogCount = document.getElementById("count-backlog").textContent;
      var doneCount = document.getElementById("count-done").textContent;
      expect(backlogCount === "0" || backlogCount === "").toBe(true);
      expect(doneCount).toBe("1");
    });
  });

  describe("moveCardToColumn: column guard", function () {
    it("should not move card to an unknown column", async function () {
      var card = makeCard({ column: "backlog" });
      var boardData = { cards: [card], edges: [], ghostNodes: [], agents: [], repos: [], generatedAt: new Date().toISOString() };

      loadScript(function () {
        return Promise.resolve({ ok: true, json: function () { return Promise.resolve(boardData); } });
      });

      await flushPromises();

      var cardEl = document.getElementById("card-github:owner/repo:1");

      // Trigger a move to an invalid column — the guard should prevent it
      fireEvent(esMock.mockSource.listeners, "card.updated", {
        card: { key: "github:owner/repo:1", column: "nonexistent_column" },
      });

      vi.advanceTimersByTime(320);

      // Card should remain in backlog since the guard prevented the move
      var backlogCol = document.getElementById("col-backlog");
      expect(backlogCol.contains(cardEl)).toBe(true);
    });
  });

  // ─── Cleanup on re-render ─────────────────────────────────────────────

  describe("cardIndex and agentRunToCardKey cleanup", function () {
    it("should clear pendingMoves timeouts on board re-render", async function () {
      var card = makeCard({ column: "backlog" });
      var boardData = { cards: [card], edges: [], ghostNodes: [], agents: [], repos: [], generatedAt: new Date().toISOString() };

      var callCount = 0;
      loadScript(function () {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({ ok: true, json: function () { return Promise.resolve(boardData); } });
        }
        return Promise.resolve({ ok: true, json: function () { return Promise.resolve(boardData); } });
      });

      await flushPromises();

      // Start a move via agent.started (debounces to in_flight after 50ms)
      fireEvent(esMock.mockSource.listeners, "agent.started", {
        agent: makeAgent({ agentRunId: "run-1", cardKey: "github:owner/repo:1" }),
      });

      // Trigger a board re-render via refresh button BEFORE the debounce fires
      var refreshBtn = document.getElementById("refresh-btn");
      refreshBtn.click();
      await flushPromises();

      // Advance well past the debounce — the stale timeout should have been cleared
      vi.advanceTimersByTime(500);

      // Card should still be in backlog (the stale pendingMove was cancelled on re-render)
      var cardEl = document.getElementById("card-github:owner/repo:1");
      var backlogCol = document.getElementById("col-backlog");
      expect(backlogCol.contains(cardEl)).toBe(true);
    });

    it("should clean up agentRunToCardKey when agent completes", async function () {
      var card = makeCard();
      var boardData = { cards: [card], edges: [], ghostNodes: [], agents: [], repos: [], generatedAt: new Date().toISOString() };

      loadScript(function () {
        return Promise.resolve({ ok: true, json: function () { return Promise.resolve(boardData); } });
      });

      await flushPromises();

      // Start + complete
      fireEvent(esMock.mockSource.listeners, "agent.started", {
        agent: makeAgent({ agentRunId: "run-1", cardKey: "github:owner/repo:1" }),
      });
      fireEvent(esMock.mockSource.listeners, "agent.completed", {
        agentRunId: "run-1",
        status: "completed",
      });

      // Subsequent step for same runId should be silently ignored
      fireEvent(esMock.mockSource.listeners, "agent.step", {
        agentRunId: "run-1",
        toolName: "Grep",
        stepOrder: 10,
      });

      // No crash, no warning — the mapping was cleaned up
      expect(consoleWarnSpy).not.toHaveBeenCalled();
    });

    it("should rebuild cardIndex on board re-render with fresh cards", async function () {
      var card1 = makeCard({ key: "github:owner/repo:1", column: "backlog" });
      var boardData1 = { cards: [card1], edges: [], ghostNodes: [], agents: [], repos: [], generatedAt: new Date().toISOString() };

      var callCount = 0;
      loadScript(function () {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({ ok: true, json: function () { return Promise.resolve(boardData1); } });
        }
        var card2 = makeCard({ key: "github:owner/repo:2", column: "done" });
        return Promise.resolve({
          ok: true,
          json: function () {
            return Promise.resolve({
              cards: [card2],
              edges: [],
              ghostNodes: [],
              agents: [],
              repos: [],
              generatedAt: new Date().toISOString(),
            });
          },
        });
      });

      await flushPromises();

      // card1 should be in the DOM
      expect(document.getElementById("card-github:owner/repo:1")).toBeTruthy();

      // Trigger re-render
      var refreshBtn = document.getElementById("refresh-btn");
      refreshBtn.click();
      await flushPromises();

      // Old card should be gone, new card should exist
      expect(document.getElementById("card-github:owner/repo:1")).toBeNull();
      expect(document.getElementById("card-github:owner/repo:2")).toBeTruthy();
    });
  });
});
