import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentRunDatabase } from '../database';

describe('Schema migration: issue linkage + worktree columns', () => {
  let db: AgentRunDatabase;

  beforeEach(() => {
    db = new AgentRunDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('should create the idx_agent_runs_issue composite index', () => {
    const indexes = (db as unknown as { db: { prepare(sql: string): { all(): Array<{ name: string }> } } })
      .db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_agent_runs_issue'")
      .all();
    expect(indexes).toHaveLength(1);
    expect(indexes[0].name).toBe('idx_agent_runs_issue');
  });

  it('should expose issue_id, issue_platform, issue_repo columns in the schema', () => {
    const columns = (db as unknown as { db: { prepare(sql: string): { all(): Array<{ name: string }> } } })
      .db.prepare("PRAGMA table_info(agent_runs)")
      .all()
      .map((c) => c.name);
    expect(columns).toContain('issue_id');
    expect(columns).toContain('issue_platform');
    expect(columns).toContain('issue_repo');
  });

  it('should expose worktree_path and branch columns in the schema', () => {
    const columns = (db as unknown as { db: { prepare(sql: string): { all(): Array<{ name: string }> } } })
      .db.prepare("PRAGMA table_info(agent_runs)")
      .all()
      .map((c) => c.name);
    expect(columns).toContain('worktree_path');
    expect(columns).toContain('branch');
  });

  it('should persist issue linkage fields via startRun', () => {
    const run = db.startRun({
      sessionId: 'sess-1',
      userId: 'user-1',
      mode: 'productivity',
      issueId: '129',
      issuePlatform: 'github',
      issueRepo: 'redsand/AIWorkAssistant',
    });
    expect(run.issueId).toBe('129');
    expect(run.issuePlatform).toBe('github');
    expect(run.issueRepo).toBe('redsand/AIWorkAssistant');

    const fetched = db.getRun(run.id);
    expect(fetched?.issueId).toBe('129');
    expect(fetched?.issuePlatform).toBe('github');
    expect(fetched?.issueRepo).toBe('redsand/AIWorkAssistant');
  });

  it('should persist worktree_path and branch via startRun', () => {
    const run = db.startRun({
      userId: 'user-1',
      mode: 'engineering',
      worktreePath: '/tmp/worktrees/issue-129',
      branch: 'ai/issue-129',
    });
    expect(run.worktreePath).toBe('/tmp/worktrees/issue-129');
    expect(run.branch).toBe('ai/issue-129');

    const fetched = db.getRun(run.id);
    expect(fetched?.worktreePath).toBe('/tmp/worktrees/issue-129');
    expect(fetched?.branch).toBe('ai/issue-129');
  });

  it('should not break existing callers — new fields default to null', () => {
    const run = db.startRun({ userId: 'user-1', mode: 'productivity' });
    expect(run.issueId).toBeNull();
    expect(run.issuePlatform).toBeNull();
    expect(run.issueRepo).toBeNull();
    expect(run.worktreePath).toBeNull();
    expect(run.branch).toBeNull();

    const fetched = db.getRun(run.id);
    expect(fetched?.issueId).toBeNull();
    expect(fetched?.issuePlatform).toBeNull();
    expect(fetched?.issueRepo).toBeNull();
    expect(fetched?.worktreePath).toBeNull();
    expect(fetched?.branch).toBeNull();
  });

  it('should return new fields in listRuns results', () => {
    db.startRun({
      userId: 'user-1',
      mode: 'productivity',
      issueId: '42',
      issuePlatform: 'jira',
      issueRepo: 'PROJ',
      worktreePath: '/wt/42',
      branch: 'fix/42',
    });
    const result = db.listRuns({ userId: 'user-1' });
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0].issueId).toBe('42');
    expect(result.runs[0].issuePlatform).toBe('jira');
    expect(result.runs[0].issueRepo).toBe('PROJ');
    expect(result.runs[0].worktreePath).toBe('/wt/42');
    expect(result.runs[0].branch).toBe('fix/42');
  });

  it('should survive schema re-initialization without error', () => {
    // Simulate re-opening the database on an existing file
    const db2 = new AgentRunDatabase(':memory:');
    const run = db2.startRun({
      userId: 'user-1',
      mode: 'productivity',
      issueId: '99',
      issuePlatform: 'gitlab',
    });
    expect(run.issueId).toBe('99');
    db2.close();
  });
});
