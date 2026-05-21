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

  describe('processed issues', () => {
    it('should mark an issue as processed', () => {
      db.markIssueProcessed('PROJ-1', 'ws-1');
      expect(db.isIssueProcessed('PROJ-1')).toBe(true);
      expect(db.isIssueProcessed('PROJ-1', 'ws-1')).toBe(true);
    });

    it('should return false for unprocessed issue', () => {
      expect(db.isIssueProcessed('PROJ-999')).toBe(false);
      expect(db.isIssueProcessed('PROJ-999', 'ws-1')).toBe(false);
    });

    it('should be idempotent — marking twice does not throw', () => {
      db.markIssueProcessed('PROJ-1', 'ws-1');
      db.markIssueProcessed('PROJ-1', 'ws-1');
      expect(db.isIssueProcessed('PROJ-1')).toBe(true);
    });

    it('should filter isIssueProcessed by workspace', () => {
      db.markIssueProcessed('PROJ-1', 'ws-1');
      db.markIssueProcessed('PROJ-1', 'ws-2');
      expect(db.isIssueProcessed('PROJ-1', 'ws-1')).toBe(true);
      expect(db.isIssueProcessed('PROJ-1', 'ws-2')).toBe(true);
      expect(db.isIssueProcessed('PROJ-1', 'ws-3')).toBe(false);
    });

    it('should unmark an issue (no workspace filter removes all workspaces)', () => {
      db.markIssueProcessed('PROJ-1', 'ws-1');
      db.markIssueProcessed('PROJ-1', 'ws-2');
      db.unmarkIssueProcessed('PROJ-1');
      expect(db.isIssueProcessed('PROJ-1')).toBe(false);
    });

    it('should unmark an issue scoped to a specific workspace', () => {
      db.markIssueProcessed('PROJ-1', 'ws-1');
      db.markIssueProcessed('PROJ-1', 'ws-2');
      db.unmarkIssueProcessed('PROJ-1', 'ws-1');
      expect(db.isIssueProcessed('PROJ-1', 'ws-1')).toBe(false);
      expect(db.isIssueProcessed('PROJ-1', 'ws-2')).toBe(true);
    });

    it('should list processed issues for a specific workspace', () => {
      db.markIssueProcessed('PROJ-1', 'ws-1');
      db.markIssueProcessed('PROJ-2', 'ws-1');
      db.markIssueProcessed('PROJ-3', 'ws-2');
      const ws1 = db.listProcessedIssues('ws-1');
      expect(ws1).toEqual(expect.arrayContaining(['PROJ-1', 'PROJ-2']));
      expect(ws1).not.toContain('PROJ-3');
    });

    it('should list all processed issues when no workspace given', () => {
      db.markIssueProcessed('PROJ-1', 'ws-1');
      db.markIssueProcessed('PROJ-2', 'ws-2');
      const all = db.listProcessedIssues();
      expect(all).toEqual(expect.arrayContaining(['PROJ-1', 'PROJ-2']));
    });

    it('should return empty list when no issues processed', () => {
      expect(db.listProcessedIssues()).toEqual([]);
      expect(db.listProcessedIssues('ws-1')).toEqual([]);
    });

    it('should not interfere across workspaces', () => {
      db.markIssueProcessed('PROJ-1', 'ws-1');
      db.markIssueProcessed('PROJ-2', 'ws-2');
      db.unmarkIssueProcessed('PROJ-1', 'ws-1');
      expect(db.isIssueProcessed('PROJ-1', 'ws-1')).toBe(false);
      expect(db.isIssueProcessed('PROJ-2', 'ws-2')).toBe(true);
    });
  });

  describe('migrateProcessedIssuesFromJson', () => {
    let tmpDir: string;
    let fs: typeof import('fs');
    let path: typeof import('path');

    beforeEach(async () => {
      fs = await import('fs');
      path = await import('path');
      tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-migrate-'));
    });

    afterEach(() => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    it('should migrate keys from a legacy JSON file', () => {
      const jsonPath = path.join(tmpDir, 'processed-issues.json');
      fs.writeFileSync(jsonPath, JSON.stringify(['PROJ-1', 'PROJ-2']), 'utf-8');
      const count = db.migrateProcessedIssuesFromJson(jsonPath, 'ws-1');
      expect(count).toBe(2);
      expect(db.isIssueProcessed('PROJ-1', 'ws-1')).toBe(true);
      expect(db.isIssueProcessed('PROJ-2', 'ws-1')).toBe(true);
      expect(fs.existsSync(jsonPath)).toBe(false);
      expect(fs.existsSync(jsonPath + '.migrated')).toBe(true);
    });

    it('should return 0 when file does not exist', () => {
      const count = db.migrateProcessedIssuesFromJson('/nonexistent/path.json', 'ws-1');
      expect(count).toBe(0);
    });

    it('should return 0 for invalid JSON content', () => {
      const jsonPath = path.join(tmpDir, 'processed-issues.json');
      fs.writeFileSync(jsonPath, 'not-json', 'utf-8');
      const count = db.migrateProcessedIssuesFromJson(jsonPath, 'ws-1');
      expect(count).toBe(0);
    });

    it('should skip non-string entries in the array', () => {
      const jsonPath = path.join(tmpDir, 'processed-issues.json');
      fs.writeFileSync(jsonPath, JSON.stringify(['PROJ-1', 123, null, '', 'PROJ-2']), 'utf-8');
      const count = db.migrateProcessedIssuesFromJson(jsonPath, 'ws-1');
      expect(count).toBe(2);
    });

    it('should be idempotent — re-migrating does not duplicate', () => {
      const jsonPath = path.join(tmpDir, 'processed-issues.json');
      fs.writeFileSync(jsonPath, JSON.stringify(['PROJ-1']), 'utf-8');
      db.migrateProcessedIssuesFromJson(jsonPath, 'ws-1');
      // File was renamed, so re-running finds nothing
      const count2 = db.migrateProcessedIssuesFromJson(jsonPath, 'ws-1');
      expect(count2).toBe(0);
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