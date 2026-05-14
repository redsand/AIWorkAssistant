/**
 * Smoke tests: prove the LLM response pipeline end-to-end.
 *
 * Covers:
 *   1. Full valid JSON → parsed correctly, AI findings present
 *   2. Markdown with {code} fragments → JSON.parse throws → retries × 3 → escalation
 *   3. Truncated response (no closing brace) → immediate escalation, no retry
 *   4. Network error per attempt → all retries exhausted → heuristic fallback
 *   5. IR-98/IR-106 scenario: security review with hardcoded credentials
 *   6. Streaming path: valid JSON → parsed correctly
 *   7. Streaming path: markdown with {} → retries × 3 → escalation
 *   8. Streaming path: truncated stream → immediate escalation
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks (must not reference module-level consts) ────────────────────

const {
  mockAiIsConfigured,
  mockAiChat,
  mockAiChatStream,
  mockGetPullRequest,
  mockGetPullRequestFiles,
  mockListChecks,
  mockListComments,
  mockGetMergeRequest,
  mockGetMergeRequestChanges,
  mockListPipelines,
  mockListMergeRequestNotes,
} = vi.hoisted(() => ({
  mockAiIsConfigured: vi.fn(() => true),
  mockAiChat: vi.fn(),
  mockAiChatStream: vi.fn(),
  mockGetPullRequest: vi.fn(),
  mockGetPullRequestFiles: vi.fn(),
  mockListChecks: vi.fn(),
  mockListComments: vi.fn(),
  mockGetMergeRequest: vi.fn(),
  mockGetMergeRequestChanges: vi.fn(),
  mockListPipelines: vi.fn(),
  mockListMergeRequestNotes: vi.fn(),
}));

vi.mock("../../../src/agent/opencode-client", () => ({
  aiClient: {
    isConfigured: mockAiIsConfigured,
    chat: mockAiChat,
    chatStream: mockAiChatStream,
  },
}));

vi.mock("../../../src/integrations/github/github-client", () => ({
  githubClient: {
    isConfigured: vi.fn(() => true),
    getPullRequest: mockGetPullRequest,
    getPullRequestFiles: mockGetPullRequestFiles,
    listPullRequestChecks: mockListChecks,
    listPullRequestComments: mockListComments,
    getIssue: vi.fn().mockRejectedValue(new Error("not found")),
  },
}));

vi.mock("../../../src/integrations/gitlab/gitlab-client", () => ({
  gitlabClient: {
    isConfigured: vi.fn(() => false),
    getMergeRequest: mockGetMergeRequest,
    getMergeRequestChanges: mockGetMergeRequestChanges,
    listPipelines: mockListPipelines,
    listMergeRequestNotes: mockListMergeRequestNotes,
  },
}));

vi.mock("../../../src/integrations/jira/jira-client", () => ({
  jiraClient: {
    isConfigured: vi.fn(() => false),
    getIssue: vi.fn(),
  },
}));

vi.mock("../../../src/work-items/database", () => ({
  workItemDatabase: { createWorkItem: vi.fn() },
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PR_FIXTURE = {
  title: "IR-98: Remove hardcoded credentials from config loader",
  body: "Closes IR-98. Replaces hardcoded DB password with env var lookup.",
  user: { login: "ai-agent" },
  head: { ref: "ai/issue-98-remove-hardcoded-credentials", sha: "4ad1c559" },
  base: { ref: "main" },
  html_url: "https://github.com/org/hawk-soar-cloud-v3/pull/98",
};

const FILES_FIXTURE = [
  {
    filename: "src/config/loader.ts",
    status: "modified",
    additions: 12,
    deletions: 8,
    patch: '-const DB_PASSWORD = "supersecret";\n+const DB_PASSWORD = process.env.DB_PASSWORD ?? "";',
  },
  {
    filename: "src/auth/token.ts",
    status: "modified",
    additions: 5,
    deletions: 3,
    patch: "-const SECRET = 'hardcoded';\n+const SECRET = process.env.JWT_SECRET ?? '';",
  },
];

/** A realistic full AI review for the IR-98 scenario */
const FULL_AI_REVIEW = {
  whatChanged:
    "Replaces two hardcoded credentials (DB password, JWT secret) with environment variable lookups in config/loader.ts and auth/token.ts.",
  riskLevel: "medium",
  recommendation: "ready_for_human_review",
  mustFix: [],
  shouldFix: [
    "config/loader.ts:14 — add validation that DB_PASSWORD is non-empty at startup",
    "auth/token.ts:9 — log a warning (not the value) when JWT_SECRET is missing",
  ],
  testGaps: ["No test verifying startup fails when DB_PASSWORD is unset"],
  securityConcerns: [
    "Confirm no other hardcoded credentials remain — grep for password|secret|token literals",
  ],
  observabilityConcerns: [],
  migrationRisks: [],
  rollbackConsiderations: ["Revert PR and re-set secrets in env — no DB schema changes"],
  suggestedReviewComment:
    "🟡 MEDIUM: credentials moved to env vars. Verify DB_PASSWORD/JWT_SECRET are set in all environments before merge.",
};

/** Markdown response the model sometimes returns instead of JSON — has {key: val} fragments */
const MARKDOWN_RESPONSE = `
I reviewed the changes to the credential loading code.

The \`config/loader.ts\` file previously used \`{key: "hardcoded_value"}\` which is a security risk.
The fix uses \`process.env.DB_PASSWORD\` which is much better.

**Summary:** This is a good security improvement. I recommend merging after verifying env vars are set.

**Risk:** Medium — credentials properly moved to env vars.
`;

/** Response truncated mid-JSON (no closing brace — simulates token-limit cut-off) */
const TRUNCATED_MID_JSON =
  '{"whatChanged":"Removes hardcoded credentials","riskLevel":"medium","mustFix":[],"shouldFix":["config/loader.ts:14 — add';

/**
 * Simulates the production IR-98/MR-11 truncation: the model completes all important fields
 * (riskLevel, mustFix, securityConcerns) but gets cut off mid-suggestedReviewComment.
 * extractPartialReview should recover the real findings from this partial content.
 */
const TRUNCATED_BEFORE_COMMENT =
  `{"whatChanged":"Removes hardcoded OpenAI API key and Elasticsearch credentials from .env file","riskLevel":"critical",` +
  `"recommendation":"needs_changes","mustFix":["Revoke exposed credentials immediately — they are in git history regardless of file deletion",` +
  `"Run BFG Repo-Cleaner or git filter-repo to scrub secrets from git history"],"shouldFix":[".env.example:4 — add trailing newline"],` +
  `"testGaps":["Verify .gitignore pattern excludes nested .env files"],"securityConcerns":["OpenAI key sk-6T1TX... is in git history — must be revoked",` +
  `"Elasticsearch password exposed — must be rotated"],"observabilityConcerns":[],"migrationRisks":[],"rollbackConsiderations":["Rollback would re-expose .env file"],` +
  `"suggestedReviewComment":"🔴 CRITICAL: hardcoded credentials were committed. Deleting the file does not remove them from git history`;

// ── Helper: async generator from string chunks ────────────────────────────────

async function* chunked(content: string, size = 50): AsyncGenerator<string> {
  for (let i = 0; i < content.length; i += size) {
    yield content.slice(i, i + size);
  }
}

// ── Import under test (after mocks are hoisted) ───────────────────────────────

import { reviewAssistant } from "../../../src/code-review/review-assistant";

// ── Shared beforeEach for non-streaming tests ─────────────────────────────────

function setupGitHubMocks() {
  mockGetPullRequest.mockResolvedValue(PR_FIXTURE);
  mockGetPullRequestFiles.mockResolvedValue(FILES_FIXTURE);
  mockListChecks.mockResolvedValue([{ conclusion: "success" }]);
  mockListComments.mockResolvedValue([]);
}

// ── Non-streaming path (buildReview via reviewGitHubPullRequest) ──────────────

describe("smoke: non-streaming path — full valid JSON", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAiIsConfigured.mockReturnValue(true);
    setupGitHubMocks();
    mockAiChat.mockResolvedValue({ content: JSON.stringify(FULL_AI_REVIEW) });
  });

  it("parses AI review JSON and populates all fields", async () => {
    const review = await reviewAssistant.reviewGitHubPullRequest({
      owner: "org",
      repo: "hawk-soar-cloud-v3",
      prNumber: 98,
    });

    expect(review.whatChanged).toBe(FULL_AI_REVIEW.whatChanged);
    expect(review.riskLevel).toBe("medium");
    expect(review.recommendation).toBe("ready_for_human_review");
    expect(review.shouldFix).toHaveLength(2);
    expect(review.securityConcerns).toHaveLength(1);
    expect(review.suggestedReviewComment).toContain("MEDIUM");
  });

  it("AI is called exactly once when JSON parses on first attempt", async () => {
    await reviewAssistant.reviewGitHubPullRequest({ owner: "org", repo: "hawk-soar-cloud-v3", prNumber: 98 });
    expect(mockAiChat).toHaveBeenCalledTimes(1);
  });
});

describe("smoke: non-streaming path — markdown with {code} triggers retries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAiIsConfigured.mockReturnValue(true);
    setupGitHubMocks();
    mockAiChat.mockResolvedValue({ content: MARKDOWN_RESPONSE });
  });

  it("retries exactly MAX_REVIEW_RETRIES (3) times before escalating", async () => {
    const review = await reviewAssistant.reviewGitHubPullRequest({
      owner: "org",
      repo: "hawk-soar-cloud-v3",
      prNumber: 98,
    });

    expect(mockAiChat).toHaveBeenCalledTimes(3);
    expect(review.riskLevel).toBe("high");
    expect(review.recommendation).toBe("needs_changes");
  });

  it("escalation mustFix message mentions retries or manual review", async () => {
    const review = await reviewAssistant.reviewGitHubPullRequest({
      owner: "org",
      repo: "hawk-soar-cloud-v3",
      prNumber: 98,
    });

    expect(review.mustFix.some((m) => /manual review|retries/i.test(m))).toBe(true);
  });

  it("second attempt succeeds if model returns valid JSON on retry", async () => {
    mockAiChat
      .mockResolvedValueOnce({ content: MARKDOWN_RESPONSE })
      .mockResolvedValueOnce({ content: JSON.stringify(FULL_AI_REVIEW) });

    const review = await reviewAssistant.reviewGitHubPullRequest({
      owner: "org",
      repo: "hawk-soar-cloud-v3",
      prNumber: 98,
    });

    expect(mockAiChat).toHaveBeenCalledTimes(2);
    expect(review.riskLevel).toBe("medium");
    expect(review.recommendation).toBe("ready_for_human_review");
    expect(review.whatChanged).toBe(FULL_AI_REVIEW.whatChanged);
  });
});

describe("smoke: non-streaming path — truncated response (no closing brace)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAiIsConfigured.mockReturnValue(true);
    setupGitHubMocks();
    mockAiChat.mockResolvedValue({ content: TRUNCATED_MID_JSON });
  });

  it("escalates immediately without retrying when no JSON match found", async () => {
    const review = await reviewAssistant.reviewGitHubPullRequest({
      owner: "org",
      repo: "hawk-soar-cloud-v3",
      prNumber: 98,
    });

    // Truncation path breaks immediately — only 1 AI call
    expect(mockAiChat).toHaveBeenCalledTimes(1);
    expect(review.riskLevel).toBe("high");
    expect(review.recommendation).toBe("needs_changes");
    expect(review.mustFix.some((m) => /truncated/i.test(m))).toBe(true);
    expect(review.securityConcerns.some((c) => /AI review was unavailable/i.test(c))).toBe(true);
  });
});

describe("smoke: non-streaming path — network errors on all attempts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAiIsConfigured.mockReturnValue(true);
    setupGitHubMocks();
    mockAiChat.mockRejectedValue(new Error("ECONNREFUSED"));
  });

  it("falls through to heuristic fallback after all retries throw", async () => {
    const review = await reviewAssistant.reviewGitHubPullRequest({
      owner: "org",
      repo: "hawk-soar-cloud-v3",
      prNumber: 98,
    });

    expect(mockAiChat).toHaveBeenCalledTimes(3);
    // Heuristic fallback always escalates
    expect(review.riskLevel).toBe("high");
    expect(review.recommendation).toBe("needs_changes");
    expect(review.mustFix.some((m) => /AI review was unavailable/i.test(m))).toBe(true);
  });
});

// ── IR-98/IR-106 scenario: hardcoded credentials security review ──────────────

describe("smoke: IR-98 scenario — hardcoded credentials security review", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAiIsConfigured.mockReturnValue(true);
    setupGitHubMocks();
    mockAiChat.mockResolvedValue({ content: JSON.stringify(FULL_AI_REVIEW) });
  });

  it("surfaces securityConcerns about remaining hardcoded credential search", async () => {
    const review = await reviewAssistant.reviewGitHubPullRequest({
      owner: "org",
      repo: "hawk-soar-cloud-v3",
      prNumber: 98,
    });

    expect(review.securityConcerns).toHaveLength(1);
    expect(review.securityConcerns[0]).toMatch(/hardcoded|credential/i);
  });

  it("rollbackConsiderations includes env var rollback guidance", async () => {
    const review = await reviewAssistant.reviewGitHubPullRequest({
      owner: "org",
      repo: "hawk-soar-cloud-v3",
      prNumber: 98,
    });

    expect(review.rollbackConsiderations.length).toBeGreaterThan(0);
    expect(review.rollbackConsiderations.some((r) => /env|revert/i.test(r))).toBe(true);
  });

  it("uses AI findings over heuristic defaults", async () => {
    const review = await reviewAssistant.reviewGitHubPullRequest({
      owner: "org",
      repo: "hawk-soar-cloud-v3",
      prNumber: 98,
    });

    // Heuristic fallback would say "AI review was unavailable" — AI path does not
    expect(review.mustFix.every((m) => !/AI review was unavailable/i.test(m))).toBe(true);
    expect(review.whatChanged).toBe(FULL_AI_REVIEW.whatChanged);
  });
});

// ── Streaming path (buildReviewStreaming via reviewWithStreaming) ──────────────

describe("smoke: streaming path — full valid JSON", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAiIsConfigured.mockReturnValue(true);
    setupGitHubMocks();
    mockAiChatStream.mockImplementation(() => chunked(JSON.stringify(FULL_AI_REVIEW)));
  });

  it("parses streamed AI review and populates all fields", async () => {
    const events: string[] = [];
    const review = await reviewAssistant.reviewWithStreaming(
      { owner: "org", repo: "hawk-soar-cloud-v3", prNumber: 98 },
      (e) => { if (e.type === "progress") events.push(e.message ?? ""); },
    );

    expect(review.riskLevel).toBe("medium");
    expect(review.recommendation).toBe("ready_for_human_review");
    expect(review.whatChanged).toBe(FULL_AI_REVIEW.whatChanged);
    expect(events.some((m) => /parsing results/i.test(m))).toBe(true);
  });

  it("stream is consumed exactly once when JSON parses on first attempt", async () => {
    await reviewAssistant.reviewWithStreaming(
      { owner: "org", repo: "hawk-soar-cloud-v3", prNumber: 98 },
    );
    expect(mockAiChatStream).toHaveBeenCalledTimes(1);
  });
});

describe("smoke: streaming path — markdown with {} triggers retries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAiIsConfigured.mockReturnValue(true);
    setupGitHubMocks();
    mockAiChatStream.mockImplementation(() => chunked(MARKDOWN_RESPONSE));
  });

  it("retries exactly 3 times then escalates", async () => {
    const review = await reviewAssistant.reviewWithStreaming(
      { owner: "org", repo: "hawk-soar-cloud-v3", prNumber: 98 },
    );

    expect(mockAiChatStream).toHaveBeenCalledTimes(3);
    expect(review.riskLevel).toBe("high");
    expect(review.recommendation).toBe("needs_changes");
    expect(review.mustFix.some((m) => /retries|manual review/i.test(m))).toBe(true);
  });

  it("succeeds on retry if second stream returns valid JSON", async () => {
    mockAiChatStream
      .mockImplementationOnce(() => chunked(MARKDOWN_RESPONSE))
      .mockImplementationOnce(() => chunked(JSON.stringify(FULL_AI_REVIEW)));

    const review = await reviewAssistant.reviewWithStreaming(
      { owner: "org", repo: "hawk-soar-cloud-v3", prNumber: 98 },
    );

    expect(mockAiChatStream).toHaveBeenCalledTimes(2);
    expect(review.riskLevel).toBe("medium");
    expect(review.whatChanged).toBe(FULL_AI_REVIEW.whatChanged);
  });
});

describe("smoke: streaming path — partial extraction from production truncation pattern", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAiIsConfigured.mockReturnValue(true);
    setupGitHubMocks();
    // All 3 retries return the truncated-before-suggestedReviewComment response
    mockAiChatStream.mockImplementation(() => chunked(TRUNCATED_BEFORE_COMMENT));
  });

  it("recovers real findings via partial extraction instead of fake escalation", async () => {
    const review = await reviewAssistant.reviewWithStreaming(
      { owner: "org", repo: "hawk-soar-cloud-v3", prNumber: 98 },
    );

    // extractPartialReview should recover actual riskLevel/recommendation/findings
    expect(review.riskLevel).toBe("critical");
    expect(review.recommendation).toBe("needs_changes");
    // Real mustFix items extracted — not the fake escalation message
    expect(review.mustFix.some((m) => /revoke|credentials|BFG/i.test(m))).toBe(true);
    expect(review.mustFix.every((m) => !/truncated|manual review|unavailable/i.test(m))).toBe(true);
    // Real security concerns extracted
    expect(review.securityConcerns.some((c) => /OpenAI|key|sk-/i.test(c))).toBe(true);
  });

  it("uses all 3 retries before attempting partial extraction", async () => {
    await reviewAssistant.reviewWithStreaming(
      { owner: "org", repo: "hawk-soar-cloud-v3", prNumber: 98 },
    );
    expect(mockAiChatStream).toHaveBeenCalledTimes(3);
  });

  it("partial review succeeds if a later retry returns complete JSON", async () => {
    mockAiChatStream
      .mockImplementationOnce(() => chunked(TRUNCATED_BEFORE_COMMENT))
      .mockImplementationOnce(() => chunked(JSON.stringify(FULL_AI_REVIEW)));

    const review = await reviewAssistant.reviewWithStreaming(
      { owner: "org", repo: "hawk-soar-cloud-v3", prNumber: 98 },
    );

    expect(mockAiChatStream).toHaveBeenCalledTimes(2);
    expect(review.riskLevel).toBe("medium");
    expect(review.whatChanged).toBe(FULL_AI_REVIEW.whatChanged);
  });
});

describe("smoke: streaming path — truncated stream (no closing brace)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAiIsConfigured.mockReturnValue(true);
    setupGitHubMocks();
    mockAiChatStream.mockImplementation(() => chunked(TRUNCATED_MID_JSON));
  });

  it("retries all MAX_REVIEW_RETRIES (3) times then escalates with truncation message", async () => {
    const review = await reviewAssistant.reviewWithStreaming(
      { owner: "org", repo: "hawk-soar-cloud-v3", prNumber: 98 },
    );

    // Streaming path retries truncation (model may produce complete JSON on retry)
    expect(mockAiChatStream).toHaveBeenCalledTimes(3);
    expect(review.riskLevel).toBe("high");
    expect(review.mustFix.some((m) => /truncated|manual review/i.test(m))).toBe(true);
    expect(review.securityConcerns.some((c) => /AI review was unavailable/i.test(c))).toBe(true);
  });

  it("succeeds if a later retry returns complete JSON", async () => {
    mockAiChatStream
      .mockImplementationOnce(() => chunked(TRUNCATED_MID_JSON))
      .mockImplementationOnce(() => chunked(JSON.stringify(FULL_AI_REVIEW)));

    const review = await reviewAssistant.reviewWithStreaming(
      { owner: "org", repo: "hawk-soar-cloud-v3", prNumber: 98 },
    );

    expect(mockAiChatStream).toHaveBeenCalledTimes(2);
    expect(review.riskLevel).toBe("medium");
    expect(review.whatChanged).toBe(FULL_AI_REVIEW.whatChanged);
  });
});
