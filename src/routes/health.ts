/**
 * Health check route
 */

import { FastifyInstance } from "fastify";
import { execFileSync } from "child_process";
import { githubClient } from "../integrations/github/github-client";
import { gitlabClient } from "../integrations/gitlab/gitlab-client";
import { jiraClient } from "../integrations/jira/jira-client";
import { jitbitClient } from "../integrations/jitbit/jitbit-client";
import { aiRequestLimiter } from "../agent/providers/ai-request-limiter";
import { providerCircuitBreaker } from "../agent/providers/circuit-breaker";

function getGitMetadata(): { commit: string | null; dirty: boolean } {
  try {
    const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf-8",
      timeout: 2000,
    }).trim();
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: process.cwd(),
      encoding: "utf-8",
      timeout: 2000,
    }).trim();
    return { commit, dirty: status.length > 0 };
  } catch {
    return { commit: process.env.GIT_COMMIT?.slice(0, 12) || null, dirty: false };
  }
}

export async function healthRoutes(fastify: FastifyInstance) {
  fastify.get("/health", async (_request, _reply) => {
    const git = getGitMetadata();
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
      git,
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

  /**
   * Per-provider slot accounting + circuit-breaker state. Use this to see
   * which provider is wedged, how many slots are in use, and whether the
   * breaker has tripped on a (provider, model) pair.
   *
   * Cheap, in-memory, no upstream calls — safe to poll from a status badge.
   */
  fastify.get("/health/providers", async () => {
    const breakers = providerCircuitBreaker.snapshot();
    const now = Date.now();
    return {
      timestamp: new Date().toISOString(),
      limiter: aiRequestLimiter.stats,
      breakers: breakers.map((b) => ({
        ...b,
        cooldownSecondsRemaining: b.isOpen
          ? Math.ceil((b.degradedUntil - now) / 1000)
          : 0,
      })),
    };
  });
}
