import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';

const { mockListRuns, mockGetRunSteps } = vi.hoisted(() => ({
  mockListRuns: vi.fn().mockReturnValue({ runs: [], total: 0 }),
  mockGetRunSteps: vi.fn().mockReturnValue([]),
}));

vi.mock('../../integrations/github/github-client', () => ({
  githubClient: {
    listRepositories: vi.fn().mockResolvedValue([]),
    listIssues: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../../integrations/gitlab/gitlab-client', () => ({
  gitlabClient: {
    getProjects: vi.fn().mockResolvedValue([]),
    listIssues: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../../integrations/jira/jira-client', () => ({
  jiraClient: {
    getProjects: vi.fn().mockResolvedValue([]),
    searchIssues: vi.fn().mockResolvedValue([]),
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
    getRunSteps: mockGetRunSteps,
    startRun: vi.fn(),
    failRun: vi.fn(),
    completeRun: vi.fn(),
  },
}));

vi.mock('../../kanban/worktree-manager.js', () => ({
  createWorktree: vi.fn().mockResolvedValue('/tmp/test-wt'),
}));

vi.mock('../../autonomous-loop/agent-runner', () => ({
  runAgent: vi.fn().mockResolvedValue({ finDetected: false, exitCode: 0, ranTests: false }),
}));

describe('Kanban GET /agents', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    mockListRuns.mockReturnValue({ runs: [], total: 0 });
    mockGetRunSteps.mockReturnValue([]);
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

  it('should return empty array when no running agents', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/kanban/agents' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('should return running agents with correct shape', async () => {
    const now = new Date().toISOString();
    mockListRuns.mockReturnValue({
      runs: [
        {
          id: 'run-1',
          sessionId: null,
          userId: 'kanban',
          mode: 'interactive',
          model: 'opus',
          status: 'running',
          errorMessage: null,
          promptTokens: null,
          completionTokens: null,
          totalTokens: null,
          toolLoopCount: 5,
          startedAt: now,
          lastActivityAt: now,
          completedAt: null,
          cancelledAt: null,
          issueId: '42',
          issuePlatform: 'github',
          issueRepo: 'owner/repo',
          worktreePath: '/tmp/wt',
          branch: 'ai/issue-42-test',
        },
      ],
      total: 1,
    });

    mockGetRunSteps.mockReturnValue([
      { id: 's1', runId: 'run-1', toolName: 'Read', stepOrder: 1 },
      { id: 's2', runId: 'run-1', toolName: 'Edit', stepOrder: 2 },
    ]);

    const res = await app.inject({ method: 'GET', url: '/api/kanban/agents' });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body).toHaveLength(1);

    const agent = body[0];
    expect(agent.agentRunId).toBe('run-1');
    expect(agent.agent).toBe('claude');
    expect(agent.model).toBe('opus');
    expect(agent.status).toBe('running');
    expect(agent.cardKey).toBe('github:owner/repo:42');
    expect(agent.startedAt).toBe(now);
    expect(agent.lastTool).toBe('Edit');
    expect(agent.toolLoopCount).toBe(2);
  });

  it('should return null cardKey when run has no issue linkage', async () => {
    const now = new Date().toISOString();
    mockListRuns.mockReturnValue({
      runs: [
        {
          id: 'run-2',
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
          startedAt: now,
          lastActivityAt: now,
          completedAt: null,
          cancelledAt: null,
          issueId: null,
          issuePlatform: null,
          issueRepo: null,
          worktreePath: null,
          branch: null,
        },
      ],
      total: 1,
    });

    const res = await app.inject({ method: 'GET', url: '/api/kanban/agents' });
    expect(res.statusCode).toBe(200);
    const agent = res.json()[0];
    expect(agent.cardKey).toBeNull();
    expect(agent.lastTool).toBeNull();
  });

  it('should handle getRunSteps throwing gracefully', async () => {
    const now = new Date().toISOString();
    mockListRuns.mockReturnValue({
      runs: [
        {
          id: 'run-3',
          sessionId: null,
          userId: 'kanban',
          mode: 'interactive',
          model: null,
          status: 'running',
          errorMessage: null,
          promptTokens: null,
          completionTokens: null,
          totalTokens: null,
          toolLoopCount: 3,
          startedAt: now,
          lastActivityAt: now,
          completedAt: null,
          cancelledAt: null,
          issueId: '10',
          issuePlatform: 'github',
          issueRepo: 'owner/repo',
          worktreePath: null,
          branch: null,
        },
      ],
      total: 1,
    });

    mockGetRunSteps.mockImplementation(() => {
      throw new Error('db locked');
    });

    const res = await app.inject({ method: 'GET', url: '/api/kanban/agents' });
    expect(res.statusCode).toBe(200);
    const agent = res.json()[0];
    expect(agent.agentRunId).toBe('run-3');
    expect(agent.lastTool).toBeNull();
    expect(agent.toolLoopCount).toBe(3);
  });

  it('should cap at 50 runs', async () => {
    mockListRuns.mockReturnValue({ runs: [], total: 0 });

    await app.inject({ method: 'GET', url: '/api/kanban/agents' });

    expect(mockListRuns).toHaveBeenCalledWith({ status: 'running', limit: 50 });
  });

  it('should return null lastTool when steps array is empty', async () => {
    const now = new Date().toISOString();
    mockListRuns.mockReturnValue({
      runs: [
        {
          id: 'run-4',
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
          startedAt: now,
          lastActivityAt: now,
          completedAt: null,
          cancelledAt: null,
          issueId: '1',
          issuePlatform: 'github',
          issueRepo: 'owner/repo',
          worktreePath: null,
          branch: null,
        },
      ],
      total: 1,
    });

    mockGetRunSteps.mockReturnValue([]);

    const res = await app.inject({ method: 'GET', url: '/api/kanban/agents' });
    const agent = res.json()[0];
    expect(agent.lastTool).toBeNull();
  });

  it('should return empty array when listRuns throws', async () => {
    mockListRuns.mockImplementation(() => {
      throw new Error('database is locked');
    });

    const res = await app.inject({ method: 'GET', url: '/api/kanban/agents' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('should use agentName from run when available', async () => {
    const now = new Date().toISOString();
    mockListRuns.mockReturnValue({
      runs: [
        {
          id: 'run-5',
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
          startedAt: now,
          lastActivityAt: now,
          completedAt: null,
          cancelledAt: null,
          issueId: '1',
          issuePlatform: 'github',
          issueRepo: 'owner/repo',
          worktreePath: null,
          branch: null,
          agentName: 'codex',
        },
      ],
      total: 1,
    });

    mockGetRunSteps.mockReturnValue([]);

    const res = await app.inject({ method: 'GET', url: '/api/kanban/agents' });
    const agent = res.json()[0];
    expect(agent.agent).toBe('codex');
  });

  it('should default to claude when agentName is null', async () => {
    const now = new Date().toISOString();
    mockListRuns.mockReturnValue({
      runs: [
        {
          id: 'run-6',
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
          startedAt: now,
          lastActivityAt: now,
          completedAt: null,
          cancelledAt: null,
          issueId: '1',
          issuePlatform: 'github',
          issueRepo: 'owner/repo',
          worktreePath: null,
          branch: null,
          agentName: null,
        },
      ],
      total: 1,
    });

    mockGetRunSteps.mockReturnValue([]);

    const res = await app.inject({ method: 'GET', url: '/api/kanban/agents' });
    const agent = res.json()[0];
    expect(agent.agent).toBe('claude');
  });
});
