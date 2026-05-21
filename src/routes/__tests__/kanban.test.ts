import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { kanbanRoutes } from '../kanban';

// Mock all external integrations so tests don't require real credentials
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

vi.mock('../../agent-runs/database', () => {
  const mockDb = {
    listRuns: vi.fn().mockReturnValue({ runs: [], total: 0 }),
  };
  return { agentRunDatabase: mockDb };
});

describe('Kanban Routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await app.register(kanbanRoutes, { prefix: '/api/kanban' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /board', () => {
    it('should return 200 with correct shape when no integrations are configured', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/kanban/board' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty('cards');
      expect(body).toHaveProperty('edges');
      expect(body).toHaveProperty('ghostNodes');
      expect(body).toHaveProperty('agents');
      expect(body).toHaveProperty('repos');
      expect(body).toHaveProperty('generatedAt');
      expect(Array.isArray(body.cards)).toBe(true);
      expect(Array.isArray(body.edges)).toBe(true);
      expect(Array.isArray(body.ghostNodes)).toBe(true);
      expect(Array.isArray(body.agents)).toBe(true);
      expect(Array.isArray(body.repos)).toBe(true);
      expect(typeof body.generatedAt).toBe('string');
    });

    it('should return empty arrays when no integrations produce issues', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/kanban/board' });
      const body = res.json();
      expect(body.cards).toEqual([]);
      expect(body.edges).toEqual([]);
      expect(body.ghostNodes).toEqual([]);
      expect(body.agents).toEqual([]);
      expect(body.repos).toEqual([]);
    });

    it('should accept optional filter query params without error', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/kanban/board?repos[]=owner/repo&priority=high&assignee=user1&sprint=sprint-1',
      });
      expect(res.statusCode).toBe(200);
    });

    it('should return generatedAt as a valid ISO date string', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/kanban/board' });
      const body = res.json();
      const date = new Date(body.generatedAt);
      expect(date.getTime()).not.toBeNaN();
    });
  });
});

describe('Kanban Routes with mock data', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.resetModules();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('should produce cards from GitHub issues', async () => {
    vi.doMock('../../integrations/github/github-client', () => ({
      githubClient: {
        listRepositories: vi.fn().mockResolvedValue([
          { name: 'test-repo', owner: { login: 'testowner' } },
        ]),
        listIssues: vi.fn().mockResolvedValue([
          {
            number: 42,
            title: 'Test GitHub issue',
            html_url: 'https://github.com/testowner/test-repo/issues/42',
            state: 'open',
            labels: [],
            assignee: null,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-02T00:00:00Z',
            body: 'depends on GH:other/repo#99',
          },
        ]),
      },
    }));
    vi.doMock('../../integrations/gitlab/gitlab-client', () => ({
      gitlabClient: {
        getProjects: vi.fn().mockResolvedValue([]),
        listIssues: vi.fn().mockResolvedValue([]),
      },
    }));
    vi.doMock('../../integrations/jira/jira-client', () => ({
      jiraClient: {
        getProjects: vi.fn().mockResolvedValue([]),
        searchIssues: vi.fn().mockResolvedValue([]),
      },
    }));
    vi.doMock('../../work-items/database', () => ({
      workItemDatabase: {
        listWorkItems: vi.fn().mockReturnValue({ items: [], total: 0 }),
      },
    }));
    vi.doMock('../../agent-runs/database', () => ({
      agentRunDatabase: {
        listRuns: vi.fn().mockReturnValue({ runs: [], total: 0 }),
      },
    }));

    const { kanbanRoutes: freshRoutes } = await import('../kanban.js');
    app = Fastify();
    await app.register(freshRoutes, { prefix: '/api/kanban' });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/kanban/board' });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.cards.length).toBeGreaterThanOrEqual(1);
    const ghCard = body.cards.find((c: any) => c.platform === 'github');
    expect(ghCard).toBeDefined();
    expect(ghCard.key).toBe('github:testowner/test-repo:42');
    expect(ghCard.dependencyKeys.length).toBeGreaterThanOrEqual(1);

    await app.close();
  });

  it('should deduplicate cards when same issue appears across platforms', async () => {
    // This test validates dedup by key — same platform:repo:id should not appear twice
    vi.doMock('../../integrations/github/github-client', () => ({
      githubClient: {
        listRepositories: vi.fn().mockResolvedValue([
          { name: 'repo', owner: { login: 'owner' } },
        ]),
        listIssues: vi.fn().mockResolvedValue([
          {
            number: 1,
            title: 'Issue 1',
            html_url: 'https://github.com/owner/repo/issues/1',
            state: 'open',
            labels: [],
            assignee: null,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            body: '',
          },
          {
            number: 1,
            title: 'Issue 1 duplicate',
            html_url: 'https://github.com/owner/repo/issues/1',
            state: 'open',
            labels: [],
            assignee: null,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            body: '',
          },
        ]),
      },
    }));
    vi.doMock('../../integrations/gitlab/gitlab-client', () => ({
      gitlabClient: {
        getProjects: vi.fn().mockResolvedValue([]),
        listIssues: vi.fn().mockResolvedValue([]),
      },
    }));
    vi.doMock('../../integrations/jira/jira-client', () => ({
      jiraClient: {
        getProjects: vi.fn().mockResolvedValue([]),
        searchIssues: vi.fn().mockResolvedValue([]),
      },
    }));
    vi.doMock('../../work-items/database', () => ({
      workItemDatabase: {
        listWorkItems: vi.fn().mockReturnValue({ items: [], total: 0 }),
      },
    }));
    vi.doMock('../../agent-runs/database', () => ({
      agentRunDatabase: {
        listRuns: vi.fn().mockReturnValue({ runs: [], total: 0 }),
      },
    }));

    const { kanbanRoutes: freshRoutes } = await import('../kanban.js');
    const dedupApp = Fastify();
    await dedupApp.register(freshRoutes, { prefix: '/api/kanban' });
    await dedupApp.ready();

    const res = await dedupApp.inject({ method: 'GET', url: '/api/kanban/board' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const keys = body.cards.map((c: any) => c.key);
    const uniqueKeys = new Set(keys);
    expect(uniqueKeys.size).toBe(keys.length);

    await dedupApp.close();
  });
});
