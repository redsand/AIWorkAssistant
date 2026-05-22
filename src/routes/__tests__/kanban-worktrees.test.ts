import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { kanbanRoutes } from '../kanban';

const {
  mockListRuns,
  mockGetRun,
  mockGetKanbanSetting,
  mockSetKanbanSetting,
  mockListWorktrees,
  mockIsClean,
  mockRemoveWorktree,
  mockExistsSync,
} = vi.hoisted(() => ({
  mockListRuns: vi.fn().mockReturnValue({ runs: [], total: 0 }),
  mockGetRun: vi.fn().mockReturnValue(null),
  mockGetKanbanSetting: vi.fn().mockReturnValue(null),
  mockSetKanbanSetting: vi.fn(),
  mockListWorktrees: vi.fn().mockResolvedValue([]),
  mockIsClean: vi.fn().mockResolvedValue(true),
  mockRemoveWorktree: vi.fn().mockResolvedValue(undefined),
  mockExistsSync: vi.fn().mockReturnValue(false),
}));

// Mock all external integrations
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

vi.mock('../../work-items/database', () => {
  const mockDb = {
    listWorkItems: vi.fn().mockReturnValue({ items: [], total: 0 }),
  };
  return { workItemDatabase: mockDb };
});

vi.mock('../../agent-runs/database', () => ({
  agentRunDatabase: {
    listRuns: mockListRuns,
    getRun: mockGetRun,
    getKanbanSetting: mockGetKanbanSetting,
    setKanbanSetting: mockSetKanbanSetting,
  },
}));

vi.mock('../../kanban/worktree-manager', () => ({
  createWorktree: vi.fn(),
  removeWorktree: (...args: unknown[]) => mockRemoveWorktree(...args),
  isClean: (...args: unknown[]) => mockIsClean(...args),
  listWorktrees: (...args: unknown[]) => mockListWorktrees(...args),
}));

// Mock fs to control existsSync behavior in DELETE dirty check
vi.mock('node:fs', () => ({
  ...require('node:fs'),
  existsSync: mockExistsSync,
  statSync: vi.fn().mockReturnValue({ isDirectory: () => true }),
}));

describe('Kanban Worktree Admin Routes', () => {
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
    mockGetRun.mockReturnValue(null);
    mockGetKanbanSetting.mockReturnValue(null);
  });

  describe('GET /worktrees', () => {
    it('should return empty array when no worktrees tracked', async () => {
      mockListRuns.mockReturnValue({ runs: [], total: 0 });
      mockListWorktrees.mockResolvedValue([]);

      const res = await app.inject({ method: 'GET', url: '/api/kanban/worktrees' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    });

    it('should list active worktrees from DB matches on disk', async () => {
      mockListRuns.mockReturnValue({
        runs: [
          {
            id: 'run-1',
            worktreePath: '/repo/.kanban-worktrees/test-abc123',
            branch: 'ai/issue-12',
            issuePlatform: 'github',
            issueRepo: 'owner/repo',
            issueId: '12',
            status: 'completed',
          },
        ],
        total: 1,
      });
      mockListWorktrees.mockResolvedValue([
        {
          path: '/repo/.kanban-worktrees/test-abc123',
          branch: 'refs/heads/ai/issue-12',
          head: 'abc123',
          locked: false,
          prunable: false,
        },
      ]);
      mockIsClean.mockResolvedValue(true);

      const res = await app.inject({ method: 'GET', url: '/api/kanban/worktrees' });
      expect(res.statusCode).toBe(200);
      const entries = res.json();
      expect(entries).toHaveLength(1);
      expect(entries[0].state).toBe('active');
      expect(entries[0].agentRunId).toBe('run-1');
      expect(entries[0].cardKey).toBe('github:owner/repo:12');
      expect(entries[0].isClean).toBe(true);
    });

    it('should detect orphans (in DB but not on disk)', async () => {
      mockListRuns.mockReturnValue({
        runs: [
          {
            id: 'run-2',
            worktreePath: '/repo/.kanban-worktrees/orphan-xyz',
            branch: 'ai/orphan',
            issuePlatform: 'github',
            issueRepo: 'owner/repo',
            issueId: '99',
            status: 'completed',
          },
        ],
        total: 1,
      });
      mockListWorktrees.mockResolvedValue([]);

      const res = await app.inject({ method: 'GET', url: '/api/kanban/worktrees' });
      expect(res.statusCode).toBe(200);
      const entries = res.json();
      expect(entries).toHaveLength(1);
      expect(entries[0].state).toBe('orphan');
      expect(entries[0].onDisk).toBe(false);
      expect(entries[0].isClean).toBeNull();
    });

    it('should detect ghosts (on disk but not in DB)', async () => {
      mockListRuns.mockReturnValue({ runs: [], total: 0 });
      mockListWorktrees.mockResolvedValue([
        {
          path: '/repo/.kanban-worktrees/ghost-branch',
          branch: 'refs/heads/ghost',
          head: 'def456',
          locked: false,
          prunable: false,
        },
      ]);

      const res = await app.inject({ method: 'GET', url: '/api/kanban/worktrees' });
      expect(res.statusCode).toBe(200);
      const entries = res.json();
      expect(entries).toHaveLength(1);
      expect(entries[0].state).toBe('ghost');
      expect(entries[0].agentRunId).toBe('');
      expect(entries[0].cardKey).toBeNull();
    });
  });

  describe('DELETE /worktrees/:id', () => {
    it('should return 404 when run not found', async () => {
      mockGetRun.mockReturnValue(null);

      const res = await app.inject({ method: 'DELETE', url: '/api/kanban/worktrees/nonexistent' });
      expect(res.statusCode).toBe(404);
    });

    it('should return 404 when run has no worktree', async () => {
      mockGetRun.mockReturnValue({ id: 'run-1', worktreePath: null });

      const res = await app.inject({ method: 'DELETE', url: '/api/kanban/worktrees/run-1' });
      expect(res.statusCode).toBe(404);
    });

    it('should return 409 for dirty worktree without force', async () => {
      mockGetRun.mockReturnValue({
        id: 'run-1',
        worktreePath: '/repo/.kanban-worktrees/dirty-wt',
        status: 'completed',
      });
      mockIsClean.mockResolvedValue(false);
      mockExistsSync.mockReturnValue(true);

      const res = await app.inject({ method: 'DELETE', url: '/api/kanban/worktrees/run-1' });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toContain('uncommitted changes');
    });

    it('should remove dirty worktree with ?force=true', async () => {
      mockGetRun.mockReturnValue({
        id: 'run-1',
        worktreePath: '/repo/.kanban-worktrees/dirty-wt',
        status: 'completed',
      });
      mockIsClean.mockResolvedValue(false);
      mockRemoveWorktree.mockResolvedValue(undefined);

      const res = await app.inject({ method: 'DELETE', url: '/api/kanban/worktrees/run-1?force=true' });
      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
      expect(mockRemoveWorktree).toHaveBeenCalledWith('/repo/.kanban-worktrees/dirty-wt', { force: true });
    });

    it('should remove clean worktree without force', async () => {
      mockGetRun.mockReturnValue({
        id: 'run-1',
        worktreePath: '/repo/.kanban-worktrees/clean-wt',
        status: 'completed',
      });
      mockIsClean.mockResolvedValue(true);
      mockRemoveWorktree.mockResolvedValue(undefined);
      mockExistsSync.mockReturnValue(true);

      const res = await app.inject({ method: 'DELETE', url: '/api/kanban/worktrees/run-1' });
      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
    });
  });

  describe('GET /settings', () => {
    it('should return default 24 hours when no setting stored', async () => {
      mockGetKanbanSetting.mockReturnValue(null);

      const res = await app.inject({ method: 'GET', url: '/api/kanban/settings' });
      expect(res.statusCode).toBe(200);
      expect(res.json().autoCleanupHours).toBe(24);
    });

    it('should return stored setting', async () => {
      mockGetKanbanSetting.mockReturnValue('48');

      const res = await app.inject({ method: 'GET', url: '/api/kanban/settings' });
      expect(res.statusCode).toBe(200);
      expect(res.json().autoCleanupHours).toBe(48);
    });
  });

  describe('PUT /settings', () => {
    it('should reject negative values', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/kanban/settings',
        payload: { autoCleanupHours: -1 },
      });
      expect(res.statusCode).toBe(400);
    });

    it('should reject non-numeric values', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/kanban/settings',
        payload: { autoCleanupHours: 'abc' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('should save valid setting', async () => {
      mockGetKanbanSetting.mockReturnValue('12');

      const res = await app.inject({
        method: 'PUT',
        url: '/api/kanban/settings',
        payload: { autoCleanupHours: 12 },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().autoCleanupHours).toBe(12);
      expect(mockSetKanbanSetting).toHaveBeenCalledWith('autoCleanupHours', '12');
    });

    it('should allow 0 (disables auto-cleanup)', async () => {
      mockGetKanbanSetting.mockReturnValue('0');

      const res = await app.inject({
        method: 'PUT',
        url: '/api/kanban/settings',
        payload: { autoCleanupHours: 0 },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().autoCleanupHours).toBe(0);
      expect(mockSetKanbanSetting).toHaveBeenCalledWith('autoCleanupHours', '0');
    });
  });
});
