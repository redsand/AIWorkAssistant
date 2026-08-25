import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/config/env", () => ({
  resolvePath: (rel: string) => rel,
  env: {
    JIRA_BASE_URL: "https://test.atlassian.net",
    JIRA_EMAIL: "test@example.com",
    JIRA_API_TOKEN: "test-token",
    GITLAB_BASE_URL: "https://gitlab.com",
    GITLAB_TOKEN: "",
    GITLAB_WEBHOOK_SECRET: "",
    PORT: 3050,
    NODE_ENV: "test",
    AUTH_USERNAME: "admin",
    AUTH_PASSWORD: "test",
    AUTH_SESSION_SECRET: "test-secret",
    OPENCODE_API_URL: "https://api.opencode.com/v1",
    OPENCODE_API_KEY: "",
    JIRA_PROJECT_KEYS: [],
    ENABLE_CALENDAR_WRITE: false,
    ENABLE_JIRA_TRANSITIONS: true,
    ENABLE_GITLAB_WEBHOOKS: true,
  },
}));

vi.mock("../../../src/audit/logger", () => ({
  auditLogger: { log: vi.fn(async () => {}) },
}));

vi.mock("../../../src/integrations/hawk-ir/hawk-ir-service", () => ({
  hawkIrService: {
    isConfigured: vi.fn(() => true),
    getCases: vi.fn(async () => []),
  },
}));

import { dispatchToolCall } from "../../../src/agent/tool-dispatcher";
import { hawkIrService } from "../../../src/integrations/hawk-ir/hawk-ir-service";

describe("Tool Dispatcher: hawk_ir.get_cases limit/offset coercion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(hawkIrService.isConfigured).mockReturnValue(true);
    vi.mocked(hawkIrService.getCases).mockResolvedValue([] as any);
  });

  async function dispatch(params: Record<string, unknown>) {
    return dispatchToolCall("hawk_ir.get_cases", params, "user", true);
  }

  it("coerces string limit/offset to numbers before calling the service", async () => {
    await dispatch({ limit: "500", offset: "0" });

    expect(hawkIrService.getCases).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(hawkIrService.getCases).mock.calls[0][0]!;
    expect(arg.limit).toBe(500);
    expect(arg.offset).toBe(0);
    // Strictly numbers, not strings — OrientDB returns 0 rows for stringly-typed bounds.
    expect(typeof arg.limit).toBe("number");
    expect(typeof arg.offset).toBe("number");
  });

  it("passes numeric limit/offset through unchanged", async () => {
    await dispatch({ limit: 500, offset: 0 });

    const arg = vi.mocked(hawkIrService.getCases).mock.calls[0][0]!;
    expect(arg.limit).toBe(500);
    expect(arg.offset).toBe(0);
  });

  it("leaves limit/offset undefined when omitted (client applies defaults)", async () => {
    await dispatch({});

    const arg = vi.mocked(hawkIrService.getCases).mock.calls[0][0]!;
    expect(arg.limit).toBeUndefined();
    expect(arg.offset).toBeUndefined();
  });

  it("falls back to undefined for non-numeric (NaN) values and warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await dispatch({ limit: "not-a-number", offset: "abc" });

    const arg = vi.mocked(hawkIrService.getCases).mock.calls[0][0]!;
    expect(arg.limit).toBeUndefined();
    expect(arg.offset).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
