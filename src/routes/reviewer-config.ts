import { FastifyInstance } from "fastify";
import { env } from "../config/env";
import { reviewAssistant } from "../code-review/review-assistant";
import type { CodeReview } from "../code-review/types";
import type { ReviewStreamEvent } from "../code-review/review-assistant";

export interface ReviewerConfig {
  source: string;
  githubToken: string;
  owner: string;
  reviewRepos: string[];
  pollIntervalMs: number;
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
  // Extract the first file:line reference from finding text.
  // The model is instructed to write "filename.ext:line_number — description".
  // Some findings reference multiple files ("file1.js:10, file2.js:20 — desc") —
  // we extract just the first one since that's the primary location.

  // Pattern 1: "filename.ext:line — description" (explicit file:line, required format)
  const explicitMatch = text.match(/^([\w./\-]+\.\w{1,10})\s*:\s*(\d+)\s*[,\s]*[—\-–]/);
  if (explicitMatch) {
    return {
      severity,
      category,
      file: explicitMatch[1],
      line: parseInt(explicitMatch[2], 10),
      message: text,
      suggestion: "See the full review comment on the PR.",
    };
  }
  // Pattern 2: "filename.ext — description" (file without line number)
  const fileOnlyMatch = text.match(/^([\w./\-]+\.\w{1,10})\s*[—\-–]/);
  if (fileOnlyMatch) {
    return {
      severity,
      category,
      file: fileOnlyMatch[1],
      line: undefined,
      message: text,
      suggestion: "See the full review comment on the PR.",
    };
  }
  // Pattern 3: fallback — first filename.ext anywhere in text (before the " — " separator)
  // Only search in the part before " — " to avoid picking up filenames from the description.
  const beforeDash = text.split(/\s+[—\-–]\s+/)[0];
  const looseMatch = beforeDash.match(/\b([\w./\-]+\.\w{1,10})(?::(\d+))?/);
  return {
    severity,
    category,
    file: looseMatch?.[1] ?? "unknown",
    line: looseMatch?.[2] ? parseInt(looseMatch[2], 10) : undefined,
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
      source?: "github" | "gitlab";
      gitlabProject?: string;
    };

    if (!body.prNumber || typeof body.prNumber !== "number") {
      return { success: false, error: "prNumber (number) is required" };
    }

    const source = body.source || "github";

    try {
      let review;

      if (source === "gitlab") {
        const projectId = body.gitlabProject || body.owner || env.GITLAB_DEFAULT_PROJECT;
        if (!projectId) {
          return { success: false, error: "gitlabProject is required for GitLab reviews (or set GITLAB_DEFAULT_PROJECT)" };
        }
        review = await reviewAssistant.reviewGitLabMergeRequest({
          projectId,
          mrIid: body.prNumber,
        });
      } else {
        const owner = body.owner || env.GITHUB_DEFAULT_OWNER;
        const repo = body.repo || env.GITHUB_DEFAULT_REPO;
        if (!owner || !repo) {
          return { success: false, error: "owner and repo are required (or set GITHUB_DEFAULT_OWNER/REPO)" };
        }
        review = await reviewAssistant.reviewGitHubPullRequest({
          owner,
          repo,
          prNumber: body.prNumber,
        });
      }

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

  // SSE streaming review endpoint — same logic as /review but streams progress
  fastify.post("/review/stream", async (request, reply): Promise<void> => {
    const body = request.body as {
      owner?: string;
      repo?: string;
      prNumber?: number;
      source?: "github" | "gitlab";
      gitlabProject?: string;
    };

    if (!body.prNumber || typeof body.prNumber !== "number") {
      reply.raw.writeHead(400, { "Content-Type": "application/json" });
      reply.raw.end(JSON.stringify({ success: false, error: "prNumber (number) is required" }));
      return;
    }

    const source = body.source || "github";

    // Set up SSE headers
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const sendEvent = (event: ReviewStreamEvent) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    try {
      let review: CodeReview;

      if (source === "gitlab") {
        const projectId = body.gitlabProject || body.owner || env.GITLAB_DEFAULT_PROJECT;
        if (!projectId) {
          sendEvent({ type: "progress", message: "Error: gitlabProject is required for GitLab reviews" });
          reply.raw.end();
          return;
        }
        review = await reviewAssistant.reviewWithStreaming(
          { projectId, mrIid: body.prNumber },
          sendEvent,
        );
      } else {
        const owner = body.owner || env.GITHUB_DEFAULT_OWNER;
        const repo = body.repo || env.GITHUB_DEFAULT_REPO;
        if (!owner || !repo) {
          sendEvent({ type: "progress", message: "Error: owner and repo are required" });
          reply.raw.end();
          return;
        }
        review = await reviewAssistant.reviewWithStreaming(
          { owner, repo, prNumber: body.prNumber },
          sendEvent,
        );
      }

      const findings = codeReviewToFindings(review);
      const hasCriticalOrHigh = findings.some(
        (f) => f.severity === "critical" || f.severity === "high",
      );

      sendEvent({
        type: "result",
        data: {
          success: true,
          clean: !hasCriticalOrHigh,
          findings,
          riskLevel: review.riskLevel,
          recommendation: review.recommendation,
          summary: review.suggestedReviewComment,
        },
      } as any);

      reply.raw.end();
    } catch (err) {
      sendEvent({ type: "progress", message: `Review failed: ${(err as Error).message}` });
      reply.raw.end();
    }
  });
}
