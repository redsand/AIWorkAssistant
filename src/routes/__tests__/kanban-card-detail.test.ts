import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { kanbanRoutes } from '../kanban';

// Hoist mock functions
const {
  mockGetIssue,
  mockGetRunWithSteps,
  mockListRuns,
  mockIsClean,
  mockRemoveWorktree,
  mockListIssueComments,
  mockAddIssueComment,
} = vi.hoisted(() => ({
  mockGetIssue: vi.fn().mockResolvedValue({
    title: 'Test Card Title',
    body: '# Description\n\nThis is a test issue.',
    number: 42,
    html_url: 'https://github.com/owner/repo/issues/42',
  }),
  mockGetRunWithSteps: vi.fn().mockReturnValue(null),
  mockListRuns: vi.fn().mockReturnValue({ runs: [], total: 0 }),
  mockIsClean: vi.fn().mockResolvedValue(true),
  mockRemoveWorktree: vi.fn().mockResolvedValue(undefined),
  mockListIssueComments: vi.fn().mockResolvedValue([
    { user: { login: 'tester' }, body: 'First comment', created_at: '2026-01-01T00:00:00Z' },
  ]),
  mockAddIssueComment: vi.fn().mockResolvedValue({ id: 1 }),
}));

vi.mock('../../integrations/github/github-client', () => ({
  githubClient: {
    listRepositories: vi.fn().mockResolvedValue([]),
    listIssues: vi.fn().mockResolvedValue([]),
    getIssue: mockGetIssue,
    listIssueComments: mockListIssueComments,
    addIssueComment: mockAddIssueComment,
  },
}));

vi.mock('../../integrations/gitlab/gitlab-client', () => ({
  gitlabClient: {
    getProjects: vi.fn().mockResolvedValue([]),
    listIssues: vi.fn().mockResolvedValue([]),
    getIssue: vi.fn().mockResolvedValue(null),
    listIssueNotes: vi.fn().mockResolvedValue([]),
    addIssueNote: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('../../integrations/jira/jira-client', () => ({
  jiraClient: {
    getProjects: vi.fn().mockResolvedValue([]),
    searchIssues: vi.fn().mockResolvedValue([]),
    getIssue: vi.fn().mockResolvedValue(null),
    getComments: vi.fn().mockResolvedValue([]),
    addComment: vi.fn().mockResolvedValue({}),
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
    getRunWithSteps: mockGetRunWithSteps,
    getRun: vi.fn().mockReturnValue(null),
  },
}));

vi.mock('../../kanban/worktree-manager', () => ({
  createWorktree: vi.fn().mockResolvedValue('/tmp/wt-test'),
  isClean: mockIsClean,
  removeWorktree: mockRemoveWorktree,
  listWorktrees: vi.fn().mockResolvedValue([]),
}));

vi.mock('../autonomous-loop/agent-runner', () => ({
  runAgent: vi.fn().mockResolvedValue({
    finDetected: false,
    exitCode: 0,
    ranTests: false,
  }),
}));

vi.mock('../autonomous-loop', () => ({
  makeBranchName: vi.fn().mockReturnValue('ai/issue-42-test-card-title'),
}));

describe('Kanban Card Detail Routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await app.register(kanbanRoutes, { prefix: '/api/kanban' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockListRuns.mockReturnValue({ runs: [], total: 0 });
    mockGetRunWithSteps.mockReturnValue(null);
    mockGetIssue.mockResolvedValue({
      title: 'Test Card Title',
      body: '# Description\n\nThis is a test issue.',
      number: 42,
      html_url: 'https://github.com/owner/repo/issues/42',
    });
    mockListIssueComments.mockResolvedValue([
      { user: { login: 'tester' }, body: 'First comment', created_at: '2026-01-01T00:00:00Z' },
    ]);
  });

  describe('GET /cards/:platform/:repo/:id', () => {
    it('should return card detail with description and comments', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/kanban/cards/github/owner%2Frepo/42',
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();

      expect(body.card).toBeDefined();
      expect(body.card.id).toBe('42');
      expect(body.card.title).toBe('Test Card Title');
      expect(body.description).toContain('Description');
      expect(body.comments).toHaveLength(1);
      expect(body.comments[0].author).toBe('tester');
      expect(body.comments[0].body).toBe('First comment');
    });

    it('should return 400 for invalid platform', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/kanban/cards/invalid/repo/42',
      });
      expect(res.statusCode).toBe(400);
    });

    it('should return 404 when card is not found', async () => {
      mockGetIssue.mockResolvedValueOnce(null);

      const res = await app.inject({
        method: 'GET',
        url: '/api/kanban/cards/github/owner%2Frepo/999',
      });

      expect(res.statusCode).toBe(404);
    });

    it('should include agent run when one exists', async () => {
      const mockRun = {
        id: 'run-123',
        sessionId: null,
        userId: 'kanban',
        mode: 'interactive',
        model: 'claude-3',
        status: 'running',
        errorMessage: null,
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
        toolLoopCount: 5,
        startedAt: '2026-05-01T00:00:00Z',
        lastActivityAt: '2026-05-01T00:01:00Z',
        completedAt: null,
        cancelledAt: null,
        issueId: '42',
        issuePlatform: 'github',
        issueRepo: 'owner/repo',
        worktreePath: '/tmp/wt-test',
        branch: 'ai/issue-42-test',
      };

      mockListRuns.mockReturnValue({ runs: [mockRun], total: 1 });
      mockGetRunWithSteps.mockReturnValue({
        ...mockRun,
        steps: [
          { id: 'step-1', runId: 'run-123', stepType: 'tool_call', toolName: 'readFile', content: null, sanitizedParams: null, success: true, errorMessage: null, durationMs: 100, stepOrder: 1, createdAt: '2026-05-01T00:00:10Z' },
        ],
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/kanban/cards/github/owner%2Frepo/42',
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.agentRun).toBeDefined();
      expect(body.agentRun.id).toBe('run-123');
      expect(body.agentRun.steps).toHaveLength(1);
    });

    it('should include worktree info when agent run has a worktree', async () => {
      const mockRun = {
        id: 'run-123',
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
        startedAt: '2026-05-01T00:00:00Z',
        lastActivityAt: '2026-05-01T00:01:00Z',
        completedAt: null,
        cancelledAt: null,
        issueId: '42',
        issuePlatform: 'github',
        issueRepo: 'owner/repo',
        worktreePath: '/tmp/wt-test',
        branch: 'ai/issue-42-test',
      };

      mockListRuns.mockReturnValue({ runs: [mockRun], total: 1 });
      mockGetRunWithSteps.mockReturnValue({ ...mockRun, steps: [] });
      mockIsClean.mockResolvedValue(true);

      const res = await app.inject({
        method: 'GET',
        url: '/api/kanban/cards/github/owner%2Frepo/42',
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.worktree).toBeDefined();
      expect(body.worktree.isClean).toBe(true);
      expect(body.worktree.branch).toBe('ai/issue-42-test');
      expect(body.diffUrl).toContain('/diff');
    });

    it('should return null diffUrl when no worktree', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/kanban/cards/github/owner%2Frepo/42',
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.diffUrl).toBeNull();
    });
  });

  describe('POST /cards/:platform/:repo/:id/comment', () => {
    it('should post a comment to the platform', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/kanban/cards/github/owner%2Frepo/42/comment',
        payload: { body: 'Great work!' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
      expect(mockAddIssueComment).toHaveBeenCalledWith(42, 'Great work!', 'owner', 'repo');
    });

    it('should return 400 when comment body is missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/kanban/cards/github/owner%2Frepo/42/comment',
        payload: {},
      });

      expect(res.statusCode).toBe(400);
    });

    it('should return 400 for invalid platform', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/kanban/cards/invalid/repo/42/comment',
        payload: { body: 'test' },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('DELETE /worktrees/:id', () => {
    it('should return 404 when agent run is not found', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/kanban/worktrees/nonexistent',
      });

      expect(res.statusCode).toBe(404);
    });

    it('should remove worktree when agent run exists', async () => {
      const mockRun = {
        id: 'run-123',
        worktreePath: '/tmp/wt-test',
      };

      const { agentRunDatabase } = await import('../../agent-runs/database.js');
      (agentRunDatabase.getRun as ReturnType<typeof vi.fn>).mockReturnValueOnce(mockRun);

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/kanban/worktrees/run-123',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
      expect(mockRemoveWorktree).toHaveBeenCalledWith('/tmp/wt-test', { force: true });
    });
  });

  describe('GET /cards/:platform/:repo/:id/diff', () => {
    it('should return 404 when no worktree exists', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/kanban/cards/github/owner%2Frepo/42/diff',
      });

      expect(res.statusCode).toBe(404);
    });

    it('should return 400 for invalid platform', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/kanban/cards/invalid/repo/42/diff',
      });

      expect(res.statusCode).toBe(400);
    });
  });
});
