/**
 * Kanban smoke e2e — drives the full happy path with a real Fastify server,
 * real SSE connections, real git worktrees, and a stubbed agent.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import http from 'http';
import { EventEmitter } from 'events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

// ─── Mock database ────────────────────────────────────────────────────────────

const {
  mockStartRun,
  mockFailRun,
  mockCompleteRun,
  mockListRuns,
  mockGetRun,
  mockGetRunSteps,
  mockGetKanbanSetting,
  mockGetAllKanbanSettings,
} = vi.hoisted(() => ({
  mockStartRun: vi.fn(),
  mockFailRun: vi.fn(),
  mockCompleteRun: vi.fn(),
  mockListRuns: vi.fn().mockReturnValue({ runs: [], total: 0 }),
  mockGetRun: vi.fn().mockReturnValue(null),
  mockGetRunSteps: vi.fn().mockReturnValue([]),
  mockGetKanbanSetting: vi.fn().mockReturnValue(null),
  mockGetAllKanbanSettings: vi.fn().mockReturnValue({}),
}));

vi.mock('../agent-runs/database', () => ({
  agentRunDatabase: {
    listRuns: mockListRuns,
    getRun: mockGetRun,
    startRun: mockStartRun,
    failRun: mockFailRun,
    completeRun: mockCompleteRun,
    getRunSteps: mockGetRunSteps,
    getKanbanSetting: mockGetKanbanSetting,
    getAllKanbanSettings: mockGetAllKanbanSettings,
  },
}));

// ─── Mock platform integrations ──────────────────────────────────────────────

vi.mock('../integrations/github/github-client', () => ({
  githubClient: {
    listRepositories: vi.fn().mockResolvedValue([]),
    listIssues: vi.fn().mockResolvedValue([]),
    getIssue: vi.fn().mockResolvedValue(null),
    updateIssue: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('../integrations/gitlab/gitlab-client', () => ({
  gitlabClient: {
    getProjects: vi.fn().mockResolvedValue([]),
    listIssues: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../integrations/jira/jira-client', () => ({
  jiraClient: {
    getProjects: vi.fn().mockResolvedValue([]),
    searchIssues: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../work-items/database', () => ({
  workItemDatabase: {
    listWorkItems: vi.fn().mockReturnValue({ items: [], total: 0 }),
  },
}));

vi.mock('../autonomous-loop/agent-runner', () => ({
  runAgent: vi.fn(),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

const REPO_DIR_NAME = `kanban-e2e-${process.pid}`;
const TEST_REPO = `e2e-owner/${REPO_DIR_NAME}`;

function makeHttpRequest(
  baseUrl: string,
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${baseUrl}${urlPath}`);
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          try { resolve({ status: res.statusCode || 0, data: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode || 0, data }); }
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

/** SSE connection with consumed-index tracking so waitForEvent finds any unconsumed event. */
function createSSEConnection(
  baseUrl: string,
): Promise<{
  events: Array<{ id: string; type: string; data: any }>;
  waitForEvent: (type: string, timeoutMs: number) => Promise<any>;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${baseUrl}/api/kanban/stream`);
    const events: Array<{ id: string; type: string; data: any }> = [];
    const consumed = new Set<number>();
    let buffer = '';

    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: 'GET' },
      (res) => {
        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
          while (buffer.includes('\n\n')) {
            const idx = buffer.indexOf('\n\n');
            const frame = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            if (frame.startsWith(': ')) continue;

            const lines = frame.split('\n');
            let id = '', eventType = '', dataStr = '';
            for (const line of lines) {
              if (line.startsWith('id: ')) id = line.slice(4);
              else if (line.startsWith('event: ')) eventType = line.slice(7);
              else if (line.startsWith('data: ')) dataStr = line.slice(6);
            }
            if (eventType && dataStr) {
              try { events.push({ id, type: eventType, data: JSON.parse(dataStr) }); }
              catch { /* skip malformed */ }
            }
          }
        });
        res.on('error', reject);

        resolve({
          events,
          waitForEvent(type: string, timeoutMs: number) {
            return new Promise((resWait, rejWait) => {
              const startTime = Date.now();

              const tryFind = () => {
                for (let i = 0; i < events.length; i++) {
                  if (!consumed.has(i) && events[i].type === type) {
                    consumed.add(i);
                    return events[i];
                  }
                }
                return null;
              };

              const immediate = tryFind();
              if (immediate) { resWait(immediate); return; }

              const timer = setInterval(() => {
                const f = tryFind();
                if (f) { clearInterval(timer); resWait(f); }
                else if (Date.now() - startTime > timeoutMs) {
                  clearInterval(timer);
                  rejWait(new Error(
                    `Timeout waiting for "${type}". Got: [${events.map(e => e.type).join(', ')}]`,
                  ));
                }
              }, 50);
            });
          },
          close: () => { req.destroy(); },
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe('Kanban Smoke E2E', () => {
  let app: FastifyInstance;
  let baseUrl: string;
  let tempRepoPath: string;

  beforeAll(async () => {
    // 1. Create a temp git repo at ../<name> so resolveRepoPath() finds it
    const parentDir = path.dirname(process.cwd());
    tempRepoPath = path.join(parentDir, REPO_DIR_NAME);

    fs.mkdirSync(tempRepoPath, { recursive: true });
    execSync('git init --initial-branch=main', { cwd: tempRepoPath, stdio: 'pipe' });
    execSync('git config user.email test@test.com', { cwd: tempRepoPath, stdio: 'pipe' });
    execSync('git config user.name Test', { cwd: tempRepoPath, stdio: 'pipe' });
    fs.writeFileSync(path.join(tempRepoPath, 'README.md'), '# e2e\n');
    execSync('git add .', { cwd: tempRepoPath, stdio: 'pipe' });
    execSync('git commit -m initial', { cwd: tempRepoPath, stdio: 'pipe' });

    // 2. Seed mock GitHub issue
    const { githubClient } = await import('../integrations/github/github-client');
    (githubClient.getIssue as any).mockResolvedValue({
      number: 42,
      title: 'E2E smoke test issue',
      body: 'Full happy-path validation',
      state: 'open',
      html_url: `https://github.com/${TEST_REPO}/issues/42`,
    });

    // 3. Configure mock DB
    mockListRuns.mockReturnValue({ runs: [], total: 0 });
    mockGetKanbanSetting.mockReturnValue(null);
    mockGetAllKanbanSettings.mockReturnValue({});
    mockStartRun.mockReturnValue({
      id: 'e2e-run-1',
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
      issueId: '42',
      issuePlatform: 'github',
      issueRepo: TEST_REPO,
      worktreePath: '',
      branch: '',
      agentType: 'claude',
    });

    // 4. Start Fastify on random port
    const { kanbanRoutes } = await import('../routes/kanban');
    app = Fastify();
    await app.register(kanbanRoutes, { prefix: '/api/kanban' });
    await app.ready();
    baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  }, 20000);

  afterAll(async () => {
    if (app) await app.close();

    // Clean up worktrees and temp repo
    if (tempRepoPath && fs.existsSync(tempRepoPath)) {
      try { execSync('git worktree prune', { cwd: tempRepoPath, stdio: 'pipe' }); } catch { /* ignore */ }
      const worktreeRoot = path.resolve(tempRepoPath, '..', '.kanban-worktrees');
      if (fs.existsSync(worktreeRoot)) {
        fs.rmSync(worktreeRoot, { recursive: true, force: true });
      }
      fs.rmSync(tempRepoPath, { recursive: true, force: true });
    }
  }, 20000);

  it('drives the full happy path: start agent, receive SSE steps, complete, cleanup worktree', async () => {
    // ── Connect SSE BEFORE starting the agent ───────────────────────────────
    const sse = await createSSEConnection(baseUrl);

    // ── Stub runAgent: emit two agent.step events then exit successfully ─────
    const { runAgent } = await import('../autonomous-loop/agent-runner');
    (runAgent as any).mockImplementation(
      async (_p: any, _c: any, _l: any, _r: any, _log: any, onChildReady: any, onStep: any) => {
        const mockChild = new EventEmitter() as any;
        mockChild.kill = vi.fn().mockReturnValue(true);
        mockChild.killed = false;
        mockChild.stdin = { write: vi.fn(), end: vi.fn() };
        mockChild.stdout = new EventEmitter();
        mockChild.stderr = new EventEmitter();
        onChildReady?.(mockChild);

        // First step — always emits (lastStepEmit starts at 0)
        onStep?.({ output: 'Step 1: Reading source files' });

        // Wait past the 1-second throttle so both steps produce SSE events
        await new Promise((r) => setTimeout(r, 1100));

        // Second step
        onStep?.({ output: 'Step 2: Writing changes' });

        return { finDetected: true, exitCode: 0, ranTests: false };
      },
    );

    // ── POST /start ──────────────────────────────────────────────────────────
    const startRes = await makeHttpRequest(
      baseUrl,
      'POST',
      '/api/kanban/cards/github/42/start',
      { repo: TEST_REPO, agent: 'claude' },
    );

    expect(startRes.status).toBe(200);
    const { agentRunId, worktreePath, branch } = startRes.data;
    expect(agentRunId).toBe('e2e-run-1');
    expect(branch).toContain('ai/issue-42');
    expect(fs.existsSync(worktreePath)).toBe(true);

    // ── Receive SSE events (consumed-index tracker finds any unconsumed event) ──

    // agent.started
    const started = await sse.waitForEvent('agent.started', 5000);
    expect(started.data.agent.agentRunId).toBe(agentRunId);
    expect(started.data.agent.status).toBe('running');

    // Two agent.step events
    const step1 = await sse.waitForEvent('agent.step', 5000);
    expect(step1.data.agentRunId).toBe(agentRunId);
    expect(step1.data.toolName).toBe('output');

    const step2 = await sse.waitForEvent('agent.step', 5000);
    expect(step2.data.agentRunId).toBe(agentRunId);
    expect(step2.data.stepOrder).toBeGreaterThan(step1.data.stepOrder);

    // agent.completed
    const completed = await sse.waitForEvent('agent.completed', 5000);
    expect(completed.data.agentRunId).toBe(agentRunId);
    expect(completed.data.status).toBe('completed');

    // ── Assert agent_runs row is complete ────────────────────────────────────
    expect(mockCompleteRun).toHaveBeenCalledWith(
      agentRunId,
      expect.objectContaining({ toolLoopCount: expect.any(Number) }),
    );

    // ── Assert worktree on disk ─────────────────────────────────────────────
    expect(fs.existsSync(worktreePath)).toBe(true);
    expect(fs.existsSync(path.join(worktreePath, '.git'))).toBe(true);
    expect(fs.existsSync(path.join(worktreePath, 'README.md'))).toBe(true);

    // ── DELETE the worktree via API ──────────────────────────────────────────
    mockGetRun.mockReturnValue({
      id: agentRunId,
      worktreePath,
      status: 'completed',
    });

    const deleteRes = await makeHttpRequest(
      baseUrl,
      'DELETE',
      `/api/kanban/worktrees/${agentRunId}`,
    );

    expect(deleteRes.status).toBe(200);
    expect(deleteRes.data.ok).toBe(true);

    // Worktree should be gone from disk
    expect(fs.existsSync(worktreePath)).toBe(false);

    sse.close();
  }, 25000);
});
