/**
 * Health check route
 */

import { FastifyInstance } from "fastify";
import { githubClient } from "../integrations/github/github-client";
import { gitlabClient } from "../integrations/gitlab/gitlab-client";
import { jiraClient } from "../integrations/jira/jira-client";
import { jitbitClient } from "../integrations/jitbit/jitbit-client";

export async function healthRoutes(fastify: FastifyInstance) {
  fastify.get("/health", async (_request, _reply) => {
    const [githubValid, gitlabValid, jiraValid, jitbitValid] = await Promise.all([
      githubClient.isConfigured()
        ? githubClient.validateConfig().catch(() => false)
        : false,
      gitlabClient.isConfigured()
        ? gitlabClient.validateConfig().catch(() => false)
        : false,
      jiraClient.isConfigured()
        ? jiraClient.validateConfig().catch(() => false)
        : false,
      jitbitClient.isConfigured()
        ? jitbitClient.validateConfig().catch(() => false)
        : false,
    ]);

    return {
      status: "ok",
      timestamp: new Date().toISOString(),
      version: process.env.npm_package_version || "0.1.0",
      integrations: {
        github: {
          configured: githubClient.isConfigured(),
          valid: githubValid,
        },
        gitlab: {
          configured: gitlabClient.isConfigured(),
          valid: gitlabValid,
        },
        jira: {
          configured: jiraClient.isConfigured(),
          valid: jiraValid,
        },
        jitbit: {
          configured: jitbitClient.isConfigured(),
          valid: jitbitValid,
        },
      },
    };
  });
}
