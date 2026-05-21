import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { EventEmitter } from 'events';
import { kanbanEvents } from '../../kanban/events';
import type { KanbanSSEEvent } from '../../kanban/types';

// Hoist mock functions so they're available in vi.mock factories
const {
  mockStartRun,
  mockFailRun,
  mockCompleteRun,
  mockListRuns,
  mockCreateWorktree,
  mockRunAgent,
  mockGetIssue,
} = vi.hoisted(() => {
  const mockStartRun = vi.fn().mockReturnValue({
    id: 'test-run-id',
    sessionId: null,
    userId: 'kanban',
    mode: 'interactive',
    model: null,
    status: 'running',
    errorMessage: null,
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    toolLoopCount: 0,
    startedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    completedAt: null,
    cancelledAt: null,
    issueId: '135',
    issuePlatform: 'github',
    issueRepo: 'testowner/test-repo',
    worktreePath: '/tmp/wt-test',
    branch: 'ai/issue-135-test',
  });
  return {
    mockStartRun,
    mockFailRun: vi.fn(),
    mockCompleteRun: vi.fn(),
    mockListRuns: vi.fn().mockReturnValue({ runs: [], total: 0 }),
    mockCreateWorktree: vi.fn().mockResolvedValue('/tmp/kanban-wt-test'),
    mockRunAgent: vi.fn().mockResolvedValue({
      finDetected: false,
      exitCode: 0,
      ranTests: false,
    }),
    mockGetIssue: vi.fn().mockResolvedValue(null),
  };
});

vi.mock('../../integrations/github/github-client', () => ({
  githubClient: {
    listRepositories: vi.fn().mockResolvedValue([]),
    listIssues: vi.fn().mockResolvedValue([]),
    getIssue: mockGetIssue,
  },
}));

vi.mock('../../integrations/gitlab/gitlab-client', () => ({
  gitlabClient: {
    getProjects: vi.fn().mockResolvedValue([]),
    listIssues: vi.fn().mockResolvedValue([]),
    getIssue: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock('../../integrations/jira/jira-client', () => ({
  jiraClient: {
    getProjects: vi.fn().mockResolvedValue([]),
    searchIssues: vi.fn().mockResolvedValue([]),
    getIssue: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock('../../work-items/database', () => ({
  workItemDatabase: {
    listWorkItems: vi.fn().mockReturnValue({ items: [], total: 0 }),
  },
}));

vi.mock('../../agent-runs/database', () => ({
  agentRunDatabase: {
    listRuns: mockListRuns,
    startRun: mockStartRun,
    failRun: mockFailRun,
    completeRun: mockCompleteRun,
  },
}));

vi.mock('../../kanban/worktree-manager.js', () => ({
  createWorktree: mockCreateWorktree,
}));

vi.mock('../../autonomous-loop/agent-runner', () => ({
  runAgent: mockRunAgent,
}));

const TEST_REPO = 'testowner/test-repo';

describe('Kanban POST /start and /stop', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    mockListRuns.mockReturnValue({ runs: [], total: 0 });
    mockStartRun.mockReturnValue({
      id: 'test-run-id',
      sessionId: null,
      userId: 'kanban',
      mode: 'interactive',
      model: null,
      status: 'running',
      errorMessage: null,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      toolLoopCount: 0,
      startedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      completedAt: null,
      cancelledAt: null,
      issueId: '135',
      issuePlatform: 'github',
      issueRepo: TEST_REPO,
      worktreePath: '/tmp/wt-test',
      branch: 'ai/issue-135-test',
    });
    mockGetIssue.mockResolvedValue(null);
  });

  beforeAll(async () => {
    const { kanbanRoutes } = await import('../kanban.js');
    app = Fastify();
    await app.register(kanbanRoutes, { prefix: '/api/kanban' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST /cards/:platform/:id/start', () => {
    it('should return 404 when card not found', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/kanban/cards/github/999/start',
        payload: { repo: TEST_REPO, agent: 'claude' },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('Card not found');
    });

    it('should return 200 with expected keys when card exists', async () => {
      mockGetIssue.mockResolvedValueOnce({
        number: 135,
        title: 'Test issue for kanban start',
        body: 'Issue description here',
        state: 'open',
        html_url: 'https://github.com/testowner/test-repo/issues/135',
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/kanban/cards/github/135/start',
        payload: { repo: TEST_REPO, agent: 'claude' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty('agentRunId');
      expect(body).toHaveProperty('worktreePath');
      expect(body).toHaveProperty('branch');
      expect(body.status).toBe('started');
    });

    it('should create an agent_runs row with linkage columns', async () => {
      mockGetIssue.mockResolvedValueOnce({
        number: 135,
        title: 'Test linkage',
        body: 'desc',
        state: 'open',
      });

      await app.inject({
        method: 'POST',
        url: '/api/kanban/cards/github/135/start',
        payload: { repo: TEST_REPO, agent: 'claude' },
      });

      expect(mockStartRun).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'kanban',
          mode: 'interactive',
          issueId: '135',
          issuePlatform: 'github',
          issueRepo: TEST_REPO,
          worktreePath: '/tmp/kanban-wt-test',
          branch: expect.stringContaining('ai/issue-135'),
        }),
      );
    });

    it('should call createWorktree with correct params', async () => {
      mockGetIssue.mockResolvedValueOnce({
        number: 135,
        title: 'Test worktree',
        body: 'desc',
        state: 'open',
      });

      await app.inject({
        method: 'POST',
        url: '/api/kanban/cards/github/135/start',
        payload: { repo: TEST_REPO, agent: 'claude', baseBranch: 'develop' },
      });

      expect(mockCreateWorktree).toHaveBeenCalledWith(
        expect.objectContaining({
          branch: expect.stringContaining('ai/issue-135'),
          baseBranch: 'develop',
        }),
      );
    });

    it('should spawn agent via runAgent with prompt containing title and AGENTS.md', async () => {
      mockGetIssue.mockResolvedValueOnce({
        number: 135,
        title: 'Test spawn',
        body: 'Agent body',
        state: 'open',
      });

      await app.inject({
        method: 'POST',
        url: '/api/kanban/cards/github/135/start',
        payload: { repo: TEST_REPO, agent: 'claude', model: 'opus' },
      });

      expect(mockRunAgent).toHaveBeenCalled();
      const [prompt, cfg] = mockRunAgent.mock.calls[0];
      expect(prompt).toContain('Test spawn');
      expect(prompt).toContain('Read AGENTS.md');
      expect(cfg.agent).toBe('claude');
      expect(cfg.model).toBe('opus');
    });

    it('should emit agent.started SSE event', async () => {
      mockGetIssue.mockResolvedValueOnce({
        number: 135,
        title: 'SSE test',
        body: 'desc',
        state: 'open',
      });

      const emitted: KanbanSSEEvent[] = [];
      const handler = (entry: { event: KanbanSSEEvent }) => emitted.push(entry.event);
      kanbanEvents.on('event', handler);

      await app.inject({
        method: 'POST',
        url: '/api/kanban/cards/github/135/start',
        payload: { repo: TEST_REPO, agent: 'claude' },
      });

      kanbanEvents.off('event', handler);

      const started = emitted.find((e) => e.type === 'agent.started');
      expect(started).toBeDefined();
      if (started && started.type === 'agent.started') {
        expect(started.agent.agentRunId).toBe('test-run-id');
        expect(started.agent.agent).toBe('claude');
        expect(started.agent.status).toBe('running');
        expect(started.agent.cardKey).toBe(`github:${TEST_REPO}:135`);
      }
    });

    it('should return 500 when worktree creation fails', async () => {
      mockGetIssue.mockResolvedValueOnce({
        number: 135,
        title: 'Fail worktree',
        body: 'desc',
        state: 'open',
      });

      mockCreateWorktree.mockRejectedValueOnce(new Error('disk full'));

      const res = await app.inject({
        method: 'POST',
        url: '/api/kanban/cards/github/135/start',
        payload: { repo: TEST_REPO, agent: 'claude' },
      });

      expect(res.statusCode).toBe(500);
      expect(res.json().error).toContain('Worktree creation failed');
    });

    it('should return 409 when an agent is already running for the same card', async () => {
      mockListRuns.mockReturnValueOnce({
        runs: [{
          id: 'existing-run-id',
          issuePlatform: 'github',
          issueRepo: TEST_REPO,
          issueId: '135',
          status: 'running',
          worktreePath: '/tmp/wt-existing',
        }],
        total: 1,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/kanban/cards/github/135/start',
        payload: { repo: TEST_REPO, agent: 'claude' },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('Agent already running for this card');
      expect(res.json().agentRunId).toBe('existing-run-id');
    });

    it('should return 400 for invalid platform', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/kanban/cards/invalid_platform/135/start',
        payload: { repo: TEST_REPO, agent: 'claude' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('Invalid platform');
    });

    it('should return 400 for invalid agent', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/kanban/cards/github/135/start',
        payload: { repo: TEST_REPO, agent: 'invalid_agent' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('Invalid agent');
    });

    it('should return 400 when repo is missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/kanban/cards/github/135/start',
        payload: { agent: 'claude' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('Missing or invalid repo');
    });

    it('should return 400 when repo is empty string', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/kanban/cards/github/135/start',
        payload: { repo: '', agent: 'claude' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('Missing or invalid repo');
    });

    it('should return 400 when repo contains path traversal', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/kanban/cards/github/135/start',
        payload: { repo: '../../../etc/passwd', agent: 'claude' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('Missing or invalid repo');
    });

    it('should call completeRun when agent succeeds asynchronously', async () => {
      mockGetIssue.mockResolvedValueOnce({
        number: 135,
        title: 'Async success',
        body: 'desc',
        state: 'open',
      });

      let resolveRun: (value: any) => void;
      const runPromise = new Promise((resolve) => { resolveRun = resolve; });
      mockRunAgent.mockReturnValueOnce(runPromise);

      const res = await app.inject({
        method: 'POST',
        url: '/api/kanban/cards/github/135/start',
        payload: { repo: TEST_REPO, agent: 'claude' },
      });

      expect(res.statusCode).toBe(200);

      // Simulate agent completing successfully
      resolveRun!({ finDetected: true, exitCode: 0, ranTests: false });
      await runPromise;

      // Allow microtask queue to flush
      await new Promise((r) => setTimeout(r, 10));

      expect(mockCompleteRun).toHaveBeenCalledWith('test-run-id', expect.objectContaining({ toolLoopCount: 0 }));
    });

    it('should call failRun when agent fails asynchronously', async () => {
      mockGetIssue.mockResolvedValueOnce({
        number: 135,
        title: 'Async fail',
        body: 'desc',
        state: 'open',
      });

      let resolveRun: (value: any) => void;
      const runPromise = new Promise((resolve) => { resolveRun = resolve; });
      mockRunAgent.mockReturnValueOnce(runPromise);

      const res = await app.inject({
        method: 'POST',
        url: '/api/kanban/cards/github/135/start',
        payload: { repo: TEST_REPO, agent: 'claude' },
      });

      expect(res.statusCode).toBe(200);

      // Simulate agent failing
      resolveRun!({ finDetected: false, exitCode: 1, ranTests: false, stderr: 'fatal error' });
      await runPromise;

      // Allow microtask queue to flush
      await new Promise((r) => setTimeout(r, 10));

      expect(mockFailRun).toHaveBeenCalledWith('test-run-id', 'fatal error');
    });

    it('should call failRun when agent throws asynchronously', async () => {
      mockGetIssue.mockResolvedValueOnce({
        number: 135,
        title: 'Async throw',
        body: 'desc',
        state: 'open',
      });

      let rejectRun: (reason: any) => void;
      const runPromise = new Promise((_, reject) => { rejectRun = reject; });
      mockRunAgent.mockReturnValueOnce(runPromise);

      const res = await app.inject({
        method: 'POST',
        url: '/api/kanban/cards/github/135/start',
        payload: { repo: TEST_REPO, agent: 'claude' },
      });

      expect(res.statusCode).toBe(200);

      // Simulate agent throwing
      rejectRun!(new Error('spawn ENOENT'));
      await runPromise.catch(() => {});

      // Allow microtask queue to flush
      await new Promise((r) => setTimeout(r, 10));

      expect(mockFailRun).toHaveBeenCalledWith('test-run-id', 'spawn ENOENT');
    });
  });

  describe('POST /cards/:platform/:id/stop', () => {
    it('should return 404 when no running agent found', async () => {
      mockListRuns.mockReturnValueOnce({ runs: [], total: 0 });

      const res = await app.inject({
        method: 'POST',
        url: '/api/kanban/cards/github/999/stop',
        payload: { repo: TEST_REPO },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('No running agent found for this card');
    });

    it('should fail the run and return stopped status', async () => {
      mockListRuns.mockReturnValueOnce({
        runs: [{
          id: 'running-run-id',
          issuePlatform: 'github',
          issueRepo: TEST_REPO,
          issueId: '135',
          status: 'running',
          worktreePath: '/tmp/wt-test',
        }],
        total: 1,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/kanban/cards/github/135/stop',
        payload: { repo: TEST_REPO },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        agentRunId: 'running-run-id',
        status: 'stopped',
      });

      expect(mockFailRun).toHaveBeenCalledWith('running-run-id', 'stopped_by_user');
    });

    it('should emit agent.completed SSE event on stop', async () => {
      mockListRuns.mockReturnValueOnce({
        runs: [{
          id: 'stop-sse-run-id',
          issuePlatform: 'github',
          issueRepo: TEST_REPO,
          issueId: '135',
          status: 'running',
          worktreePath: '/tmp/wt-test',
        }],
        total: 1,
      });

      const emitted: KanbanSSEEvent[] = [];
      const handler = (entry: { event: KanbanSSEEvent }) => emitted.push(entry.event);
      kanbanEvents.on('event', handler);

      await app.inject({
        method: 'POST',
        url: '/api/kanban/cards/github/135/stop',
        payload: { repo: TEST_REPO },
      });

      kanbanEvents.off('event', handler);

      const completed = emitted.find((e) => e.type === 'agent.completed');
      expect(completed).toBeDefined();
      if (completed && completed.type === 'agent.completed') {
        expect(completed.agentRunId).toBe('stop-sse-run-id');
        expect(completed.status).toBe('failed');
        expect(completed.errorMessage).toBe('stopped_by_user');
      }
    });

    it('should SIGTERM the child process on stop', async () => {
      // First, start an agent so a child process is registered
      mockGetIssue.mockResolvedValueOnce({
        number: 135,
        title: 'Kill test',
        body: 'desc',
        state: 'open',
      });

      const mockChild = new EventEmitter() as any;
      mockChild.kill = vi.fn().mockReturnValue(true);
      mockChild.killed = false;
      mockChild.stdin = { write: vi.fn(), end: vi.fn() };
      mockChild.stdout = new EventEmitter();
      mockChild.stderr = new EventEmitter();

      // Capture the onChildReady callback from runAgent
      let onChildReady: ((child: any) => void) | undefined;
      let resolveRunPromise: (value: any) => void;
      const runPromise = new Promise((resolve) => { resolveRunPromise = resolve; });

      mockRunAgent.mockImplementationOnce((_prompt, _cfg, _launcher, _resume, _logger, onChild, _onStep) => {
        onChildReady = onChild;
        // Simulate child process registration
        if (onChildReady) onChildReady(mockChild);
        return runPromise;
      });

      // Start the agent
      const startRes = await app.inject({
        method: 'POST',
        url: '/api/kanban/cards/github/135/start',
        payload: { repo: TEST_REPO, agent: 'claude' },
      });
      expect(startRes.statusCode).toBe(200);

      // Now stop it
      mockListRuns.mockReturnValueOnce({
        runs: [{
          id: 'test-run-id',
          issuePlatform: 'github',
          issueRepo: TEST_REPO,
          issueId: '135',
          status: 'running',
          worktreePath: '/tmp/wt-test',
        }],
        total: 1,
      });

      const stopRes = await app.inject({
        method: 'POST',
        url: '/api/kanban/cards/github/135/stop',
        payload: { repo: TEST_REPO },
      });

      expect(stopRes.statusCode).toBe(200);
      expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM');

      // Clean up the pending promise so the test doesn't hang
      resolveRunPromise!({ finDetected: false, exitCode: 0, ranTests: false });
      await runPromise;
      await new Promise((r) => setTimeout(r, 10));
    });

    it('should return 400 when stop is called with invalid repo', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/kanban/cards/github/135/stop',
        payload: { repo: '' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('Missing or invalid repo');
    });
  });
});
