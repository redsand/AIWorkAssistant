/**
 * Tests for the post-merge source issue closing behaviour.
 *
 * closeSourceIssue() is a module-level function inside aicoder.ts which has
 * heavy initialisation side effects, so we test the underlying client methods
 * and the webhook handler path that exercises the same flow.
 *
 * For Jira: verify getTransitions → find Done → transitionIssue + addComment.
 * For GitLab: verify editIssue(stateEvent:"close") + addIssueNote.
 * For GitHub: verify updateIssue(state:"closed") + addIssueComment.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Jira client ───────────────────────────────────────────────────────────────

vi.mock("axios", () => {
  const mockInstance = {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    patch: vi.fn(),
    interceptors: {
      request: { use: vi.fn() },
      response: { use: vi.fn() },
    },
  };
  return {
    default: {
      create: vi.fn(() => mockInstance),
      isAxiosError: vi.fn(),
    },
  };
});

vi.mock("../../../src/config/env", () => ({
  env: {
    JIRA_BASE_URL: "https://test.atlassian.net",
    JIRA_EMAIL: "test@example.com",
    JIRA_API_TOKEN: "test-token",
    GITLAB_BASE_URL: "https://gitlab.test.local",
    GITLAB_TOKEN: "test-token",
    GITLAB_DEFAULT_PROJECT: "siem",
    GITLAB_WEBHOOK_SECRET: "",
    GITHUB_BASE_URL: "https://api.github.com",
    GITHUB_TOKEN: "gh-test-token",
    GITHUB_DEFAULT_OWNER: "hawkio",
    GITHUB_DEFAULT_REPO: "soc-agent",
    PORT: 3050,
    NODE_ENV: "test",
    AUTH_USERNAME: "admin",
    AUTH_PASSWORD: "test",
    AUTH_SESSION_SECRET: "test-secret",
    OPENCODE_API_URL: "",
    OPENCODE_API_KEY: "",
    JIRA_PROJECT_KEYS: [],
    ENABLE_CALENDAR_WRITE: false,
    ENABLE_JIRA_TRANSITIONS: true,
    ENABLE_GITLAB_WEBHOOKS: true,
  },
}));

import axios from "axios";
import { JiraClient } from "../../../src/integrations/jira/jira-client";
import { GitlabClient } from "../../../src/integrations/gitlab/gitlab-client";

function mockAxiosInstance() {
  const mockGet = vi.fn();
  const mockPost = vi.fn();
  const mockPut = vi.fn();
  const mockPatch = vi.fn();
  vi.mocked(axios.create).mockReturnValue({
    get: mockGet,
    post: mockPost,
    put: mockPut,
    patch: mockPatch,
    interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
  } as any);
  return { mockGet, mockPost, mockPut, mockPatch };
}

// ── Jira: transition to Done after merge ─────────────────────────────────────

describe("Jira closeSourceIssue flow", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("transitions to Done when transition is available", async () => {
    const { mockGet, mockPost } = mockAxiosInstance();
    const client = new JiraClient();

    mockGet.mockResolvedValueOnce({
      data: {
        transitions: [
          { id: "21", name: "In Progress", to: { name: "In Progress", id: "31" } },
          { id: "31", name: "Done", to: { name: "Done", id: "41" } },
        ],
      },
    });
    mockPost.mockResolvedValue({ data: {} });

    const transitions = await client.getTransitions("IR-99");
    const closeNames = ["done", "completed", "resolved", "closed"];
    const doneTransition = transitions.find((t) =>
      closeNames.some((n) => t.name.toLowerCase().includes(n)),
    );

    expect(doneTransition).toBeDefined();
    expect(doneTransition!.id).toBe("31");

    await client.transitionIssue("IR-99", doneTransition!.id);
    expect(mockPost).toHaveBeenCalledWith(
      "/rest/api/3/issue/IR-99/transitions",
      expect.objectContaining({ transition: { id: "31" } }),
    );
  });

  it("matches 'Completed' transition name", async () => {
    const { mockGet } = mockAxiosInstance();
    const client = new JiraClient();

    mockGet.mockResolvedValueOnce({
      data: {
        transitions: [
          { id: "51", name: "Completed", to: { name: "Completed", id: "61" } },
        ],
      },
    });

    const transitions = await client.getTransitions("IR-99");
    const closeNames = ["done", "completed", "resolved", "closed"];
    const found = transitions.find((t) =>
      closeNames.some((n) => t.name.toLowerCase().includes(n)),
    );
    expect(found?.name).toBe("Completed");
  });

  it("returns undefined (no transition) gracefully when none match", async () => {
    const { mockGet } = mockAxiosInstance();
    const client = new JiraClient();

    mockGet.mockResolvedValueOnce({
      data: {
        transitions: [
          { id: "21", name: "In Progress", to: { name: "In Progress", id: "31" } },
          { id: "11", name: "To Do", to: { name: "To Do", id: "11" } },
        ],
      },
    });

    const transitions = await client.getTransitions("IR-99");
    const closeNames = ["done", "completed", "resolved", "closed"];
    const found = transitions.find((t) =>
      closeNames.some((n) => t.name.toLowerCase().includes(n)),
    );
    expect(found).toBeUndefined();
  });

  it("posts completion comment before transitioning", async () => {
    const { mockGet, mockPost } = mockAxiosInstance();
    const client = new JiraClient();

    mockGet.mockResolvedValueOnce({
      data: { transitions: [{ id: "31", name: "Done", to: { name: "Done", id: "41" } }] },
    });
    mockPost.mockResolvedValue({ data: {} });

    await client.addComment("IR-99", "✅ Autonomous loop complete — MR !4 merged to main");
    await client.transitionIssue("IR-99", "31");

    const calls = mockPost.mock.calls;
    expect(calls[0][0]).toContain("/comment");
    expect(calls[1][0]).toContain("/transitions");
  });
});

// ── GitLab: close issue after merge ──────────────────────────────────────────

describe("GitLab closeSourceIssue flow", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("closes the GitLab issue with stateEvent=close", async () => {
    const { mockPut } = mockAxiosInstance();
    const client = new GitlabClient();
    mockPut.mockResolvedValue({ data: { iid: 42, state: "closed" } });

    await client.editIssue("siem", 42, { stateEvent: "close" });

    expect(mockPut).toHaveBeenCalledWith(
      "/api/v4/projects/siem/issues/42",
      { state_event: "close" },
    );
  });

  it("posts a note before closing the GitLab issue", async () => {
    const { mockPost, mockPut } = mockAxiosInstance();
    const client = new GitlabClient();
    mockPost.mockResolvedValue({ data: {} });
    mockPut.mockResolvedValue({ data: { state: "closed" } });

    await client.addIssueNote("siem", 42, "✅ MR !4 merged");
    await client.editIssue("siem", 42, { stateEvent: "close" });

    expect(mockPost).toHaveBeenCalledWith(
      "/api/v4/projects/siem/issues/42/notes",
      { body: "✅ MR !4 merged" },
    );
    expect(mockPut).toHaveBeenCalledWith(
      "/api/v4/projects/siem/issues/42",
      { state_event: "close" },
    );
  });
});

// ── closeSourceIssue module ───────────────────────────────────────────────────

import { closeSourceIssue } from "../../../src/autonomous-loop/close-source-issue";

describe("closeSourceIssue — Jira", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("posts comment then transitions to Done", async () => {
    const { mockGet, mockPost } = mockAxiosInstance();
    const client = new JiraClient();

    mockGet.mockResolvedValueOnce({
      data: { transitions: [{ id: "31", name: "Done", to: { name: "Done", id: "41" } }] },
    });
    mockPost.mockResolvedValue({ data: {} });

    await closeSourceIssue(
      { source: "jira", issueKey: "IR-99", mrIid: 4, branchName: "ai/issue-99-fix" },
      client,
      null,
      null,
    );

    const calls = mockPost.mock.calls;
    expect(calls[0][0]).toContain("/comment"); // comment first
    expect(calls[1][0]).toContain("/transitions"); // then transition
  });

  it("warns and skips transition when no Done-like transition exists", async () => {
    const { mockGet, mockPost } = mockAxiosInstance();
    const client = new JiraClient();

    mockGet.mockResolvedValueOnce({
      data: { transitions: [{ id: "11", name: "To Do", to: { name: "To Do", id: "11" } }] },
    });
    mockPost.mockResolvedValue({ data: {} }); // comment still posts

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await closeSourceIssue(
      { source: "jira", issueKey: "IR-99", mrIid: 4 },
      client,
      null,
      null,
    );

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("No \"Done\" transition found"),
    );
    expect(mockPost).toHaveBeenCalledTimes(1); // comment only, no transition
  });

  it("still tries transition even if comment posting fails", async () => {
    const { mockGet, mockPost } = mockAxiosInstance();
    const client = new JiraClient();

    mockGet.mockResolvedValueOnce({
      data: { transitions: [{ id: "31", name: "Done", to: { name: "Done", id: "41" } }] },
    });
    mockPost
      .mockRejectedValueOnce(new Error("comment failed"))
      .mockResolvedValueOnce({ data: {} }); // transition succeeds

    vi.spyOn(console, "warn").mockImplementation(() => {});

    await closeSourceIssue(
      { source: "jira", issueKey: "IR-99" },
      client,
      null,
      null,
    );

    // transition was still attempted
    const transitionCall = mockPost.mock.calls.find((c) => String(c[0]).includes("/transitions"));
    expect(transitionCall).toBeDefined();
  });
});

describe("closeSourceIssue — GitLab", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("adds note then closes issue", async () => {
    const { mockPost, mockPut } = mockAxiosInstance();
    const client = new GitlabClient();
    mockPost.mockResolvedValue({ data: {} });
    mockPut.mockResolvedValue({ data: { state: "closed" } });

    const jira = new JiraClient();
    await closeSourceIssue(
      { source: "gitlab", issueKey: "siem#42", mrIid: 7 },
      jira,
      client,
      null,
    );

    expect(mockPost).toHaveBeenCalledWith(
      "/api/v4/projects/siem/issues/42/notes",
      expect.objectContaining({ body: expect.stringContaining("Autonomous loop completed") }),
    );
    expect(mockPut).toHaveBeenCalledWith(
      "/api/v4/projects/siem/issues/42",
      { state_event: "close" },
    );
  });

  it("warns and skips when issueKey format is invalid", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { mockPost } = mockAxiosInstance();
    const client = new GitlabClient();
    const jira = new JiraClient();

    await closeSourceIssue(
      { source: "gitlab", issueKey: "bad-format" },
      jira,
      client,
      null,
    );

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Cannot parse GitLab issueKey"),
    );
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("warns when gitlabClient is null", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const jira = new JiraClient();

    await closeSourceIssue({ source: "gitlab", issueKey: "siem#42" }, jira, null, null);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("GitLab client not available"));
  });
});
