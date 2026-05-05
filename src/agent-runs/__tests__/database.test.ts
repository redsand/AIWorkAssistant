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
      const run2 = db.startRun({ userId: 'user-2', mode: 'engineering' });
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
});

// File: src/agent-runs/__tests__/sanitizer.test.ts

describe('sanitizeValue', () => {
  it('should redact known secret field names', () => {
    const result = sanitizeValue({ apiKey: 'sk-12345', token: 'abc', password: 'secret', authorization: 'Bearer xyz', secret: 'hidden', access_token: 'at-1', refresh_token: 'rt-1' });
    expect(result.apiKey).toBe('[REDACTED]');
    expect(result.token).toBe('[REDACTED]');
    expect(result.password).toBe('[REDACTED]');
    expect(result.authorization).toBe('[REDACTED]');
    expect(result.secret).toBe('[REDACTED]');
    expect(result.access_token).toBe('[REDACTED]');
    expect(result.refresh_token).toBe('[REDACTED]');
  });

  it('should preserve non-secret fields', () => {
    const result = sanitizeValue({ name: 'test', count: 5, active: true });
    expect(result.name).toBe('test');
    expect(result.count).toBe(5);
    expect(result.active).toBe(true);
  });

  it('should handle nested objects', () => {
    const result = sanitizeValue({ config: { apiKey: 'sk-123', region: 'us-east' } });
    expect(result.config.apiKey).toBe('[REDACTED]');
    expect(result.config.region).toBe('us-east');
  });

  it('should handle arrays', () => {
    const result = sanitizeValue([{ apiKey: 'sk-1' }, { apiKey: 'sk-2' }]);
    expect(result[0].apiKey).toBe('[REDACTED]');
    expect(result[1].apiKey).toBe('[REDACTED]');
  });

  it('should handle null and undefined', () => {
    expect(sanitizeValue(null)).toBeNull();
    expect(sanitizeValue(undefined)).toBeUndefined();
  });
});