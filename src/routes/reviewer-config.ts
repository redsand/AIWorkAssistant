import { FastifyInstance } from "fastify";
import { env } from "../config/env";

export interface ReviewerConfig {
  githubToken: string;
  owner: string;
  reviewRepos: string[];
  pollIntervalMs: number;
  maxReviewCycles: number;
  securityAgentCmd: string;
  qaAgentCmd: string;
  qualityAgentCmd: string;
}

export async function reviewerConfigRoutes(fastify: FastifyInstance) {
  fastify.get("/config", async (_request, _reply): Promise<ReviewerConfig> => {
    return {
      githubToken: env.GITHUB_TOKEN,
      owner: env.GITHUB_DEFAULT_OWNER || "redsand",
      reviewRepos: env.REVIEW_REPOS.split(",").filter(Boolean),
      pollIntervalMs: env.REVIEW_POLL_INTERVAL_MS,
      maxReviewCycles: env.REVIEW_MAX_CYCLES,
      securityAgentCmd: env.SECURITY_AGENT_CMD,
      qaAgentCmd: env.QA_AGENT_CMD,
      qualityAgentCmd: env.QUALITY_AGENT_CMD,
    };
  });
}
