import { FastifyInstance } from "fastify";
import { reviewAssistant } from "../code-review/review-assistant";
import type { GitHubPRReviewInput, GitLabMRReviewInput, ReleaseReadinessInput } from "../code-review/types";

export async function codeReviewRoutes(fastify: FastifyInstance) {
  fastify.post("/github/pr", async (request, _reply) => {
    const { owner, repo, prNumber } = request.body as GitHubPRReviewInput;

    if (!owner || !repo || !prNumber) {
      return { success: false, error: "owner, repo, and prNumber are required" };
    }

    try {
      const review = await reviewAssistant.reviewGitHubPullRequest({ owner, repo, prNumber });
      return { success: true, review };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  fastify.post("/gitlab/mr", async (request, _reply) => {
    const { projectId, mrIid } = request.body as GitLabMRReviewInput;

    if (!projectId || !mrIid) {
      return { success: false, error: "projectId and mrIid are required" };
    }

    try {
      const review = await reviewAssistant.reviewGitLabMergeRequest({ projectId, mrIid });
      return { success: true, review };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });

  fastify.post("/release-readiness", async (request, _reply) => {
    const input = request.body as ReleaseReadinessInput;

    if (!input?.platform) {
      return { success: false, error: "platform is required (github or gitlab)" };
    }

    try {
      const report = await reviewAssistant.generateReleaseReadinessReport(input);
      return { success: true, report };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  });
}
