import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentRunDatabase } from '../database';

describe('AgentRunDatabase agent_type', () => {
  let db: AgentRunDatabase;

  beforeEach(() => {
    db = new AgentRunDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  describe('startRun with agentType', () => {
    it('should store agent_type as null when not provided', () => {
      const run = db.startRun({
        userId: 'user-1',
        mode: 'interactive',
      });
      expect(run.agentType).toBeNull();

      const fetched = db.getRun(run.id);
      expect(fetched?.agentType).toBeNull();
    });

    it('should store agent_type when provided', () => {
      const run = db.startRun({
        userId: 'user-1',
        mode: 'interactive',
        agentType: 'claude',
      });
      expect(run.agentType).toBe('claude');

      const fetched = db.getRun(run.id);
      expect(fetched?.agentType).toBe('claude');
    });

    it('should store different agent types (codex, opencode)', () => {
      const run1 = db.startRun({
        userId: 'user-1',
        mode: 'interactive',
        agentType: 'codex',
      });
      const run2 = db.startRun({
        userId: 'user-1',
        mode: 'interactive',
        agentType: 'opencode',
      });

      expect(db.getRun(run1.id)?.agentType).toBe('codex');
      expect(db.getRun(run2.id)?.agentType).toBe('opencode');
    });
  });

  describe('listRuns with agentType filter', () => {
    it('should list runs and include agentType', () => {
      db.startRun({
        userId: 'user-1',
        mode: 'interactive',
        issueId: '42',
        issuePlatform: 'github',
        issueRepo: 'owner/repo',
        agentType: 'claude',
      });
      db.startRun({
        userId: 'user-1',
        mode: 'interactive',
        issueId: '43',
        issuePlatform: 'github',
        issueRepo: 'owner/repo',
        agentType: 'codex',
      });

      const result = db.listRuns({ status: 'running', limit: 100 });
      expect(result.runs).toHaveLength(2);

      const claudeRun = result.runs.find(r => r.agentType === 'claude');
      const codexRun = result.runs.find(r => r.agentType === 'codex');
      expect(claudeRun).toBeDefined();
      expect(codexRun).toBeDefined();
      expect(claudeRun?.issueId).toBe('42');
      expect(codexRun?.issueId).toBe('43');
    });

    it('should filter cards by agent type', () => {
      // Start a claude run on issue 1
      db.startRun({
        userId: 'user-1',
        mode: 'interactive',
        issueId: '1',
        issuePlatform: 'github',
        issueRepo: 'owner/repo',
        agentType: 'claude',
      });
      // Start a codex run on issue 2
      db.startRun({
        userId: 'user-1',
        mode: 'interactive',
        issueId: '2',
        issuePlatform: 'github',
        issueRepo: 'owner/repo',
        agentType: 'codex',
      });

      const allRuns = db.listRuns({ status: 'running', limit: 100 });
      const claudeOnly = allRuns.runs.filter(r => r.agentType === 'claude');
      const codexOnly = allRuns.runs.filter(r => r.agentType === 'codex');

      expect(claudeOnly).toHaveLength(1);
      expect(claudeOnly[0].issueId).toBe('1');
      expect(codexOnly).toHaveLength(1);
      expect(codexOnly[0].issueId).toBe('2');
    });
  });

  describe('getRunWithSteps with agentType', () => {
    it('should include agentType in run with steps', () => {
      const run = db.startRun({
        userId: 'user-1',
        mode: 'interactive',
        agentType: 'opencode',
      });

      const withSteps = db.getRunWithSteps(run.id);
      expect(withSteps?.agentType).toBe('opencode');
      expect(withSteps?.steps).toEqual([]);
    });
  });
});
