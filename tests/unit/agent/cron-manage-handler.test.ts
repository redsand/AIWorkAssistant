import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockCreateJob, mockListJobs, mockEditJob, mockDeleteJob, mockGetStatus } = vi.hoisted(() => ({
  mockCreateJob: vi.fn(),
  mockListJobs: vi.fn(),
  mockEditJob: vi.fn(),
  mockDeleteJob: vi.fn(),
  mockGetStatus: vi.fn(),
}));

vi.mock("../../../src/scheduler/cron-engine", () => ({
  cronEngine: {
    createJob: mockCreateJob,
    listJobs: mockListJobs,
    editJob: mockEditJob,
    deleteJob: mockDeleteJob,
    getStatus: mockGetStatus,
  },
}));

import { dispatchToolCall } from "../../../src/agent/tool-dispatcher";

function fakeJob(overrides: Partial<any> = {}) {
  return {
    id: "cron-abc123",
    name: "Test job",
    schedule: { kind: "interval", minutes: 30, original: "every 30m" },
    prompt: "Do the thing",
    enabled: true,
    createdAt: "2026-06-03T09:00:00.000Z",
    runCount: 0,
    ...overrides,
  };
}

describe("cron.manage tool handler — sessionId/userId forwarding", () => {
  beforeEach(() => {
    mockCreateJob.mockReset();
    mockListJobs.mockReset();
    mockEditJob.mockReset();
    mockDeleteJob.mockReset();
    mockGetStatus.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards sessionId (from _chatSessionId) and userId to createJob, defaulting deliver to chat", async () => {
    mockCreateJob.mockReturnValue(fakeJob({ deliver: "chat" }));

    const result = await dispatchToolCall(
      "cron.manage",
      {
        action: "create",
        schedule: "every 30m",
        prompt: "Do the thing",
        _chatSessionId: "session-xyz",
      },
      "user-42",
    );

    expect(result.success).toBe(true);
    expect(mockCreateJob).toHaveBeenCalledWith(
      "every 30m",
      "Do the thing",
      expect.objectContaining({
        sessionId: "session-xyz",
        userId: "user-42",
        deliver: "chat",
      }),
    );
  });

  it("prefers an explicit sessionId param over _chatSessionId", async () => {
    mockCreateJob.mockReturnValue(fakeJob({ deliver: "chat" }));

    await dispatchToolCall(
      "cron.manage",
      {
        action: "create",
        schedule: "every 30m",
        prompt: "Do the thing",
        sessionId: "explicit-session",
        _chatSessionId: "injected-session",
      },
      "user-42",
    );

    expect(mockCreateJob).toHaveBeenCalledWith(
      "every 30m",
      "Do the thing",
      expect.objectContaining({ sessionId: "explicit-session" }),
    );
  });

  it("does not default deliver to chat when there is no _chatSessionId (e.g. script/subagent callers)", async () => {
    mockCreateJob.mockReturnValue(fakeJob({ deliver: undefined }));

    await dispatchToolCall(
      "cron.manage",
      {
        action: "create",
        schedule: "every 30m",
        prompt: "Do the thing",
      },
      "user-42",
    );

    expect(mockCreateJob).toHaveBeenCalledWith(
      "every 30m",
      "Do the thing",
      expect.objectContaining({ sessionId: undefined, deliver: undefined }),
    );
  });

  it("respects an explicit deliver target (e.g. discord) even when a session is present", async () => {
    mockCreateJob.mockReturnValue(fakeJob({ deliver: "discord" }));

    await dispatchToolCall(
      "cron.manage",
      {
        action: "create",
        schedule: "every 30m",
        prompt: "Do the thing",
        deliver: "discord",
        _chatSessionId: "session-xyz",
      },
      "user-42",
    );

    expect(mockCreateJob).toHaveBeenCalledWith(
      "every 30m",
      "Do the thing",
      expect.objectContaining({ deliver: "discord", sessionId: "session-xyz" }),
    );
  });

  it("includes deliver/lastDelivered/undeliveredCount in list output", async () => {
    mockListJobs.mockReturnValue([
      fakeJob({
        deliver: "chat",
        lastDelivered: false,
        undeliveredResults: [{ output: "x", timestamp: "t", success: true }],
      }),
    ]);

    const result = await dispatchToolCall("cron.manage", { action: "list" }, "user-42");

    expect(result.success).toBe(true);
    expect(result.data).toEqual([
      expect.objectContaining({
        deliver: "chat",
        lastDelivered: false,
        undeliveredCount: 1,
      }),
    ]);
  });
});
