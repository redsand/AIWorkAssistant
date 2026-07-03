import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { Runner } from "../../agent-runs/types";

const {
  mockGetRunner,
  mockUpdateRunner,
  mockSetRunnerStatus,
  mockAcquireRepoRunLock,
  mockReleaseRepoRunLock,
  mockGetProviderHost,
} = vi.hoisted(() => ({
  mockGetRunner: vi.fn(),
  mockUpdateRunner: vi.fn(),
  mockSetRunnerStatus: vi.fn(),
  mockAcquireRepoRunLock: vi.fn(() => ({ acquired: true })),
  mockReleaseRepoRunLock: vi.fn(),
  mockGetProviderHost: vi.fn(),
}));

vi.mock("../../agent-runs/database", () => ({
  agentRunDatabase: {
    getRunner: mockGetRunner,
    updateRunner: mockUpdateRunner,
    setRunnerStatus: mockSetRunnerStatus,
    acquireRepoRunLock: mockAcquireRepoRunLock,
    releaseRepoRunLock: mockReleaseRepoRunLock,
    getProviderHost: mockGetProviderHost,
  },
}));

const { mockEnsurePersistentWorktree } = vi.hoisted(() => ({
  mockEnsurePersistentWorktree: vi.fn(async () => "C:/fake/workspace"),
}));
vi.mock("../../kanban/worktree-manager", () => ({
  ensurePersistentWorktree: mockEnsurePersistentWorktree,
}));

vi.mock("../runner-events", () => ({
  runnerEvents: {
    emitStatus: vi.fn(),
    emitLog: vi.fn(),
  },
}));

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mockSpawn }));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
  appendFileSync: vi.fn(),
  createWriteStream: vi.fn(() => ({ write: vi.fn(), end: vi.fn() })),
}));

import { RunnerLoop, splitGithubRepoSlug } from "../runner-loop";

describe("splitGithubRepoSlug", () => {
  it("splits an owner/name slug for github runners", () => {
    expect(splitGithubRepoSlug("github", null, "redsand/AIWorkAssistant"))
      .toEqual({ owner: "redsand", repo: "AIWorkAssistant" });
  });

  it("preserves an explicit owner over the slug's owner", () => {
    expect(splitGithubRepoSlug("github", "tim-org", "redsand/AIWorkAssistant"))
      .toEqual({ owner: "tim-org", repo: "AIWorkAssistant" });
  });

  it("passes a bare repo name through untouched", () => {
    expect(splitGithubRepoSlug("github", "redsand", "AIWorkAssistant"))
      .toEqual({ owner: "redsand", repo: "AIWorkAssistant" });
  });

  it("leaves gitlab path-with-namespace alone (CLI accepts that form)", () => {
    expect(splitGithubRepoSlug("gitlab", null, "group/subgroup/project"))
      .toEqual({ owner: null, repo: "group/subgroup/project" });
  });

  it("handles null/undefined repo without throwing", () => {
    expect(splitGithubRepoSlug("github", "redsand", null))
      .toEqual({ owner: "redsand", repo: null });
    expect(splitGithubRepoSlug("github", "redsand", undefined))
      .toEqual({ owner: "redsand", repo: undefined });
  });

  it("falls back to original slug when name half is empty", () => {
    expect(splitGithubRepoSlug("github", null, "redsand/"))
      .toEqual({ owner: "redsand", repo: "redsand/" });
  });
});

describe("RunnerLoop — target-issue one-shot completion", () => {
  const baseRunner: Runner = {
    id: "runner-1",
    name: "Test Runner",
    kind: "aicoder",
    enabled: true,
    repoUrl: "https://github.com/redsand/example.git",
    baseBranch: "main",
    workspacePath: "C:/fake/workspace",
    source: "github",
    owner: "redsand",
    repo: "example",
    label: null,
    sprint: null,
    targetIssue: "51",
    agent: "claude",
    model: null,
    apiProvider: null,
    apiProviderHostId: null,
    pollIntervalMs: 5,
    maxCycles: 0,
    status: "idle",
    currentRunId: null,
    lastStartedAt: null,
    lastFinishedAt: null,
    lastError: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  it("clears targetIssue and keeps polling instead of disabling the runner", async () => {
    mockGetRunner.mockReset();
    mockUpdateRunner.mockReset();
    mockSetRunnerStatus.mockReset();
    mockSpawn.mockReset();

    // Every getRunner() call sees the same one-shot config until the test
    // stops the loop — the SUT itself is responsible for clearing targetIssue.
    mockGetRunner.mockImplementation(() => ({ ...baseRunner }));

    mockSpawn.mockImplementation(() => {
      const child: any = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      // Resolve the cycle on the next tick, after runner-loop's Promise
      // executor has synchronously attached its 'close' listener.
      setImmediate(() => child.emit("close", 0, null));
      return child;
    });

    const loop = new RunnerLoop(baseRunner.id);
    const runPromise = loop.run();

    await vi.waitFor(() => {
      expect(mockUpdateRunner).toHaveBeenCalledWith(baseRunner.id, { targetIssue: null });
    });

    // The old behavior disabled the runner outright; assert that never happens.
    expect(mockUpdateRunner).not.toHaveBeenCalledWith(baseRunner.id, { enabled: false });

    loop.stop();
    await runPromise;
  });
});
