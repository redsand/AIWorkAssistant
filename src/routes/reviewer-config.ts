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

export type { ReviewFinding } from "../code-review/findings-adapter";
import type { ReviewFinding } from "../code-review/findings-adapter";
import { codeReviewToFindings } from "../code-review/findings-adapter";

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
