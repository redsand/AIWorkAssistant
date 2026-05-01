/**
 * GitLab webhook routes
 */

import { FastifyInstance } from "fastify";
import { webhookHandler } from "../integrations/gitlab/webhook-handler";

export async function gitlabWebhookRoutes(fastify: FastifyInstance) {
  /**
   * GitLab webhook endpoint
   */
  fastify.post("/webhooks/gitlab", async (request, reply) => {
    try {
      // Verify webhook signature
      const signature = request.headers["x-gitlab-token"] as string;
      const body = request.body as any;

      if (!signature) {
        fastify.log.warn("[GitLab] Webhook received without signature");
      }

      if (
        !webhookHandler.verifyWebhook(signature || "", JSON.stringify(body))
      ) {
        reply.code(401);
        return { error: "Invalid webhook signature" };
      }

      // Handle different event types
      const eventType = body.object_kind;

      if (eventType === "push") {
        await webhookHandler.handlePush(body);
      } else if (eventType === "merge_request") {
        await webhookHandler.handleMergeRequest(body);
      } else {
        fastify.log.info(`[GitLab] Unsupported event type: ${eventType}`);
      }

      return { status: "ok" };
    } catch (error) {
      fastify.log.error(error);
      reply.code(500);
      return {
        error: "Failed to process webhook",
        message: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });
}
