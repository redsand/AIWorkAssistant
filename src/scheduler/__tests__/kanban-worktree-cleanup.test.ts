import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runCleanupTick } from '../kanban-worktree-cleanup';

const mockGetSetting = vi.fn();
const mockListRuns = vi.fn();
const mockRemoveWorktree = vi.fn();

vi.mock('../../kanban/worktree-manager', () => ({
  removeWorktree: (...args: unknown[]) => mockRemoveWorktree(...args),
}));

vi.mock('../../agent-runs/database', () => ({
  agentRunDatabase: {},
}));

vi.mock('../../kanban/events', () => ({
  kanbanEvents: {
    emitEvent: vi.fn(),
  },
}));

describe('Kanban Worktree Auto-Cleanup Scheduler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSetting.mockReturnValue('24');
    mockRemoveWorktree.mockResolvedValue(undefined);
  });

  it('should not clean anything when setting is 0 (disabled)', async () => {
    mockGetSetting.mockReturnValue('0');
    mockListRuns.mockReturnValue({ runs: [], total: 0 });

    const result = await runCleanupTick(new Date(), mockGetSetting, mockListRuns);

    expect(result.cleaned).toBe(0);
    expect(result.skipped).toBe(0);
    expect(mockRemoveWorktree).not.toHaveBeenCalled();
  });

  it('should not clean anything when no completed runs exist', async () => {
    mockListRuns.mockReturnValue({ runs: [], total: 0 });

    const result = await runCleanupTick(new Date(), mockGetSetting, mockListRuns);

    expect(result.cleaned).toBe(0);
    expect(mockRemoveWorktree).not.toHaveBeenCalled();
  });

  it('should not clean worktrees that are too recent', async () => {
    const now = new Date('2026-01-15T12:00:00Z');
    // Completed only 1 hour ago, threshold is 24h
    const recent = new Date('2026-01-15T11:00:00Z').toISOString();

    mockListRuns
      .mockReturnValueOnce({ runs: [{ id: 'r1', worktreePath: '/wt1', completedAt: recent }], total: 1 })
      .mockReturnValueOnce({ runs: [], total: 0 });

    const result = await runCleanupTick(now, mockGetSetting, mockListRuns);

    expect(result.cleaned).toBe(0);
    expect(mockRemoveWorktree).not.toHaveBeenCalled();
  });

  it('should clean worktrees older than autoCleanupHours', async () => {
    const now = new Date('2026-01-15T12:00:00Z');
    // Completed 25 hours ago, threshold is 24h
    const old = new Date('2026-01-14T11:00:00Z').toISOString();

    mockListRuns
      .mockReturnValueOnce({ runs: [{ id: 'r1', worktreePath: '/wt1', completedAt: old }], total: 1 })
      .mockReturnValueOnce({ runs: [], total: 0 });

    const result = await runCleanupTick(now, mockGetSetting, mockListRuns);

    expect(result.cleaned).toBe(1);
    expect(mockRemoveWorktree).toHaveBeenCalledWith('/wt1', { force: true });
  });

  it('should clean both completed and failed runs', async () => {
    const now = new Date('2026-01-15T12:00:00Z');
    const old = new Date('2026-01-14T11:00:00Z').toISOString();

    mockListRuns
      .mockReturnValueOnce({ runs: [{ id: 'r1', worktreePath: '/wt1', completedAt: old }], total: 1 })
      .mockReturnValueOnce({ runs: [{ id: 'r2', worktreePath: '/wt2', completedAt: old }], total: 1 });

    const result = await runCleanupTick(now, mockGetSetting, mockListRuns);

    expect(result.cleaned).toBe(2);
  });

  it('should skip runs without worktreePath', async () => {
    const now = new Date('2026-01-15T12:00:00Z');
    const old = new Date('2026-01-14T11:00:00Z').toISOString();

    mockListRuns
      .mockReturnValueOnce({ runs: [{ id: 'r1', worktreePath: null, completedAt: old }], total: 1 })
      .mockReturnValueOnce({ runs: [], total: 0 });

    const result = await runCleanupTick(now, mockGetSetting, mockListRuns);

    expect(result.cleaned).toBe(0);
  });

  it('should count skips when removeWorktree fails', async () => {
    const now = new Date('2026-01-15T12:00:00Z');
    const old = new Date('2026-01-14T11:00:00Z').toISOString();

    mockListRuns
      .mockReturnValueOnce({ runs: [{ id: 'r1', worktreePath: '/wt1', completedAt: old }], total: 1 })
      .mockReturnValueOnce({ runs: [], total: 0 });
    mockRemoveWorktree.mockRejectedValue(new Error('locked'));

    const result = await runCleanupTick(now, mockGetSetting, mockListRuns);

    expect(result.cleaned).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it('should use default 24h when setting is null', async () => {
    mockGetSetting.mockReturnValue(null);
    const now = new Date('2026-01-15T12:00:00Z');
    // 25h ago — past the default 24h threshold
    const old = new Date('2026-01-14T11:00:00Z').toISOString();

    mockListRuns
      .mockReturnValueOnce({ runs: [{ id: 'r1', worktreePath: '/wt1', completedAt: old }], total: 1 })
      .mockReturnValueOnce({ runs: [], total: 0 });

    const result = await runCleanupTick(now, mockGetSetting, mockListRuns);

    expect(result.cleaned).toBe(1);
  });
});
