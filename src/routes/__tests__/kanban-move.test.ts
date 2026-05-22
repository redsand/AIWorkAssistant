import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { kanbanRoutes } from '../kanban';
import { kanbanEvents } from '../../kanban/events';

const {
  mockGetIssue,
  mockUpdateIssue,
  mockListIssues,
  mockEditIssue,
  mockJiraGetTransitions,
  mockJiraTransitionIssue,
  mockUpdateWorkItem,
  mockGitlabGetIssue,
  mockJiraGetIssue,
  mockListRuns,
} = vi.hoisted(() => ({
  mockGetIssue: vi.fn().mockResolvedValue({
    title: 'Test Issue',
    body: 'Test body',
    number: 42,
    state: 'open',
    labels: [{ name: 'bug' }],
  }),
  mockUpdateIssue: vi.fn().mockResolvedValue({}),
  mockListIssues: vi.fn().mockResolvedValue([]),
  mockEditIssue: vi.fn().mockResolvedValue({}),
  mockJiraGetTransitions: vi.fn().mockResolvedValue([
    { id: '21', name: 'In Progress', to: { name: 'In Progress' } },
    { id: '31', name: 'Done', to: { name: 'Done' } },
    { id: '41', name: 'To Do', to: { name: 'To Do' } },
    { id: '51', name: 'Blocked', to: { name: 'Blocked' } },
  ]),
  mockJiraTransitionIssue: vi.fn().mockResolvedValue(undefined),
  mockUpdateWorkItem: vi.fn().mockReturnValue({ id: 'wi-1', status: 'done' }),
  mockGitlabGetIssue: vi.fn().mockResolvedValue({
    title: 'GL Issue',
    description: 'desc',
    iid: 10,
    state: 'opened',
    labels: ['enhancement'],
  }),
  mockJiraGetIssue: vi.fn().mockResolvedValue({
    key: 'PROJ-1',
    fields: {
      summary: 'Jira Issue',
      status: { name: 'To Do' },
    },
  }),
  mockListRuns: vi.fn().mockReturnValue({ runs: [], total: 0 }),
}));

vi.mock('../../integrations/github/github-client', () => ({
  githubClient: {
    listRepositories: vi.fn().mockResolvedValue([]),
    listIssues: mockListIssues,
    getIssue: mockGetIssue,
    updateIssue: mockUpdateIssue,
  },
}));

vi.mock('../../integrations/gitlab/gitlab-client', () => ({
  gitlabClient: {
    getProjects: vi.fn().mockResolvedValue([]),
    listIssues: vi.fn().mockResolvedValue([]),
    getIssue: mockGitlabGetIssue,
    editIssue: mockEditIssue,
  },
}));

vi.mock('../../integrations/jira/jira-client', () => ({
  jiraClient: {
    getProjects: vi.fn().mockResolvedValue([]),
    searchIssues: vi.fn().mockResolvedValue([]),
    getIssue: mockJiraGetIssue,
    getTransitions: mockJiraGetTransitions,
    transitionIssue: mockJiraTransitionIssue,
  },
}));

vi.mock('../../work-items/database', () => ({
  workItemDatabase: {
    listWorkItems: vi.fn().mockReturnValue({ items: [], total: 0 }),
    updateWorkItem: mockUpdateWorkItem,
  },
}));

vi.mock('../../agent-runs/database', () => ({
  agentRunDatabase: {
    listRuns: mockListRuns,
  },
}));

vi.mock('../../kanban/worktree-manager', () => ({
  createWorktree: vi.fn().mockResolvedValue('/tmp/wt-test'),
  isClean: vi.fn().mockResolvedValue(true),
  removeWorktree: vi.fn().mockResolvedValue(undefined),
  listWorktrees: vi.fn().mockResolvedValue([]),
}));

vi.mock('../autonomous-loop/agent-runner', () => ({
  runAgent: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

function moveUrl(platform: string, repo: string, id: string) {
  return `/api/kanban/cards/${platform}/${encodeURIComponent(repo)}/${id}/move`;
}

describe('POST /cards/:platform/:repo/:id/move', () => {
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

  // ─── Validation ─────────────────────────────────────────────────────────────

  it('should return 400 for invalid platform', async () => {
    const res = await app.inject({
      method: 'POST',
      url: moveUrl('slack', 'owner/repo', '1'),
      payload: { column: 'done' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/invalid platform/i);
  });

  it('should return 400 for invalid repo (path traversal)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: moveUrl('github', '../etc', '1'),
      payload: { column: 'done' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('should return 400 when column is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: moveUrl('github', 'owner/repo', '1'),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/column/i);
  });

  it('should return 400 for invalid column value', async () => {
    const res = await app.inject({
      method: 'POST',
      url: moveUrl('github', 'owner/repo', '1'),
      payload: { column: 'wombat' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/invalid column/i);
  });

  // ─── GitHub ─────────────────────────────────────────────────────────────────

  it('should close a GitHub issue when moving to done', async () => {
    mockGetIssue.mockResolvedValueOnce({
      title: 'Test',
      body: '',
      state: 'open',
      labels: [{ name: 'bug' }],
    });
    mockUpdateIssue.mockResolvedValueOnce({});

    const res = await app.inject({
      method: 'POST',
      url: moveUrl('github', 'owner/repo', '42'),
      payload: { column: 'done' },
    });

    expect(res.statusCode).toBe(200);
    expect(mockUpdateIssue).toHaveBeenCalledWith(42, { state: 'closed', labels: ['bug'] }, 'owner', 'repo');
  });

  it('should reopen a GitHub issue when moving to backlog', async () => {
    mockGetIssue.mockResolvedValueOnce({
      title: 'Test',
      body: '',
      state: 'closed',
      labels: [],
    });
    mockUpdateIssue.mockResolvedValueOnce({});

    const res = await app.inject({
      method: 'POST',
      url: moveUrl('github', 'owner/repo', '42'),
      payload: { column: 'backlog' },
    });

    expect(res.statusCode).toBe(200);
    expect(mockUpdateIssue).toHaveBeenCalledWith(42, { state: 'open', labels: [] }, 'owner', 'repo');
  });

  it('should add blocked label when moving to blocked', async () => {
    mockGetIssue.mockResolvedValueOnce({
      title: 'Test',
      body: '',
      state: 'open',
      labels: [{ name: 'bug' }],
    });
    mockUpdateIssue.mockResolvedValueOnce({});

    const res = await app.inject({
      method: 'POST',
      url: moveUrl('github', 'owner/repo', '42'),
      payload: { column: 'blocked' },
    });

    expect(res.statusCode).toBe(200);
    expect(mockUpdateIssue).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        labels: expect.arrayContaining(['bug', 'blocked']),
      }),
      'owner',
      'repo',
    );
  });

  it('should add in progress label when moving to in_flight', async () => {
    mockGetIssue.mockReset();
    mockGetIssue.mockResolvedValue({
      title: 'Test',
      body: '',
      state: 'open',
      labels: [{ name: 'bug' }],
    });
    mockUpdateIssue.mockReset();
    mockUpdateIssue.mockResolvedValue({});

    const res = await app.inject({
      method: 'POST',
      url: moveUrl('github', 'owner/repo', '42'),
      payload: { column: 'in_flight' },
    });

    expect(res.statusCode).toBe(200);
    expect(mockUpdateIssue).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        labels: expect.arrayContaining(['bug', 'in progress']),
      }),
      'owner',
      'repo',
    );
  });

  it('should remove blocked label when moving GitHub issue from blocked to backlog', async () => {
    mockGetIssue.mockResolvedValueOnce({
      title: 'Test',
      body: '',
      state: 'open',
      labels: [{ name: 'bug' }, { name: 'blocked' }],
    });
    mockUpdateIssue.mockResolvedValueOnce({});

    const res = await app.inject({
      method: 'POST',
      url: moveUrl('github', 'owner/repo', '42'),
      payload: { column: 'backlog' },
    });

    expect(res.statusCode).toBe(200);
    expect(mockUpdateIssue).toHaveBeenCalledWith(
      42,
      { state: 'open', labels: ['bug'] },
      'owner',
      'repo',
    );
  });

  it('should remove in progress label when moving GitHub issue from in_flight to backlog', async () => {
    mockGetIssue.mockResolvedValueOnce({
      title: 'Test',
      body: '',
      state: 'open',
      labels: [{ name: 'feature' }, { name: 'in progress' }],
    });
    mockUpdateIssue.mockResolvedValueOnce({});

    const res = await app.inject({
      method: 'POST',
      url: moveUrl('github', 'owner/repo', '42'),
      payload: { column: 'backlog' },
    });

    expect(res.statusCode).toBe(200);
    expect(mockUpdateIssue).toHaveBeenCalledWith(
      42,
      { state: 'open', labels: ['feature'] },
      'owner',
      'repo',
    );
  });

  it('should remove blocked and in progress labels when moving GitHub issue to done', async () => {
    mockGetIssue.mockResolvedValueOnce({
      title: 'Test',
      body: '',
      state: 'open',
      labels: [{ name: 'bug' }, { name: 'blocked' }, { name: 'in progress' }],
    });
    mockUpdateIssue.mockResolvedValueOnce({});

    const res = await app.inject({
      method: 'POST',
      url: moveUrl('github', 'owner/repo', '42'),
      payload: { column: 'done' },
    });

    expect(res.statusCode).toBe(200);
    expect(mockUpdateIssue).toHaveBeenCalledWith(
      42,
      { state: 'closed', labels: ['bug'] },
      'owner',
      'repo',
    );
  });

  it('should return 400 for non-numeric GitHub issue id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: moveUrl('github', 'owner/repo', 'abc'),
      payload: { column: 'done' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/invalid issue id/i);
  });

  it('should return 404 when moving GitHub issue to done and issue does not exist', async () => {
    mockGetIssue.mockResolvedValueOnce(null);

    const res = await app.inject({
      method: 'POST',
      url: moveUrl('github', 'owner/repo', '42'),
      payload: { column: 'done' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/issue not found/i);
    expect(mockUpdateIssue).not.toHaveBeenCalled();
  });

  // ─── GitLab ─────────────────────────────────────────────────────────────────

  it('should close a GitLab issue when moving to done', async () => {
    mockGitlabGetIssue.mockResolvedValueOnce({
      title: 'GL',
      description: '',
      state: 'opened',
      labels: ['enhancement'],
    });
    mockEditIssue.mockResolvedValueOnce({});

    const res = await app.inject({
      method: 'POST',
      url: moveUrl('gitlab', '123', '10'),
      payload: { column: 'done' },
    });

    expect(res.statusCode).toBe(200);
    expect(mockEditIssue).toHaveBeenCalledWith('123', 10, { stateEvent: 'close', labels: 'enhancement' });
  });

  it('should reopen a GitLab issue when moving to backlog', async () => {
    mockGitlabGetIssue.mockResolvedValueOnce({
      title: 'GL',
      description: '',
      state: 'closed',
      labels: [],
    });
    mockEditIssue.mockResolvedValueOnce({});

    const res = await app.inject({
      method: 'POST',
      url: moveUrl('gitlab', '123', '10'),
      payload: { column: 'backlog' },
    });

    expect(res.statusCode).toBe(200);
    expect(mockEditIssue).toHaveBeenCalledWith('123', 10, { stateEvent: 'reopen', labels: '' });
  });

  it('should add blocked label on GitLab when moving to blocked', async () => {
    mockGitlabGetIssue.mockResolvedValueOnce({
      title: 'GL',
      description: '',
      state: 'opened',
      labels: ['enhancement'],
    });
    mockEditIssue.mockResolvedValueOnce({});

    const res = await app.inject({
      method: 'POST',
      url: moveUrl('gitlab', '123', '10'),
      payload: { column: 'blocked' },
    });

    expect(res.statusCode).toBe(200);
    expect(mockEditIssue).toHaveBeenCalledWith(
      '123',
      10,
      expect.objectContaining({
        labels: expect.stringContaining('blocked'),
      }),
    );
  });

  it('should remove blocked label when moving GitLab issue from blocked to backlog', async () => {
    mockGitlabGetIssue.mockResolvedValueOnce({
      title: 'GL',
      description: '',
      state: 'opened',
      labels: ['enhancement', 'blocked'],
    });
    mockEditIssue.mockResolvedValueOnce({});

    const res = await app.inject({
      method: 'POST',
      url: moveUrl('gitlab', '123', '10'),
      payload: { column: 'backlog' },
    });

    expect(res.statusCode).toBe(200);
    expect(mockEditIssue).toHaveBeenCalledWith(
      '123',
      10,
      { stateEvent: 'reopen', labels: 'enhancement' },
    );
  });

  it('should remove in progress label when moving GitLab issue from in_flight to backlog', async () => {
    mockGitlabGetIssue.mockResolvedValueOnce({
      title: 'GL',
      description: '',
      state: 'opened',
      labels: ['feature', 'in progress'],
    });
    mockEditIssue.mockResolvedValueOnce({});

    const res = await app.inject({
      method: 'POST',
      url: moveUrl('gitlab', '123', '10'),
      payload: { column: 'backlog' },
    });

    expect(res.statusCode).toBe(200);
    expect(mockEditIssue).toHaveBeenCalledWith(
      '123',
      10,
      { stateEvent: 'reopen', labels: 'feature' },
    );
  });

  it('should remove blocked and in progress labels when moving GitLab issue to done', async () => {
    mockGitlabGetIssue.mockResolvedValueOnce({
      title: 'GL',
      description: '',
      state: 'opened',
      labels: ['bug', 'blocked', 'in progress'],
    });
    mockEditIssue.mockResolvedValueOnce({});

    const res = await app.inject({
      method: 'POST',
      url: moveUrl('gitlab', '123', '10'),
      payload: { column: 'done' },
    });

    expect(res.statusCode).toBe(200);
    expect(mockEditIssue).toHaveBeenCalledWith(
      '123',
      10,
      { stateEvent: 'close', labels: 'bug' },
    );
  });

  it('should return 404 when moving GitLab issue to done and issue does not exist', async () => {
    mockGitlabGetIssue.mockResolvedValueOnce(null);

    const res = await app.inject({
      method: 'POST',
      url: moveUrl('gitlab', '123', '10'),
      payload: { column: 'done' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/issue not found/i);
    expect(mockEditIssue).not.toHaveBeenCalled();
  });

  it('should return 400 for non-numeric GitLab issue id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: moveUrl('gitlab', '123', 'not-a-number'),
      payload: { column: 'done' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/invalid issue id/i);
  });

  // ─── Jira ───────────────────────────────────────────────────────────────────

  it('should transition a Jira issue to Done', async () => {
    mockJiraGetTransitions.mockResolvedValueOnce([
      { id: '31', name: 'Done', to: { name: 'Done' } },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: moveUrl('jira', 'PROJ', 'PROJ-1'),
      payload: { column: 'done' },
    });

    expect(res.statusCode).toBe(200);
    expect(mockJiraTransitionIssue).toHaveBeenCalledWith('PROJ-1', '31', expect.any(String));
  });

  it('should transition a Jira issue to In Progress', async () => {
    mockJiraGetTransitions.mockResolvedValueOnce([
      { id: '21', name: 'In Progress', to: { name: 'In Progress' } },
    ]);

    const res = await app.inject({
      method: 'POST',
      url: moveUrl('jira', 'PROJ', 'PROJ-1'),
      payload: { column: 'in_flight' },
    });

    expect(res.statusCode).toBe(200);
    expect(mockJiraTransitionIssue).toHaveBeenCalledWith('PROJ-1', '21', expect.any(String));
  });

  it('should return 409 when no matching Jira transition is found', async () => {
    mockJiraGetTransitions.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: 'POST',
      url: moveUrl('jira', 'PROJ', 'PROJ-1'),
      payload: { column: 'blocked' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/transition/i);
  });

  it('should return 409 when Jira getTransitions returns null', async () => {
    mockJiraGetTransitions.mockResolvedValueOnce(null as any);

    const res = await app.inject({
      method: 'POST',
      url: moveUrl('jira', 'PROJ', 'PROJ-1'),
      payload: { column: 'in_flight' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/transition/i);
  });

  // ─── Work Items ─────────────────────────────────────────────────────────────

  it('should update work item status to done', async () => {
    mockUpdateWorkItem.mockReturnValueOnce({ id: 'wi-1', status: 'done' });

    const res = await app.inject({
      method: 'POST',
      url: moveUrl('work_items', 'manual', 'wi-1'),
      payload: { column: 'done' },
    });

    expect(res.statusCode).toBe(200);
    expect(mockUpdateWorkItem).toHaveBeenCalledWith('wi-1', { status: 'done' });
  });

  it('should update work item status to active for in_flight', async () => {
    mockUpdateWorkItem.mockReturnValueOnce({ id: 'wi-1', status: 'active' });

    const res = await app.inject({
      method: 'POST',
      url: moveUrl('work_items', 'manual', 'wi-1'),
      payload: { column: 'in_flight' },
    });

    expect(res.statusCode).toBe(200);
    expect(mockUpdateWorkItem).toHaveBeenCalledWith('wi-1', { status: 'active' });
  });

  it('should update work item status to proposed for backlog', async () => {
    mockUpdateWorkItem.mockReturnValueOnce({ id: 'wi-1', status: 'proposed' });

    const res = await app.inject({
      method: 'POST',
      url: moveUrl('work_items', 'manual', 'wi-1'),
      payload: { column: 'backlog' },
    });

    expect(res.statusCode).toBe(200);
    expect(mockUpdateWorkItem).toHaveBeenCalledWith('wi-1', { status: 'proposed' });
  });

  it('should update work item status to blocked', async () => {
    mockUpdateWorkItem.mockReturnValueOnce({ id: 'wi-1', status: 'blocked' });

    const res = await app.inject({
      method: 'POST',
      url: moveUrl('work_items', 'manual', 'wi-1'),
      payload: { column: 'blocked' },
    });

    expect(res.statusCode).toBe(200);
    expect(mockUpdateWorkItem).toHaveBeenCalledWith('wi-1', { status: 'blocked' });
  });

  // ─── SSE & cache ────────────────────────────────────────────────────────────

  it('should emit card.updated SSE event on successful move', async () => {
    const emitSpy = vi.spyOn(kanbanEvents, 'emitEvent');
    mockGetIssue.mockResolvedValueOnce({
      title: 'Test',
      body: '',
      state: 'open',
      labels: [],
    });
    mockUpdateIssue.mockResolvedValueOnce({});

    const res = await app.inject({
      method: 'POST',
      url: moveUrl('github', 'owner/repo', '42'),
      payload: { column: 'done' },
    });

    expect(res.statusCode).toBe(200);
    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'card.updated',
      }),
    );

    emitSpy.mockRestore();
  });

  it('should return 500 when platform API fails', async () => {
    mockUpdateIssue.mockReset();
    mockUpdateIssue.mockRejectedValue(new Error('API rate limit'));

    const res = await app.inject({
      method: 'POST',
      url: moveUrl('github', 'owner/repo', '42'),
      payload: { column: 'done' },
    });

    expect(res.statusCode).toBe(500);
    expect(res.json().error).toMatch(/API rate limit/);
  });
});

describe('GET /token-status', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await app.register(kanbanRoutes, { prefix: '/api/kanban' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('should return token status for all platforms', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/kanban/token-status',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty('github');
    expect(body).toHaveProperty('gitlab');
    expect(body).toHaveProperty('jira');
    expect(body).toHaveProperty('work_items');
    expect(body.work_items).toBe(true);
  });
});
