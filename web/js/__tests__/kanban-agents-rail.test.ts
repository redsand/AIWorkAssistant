// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

function setupDOM() {
  document.body.innerHTML = `
    <div id="kanban-loading" style="display:none"></div>
    <div id="kanban-empty" style="display:none"></div>
    <div id="kanban-board" style="none"></div>
    <div id="error-banner" style="display:none"></div>
    <button id="refresh-btn"></button>
    <section id="agents-rail" class="k-agents-rail"></section>
    <div id="col-backlog"></div>
    <div id="col-in_flight"></div>
    <div id="col-blocked"></div>
    <div id="col-done"></div>
    <span id="count-backlog">0</span>
    <span id="count-in_flight">0</span>
    <span id="count-blocked">0</span>
    <span id="count-done">0</span>
  `;
}

function loadScript() {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../kanban.js'),
    'utf-8',
  );
  const fn = new Function(src);
  fn();
}

function createMockEventSource(handlers?: { onStarted?: (h: (e: any) => void) => void; onStep?: (h: (e: any) => void) => void; onCompleted?: (h: (e: any) => void) => void }) {
  const ctor = vi.fn(function (this: any) {
    this.addEventListener = vi.fn(function (this: any, event: string, handler: (e: any) => void) {
      if (event === 'agent.started' && handlers?.onStarted) handlers.onStarted(handler);
      if (event === 'agent.step' && handlers?.onStep) handlers.onStep(handler);
      if (event === 'agent.completed' && handlers?.onCompleted) handlers.onCompleted(handler);
    }.bind({}));
    this.close = vi.fn();
    this.onerror = null;
  });
  return ctor;
}

const boardResponse = (cards: any[] = []) => ({
  cards,
  edges: [],
  ghostNodes: [],
  agents: [],
  repos: [],
  generatedAt: new Date().toISOString(),
});

describe('Agents Rail — kanban.js', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setupDOM();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('EventSource', createMockEventSource());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe('tile rendering', () => {
    it('should render agent tiles from fetch response', async () => {
      const now = new Date().toISOString();
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(boardResponse([{
            key: 'github:owner/repo:42', platform: 'github', repo: 'owner/repo',
            id: '42', externalId: '#42', title: 'Fix bug', url: '',
            status: 'in_progress', column: 'in_flight', priority: 'high',
            assignee: null, labels: [], createdAt: now, updatedAt: now,
            dependencyKeys: [], activeAgentRunId: null,
          }])),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve([{
            agentRunId: 'run-1', agent: 'claude', model: 'opus', status: 'running',
            cardKey: 'github:owner/repo:42', startedAt: now, lastActivityAt: now,
            toolLoopCount: 3, lastTool: 'Edit',
          }]),
        });

      loadScript();

      await vi.waitFor(() => {
        expect(document.querySelectorAll('.krun').length).toBe(1);
      });

      const tile = document.querySelector('.krun') as HTMLElement;
      expect(tile.getAttribute('data-run-id')).toBe('run-1');
      expect(tile.getAttribute('data-card-key')).toBe('github:owner/repo:42');

      const cardLink = tile.querySelector('.krun-card') as HTMLElement;
      expect(cardLink.textContent).toBe('Fix bug');

      const head = tile.querySelector('.krun-head') as HTMLElement;
      expect(head.textContent).toContain('claude');
      expect(head.textContent).toContain('opus');

      const toolEl = tile.querySelector('.krun-tool') as HTMLElement;
      expect(toolEl.textContent).toBe('Edit · 3');
    });

    it('should show cardKey as fallback when not in cardTitleMap', async () => {
      const now = new Date().toISOString();
      fetchMock
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(boardResponse()) })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve([{
            agentRunId: 'run-x', agent: 'claude', model: null, status: 'running',
            cardKey: 'github:foo/bar:99', startedAt: now, lastActivityAt: now,
            toolLoopCount: 0, lastTool: null,
          }]),
        });

      loadScript();

      await vi.waitFor(() => {
        expect(document.querySelectorAll('.krun').length).toBe(1);
      });

      const cardLink = document.querySelector('.krun-card') as HTMLElement;
      expect(cardLink.textContent).toBe('github:foo/bar:99');
    });

    it('should deduplicate tiles by agentRunId', async () => {
      const now = new Date().toISOString();
      fetchMock
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(boardResponse()) })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve([
            {
              agentRunId: 'run-dup', agent: 'claude', model: null, status: 'running',
              cardKey: null, startedAt: now, lastActivityAt: now, toolLoopCount: 0, lastTool: null,
            },
            {
              agentRunId: 'run-dup', agent: 'claude', model: null, status: 'running',
              cardKey: null, startedAt: now, lastActivityAt: now, toolLoopCount: 0, lastTool: null,
            },
          ]),
        });

      loadScript();

      await vi.waitFor(() => {
        expect(document.querySelectorAll('.krun').length).toBe(1);
      });
    });

    it('should render stop button on each tile', async () => {
      const now = new Date().toISOString();
      fetchMock
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(boardResponse()) })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve([{
            agentRunId: 'run-stop', agent: 'claude', model: null, status: 'running',
            cardKey: 'github:owner/repo:1', startedAt: now, lastActivityAt: now,
            toolLoopCount: 0, lastTool: null,
          }]),
        });

      loadScript();

      await vi.waitFor(() => {
        expect(document.querySelectorAll('.krun').length).toBe(1);
      });

      const stopBtn = document.querySelector('.krun-stop') as HTMLButtonElement;
      expect(stopBtn).toBeTruthy();
      expect(stopBtn.textContent).toBe('Stop');
    });
  });

  describe('elapsed timer', () => {
    it('should display elapsed time from startedAt', async () => {
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      fetchMock
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(boardResponse()) })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve([{
            agentRunId: 'run-timer', agent: 'claude', model: null, status: 'running',
            cardKey: null, startedAt: fiveMinutesAgo, lastActivityAt: fiveMinutesAgo,
            toolLoopCount: 0, lastTool: null,
          }]),
        });

      loadScript();

      await vi.waitFor(() => {
        expect(document.querySelectorAll('.krun').length).toBe(1);
      });

      const elapsedEl = document.querySelector('.krun-elapsed') as HTMLElement;
      expect(elapsedEl.textContent).toMatch(/\d+m \d{2}s/);
    });
  });

  describe('stop button click', () => {
    it('should POST to stop endpoint when clicked', async () => {
      const now = new Date().toISOString();
      fetchMock
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(boardResponse()) })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve([{
            agentRunId: 'run-stop-click', agent: 'claude', model: null, status: 'running',
            cardKey: 'github:owner/repo:42', startedAt: now, lastActivityAt: now,
            toolLoopCount: 0, lastTool: null,
          }]),
        })
        .mockResolvedValueOnce({ ok: true });

      loadScript();

      await vi.waitFor(() => {
        expect(document.querySelectorAll('.krun').length).toBe(1);
      });

      const stopBtn = document.querySelector('.krun-stop') as HTMLButtonElement;
      stopBtn.click();

      await vi.waitFor(() => {
        const stopCalls = fetchMock.mock.calls.filter(
          (call: any[]) => call[1]?.method === 'POST' && call[0].includes('/stop'),
        );
        expect(stopCalls.length).toBe(1);
      });

      const stopCall = fetchMock.mock.calls.find(
        (call: any[]) => call[1]?.method === 'POST' && call[0].includes('/stop'),
      );
      expect(stopCall![0]).toBe('/api/kanban/cards/github/42/stop');
      expect(JSON.parse(stopCall![1].body)).toEqual({ repo: 'owner/repo' });
    });

    it('should not POST when cardKey is null', async () => {
      const now = new Date().toISOString();
      fetchMock
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(boardResponse()) })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve([{
            agentRunId: 'run-nokey', agent: 'claude', model: null, status: 'running',
            cardKey: null, startedAt: now, lastActivityAt: now, toolLoopCount: 0, lastTool: null,
          }]),
        });

      loadScript();

      await vi.waitFor(() => {
        expect(document.querySelectorAll('.krun').length).toBe(1);
      });

      const stopBtn = document.querySelector('.krun-stop') as HTMLButtonElement;
      stopBtn.click();

      const stopCalls = fetchMock.mock.calls.filter(
        (call: any[]) => call[1]?.method === 'POST',
      );
      expect(stopCalls.length).toBe(0);
    });
  });

  describe('SSE event handling', () => {
    it('should open EventSource to /api/kanban/stream', () => {
      const MockES = createMockEventSource();
      vi.stubGlobal('EventSource', MockES);

      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(boardResponse()),
      });

      loadScript();
      expect(MockES).toHaveBeenCalledWith('/api/kanban/stream');
    });

    it('should add tile on agent.started SSE event', async () => {
      const now = new Date().toISOString();
      let startedHandler: ((e: any) => void) | null = null;

      const MockES = createMockEventSource({
        onStarted: (h) => { startedHandler = h; },
      });
      vi.stubGlobal('EventSource', MockES);

      fetchMock
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(boardResponse()) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) });

      loadScript();

      await vi.waitFor(() => {
        expect(fetchMock).toHaveBeenCalled();
      });

      expect(startedHandler).toBeTruthy();
      startedHandler!({
        data: JSON.stringify({
          agent: {
            agentRunId: 'run-sse', agent: 'codex', model: 'gpt-4', status: 'running',
            cardKey: 'github:owner/repo:5', startedAt: now, lastActivityAt: now,
            toolLoopCount: 0, lastTool: null,
          },
        }),
      });

      const tiles = document.querySelectorAll('.krun');
      expect(tiles.length).toBe(1);
      const tile = tiles[0] as HTMLElement;
      expect(tile.getAttribute('data-run-id')).toBe('run-sse');
      expect(tile.querySelector('.krun-head')!.textContent).toContain('codex');
    });

    it('should update tile on agent.step SSE event', async () => {
      const now = new Date().toISOString();
      let stepHandler: ((e: any) => void) | null = null;

      const MockES = createMockEventSource({
        onStep: (h) => { stepHandler = h; },
      });
      vi.stubGlobal('EventSource', MockES);

      fetchMock
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(boardResponse()) })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve([{
            agentRunId: 'run-step', agent: 'claude', model: null, status: 'running',
            cardKey: null, startedAt: now, lastActivityAt: now, toolLoopCount: 0, lastTool: null,
          }]),
        });

      loadScript();

      await vi.waitFor(() => {
        expect(document.querySelectorAll('.krun').length).toBe(1);
      });

      expect(stepHandler).toBeTruthy();
      stepHandler!({
        data: JSON.stringify({ agentRunId: 'run-step', toolName: 'Read', stepOrder: 5 }),
      });

      const toolEl = document.querySelector('.krun-tool') as HTMLElement;
      expect(toolEl.textContent).toBe('Read · 5');
    });

    it('should remove tile on agent.completed SSE event', async () => {
      const now = new Date().toISOString();
      let completedHandler: ((e: any) => void) | null = null;

      const MockES = createMockEventSource({
        onCompleted: (h) => { completedHandler = h; },
      });
      vi.stubGlobal('EventSource', MockES);

      fetchMock
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(boardResponse()) })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve([{
            agentRunId: 'run-comp', agent: 'claude', model: null, status: 'running',
            cardKey: null, startedAt: now, lastActivityAt: now, toolLoopCount: 0, lastTool: null,
          }]),
        });

      loadScript();

      await vi.waitFor(() => {
        expect(document.querySelectorAll('.krun').length).toBe(1);
      });

      expect(completedHandler).toBeTruthy();
      completedHandler!({
        data: JSON.stringify({ agentRunId: 'run-comp', status: 'completed' }),
      });

      const tile = document.querySelector('.krun') as HTMLElement;
      expect(tile.classList.contains('krun--fading')).toBe(true);
    });
  });

  describe('fetch ordering', () => {
    it('should fetch agents after board completes', async () => {
      const callOrder: string[] = [];
      fetchMock.mockImplementation((url: string) => {
        callOrder.push(url);
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(
            url.includes('/board')
              ? boardResponse()
              : [],
          ),
        });
      });

      loadScript();

      await vi.waitFor(() => {
        expect(callOrder.length).toBeGreaterThanOrEqual(2);
      });

      expect(callOrder[0]).toBe('/api/kanban/board');
      expect(callOrder[1]).toBe('/api/kanban/agents');
    });
  });
});
