import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock GitHub client
const {
  mockGithubIsConfigured,
  mockGetPullRequest,
  mockGetPullRequestFiles,
  mockListPullRequestChecks,
  mockListPullRequestComments,
} = vi.hoisted(() => ({
  mockGithubIsConfigured: vi.fn(() => true),
  mockGetPullRequest: vi.fn(),
  mockGetPullRequestFiles: vi.fn(),
  mockListPullRequestChecks: vi.fn(),
  mockListPullRequestComments: vi.fn(),
}));

vi.mock("../../../src/integrations/github/github-client", () => ({
  githubClient: {
    isConfigured: mockGithubIsConfigured,
    getPullRequest: mockGetPullRequest,
    getPullRequestFiles: mockGetPullRequestFiles,
    listPullRequestChecks: mockListPullRequestChecks,
    listPullRequestComments: mockListPullRequestComments,
  },
}));

// Mock GitLab client
const {
  mockGitlabIsConfigured,
  mockGetMergeRequest,
  mockGetMergeRequestChanges,
  mockListPipelines,
  mockListMergeRequestNotes,
} = vi.hoisted(() => ({
  mockGitlabIsConfigured: vi.fn(() => true),
  mockGetMergeRequest: vi.fn(),
  mockGetMergeRequestChanges: vi.fn(),
  mockListPipelines: vi.fn(),
  mockListMergeRequestNotes: vi.fn(),
}));

vi.mock("../../../src/integrations/gitlab/gitlab-client", () => ({
  gitlabClient: {
    isConfigured: mockGitlabIsConfigured,
    getMergeRequest: mockGetMergeRequest,
    getMergeRequestChanges: mockGetMergeRequestChanges,
    listPipelines: mockListPipelines,
    listMergeRequestNotes: mockListMergeRequestNotes,
  },
}));

// Mock AI client — disabled by default, tests opt-in
const { mockAiIsConfigured, mockAiChat } = vi.hoisted(() => ({
  mockAiIsConfigured: vi.fn(() => false),
  mockAiChat: vi.fn(),
}));

vi.mock("../../../src/agent/opencode-client", () => ({
  aiClient: {
    isConfigured: mockAiIsConfigured,
    chat: mockAiChat,
  },
}));

// Mock work item database
const { mockCreateWorkItem } = vi.hoisted(() => ({
  mockCreateWorkItem: vi.fn(),
}));

vi.mock("../../../src/work-items/database", () => ({
  workItemDatabase: {
    createWorkItem: mockCreateWorkItem,
  },
}));

import { reviewAssistant } from "../../../src/code-review/review-assistant";
import type { ChangeSet } from "../../../src/code-review/types";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const LOW_RISK_PR = {
  title: "Fix typo in README",
  body: "Small docs fix",
  user: { login: "alice" },
  head: { ref: "fix/typo", sha: "abc123" },
  base: { ref: "main" },
  html_url: "https://github.com/org/repo/pull/1",
};

const HIGH_RISK_PR = {
  title: "Add user authentication and DB migration",
  body: "Adds JWT auth, password reset, and schema migration",
  user: { login: "bob" },
  head: { ref: "feat/auth", sha: "def456" },
  base: { ref: "main" },
  html_url: "https://github.com/org/repo/pull/42",
};

const LOW_RISK_FILES = [
  { filename: "README.md", status: "modified", additions: 2, deletions: 1 },
];

const HIGH_RISK_FILES = [
  { filename: "src/auth/jwt.ts", status: "added", additions: 120, deletions: 0 },
  { filename: "migrations/20240101_add_users.sql", status: "added", additions: 45, deletions: 0 },
  { filename: "src/auth/password.ts", status: "added", additions: 60, deletions: 0 },
  { filename: ".env.example", status: "modified", additions: 5, deletions: 0 },
];

const PASSING_CHECKS = [{ conclusion: "success" }, { conclusion: "success" }];
const FAILING_CHECKS = [{ conclusion: "success" }, { conclusion: "failure" }];

const GITLAB_MR = {
  title: "Add feature X",
  description: "Implements feature X",
  author: { username: "carol" },
  source_branch: "feat/x",
  target_branch: "main",
  web_url: "https://gitlab.com/org/repo/-/merge_requests/7",
  iid: 7,
};

const GITLAB_CHANGES = {
  iid: 7,
  title: "Add feature X",
  changes: [
    { old_path: "src/x.ts", new_path: "src/x.ts", diff: "+const x = 1;\n", new_file: false, deleted_file: false, renamed_file: false },
    { old_path: "", new_path: "tests/x.test.ts", diff: "+test('x', () => {});\n", new_file: true, deleted_file: false, renamed_file: false },
  ],
};

// ─── assessRisk ──────────────────────────────────────────────────────────────

describe("reviewAssistant.assessRisk", () => {
  const base: ChangeSet = {
    platform: "github",
    title: "Test",
    description: "",
    author: "alice",
    sourceBranch: "feat",
    targetBranch: "main",
    url: "https://example.com/pr/1",
    files: [],
    linesAdded: 0,
    linesRemoved: 0,
    ciStatus: "success",
    existingComments: [],
    hasMigration: false,
    hasTests: true,
    hasConfigChange: false,
  };

  it("returns low for a clean, small PR", () => {
    expect(reviewAssistant.assessRisk(base)).toBe("low");
  });

  it("returns high when migration + no tests + failed CI", () => {
    const cs: ChangeSet = { ...base, hasMigration: true, hasTests: false, ciStatus: "failed", linesAdded: 100 };
    const risk = reviewAssistant.assessRisk(cs);
    expect(["high", "critical"]).toContain(risk);
  });

  it("returns medium when config file changed", () => {
    const cs: ChangeSet = {
      ...base,
      hasConfigChange: true,
      files: [{ filename: "config/settings.yaml", status: "modified", additions: 5, deletions: 2 }],
    };
    expect(["medium", "high"]).toContain(reviewAssistant.assessRisk(cs));
  });

  it("returns critical when migration + failed CI + security file", () => {
    const cs: ChangeSet = {
      ...base,
      hasMigration: true,
      ciStatus: "failed",
      linesAdded: 200,
      files: [{ filename: "src/auth/jwt.ts", status: "added", additions: 200, deletions: 0 }],
    };
    expect(reviewAssistant.assessRisk(cs)).toBe("critical");
  });
});

// ─── reviewGitHubPullRequest — low risk ──────────────────────────────────────

describe("reviewAssistant.reviewGitHubPullRequest — low-risk PR", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGithubIsConfigured.mockReturnValue(true);
    mockGetPullRequest.mockResolvedValue(LOW_RISK_PR);
    mockGetPullRequestFiles.mockResolvedValue(LOW_RISK_FILES);
    mockListPullRequestChecks.mockResolvedValue(PASSING_CHECKS);
    mockListPullRequestComments.mockResolvedValue([]);
    mockAiIsConfigured.mockReturnValue(false);
  });

  it("returns a CodeReview with correct metadata", async () => {
    const review = await reviewAssistant.reviewGitHubPullRequest({
      owner: "org",
      repo: "repo",
      prNumber: 1,
    });
    expect(review.platform).toBe("github");
    expect(review.prUrl).toBe(LOW_RISK_PR.html_url);
    expect(review.title).toBe(LOW_RISK_PR.title);
    expect(review.author).toBe("alice");
    expect(review.filesChanged).toBe(1);
    expect(review.ciStatus).toBe("success");
    expect(review.suggestedReviewComment).toBeTruthy();
    expect(review.generatedAt).toBeTruthy();
  });

  it("escalates to high/needs_changes when AI is unavailable (heuristic fallback always escalates)", async () => {
    const review = await reviewAssistant.reviewGitHubPullRequest({
      owner: "org",
      repo: "repo",
      prNumber: 1,
    });
    // Fallback always escalates — AI review unavailable means needs human sign-off
    expect(review.riskLevel).toBe("high");
    expect(review.recommendation).toBe("needs_changes");
    expect(review.mustFix.some((m) => /AI review was unavailable/i.test(m))).toBe(true);
  });
});

// ─── reviewGitHubPullRequest — high risk ─────────────────────────────────────

describe("reviewAssistant.reviewGitHubPullRequest — high-risk PR", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGithubIsConfigured.mockReturnValue(true);
    mockGetPullRequest.mockResolvedValue(HIGH_RISK_PR);
    mockGetPullRequestFiles.mockResolvedValue(HIGH_RISK_FILES);
    mockListPullRequestChecks.mockResolvedValue(FAILING_CHECKS);
    mockListPullRequestComments.mockResolvedValue([]);
    mockAiIsConfigured.mockReturnValue(false);
  });

  it("returns high or critical risk level", async () => {
    const review = await reviewAssistant.reviewGitHubPullRequest({
      owner: "org",
      repo: "repo",
      prNumber: 42,
    });
    expect(["high", "critical"]).toContain(review.riskLevel);
  });

  it("detects migration risks", async () => {
    const review = await reviewAssistant.reviewGitHubPullRequest({
      owner: "org",
      repo: "repo",
      prNumber: 42,
    });
    expect(review.migrationRisks.length).toBeGreaterThan(0);
  });

  it("reflects failed CI status", async () => {
    const review = await reviewAssistant.reviewGitHubPullRequest({
      owner: "org",
      repo: "repo",
      prNumber: 42,
    });
    expect(review.ciStatus).toBe("failed");
    expect(review.mustFix.some((m) => /CI|check/i.test(m))).toBe(true);
  });
});

// ─── reviewGitHubPullRequest — missing diff ───────────────────────────────────

describe("reviewAssistant.reviewGitHubPullRequest — missing diff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGithubIsConfigured.mockReturnValue(true);
    mockGetPullRequest.mockResolvedValue(LOW_RISK_PR);
    mockGetPullRequestFiles.mockResolvedValue([]);
    mockListPullRequestChecks.mockResolvedValue([]);
    mockListPullRequestComments.mockResolvedValue([]);
    mockAiIsConfigured.mockReturnValue(false);
  });

  it("handles empty file list gracefully and escalates (empty MR + AI unavailable)", async () => {
    const review = await reviewAssistant.reviewGitHubPullRequest({
      owner: "org",
      repo: "repo",
      prNumber: 1,
    });
    expect(review.filesChanged).toBe(0);
    expect(review.linesAdded).toBe(0);
    expect(review.linesRemoved).toBe(0);
    // Empty MR + AI unavailable both contribute to mustFix → high risk
    expect(review.riskLevel).toBe("high");
    expect(review.mustFix.some((m) => /empty/i.test(m))).toBe(true);
  });
});

// ─── reviewGitLabMergeRequest ─────────────────────────────────────────────────

describe("reviewAssistant.reviewGitLabMergeRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGitlabIsConfigured.mockReturnValue(true);
    mockGetMergeRequest.mockResolvedValue(GITLAB_MR);
    mockGetMergeRequestChanges.mockResolvedValue(GITLAB_CHANGES);
    mockListPipelines.mockResolvedValue([{ ref: "feat/x", status: "success" }]);
    mockListMergeRequestNotes.mockResolvedValue([]);
    mockAiIsConfigured.mockReturnValue(false);
  });

  it("returns a CodeReview for a GitLab MR", async () => {
    const review = await reviewAssistant.reviewGitLabMergeRequest({
      projectId: "123",
      mrIid: 7,
    });
    expect(review.platform).toBe("gitlab");
    expect(review.prUrl).toBe(GITLAB_MR.web_url);
    expect(review.author).toBe("carol");
    expect(review.ciStatus).toBe("success");
  });

  it("detects failed pipeline status", async () => {
    mockListPipelines.mockResolvedValue([{ ref: "feat/x", status: "failed" }]);
    const review = await reviewAssistant.reviewGitLabMergeRequest({
      projectId: "123",
      mrIid: 7,
    });
    expect(review.ciStatus).toBe("failed");
  });
});

// ─── generateReviewComment ────────────────────────────────────────────────────

describe("reviewAssistant.generateReviewComment", () => {
  it("includes risk level, recommendation, and section headers", () => {
    const comment = reviewAssistant.generateReviewComment({
      prUrl: "https://example.com/pr/1",
      title: "Test PR",
      author: "alice",
      platform: "github",
      riskLevel: "high",
      recommendation: "needs_changes",
      whatChanged: "Refactored auth module",
      mustFix: ["Fix injection vulnerability"],
      shouldFix: ["Add input validation"],
      testGaps: ["No tests for auth edge cases"],
      securityConcerns: ["Hardcoded secret detected"],
      observabilityConcerns: [],
      migrationRisks: [],
      rollbackConsiderations: ["Revert and redeploy"],
      suggestedReviewComment: "",
      filesChanged: 5,
      linesAdded: 200,
      linesRemoved: 50,
      ciStatus: "success",
      generatedAt: new Date().toISOString(),
    });

    expect(comment).toContain("HIGH");
    expect(comment).toContain("needs_changes");
    expect(comment).toContain("Must Fix");
    expect(comment).toContain("Fix injection vulnerability");
    expect(comment).toContain("Security Concerns");
    expect(comment).toContain("Hardcoded secret detected");
  });

  it("omits empty sections", () => {
    const comment = reviewAssistant.generateReviewComment({
      prUrl: "https://example.com/pr/2",
      title: "Docs fix",
      author: "alice",
      platform: "github",
      riskLevel: "low",
      recommendation: "low_risk",
      whatChanged: "Fixed typo",
      mustFix: [],
      shouldFix: [],
      testGaps: [],
      securityConcerns: [],
      observabilityConcerns: [],
      migrationRisks: [],
      rollbackConsiderations: ["Revert"],
      suggestedReviewComment: "",
      filesChanged: 1,
      linesAdded: 1,
      linesRemoved: 1,
      ciStatus: "success",
      generatedAt: new Date().toISOString(),
    });

    expect(comment).not.toContain("Must Fix");
    expect(comment).not.toContain("Should Fix");
    expect(comment).not.toContain("Security Concerns");
  });
});

// ─── generateReleaseReadinessReport ──────────────────────────────────────────

describe("reviewAssistant.generateReleaseReadinessReport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGithubIsConfigured.mockReturnValue(true);
    mockGetPullRequest.mockResolvedValue(LOW_RISK_PR);
    mockGetPullRequestFiles.mockResolvedValue(LOW_RISK_FILES);
    mockListPullRequestChecks.mockResolvedValue(PASSING_CHECKS);
    mockListPullRequestComments.mockResolvedValue([]);
    mockAiIsConfigured.mockReturnValue(false);
  });

  it("returns a release report with correct metadata", async () => {
    const report = await reviewAssistant.generateReleaseReadinessReport({
      platform: "github",
      owner: "org",
      repo: "repo",
      prNumber: 1,
    });
    // When AI is unavailable, fallback always returns mustFix items → no_go for release
    expect(report.recommendation).toBe("no_go");
    expect(report.platform).toBe("github");
    expect(report.title).toBe(LOW_RISK_PR.title);
    expect(report.rollbackPlan).toBeTruthy();
    expect(report.internalCommsDraft).toBeTruthy();
    expect(report.generatedAt).toBeTruthy();
  });

  it("returns no_go when CI is failing", async () => {
    mockGetPullRequest.mockResolvedValue(HIGH_RISK_PR);
    mockGetPullRequestFiles.mockResolvedValue(HIGH_RISK_FILES);
    mockListPullRequestChecks.mockResolvedValue(FAILING_CHECKS);

    const report = await reviewAssistant.generateReleaseReadinessReport({
      platform: "github",
      owner: "org",
      repo: "repo",
      prNumber: 42,
    });
    expect(report.recommendation).toBe("no_go");
  });

  it("throws when required fields are missing", async () => {
    await expect(
      reviewAssistant.generateReleaseReadinessReport({ platform: "github" }),
    ).rejects.toThrow();
  });
});

// ─── AI path ─────────────────────────────────────────────────────────────────

describe("reviewAssistant.reviewGitHubPullRequest — AI path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGithubIsConfigured.mockReturnValue(true);
    mockGetPullRequest.mockResolvedValue(LOW_RISK_PR);
    mockGetPullRequestFiles.mockResolvedValue(LOW_RISK_FILES);
    mockListPullRequestChecks.mockResolvedValue(PASSING_CHECKS);
    mockListPullRequestComments.mockResolvedValue([]);
    mockAiIsConfigured.mockReturnValue(true);
  });

  it("uses AI response when AI is configured and returns valid JSON", async () => {
    const aiReview = {
      whatChanged: "AI says: docs fix",
      riskLevel: "low",
      recommendation: "low_risk",
      mustFix: [],
      shouldFix: ["Spellcheck the title"],
      testGaps: [],
      securityConcerns: [],
      observabilityConcerns: [],
      migrationRisks: [],
      rollbackConsiderations: ["Revert PR"],
      suggestedReviewComment: "Looks good!",
    };
    mockAiChat.mockResolvedValue({ content: JSON.stringify(aiReview) });

    const review = await reviewAssistant.reviewGitHubPullRequest({
      owner: "org",
      repo: "repo",
      prNumber: 1,
    });

    expect(review.whatChanged).toBe("AI says: docs fix");
    expect(review.shouldFix).toContain("Spellcheck the title");
    expect(review.suggestedReviewComment).toBe("Looks good!");
  });

  it("passes maxTokens: 16384 in the chat request (raised from 4096 → 8192 → 16384; 64K context window has headroom)", async () => {
    mockAiChat.mockResolvedValue({ content: JSON.stringify({ riskLevel: "low", recommendation: "low_risk", mustFix: [], shouldFix: [], testGaps: [], securityConcerns: [], observabilityConcerns: [], migrationRisks: [], rollbackConsiderations: [], whatChanged: "x" }) });

    await reviewAssistant.reviewGitHubPullRequest({ owner: "org", repo: "repo", prNumber: 1 });

    expect(mockAiChat).toHaveBeenCalledWith(
      expect.objectContaining({ maxTokens: 16384 }),
    );
  });

  it("escalates to high/needs_changes when AI response is truncated (no JSON braces)", async () => {
    mockAiChat.mockResolvedValue({
      content: "Here is my review of the changes. The session regeneration helper should use the `regenerateToken` helper for consi",
    });

    const review = await reviewAssistant.reviewGitHubPullRequest({
      owner: "org",
      repo: "repo",
      prNumber: 1,
    });

    expect(review.riskLevel).toBe("high");
    expect(review.recommendation).toBe("needs_changes");
    expect(review.mustFix.some((m) => /truncated/i.test(m))).toBe(true);
    expect(review.securityConcerns.some((c) => /AI review was unavailable/i.test(c))).toBe(true);
  });

  it("escalates to high/needs_changes when AI response is truncated mid-JSON", async () => {
    // Simulates the exact bug: JSON cut off before closing }
    mockAiChat.mockResolvedValue({
      content: '{"riskLevel":"high","recommendation":"needs_changes","mustFix":["session regeneration"],"shouldFix":["missing error log',
    });

    const review = await reviewAssistant.reviewGitHubPullRequest({
      owner: "org",
      repo: "repo",
      prNumber: 1,
    });

    expect(review.riskLevel).toBe("high");
    expect(review.recommendation).toBe("needs_changes");
    expect(review.mustFix.some((m) => /truncated/i.test(m))).toBe(true);
  });

  it("falls back gracefully when AI chat throws", async () => {
    mockAiChat.mockRejectedValue(new Error("Connection timeout"));

    const review = await reviewAssistant.reviewGitHubPullRequest({
      owner: "org",
      repo: "repo",
      prNumber: 1,
    });

    // Fell through to heuristic fallback — still escalates due to AI unavailable notice
    expect(review.riskLevel).toBe("high");
    expect(review.recommendation).toBe("needs_changes");
    expect(review.generatedAt).toBeTruthy();
  });
});

// ─── generateReviewComment — full document with all sections ─────────────────

describe("reviewAssistant.generateReviewComment — full document", () => {
  it("includes all required top-level section headings", () => {
    const review = {
      prUrl: "https://github.com/org/repo/pull/1",
      title: "Test PR",
      author: "alice",
      platform: "github" as const,
      riskLevel: "medium" as const,
      recommendation: "ready_for_human_review" as const,
      whatChanged: "Refactored service layer",
      mustFix: ["Fix null dereference"],
      shouldFix: ["Add input validation"],
      testGaps: ["No unit tests for service layer"],
      securityConcerns: [],
      observabilityConcerns: ["No metrics for new endpoint"],
      migrationRisks: [],
      rollbackConsiderations: ["Revert and redeploy"],
      suggestedReviewComment: "LGTM with minor fixes",
      filesChanged: 3,
      linesAdded: 80,
      linesRemoved: 20,
      ciStatus: "success",
      generatedAt: new Date().toISOString(),
    };

    const doc = reviewAssistant.generateReviewComment(review);

    expect(doc).toContain("# Review Summary");
    expect(doc).toContain("## Risk Level");
    expect(doc).toContain("## Recommendation");
    expect(doc).toContain("## What Changed");
    expect(doc).toContain("## Must Fix");
    expect(doc).toContain("## Should Fix");
    expect(doc).toContain("## Test Gaps");
    expect(doc).toContain("## Observability Concerns");
    expect(doc).toContain("## Rollback Considerations");
    expect(doc).toContain("## Suggested Review Comment");
    expect(doc).toContain("LGTM with minor fixes");
  });

  it("omits empty sections but always has Suggested Review Comment", () => {
    const review = {
      prUrl: "https://github.com/org/repo/pull/2",
      title: "Tiny fix",
      author: "bob",
      platform: "github" as const,
      riskLevel: "low" as const,
      recommendation: "low_risk" as const,
      whatChanged: "Fixed a typo",
      mustFix: [],
      shouldFix: [],
      testGaps: [],
      securityConcerns: [],
      observabilityConcerns: [],
      migrationRisks: [],
      rollbackConsiderations: ["Revert"],
      suggestedReviewComment: "Looks good!",
      filesChanged: 1,
      linesAdded: 1,
      linesRemoved: 1,
      ciStatus: "success",
      generatedAt: new Date().toISOString(),
    };

    const doc = reviewAssistant.generateReviewComment(review);

    expect(doc).toContain("## Suggested Review Comment");
    expect(doc).not.toContain("## Must Fix");
    expect(doc).not.toContain("## Should Fix");
    expect(doc).not.toContain("## Test Gaps");
  });
});

// ─── existingComments population ─────────────────────────────────────────────

describe("reviewAssistant — existingComments populated from API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGithubIsConfigured.mockReturnValue(true);
    mockGetPullRequest.mockResolvedValue(LOW_RISK_PR);
    mockGetPullRequestFiles.mockResolvedValue(LOW_RISK_FILES);
    mockListPullRequestChecks.mockResolvedValue(PASSING_CHECKS);
    mockAiIsConfigured.mockReturnValue(false);
  });

  it("fetches PR comments (GitHub) — API is called", async () => {
    mockListPullRequestComments.mockResolvedValue([
      { body: "LGTM" },
      { body: "Please add tests" },
    ]);
    await reviewAssistant.reviewGitHubPullRequest({ owner: "org", repo: "repo", prNumber: 1 });
    expect(mockListPullRequestComments).toHaveBeenCalledWith(1, "org", "repo");
  });

  it("fetches MR notes (GitLab) — API is called", async () => {
    mockGitlabIsConfigured.mockReturnValue(true);
    mockGetMergeRequest.mockResolvedValue(GITLAB_MR);
    mockGetMergeRequestChanges.mockResolvedValue(GITLAB_CHANGES);
    mockListPipelines.mockResolvedValue([]);
    mockListMergeRequestNotes.mockResolvedValue([
      { id: 1, body: "Looks good", author: { username: "dave" }, system: false },
      { id: 2, body: "assigned to carol", author: { username: "system" }, system: true },
    ]);
    await reviewAssistant.reviewGitLabMergeRequest({ projectId: "123", mrIid: 7 });
    expect(mockListMergeRequestNotes).toHaveBeenCalledWith("123", 7);
  });
});

// ─── createReviewWorkItem ─────────────────────────────────────────────────────

describe("reviewAssistant.createReviewWorkItem", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateWorkItem.mockReturnValue({
      id: "wi-1",
      title: "Review: Fix auth bug",
      type: "code_review",
      status: "proposed",
      priority: "high",
      source: "github",
      sourceUrl: "https://github.com/org/repo/pull/42",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  });

  it("creates a code_review work item with correct priority from riskLevel", () => {
    reviewAssistant.createReviewWorkItem({
      title: "Review: Fix auth bug",
      type: "code_review",
      prUrl: "https://github.com/org/repo/pull/42",
      riskLevel: "high",
      recommendation: "needs_changes",
    });

    expect(mockCreateWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "code_review",
        title: "Review: Fix auth bug",
        priority: "high",
        status: "proposed",
        source: "github",
        sourceUrl: "https://github.com/org/repo/pull/42",
      }),
    );
  });

  it("creates a release work item", () => {
    reviewAssistant.createReviewWorkItem({
      title: "Release: v2.4.0",
      type: "release",
      prUrl: "https://github.com/org/repo/pull/100",
      riskLevel: "low",
      recommendation: "go",
    });

    expect(mockCreateWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "release",
        priority: "low",
      }),
    );
  });

  it("maps critical risk to high priority", () => {
    reviewAssistant.createReviewWorkItem({
      title: "Review: Breaking change",
      type: "code_review",
      riskLevel: "critical",
    });

    expect(mockCreateWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({ priority: "high" }),
    );
  });

  it("respects explicit priority override", () => {
    reviewAssistant.createReviewWorkItem({
      title: "Review: Low-risk but urgent",
      type: "code_review",
      riskLevel: "low",
      priority: "critical",
    });

    expect(mockCreateWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({ priority: "critical" }),
    );
  });

  it("stores riskLevel and recommendation in metadata", () => {
    reviewAssistant.createReviewWorkItem({
      title: "Review: Auth refactor",
      type: "code_review",
      prUrl: "https://github.com/org/repo/pull/7",
      riskLevel: "medium",
      recommendation: "ready_for_human_review",
    });

    expect(mockCreateWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          riskLevel: "medium",
          recommendation: "ready_for_human_review",
          prUrl: "https://github.com/org/repo/pull/7",
        }),
      }),
    );
  });
});

// ── REVIEW_SYSTEM_PROMPT output-budget constraints ────────────────────────────

import { reviewAssistant as _ra } from "../../../src/code-review/review-assistant";

describe("REVIEW_SYSTEM_PROMPT — output budget and conciseness constraints", () => {
  it("prompt includes an explicit token/word budget to prevent truncation", () => {
    // Access via the module: the prompt is used internally, but we can verify
    // its content through the chat call made during a review.
    // We reconstruct what was sent by inspecting the mock call.
    beforeEach(() => {
      vi.clearAllMocks();
      mockGithubIsConfigured.mockReturnValue(true);
      mockGetPullRequest.mockResolvedValue(LOW_RISK_PR);
      mockGetPullRequestFiles.mockResolvedValue(LOW_RISK_FILES);
      mockListPullRequestChecks.mockResolvedValue(PASSING_CHECKS);
      mockListPullRequestComments.mockResolvedValue([]);
      mockAiIsConfigured.mockReturnValue(true);
    });
  });

  it("system prompt enforces max 150-word suggestedReviewComment", async () => {
    vi.clearAllMocks();
    mockGithubIsConfigured.mockReturnValue(true);
    mockGetPullRequest.mockResolvedValue(LOW_RISK_PR);
    mockGetPullRequestFiles.mockResolvedValue(LOW_RISK_FILES);
    mockListPullRequestChecks.mockResolvedValue(PASSING_CHECKS);
    mockListPullRequestComments.mockResolvedValue([]);
    mockAiIsConfigured.mockReturnValue(true);

    mockAiChat.mockResolvedValue({ content: JSON.stringify({ riskLevel: "low", recommendation: "low_risk", mustFix: [], shouldFix: [], testGaps: [], securityConcerns: [], observabilityConcerns: [], migrationRisks: [], rollbackConsiderations: [], whatChanged: "x" }) });

    await reviewAssistant.reviewGitHubPullRequest({ owner: "org", repo: "repo", prNumber: 1 });

    const systemMsg = mockAiChat.mock.calls[0][0].messages.find((m: { role: string }) => m.role === "system");
    expect(systemMsg).toBeDefined();
    // Prompt must constrain suggestedReviewComment length
    expect(systemMsg.content).toMatch(/150 words|under 150/i);
    // Prompt must include an output budget constraint
    expect(systemMsg.content).toMatch(/output budget|1500 tokens|under.*token/i);
    // maxTokens: 16384 (raised from 4096 → 16384; glm-5 has 64K context)
    expect(mockAiChat.mock.calls[0][0].maxTokens).toBe(16384);
  });

  it("system prompt limits each array to 5 items max", async () => {
    vi.clearAllMocks();
    mockGithubIsConfigured.mockReturnValue(true);
    mockGetPullRequest.mockResolvedValue(LOW_RISK_PR);
    mockGetPullRequestFiles.mockResolvedValue(LOW_RISK_FILES);
    mockListPullRequestChecks.mockResolvedValue(PASSING_CHECKS);
    mockListPullRequestComments.mockResolvedValue([]);
    mockAiIsConfigured.mockReturnValue(true);

    mockAiChat.mockResolvedValue({ content: JSON.stringify({ riskLevel: "low", recommendation: "low_risk", mustFix: [], shouldFix: [], testGaps: [], securityConcerns: [], observabilityConcerns: [], migrationRisks: [], rollbackConsiderations: [], whatChanged: "x" }) });

    await reviewAssistant.reviewGitHubPullRequest({ owner: "org", repo: "repo", prNumber: 1 });

    const systemMsg = mockAiChat.mock.calls[0][0].messages.find((m: { role: string }) => m.role === "system");
    expect(systemMsg.content).toMatch(/max 5 items|5 items/i);
  });
});

// ── Regression: IR-106 mid-JSON truncation scenario ──────────────────────────

describe("regression: AI review truncated mid-JSON (IR-106 / breakglass MR)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGithubIsConfigured.mockReturnValue(true);
    mockGetPullRequest.mockResolvedValue({
      ...HIGH_RISK_PR,
      title: "Breakglass Emergency Access — Session Bypasses",
      head: { ref: "ai/issue-106-breakglass", sha: "4ad1c559" },
    });
    mockGetPullRequestFiles.mockResolvedValue(HIGH_RISK_FILES);
    mockListPullRequestChecks.mockResolvedValue(PASSING_CHECKS);
    mockListPullRequestComments.mockResolvedValue([]);
    mockAiIsConfigured.mockReturnValue(true);
  });

  it("escalates when JSON is cut off inside a migrationRisks string value", async () => {
    // Mirrors the exact truncation seen in production for IR-106
    mockAiChat.mockResolvedValue({
      content: '{"whatChanged":"Adds breakglass emergency access endpoint","riskLevel":"high","recommendation":"needs_changes","mustFix":["auth.ts:42 — session not regenerated after privilege elevation"],"shouldFix":[],"testGaps":[],"securityConcerns":["loggingAttempts Map grows large — indicate an active enumeration"],"observabilityConcerns":[],"migrationRisks": "/api/breakglass/lo',
    });

    const review = await reviewAssistant.reviewGitHubPullRequest({ owner: "org", repo: "repo", prNumber: 42 });

    expect(review.riskLevel).toBe("high");
    expect(review.recommendation).toBe("needs_changes");
    expect(review.mustFix.some((m) => /truncated/i.test(m))).toBe(true);
    expect(review.securityConcerns.some((c) => /AI review was unavailable/i.test(c))).toBe(true);
  });

  it("does NOT escalate when the same review completes within 8192 tokens", async () => {
    const fullReview = {
      whatChanged: "Adds breakglass emergency access endpoint with rate limiting",
      riskLevel: "high",
      recommendation: "needs_changes",
      mustFix: ["auth.ts:42 — session not regenerated after privilege elevation"],
      shouldFix: ["breakglass.ts:18 — loggingAttempts Map can grow unbounded"],
      testGaps: ["No test for rate-limit enforcement"],
      securityConcerns: ["Weak rate limit: 10 attempts per IP — brute-forceable"],
      observabilityConcerns: [],
      migrationRisks: [],
      rollbackConsiderations: ["Revert and redeploy"],
      suggestedReviewComment: "🟠 HIGH: session not regenerated after privilege elevation. Weak rate limit.",
    };
    mockAiChat.mockResolvedValue({ content: JSON.stringify(fullReview) });

    const review = await reviewAssistant.reviewGitHubPullRequest({ owner: "org", repo: "repo", prNumber: 42 });

    expect(review.mustFix).toContain("auth.ts:42 — session not regenerated after privilege elevation");
    expect(review.mustFix.every((m) => !/truncated/i.test(m))).toBe(true);
    expect(review.riskLevel).toBe("high");
  });

  it("passes maxTokens: 16384 even for security-sensitive PRs", async () => {
    mockAiChat.mockResolvedValue({ content: JSON.stringify({ riskLevel: "high", recommendation: "needs_changes", mustFix: ["auth.ts:1 — x"], shouldFix: [], testGaps: [], securityConcerns: [], observabilityConcerns: [], migrationRisks: [], rollbackConsiderations: [], whatChanged: "breakglass endpoint" }) });

    await reviewAssistant.reviewGitHubPullRequest({ owner: "org", repo: "repo", prNumber: 42 });

    expect(mockAiChat).toHaveBeenCalledWith(expect.objectContaining({ maxTokens: 16384 }));
  });
});
