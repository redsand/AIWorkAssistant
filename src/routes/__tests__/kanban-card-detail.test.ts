import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import * as path from 'node:path';
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
  mockAddIssueNote,
  mockJiraAddComment,
  mockExecFileAsync,
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
  mockAddIssueNote: vi.fn().mockResolvedValue({ id: 2 }),
  mockJiraAddComment: vi.fn().mockResolvedValue({ id: 3 }),
  mockExecFileAsync: vi.fn().mockImplementation((_cmd: string, args: string[]) => {
    if (Array.isArray(args) && args.includes('symbolic-ref')) {
      return Promise.resolve({ stdout: 'refs/remotes/origin/main\n' });
    }
    return Promise.resolve({ stdout: 'diff --git a/file.ts b/file.ts\n+new line' });
  }),
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
    addIssueNote: mockAddIssueNote,
  },
}));

vi.mock('../../integrations/jira/jira-client', () => ({
  jiraClient: {
    getProjects: vi.fn().mockResolvedValue([]),
    searchIssues: vi.fn().mockResolvedValue([]),
    getIssue: vi.fn().mockResolvedValue(null),
    getComments: vi.fn().mockResolvedValue([]),
    addComment: mockJiraAddComment,
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

// Mock child_process for execFileAsync used in diff endpoint
vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => {
    const callback = args[args.length - 1] as (...a: unknown[]) => void;
    if (typeof callback !== 'function') return;
    const callArgs = args.slice(0, -1);
    mockExecFileAsync(...callArgs).then(
      (result: { stdout: string; stderr?: string }) => callback(null, result),
      (err: unknown) => callback(err),
    );
  },
}));

// Mock node:fs for validateWorktreePath — return appropriate stat results
// based on whether the path is a directory or the .git marker file.
vi.mock('node:fs', () => ({
  statSync: vi.fn().mockImplementation((p: string) => {
    if (typeof p === 'string' && p.endsWith(`${path.sep}.git`)) {
      return { isDirectory: () => false, isFile: () => true };
    }
    return { isDirectory: () => true, isFile: () => false };
  }),
  existsSync: vi.fn().mockReturnValue(true),
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
      const wtPath = process.platform === 'win32'
        ? 'C:\\kanban-worktrees\\wt-test'
        : '/tmp/wt-test';

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
        worktreePath: wtPath,
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

    it('should skip worktree info when worktree path fails validation', async () => {
      const mockRun = {
        id: 'run-456',
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
        worktreePath: '../etc/passwd',
        branch: 'ai/issue-42-test',
      };

      mockListRuns.mockReturnValue({ runs: [mockRun], total: 1 });
      mockGetRunWithSteps.mockReturnValue({ ...mockRun, steps: [] });

      const res = await app.inject({
        method: 'GET',
        url: '/api/kanban/cards/github/owner%2Frepo/42',
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.worktree).toBeNull();
      expect(body.diffUrl).toBeNull();
      expect(mockIsClean).not.toHaveBeenCalled();
    });
  });

  describe('POST /cards/:platform/:repo/:id/comment', () => {
    it('should post a comment to GitHub', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/kanban/cards/github/owner%2Frepo/42/comment',
        payload: { body: 'Great work!' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
      expect(mockAddIssueComment).toHaveBeenCalledWith(42, 'Great work!', 'owner', 'repo');
    });

    it('should post a comment to GitLab', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/kanban/cards/gitlab/group%2Fproject/42/comment',
        payload: { body: 'LGTM!' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
      expect(mockAddIssueNote).toHaveBeenCalledWith('group/project', 42, 'LGTM!');
    });

    it('should post a comment to Jira', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/kanban/cards/jira/PROJ/ABC-123/comment',
        payload: { body: 'Looks good' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
      expect(mockJiraAddComment).toHaveBeenCalledWith('ABC-123', 'Looks good');
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

    it('should return 404 when agent run has no worktreePath', async () => {
      const { agentRunDatabase } = await import('../../agent-runs/database.js');
      (agentRunDatabase.getRun as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        id: 'run-no-wt',
        worktreePath: null,
      });

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/kanban/worktrees/run-no-wt',
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('No worktree for this run');
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
      expect(mockRemoveWorktree).toHaveBeenCalledWith('/tmp/wt-test', { force: false });
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

    it('should return diff output when worktree exists and is valid', async () => {
      // Use a platform-appropriate absolute path so path.isAbsolute passes
      const wtPath = process.platform === 'win32'
        ? 'C:\\kanban-worktrees\\wt-test'
        : '/tmp/wt-test';

      const mockRun = {
        id: 'run-123',
        issuePlatform: 'github',
        issueRepo: 'owner/repo',
        issueId: '42',
        worktreePath: wtPath,
      };

      mockListRuns.mockReturnValue({ runs: [mockRun], total: 1 });

      const res = await app.inject({
        method: 'GET',
        url: '/api/kanban/cards/github/owner%2Frepo/42/diff',
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/plain');
      expect(res.body).toContain('diff --git');
      expect(res.body).toContain('+new line');
      // Verify symbolic-ref was called first to detect default branch
      expect(mockExecFileAsync).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['symbolic-ref']),
        expect.objectContaining({ cwd: expect.any(String) }),
      );
    });

    it('should return 400 when worktree path fails validation', async () => {
      // A relative path should fail path.isAbsolute
      const mockRun = {
        id: 'run-456',
        issuePlatform: 'github',
        issueRepo: 'owner/repo',
        issueId: '42',
        worktreePath: '../etc/passwd',
      };

      mockListRuns.mockReturnValue({ runs: [mockRun], total: 1 });

      const res = await app.inject({
        method: 'GET',
        url: '/api/kanban/cards/github/owner%2Frepo/42/diff',
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('Invalid worktree path');
    });

    it('should return 500 when git diff command throws an error', async () => {
      const wtPath = process.platform === 'win32'
        ? 'C:\\kanban-worktrees\\wt-test'
        : '/tmp/wt-test';

      const mockRun = {
        id: 'run-789',
        issuePlatform: 'github',
        issueRepo: 'owner/repo',
        issueId: '42',
        worktreePath: wtPath,
      };

      mockListRuns.mockReturnValue({ runs: [mockRun], total: 1 });
      // Override execFileAsync to reject for diff calls (but not symbolic-ref)
      mockExecFileAsync.mockImplementation((_cmd: string, args: string[]) => {
        if (Array.isArray(args) && args.includes('symbolic-ref')) {
          return Promise.resolve({ stdout: 'refs/remotes/origin/main\n' });
        }
        return Promise.reject(new Error('fatal: not a git repository'));
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/kanban/cards/github/owner%2Frepo/42/diff',
      });

      expect(res.statusCode).toBe(500);
      expect(res.json().error).toContain('Diff failed');
      expect(res.json().error).toContain('fatal: not a git repository');
    });
  });

  describe('XSS safety', () => {
    it('should not render raw script tags in card description', async () => {
      mockGetIssue.mockResolvedValueOnce({
        title: 'XSS Test <script>alert("xss")</script>',
        body: '# Description\n\n<img src=x onerror="alert(1)"><script>alert("xss")</script>',
        number: 42,
        html_url: 'https://github.com/owner/repo/issues/42',
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/kanban/cards/github/owner%2Frepo/42',
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      // The response is JSON — confirm script content is present as raw text,
      // not executed. JSON.stringify handles this safely, but the values should
      // be the literal strings, not HTML-escaped or stripped.
      expect(body.card.title).toBe('XSS Test <script>alert("xss")</script>');
      expect(body.description).toContain('<script>alert("xss")</script>');
      // Verify the response body is valid JSON (no injected HTML in the HTTP response)
      expect(res.headers['content-type']).toContain('application/json');
    });
  });
});
