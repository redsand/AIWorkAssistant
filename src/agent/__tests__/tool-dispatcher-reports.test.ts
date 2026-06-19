import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const buildAndPersistMock = vi.fn();

vi.mock("../../reports/report-builder", () => ({
  buildAndPersist: (...args: unknown[]) => buildAndPersistMock(...args),
  listTemplates: vi.fn(() => []),
}));

vi.mock("../../reports/storage", () => ({
  listReports: vi.fn(() => []),
}));

describe("reports.generate dispatch — sessionId resolution", () => {
  beforeEach(() => {
    buildAndPersistMock.mockReset();
    buildAndPersistMock.mockResolvedValue({
      reportId: "rpt-1",
      metadata: { title: "Investigation", template: "incident-response" },
      files: [
        {
          format: "markdown",
          bytes: 512,
          path: "/tmp/report.md",
          mime: "text/markdown",
        },
      ],
      warnings: [],
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("falls back to _chatSessionId when no sessionId is provided", async () => {
    const { dispatchToolCall } = await import("../tool-dispatcher.js");
    const result = await dispatchToolCall(
      "reports.generate",
      {
        _chatSessionId: "chat-session-aaa",
        formats: ["markdown"],
      },
      "user-1",
      true, // skipPolicyCheck — we're not testing policy here
    );
    expect(result.success).toBe(true);
    expect(buildAndPersistMock).toHaveBeenCalledTimes(1);
    expect(buildAndPersistMock.mock.calls[0][0].sessionId).toBe(
      "chat-session-aaa",
    );
  });

  it("prefers explicit sessionId over _chatSessionId so older sessions can be exported", async () => {
    const { dispatchToolCall } = await import("../tool-dispatcher.js");
    const result = await dispatchToolCall(
      "reports.generate",
      {
        sessionId: "older-session-xyz",
        _chatSessionId: "current-chat-session",
        formats: ["markdown"],
      },
      "user-1",
      true,
    );
    expect(result.success).toBe(true);
    expect(buildAndPersistMock.mock.calls[0][0].sessionId).toBe(
      "older-session-xyz",
    );
  });

  it("returns a helpful error when neither sessionId nor _chatSessionId is present", async () => {
    const { dispatchToolCall } = await import("../tool-dispatcher.js");
    const result = await dispatchToolCall(
      "reports.generate",
      { formats: ["markdown"] },
      "user-1",
      true,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/sessionId is required/);
    expect(buildAndPersistMock).not.toHaveBeenCalled();
  });

  it("returns downloadUrl per format on success", async () => {
    const { dispatchToolCall } = await import("../tool-dispatcher.js");
    const result = await dispatchToolCall(
      "reports.generate",
      { _chatSessionId: "s1", formats: ["markdown"] },
      "user-1",
      true,
    );
    expect(result.success).toBe(true);
    const data = result.data as { files: Array<{ format: string; downloadUrl: string }> };
    expect(data.files[0].downloadUrl).toBe(
      "/api/reports/rpt-1/download/markdown",
    );
  });
});
