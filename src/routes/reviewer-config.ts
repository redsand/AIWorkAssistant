import { FastifyInstance } from "fastify";
import { env } from "../config/env";
import { reviewAssistant } from "../code-review/review-assistant";
import type { CodeReview } from "../code-review/types";

export interface ReviewerConfig {
  source: string;
  githubToken: string;
  owner: string;
  reviewRepos: string[];
  pollIntervalMs: number;
  maxReviewCycles: number;
  securityAgentCmd: string;
  qaAgentCmd: string;
  qualityAgentCmd: string;
  gitlabProject: string;
}

export interface ReviewFinding {
  severity: "critical" | "high" | "medium" | "low";
  category: "security" | "qa" | "quality";
  file: string;
  line?: number;
  message: string;
  suggestion: string;
}

function findingFromText(
  text: string,
  severity: ReviewFinding["severity"],
  category: ReviewFinding["category"],
): ReviewFinding {
  const fileMatch = text.match(/\b([\w./\-]+\.\w{1,10})(?::(\d+))?/);
  return {
    severity,
    category,
    file: fileMatch?.[1] ?? "unknown",
    line: fileMatch?.[2] ? parseInt(fileMatch[2], 10) : undefined,
    message: text,
    suggestion: "See the full review comment on the PR.",
  };
}

function codeReviewToFindings(review: CodeReview): ReviewFinding[] {
  const findings: ReviewFinding[] = [];

  const add = (
    items: string[],
    severity: ReviewFinding["severity"],
    category: ReviewFinding["category"],
  ) => {
    for (const text of items) {
      findings.push(findingFromText(text, severity, category));
    }
  };

  add(review.mustFix, "critical", "quality");
  add(review.securityConcerns, "high", "security");
  add(review.migrationRisks, "high", "quality");
  add(review.shouldFix, "medium", "quality");
  add(review.testGaps, "medium", "qa");
  add(review.observabilityConcerns, "low", "quality");

  return findings;
}

export async function reviewerConfigRoutes(fastify: FastifyInstance) {
  fastify.get("/config", async (_request, _reply): Promise<ReviewerConfig> => {
    return {
      source: env.REVIEW_SOURCE,
      githubToken: env.GITHUB_TOKEN,
      owner: env.GITHUB_DEFAULT_OWNER || "redsand",
      reviewRepos: env.REVIEW_REPOS.split(",").filter(Boolean),
      pollIntervalMs: env.REVIEW_POLL_INTERVAL_MS,
      maxReviewCycles: env.REVIEW_MAX_CYCLES,
      securityAgentCmd: env.SECURITY_AGENT_CMD,
      qaAgentCmd: env.QA_AGENT_CMD,
      qualityAgentCmd: env.QUALITY_AGENT_CMD,
      gitlabProject: env.GITLAB_DEFAULT_PROJECT,
    };
  });

  fastify.post("/review", async (request, _reply) => {
    const body = request.body as {
      owner?: string;
      repo?: string;
      prNumber?: number;
    };

    if (!body.prNumber || typeof body.prNumber !== "number") {
      return { success: false, error: "prNumber (number) is required" };
    }

    const owner = body.owner || env.GITHUB_DEFAULT_OWNER;
    const repo = body.repo || env.GITHUB_DEFAULT_REPO;

    if (!owner || !repo) {
      return {
        success: false,
        error: "owner and repo are required (or set GITHUB_DEFAULT_OWNER/REPO)",
      };
    }

    try {
      const review = await reviewAssistant.reviewGitHubPullRequest({
        owner,
        repo,
        prNumber: body.prNumber,
      });

      const findings = codeReviewToFindings(review);
      const hasCriticalOrHigh = findings.some(
        (f) => f.severity === "critical" || f.severity === "high",
      );

      return {
        success: true,
        clean: !hasCriticalOrHigh,
        findings,
        riskLevel: review.riskLevel,
        recommendation: review.recommendation,
        summary: review.suggestedReviewComment,
      };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
}
