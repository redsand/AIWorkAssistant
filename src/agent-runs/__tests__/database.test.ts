import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentRunDatabase } from '../database';
import { sanitizeValue } from '../sanitizer';

describe('AgentRunDatabase', () => {
  let db: AgentRunDatabase;
  const testDbPath = ':memory:';

  beforeEach(() => {
    db = new AgentRunDatabase(testDbPath);
  });

  afterEach(() => {
    db.close();
  });

  describe('startRun', () => {
    it('should create a run with status running', () => {
      const run = db.startRun({ sessionId: 'sess-1', userId: 'user-1', mode: 'productivity' });
      expect(run.id).toBeDefined();
      expect(run.status).toBe('running');
      expect(run.sessionId).toBe('sess-1');
      expect(run.userId).toBe('user-1');
      expect(run.mode).toBe('productivity');
    });
  });

  describe('completeRun', () => {
    it('should mark run as completed with usage data', () => {
      const run = db.startRun({ sessionId: 'sess-1', userId: 'user-1', mode: 'productivity' });
      db.completeRun(run.id, { model: 'gpt-4', promptTokens: 100, completionTokens: 50, totalTokens: 150, toolLoopCount: 2 });
      const result = db.getRun(run.id);
      expect(result?.status).toBe('completed');
      expect(result?.model).toBe('gpt-4');
      expect(result?.promptTokens).toBe(100);
      expect(result?.toolLoopCount).toBe(2);
    });
  });

  describe('failRun', () => {
    it('should mark run as failed with error message', () => {
      const run = db.startRun({ sessionId: 'sess-1', userId: 'user-1', mode: 'productivity' });
      db.failRun(run.id, 'Something went wrong');
      const result = db.getRun(run.id);
      expect(result?.status).toBe('failed');
      expect(result?.errorMessage).toBe('Something went wrong');
    });
  });

  describe('addStep', () => {
    it('should add steps and retrieve them', () => {
      const run = db.startRun({ sessionId: 'sess-1', userId: 'user-1', mode: 'productivity' });
      db.addStep({ runId: run.id, stepType: 'model_request', stepOrder: 1 });
      db.addStep({ runId: run.id, stepType: 'model_response', content: { model: 'gpt-4' }, stepOrder: 2 });
      db.addStep({ runId: run.id, stepType: 'tool_call', toolName: 'jira.list_assigned', sanitizedParams: { jql: 'assignee = me' }, stepOrder: 3 });
      const steps = db.getRunSteps(run.id);
      expect(steps).toHaveLength(3);
      expect(steps[0].stepType).toBe('model_request');
      expect(steps[2].toolName).toBe('jira.list_assigned');
    });
  });

  describe('listRuns', () => {
    it('should filter runs by status and userId', () => {
      const run1 = db.startRun({ userId: 'user-1', mode: 'productivity' });
      db.startRun({ userId: 'user-2', mode: 'engineering' });
      db.completeRun(run1.id, { toolLoopCount: 0 });
      const result = db.listRuns({ status: 'running' });
      expect(result.runs).toHaveLength(1);
      expect(result.runs[0].userId).toBe('user-2');
    });
  });

  describe('getStats', () => {
    it('should return run statistics', () => {
      const run = db.startRun({ userId: 'user-1', mode: 'productivity' });
      db.completeRun(run.id, { toolLoopCount: 1 });
      const stats = db.getStats();
      expect(stats.totalRuns).toBe(1);
      expect(stats.completedRuns).toBe(1);
      expect(stats.runningRuns).toBe(0);
    });
  });

  describe('reapStuckAicoderRuns', () => {
    function backdateActivity(runId: string, iso: string) {
      (db as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } })
        .db.prepare('UPDATE agent_runs SET last_activity_at = ?, started_at = ? WHERE id = ?')
        .run(iso, iso, runId);
    }

    it('marks a long-silent aicoder run as failed', () => {
      const run = db.startRun({ userId: 'aicoder', mode: 'engineering' });
      const now = new Date('2026-07-03T12:00:00Z');
      backdateActivity(run.id, new Date(now.getTime() - 20 * 60 * 1000).toISOString());

      const result = db.reapStuckAicoderRuns(now);

      expect(result.count).toBe(1);
      const reaped = db.getRun(run.id);
      expect(reaped?.status).toBe('failed');
      expect(reaped?.errorMessage).toMatch(/Stuck/);
    });

    it('marks a run with zero tool-loop activity as failed after the startup-stall threshold', () => {
      const run = db.startRun({ userId: 'aicoder', mode: 'engineering' });
      const now = new Date('2026-07-03T12:00:00Z');
      backdateActivity(run.id, new Date(now.getTime() - 6 * 60 * 1000).toISOString());

      const result = db.reapStuckAicoderRuns(now);

      expect(result.count).toBe(1);
      expect(db.getRun(run.id)?.status).toBe('failed');
    });

    it('leaves a recently-active aicoder run alone', () => {
      const run = db.startRun({ userId: 'aicoder', mode: 'engineering' });
      db.updateToolLoopCount(run.id, 3);
      const now = new Date('2026-07-03T12:00:00Z');

      const result = db.reapStuckAicoderRuns(now);

      expect(result.count).toBe(0);
      expect(db.getRun(run.id)?.status).toBe('running');
    });

    it('does not touch stuck runs belonging to a different user_id', () => {
      const run = db.startRun({ userId: 'user-1', mode: 'productivity' });
      const now = new Date('2026-07-03T12:00:00Z');
      backdateActivity(run.id, new Date(now.getTime() - 20 * 60 * 1000).toISOString());

      const result = db.reapStuckAicoderRuns(now);

      expect(result.count).toBe(0);
      expect(db.getRun(run.id)?.status).toBe('running');
    });

    it('clears the repo run lock held by a reaped run', () => {
      const run = db.startRun({ userId: 'aicoder', mode: 'engineering' });
      db.acquireRepoRunLock('github', 'redsand/claimkit', run.id);
      const now = new Date('2026-07-03T12:00:00Z');
      backdateActivity(run.id, new Date(now.getTime() - 20 * 60 * 1000).toISOString());

      db.reapStuckAicoderRuns(now);

      const reacquired = db.acquireRepoRunLock('github', 'redsand/claimkit', 'some-other-run');
      expect(reacquired).toEqual({ acquired: true });
    });
  });

  describe('repo run locks', () => {
    it('acquires a lock for a free (source, repo) scope', () => {
      const result = db.acquireRepoRunLock('github', 'redsand/claimkit', 'run-1');
      expect(result).toEqual({ acquired: true });
    });

    it('rejects a second run for the same (source, repo) scope', () => {
      db.acquireRepoRunLock('github', 'redsand/claimkit', 'run-1');
      const result = db.acquireRepoRunLock('github', 'redsand/claimkit', 'run-2');
      expect(result).toEqual({ acquired: false, existingRunId: 'run-1' });
    });

    it('is idempotent for the same run re-acquiring its own lock', () => {
      db.acquireRepoRunLock('github', 'redsand/claimkit', 'run-1');
      const result = db.acquireRepoRunLock('github', 'redsand/claimkit', 'run-1');
      expect(result).toEqual({ acquired: true });
    });

    it('treats source/repo as case-insensitive when scoping the lock', () => {
      db.acquireRepoRunLock('GitHub', 'Redsand/ClaimKit', 'run-1');
      const result = db.acquireRepoRunLock('github', 'redsand/claimkit', 'run-2');
      expect(result).toEqual({ acquired: false, existingRunId: 'run-1' });
    });

    it('allows a different repo to acquire its own lock concurrently', () => {
      db.acquireRepoRunLock('github', 'redsand/claimkit', 'run-1');
      const result = db.acquireRepoRunLock('github', 'redsand/aiworkassistant', 'run-2');
      expect(result).toEqual({ acquired: true });
    });

    it('releaseRepoRunLock frees the scope for a new run', () => {
      db.acquireRepoRunLock('github', 'redsand/claimkit', 'run-1');
      db.releaseRepoRunLock('run-1');
      const result = db.acquireRepoRunLock('github', 'redsand/claimkit', 'run-2');
      expect(result).toEqual({ acquired: true });
    });

    it('an expired lock (past its TTL) is auto-released on the next acquire attempt', () => {
      db.acquireRepoRunLock('github', 'redsand/claimkit', 'run-1', 1000);
      const later = new Date(Date.now() + 5000);
      db.releaseExpiredRepoRunLocks(later);
      const result = db.acquireRepoRunLock('github', 'redsand/claimkit', 'run-2');
      expect(result).toEqual({ acquired: true });
    });
  });
});

// File: src/agent-runs/__tests__/sanitizer.test.ts

describe('sanitizeValue', () => {
  it('should redact known secret field names', () => {
    const result = sanitizeValue({ apiKey: 'sk-12345', token: 'abc', password: 'secret', authorization: 'Bearer xyz', secret: 'hidden', access_token: 'at-1', refresh_token: 'rt-1' }) as Record<string, unknown>;
    expect(result.apiKey).toBe('[REDACTED]');
    expect(result.token).toBe('[REDACTED]');
    expect(result.password).toBe('[REDACTED]');
    expect(result.authorization).toBe('[REDACTED]');
    expect(result.secret).toBe('[REDACTED]');
    expect(result.access_token).toBe('[REDACTED]');
    expect(result.refresh_token).toBe('[REDACTED]');
  });

  it('should preserve non-secret fields', () => {
    const result = sanitizeValue({ name: 'test', count: 5, active: true }) as Record<string, unknown>;
    expect(result.name).toBe('test');
    expect(result.count).toBe(5);
    expect(result.active).toBe(true);
  });

  it('should handle nested objects', () => {
    const result = sanitizeValue({ config: { apiKey: 'sk-123', region: 'us-east' } }) as { config: Record<string, unknown> };
    expect(result.config.apiKey).toBe('[REDACTED]');
    expect(result.config.region).toBe('us-east');
  });

  it('should handle arrays', () => {
    const result = sanitizeValue([{ apiKey: 'sk-1' }, { apiKey: 'sk-2' }]) as Record<string, unknown>[];
    expect(result[0].apiKey).toBe('[REDACTED]');
    expect(result[1].apiKey).toBe('[REDACTED]');
  });

  it('should handle null and undefined', () => {
    expect(sanitizeValue(null)).toBeNull();
    expect(sanitizeValue(undefined)).toBeUndefined();
  });
});