/**
 * HTTP API for UI-configured runners.
 *
 * Read endpoints require an authenticated user (cookie or API key); mutations
 * additionally require the user be authenticated — runners control real spawn
 * authority on this host so we don't accept anonymous writes.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { agentRunDatabase } from "../agent-runs/database";
import type {
  RunnerCreateParams,
  RunnerKind,
  RunnerUpdateParams,
} from "../agent-runs/types";
import { runnerManager } from "../runners/runner-manager";
import { runnerEvents, type RunnerSSEEvent } from "../runners/runner-events";
import { runnerLogPath } from "../runners/runner-loop";
import { githubClient } from "../integrations/github/github-client";
import { gitlabClient } from "../integrations/gitlab/gitlab-client";
import { jiraClient } from "../integrations/jira/jira-client";
import { env } from "../config/env";
import * as fs from "node:fs";
import * as child_process from "node:child_process";

const VALID_KINDS = new Set<RunnerKind>(["aicoder", "reviewer"]);
const VALID_AGENTS = new Set(["claude", "codex", "opencode"]);
const VALID_SOURCES = new Set(["github", "gitlab", "jira", "jitbit", "work_items", "auto"]);
const VALID_PROVIDERS = new Set(["opencode", "zai", "ollama", "openai"]);

function requireAuth(request: FastifyRequest, reply: FastifyReply): boolean {
  if (!request.userId) {
    reply.code(401).send({ error: "Authentication required" });
    return false;
  }
  return true;
}

function validateCreate(body: Partial<RunnerCreateParams>): string | null {
  if (!body.name || typeof body.name !== "string") return "name is required";
  if (!body.kind || !VALID_KINDS.has(body.kind)) return "kind must be 'aicoder' or 'reviewer'";
  if (!body.agent || !VALID_AGENTS.has(body.agent)) return "agent must be claude | codex | opencode";
  if (!body.source || !VALID_SOURCES.has(body.source)) return "source must be one of github, gitlab, jira, jitbit, work_items, auto";
  if (body.apiProvider && !VALID_PROVIDERS.has(body.apiProvider)) return "apiProvider must be one of opencode, zai, ollama, openai";
  if (body.pollIntervalMs !== undefined && (typeof body.pollIntervalMs !== "number" || body.pollIntervalMs < 1000)) {
    return "pollIntervalMs must be a number >= 1000";
  }
  if (body.maxCycles !== undefined && (typeof body.maxCycles !== "number" || body.maxCycles < 0)) {
    return "maxCycles must be a non-negative number";
  }
  return null;
}

/**
 * Normalize a runner's (owner, repo) into a stable key so two configs
 * pointing at the same project compare equal regardless of how the
 * fields were filled in. GitHub repos may arrive as "owner/name"
 * slugs in the repo field with owner missing, or as separate
 * owner+name pairs. GitLab uses path-with-namespace in the repo
 * field. Jira / work_items use a project key. The empty string falls
 * through and prevents the uniqueness check from blocking sources
 * that don't bind to a single repo.
 */
export function runnerScopeKey(
  source: string | undefined,
  owner: string | null | undefined,
  repo: string | null | undefined,
): string {
  const src = (source || "").toLowerCase();
  const r = (repo || "").trim().toLowerCase();
  if (!r) return "";
  if (src === "github") {
    // Slug form "owner/name" -> just keep the slug. Otherwise prepend
    // the owner so two "AIWorkAssistant" repos under different owners
    // don't collide.
    if (r.includes("/")) return `${src}::${r}`;
    const o = (owner || "").trim().toLowerCase();
    return o ? `${src}::${o}/${r}` : `${src}::${r}`;
  }
  // gitlab path-with-namespace, jira project key, jitbit tag, work_items
  // tag: the repo field alone is identifying for our purposes.
  return `${src}::${r}`;
}

/**
 * Enforce one aicoder per (source, repo). Two aicoders pointing at
 * the same project end up racing for the same ready-for-agent
 * tickets and stomp on each other's worktree state (the user has hit
 * this — two aicoders working on the same issue). Reviewers are
 * exempt because they're scoped per MR/PR. The excludeId arg lets
 * PATCH validate a payload against every OTHER runner without
 * tripping on the runner being updated.
 *
 * Returns null when the create/update is allowed, otherwise an error
 * message naming the existing runner.
 */
function validateUniqueAicoder(
  body: { kind?: string; source?: string; owner?: string | null; repo?: string | null },
  excludeId?: string,
): string | null {
  if (body.kind !== "aicoder") return null;
  const key = runnerScopeKey(body.source, body.owner, body.repo);
  if (!key) return null; // No repo bound — nothing to enforce against.
  const existing = agentRunDatabase.listRunners().find((r) => {
    if (r.id === excludeId) return false;
    if (r.kind !== "aicoder") return false;
    return runnerScopeKey(r.source, r.owner, r.repo) === key;
  });
  if (!existing) return null;
  return `An aicoder already exists for this project (id=${existing.id}, name="${existing.name}"). Only one aicoder is allowed per (source, repo) pair — delete or repurpose the existing one.`;
}

/**
 * Verify the requested baseBranch actually exists upstream so we never try
 * to clone from a ref that won't resolve. Best-effort: if the platform's API
 * is unavailable we skip the check rather than block the user.
 */
async function validateBranchExists(
  source: string | undefined,
  repo: string | null | undefined,
  repoUrl: string | null | undefined,
  baseBranch: string | null | undefined,
): Promise<string | null> {
  if (!baseBranch) return null;
  try {
    if (source === "github" && repo) {
      const [owner, name] = repo.includes("/") ? repo.split("/", 2) : [env.GITHUB_DEFAULT_OWNER, repo];
      if (!owner || !name) return null;
      const branches = await githubClient.listBranches(owner, name);
      const names = branches.map((b: any) => b.name as string);
      if (!names.includes(baseBranch)) {
        return `baseBranch "${baseBranch}" not found in ${owner}/${name}`;
      }
      return null;
    }
    if (source === "gitlab" && repo) {
      const branches = await gitlabClient.getBranches(repo);
      const names = branches.map((b: any) => b.name as string);
      if (!names.includes(baseBranch)) {
        return `baseBranch "${baseBranch}" not found in ${repo}`;
      }
      return null;
    }
    // Sources without a platform API (jira/work_items/auto) — verify via
    // ls-remote on the user-supplied workspace clone URL if we have one.
    if (repoUrl) {
      const names = lsRemoteBranches(repoUrl);
      if (names.length && !names.includes(baseBranch)) {
        return `baseBranch "${baseBranch}" not found in ${repoUrl}`;
      }
    }
  } catch {
    // Upstream unavailable — skip rather than block. The runner loop will
    // surface clone failures the same way it does for any other git error.
  }
  return null;
}

// ─── Repo / branch metadata for the form pickers ────────────────────────────

/**
 * One row in the repo dropdown. `repoKey` is what goes into the runner's
 * `repo` field — its meaning depends on the source platform:
 *   github     → "owner/name"
 *   gitlab     → "group/project" (path_with_namespace)
 *   jira       → project key (e.g. "IR")
 *   work_items → WorkItemSource string (e.g. "chat", "manual")
 *
 * `cloneUrl` and `defaultBranch` are only populated for github/gitlab — for
 * jira/work_items the user supplies repoUrl + base branch separately because
 * the issue source has no git repo of its own.
 */
interface RepoOption {
  platform: "github" | "gitlab" | "jira" | "work_items";
  repoKey: string;
  repoName: string;
  owner: string | null;
  cloneUrl: string | null;
  defaultBranch: string | null;
  issueCount: number;
}

async function listGitHubRepoOptions(): Promise<RepoOption[]> {
  if (!env.GITHUB_TOKEN || !env.GITHUB_DEFAULT_OWNER) return [];
  try {
    const repos = await githubClient.listRepositories();
    return repos.map((r: any) => {
      const owner = r.owner?.login || env.GITHUB_DEFAULT_OWNER;
      const name = r.name as string;
      return {
        platform: "github" as const,
        repoKey: `${owner}/${name}`,
        repoName: `${owner}/${name}`,
        owner,
        cloneUrl: (r.clone_url || r.ssh_url || null) as string | null,
        defaultBranch: (r.default_branch || "main") as string | null,
        issueCount: (r.open_issues_count as number | undefined) ?? 0,
      };
    });
  } catch {
    return [];
  }
}

async function listGitLabRepoOptions(): Promise<RepoOption[]> {
  if (!env.GITLAB_TOKEN) return [];
  try {
    const projects = await gitlabClient.getProjects();
    return projects.map((p: any) => ({
      platform: "gitlab" as const,
      repoKey: (p.path_with_namespace || p.id?.toString() || "") as string,
      repoName: (p.name_with_namespace || p.name || p.path_with_namespace || "") as string,
      owner: (p.namespace?.full_path || p.namespace?.path || null) as string | null,
      // Prefer HTTPS over SSH so the runner can use GITLAB_TOKEN at clone
      // time without needing SSH keys on the server. ssh URLs still work
      // (worktree-manager rewrites them to https + injects the token) but
      // starting with the right scheme avoids that hop.
      cloneUrl: (p.http_url_to_repo || p.ssh_url_to_repo || null) as string | null,
      defaultBranch: (p.default_branch || "main") as string | null,
      issueCount: 0,
    }));
  } catch {
    return [];
  }
}

async function listJiraProjectOptions(): Promise<RepoOption[]> {
  if (!jiraClient.isConfigured()) return [];
  try {
    const projects = await jiraClient.getProjects();
    return projects.map((p: any) => ({
      platform: "jira" as const,
      repoKey: p.key as string,
      repoName: `${p.key} — ${p.name || p.key}`,
      owner: p.key as string,    // owner = project key for Jira
      cloneUrl: null,            // user must supply workspace clone URL
      defaultBranch: null,
      issueCount: 0,
    }));
  } catch {
    return [];
  }
}

function listWorkItemSourceOptions(): RepoOption[] {
  const sources: Array<{ key: string; label: string }> = [
    { key: "chat", label: "Chat sessions" },
    { key: "manual", label: "Manual entries" },
    { key: "calendar", label: "Calendar events" },
    { key: "roadmap", label: "Roadmap items" },
    { key: "hawk-ir", label: "HAWK incident response" },
    { key: "github", label: "Imported from GitHub" },
    { key: "gitlab", label: "Imported from GitLab" },
    { key: "jira", label: "Imported from Jira" },
    { key: "jitbit", label: "Imported from Jitbit" },
  ];
  return sources.map((s) => ({
    platform: "work_items" as const,
    repoKey: s.key,
    repoName: s.label,
    owner: null,
    cloneUrl: null,
    defaultBranch: null,
    issueCount: 0,
  }));
}

/**
 * Best-effort `git ls-remote --heads <url>` to discover branches on a clone
 * URL that isn't backed by a GitHub/GitLab API listing — most commonly when
 * the runner source is Jira / work_items and the user has supplied their own
 * workspace repoUrl.
 *
 * Wrapped in spawnSync with a 15s timeout; failures return [] so callers can
 * fall back to free-typing the branch name.
 */
function lsRemoteBranches(repoUrl: string): string[] {
  if (!repoUrl) return [];
  const result = child_process.spawnSync("git", ["ls-remote", "--heads", repoUrl], {
    encoding: "utf8",
    timeout: 15000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.status !== 0) return [];
  const branches: string[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = line.match(/^[0-9a-f]+\s+refs\/heads\/(.+)$/);
    if (match) branches.push(match[1]);
  }
  return branches;
}

/**
 * Look up the most recent `running` agent_run for each runner's workspace
 * and attach its `issueId` as `currentIssue` on the returned shape. Lets the
 * UI show "Processing SIEM-8 — started 14:02" instead of just "(polling…)".
 *
 * Indexed by workspace path because the runner.id isn't propagated into the
 * child aicoder's agent_runs row; matching on the persistent worktree path
 * is the most reliable link we have between the two.
 */
function enrichRunnersWithCurrentIssue<T extends { workspacePath: string | null }>(
  runners: T[],
): Array<T & { currentIssue: string | null; currentSprint: string | null }> {
  // Snapshot the running-runs once instead of querying per-runner. 200 is
  // a generous upper bound — we have at most one or two runners typically.
  const running = agentRunDatabase.listRuns({ status: "running", limit: 200 }).runs;
  const byWorkspace = new Map<string, { issueId: string; issueSprint: string | null }>();
  for (const run of running) {
    if (run.worktreePath && run.issueId && !byWorkspace.has(run.worktreePath)) {
      byWorkspace.set(run.worktreePath, {
        issueId: run.issueId,
        issueSprint: run.issueSprint,
      });
    }
  }
  return runners.map((r) => {
    const current = r.workspacePath ? byWorkspace.get(r.workspacePath) : null;
    return {
      ...r,
      currentIssue: current?.issueId ?? null,
      currentSprint: current?.issueSprint ?? null,
    };
  });
}

export async function runnerRoutes(fastify: FastifyInstance) {
  // ─── Meta: repo + branch pickers ────────────────────────────────────────
  // The dropdown is source-scoped: passing ?source=jira returns Jira projects,
  // not GitHub repos. Without ?source we return everything merged so callers
  // that haven't picked a source yet (e.g. a deep-link) still get something.
  fastify.get<{ Querystring: { source?: string } }>(
    "/runners/meta/repos",
    async (request, reply) => {
      if (!requireAuth(request, reply)) return;
      const source = (request.query.source || "").toLowerCase();

      let repos: RepoOption[] = [];
      if (source === "github") {
        repos = await listGitHubRepoOptions();
      } else if (source === "gitlab") {
        repos = await listGitLabRepoOptions();
      } else if (source === "jira") {
        repos = await listJiraProjectOptions();
      } else if (source === "work_items") {
        repos = listWorkItemSourceOptions();
      } else {
        const [gh, gl, jira] = await Promise.all([
          listGitHubRepoOptions(),
          listGitLabRepoOptions(),
          listJiraProjectOptions(),
        ]);
        repos = [...gh, ...gl, ...jira, ...listWorkItemSourceOptions()];
      }

      repos.sort((a, b) => a.repoName.localeCompare(b.repoName));
      return { repos };
    },
  );

  fastify.get<{ Querystring: { platform?: string; repo?: string; repoUrl?: string } }>(
    "/runners/meta/branches",
    async (request, reply) => {
      if (!requireAuth(request, reply)) return;
      const platform = (request.query.platform || "").toLowerCase();
      const repo = (request.query.repo || "").trim();
      const repoUrl = (request.query.repoUrl || "").trim();

      try {
        if (platform === "github" && repo) {
          const [owner, name] = repo.includes("/") ? repo.split("/", 2) : [env.GITHUB_DEFAULT_OWNER, repo];
          if (!owner || !name) return reply.code(400).send({ error: "repo must be owner/name" });
          const branches = await githubClient.listBranches(owner, name);
          return {
            branches: branches.map((b: any) => b.name).filter(Boolean),
            default: null,
          };
        }
        if (platform === "gitlab" && repo) {
          const branches = await gitlabClient.getBranches(repo);
          const names = branches.map((b: any) => b.name).filter(Boolean);
          const def = branches.find((b: any) => b.default)?.name ?? null;
          return { branches: names, default: def };
        }
        // jira / work_items / unknown source — fall back to ls-remote on the
        // workspace clone URL the user typed.
        if (repoUrl) {
          return { branches: lsRemoteBranches(repoUrl), default: null };
        }
        return { branches: [], default: null };
      } catch (err) {
        return reply.code(502).send({
          error: "Failed to list branches",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // ─── GET /runners ───────────────────────────────────────────────────────
  fastify.get("/runners", async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    return { runners: enrichRunnersWithCurrentIssue(runnerManager.list()) };
  });

  // ─── GET /runners/:id ───────────────────────────────────────────────────
  fastify.get<{ Params: { id: string } }>("/runners/:id", async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const runner = runnerManager.get(request.params.id);
    if (!runner) return reply.code(404).send({ error: "Runner not found" });
    return enrichRunnersWithCurrentIssue([runner])[0];
  });

  // ─── POST /runners ──────────────────────────────────────────────────────
  fastify.post("/runners", async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const body = (request.body ?? {}) as Partial<RunnerCreateParams>;
    const err = validateCreate(body);
    if (err) return reply.code(400).send({ error: err });
    const dupErr = validateUniqueAicoder(body);
    if (dupErr) return reply.code(409).send({ error: dupErr });
    const branchErr = await validateBranchExists(body.source, body.repo, body.repoUrl, body.baseBranch);
    if (branchErr) return reply.code(400).send({ error: branchErr });
    const runner = runnerManager.create(body as RunnerCreateParams);
    return reply.code(201).send(runner);
  });

  // ─── PATCH /runners/:id ─────────────────────────────────────────────────
  fastify.patch<{ Params: { id: string } }>("/runners/:id", async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const body = (request.body ?? {}) as RunnerUpdateParams;
    if (body.kind && !VALID_KINDS.has(body.kind)) {
      return reply.code(400).send({ error: "kind must be 'aicoder' or 'reviewer'" });
    }
    if (body.agent && !VALID_AGENTS.has(body.agent)) {
      return reply.code(400).send({ error: "invalid agent" });
    }
    if (body.source && !VALID_SOURCES.has(body.source)) {
      return reply.code(400).send({ error: "invalid source" });
    }
    if (body.apiProvider && !VALID_PROVIDERS.has(body.apiProvider)) {
      return reply.code(400).send({ error: "invalid apiProvider" });
    }
    const existing = runnerManager.get(request.params.id);
    if (body.baseBranch !== undefined) {
      // Resolve effective source/repo/repoUrl from patch ∪ existing row so we
      // can validate the new branch against the right repository.
      const effectiveSource = body.source ?? existing?.source;
      const effectiveRepo = body.repo ?? existing?.repo ?? null;
      const effectiveRepoUrl = body.repoUrl ?? existing?.repoUrl ?? null;
      const branchErr = await validateBranchExists(effectiveSource, effectiveRepo, effectiveRepoUrl, body.baseBranch);
      if (branchErr) return reply.code(400).send({ error: branchErr });
    }
    // Re-check the (source, repo) uniqueness for the effective shape
    // post-patch. Without this, the user can sneak past the create-time
    // check by creating two runners for different repos and then editing
    // one to collide with the other.
    const dupErr = validateUniqueAicoder(
      {
        kind: body.kind ?? existing?.kind,
        source: body.source ?? existing?.source,
        owner: body.owner ?? existing?.owner ?? null,
        repo: body.repo ?? existing?.repo ?? null,
      },
      request.params.id,
    );
    if (dupErr) return reply.code(409).send({ error: dupErr });
    const updated = await runnerManager.update(request.params.id, body);
    if (!updated) return reply.code(404).send({ error: "Runner not found" });
    return updated;
  });

  // ─── DELETE /runners/:id ────────────────────────────────────────────────
  fastify.delete<{ Params: { id: string } }>("/runners/:id", async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const ok = await runnerManager.delete(request.params.id);
    if (!ok) return reply.code(404).send({ error: "Runner not found" });
    return { success: true };
  });

  // ─── Lifecycle controls ─────────────────────────────────────────────────
  fastify.post<{ Params: { id: string } }>("/runners/:id/start", async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const r = runnerManager.start(request.params.id);
    if (!r) return reply.code(404).send({ error: "Runner not found" });
    return r;
  });

  fastify.post<{ Params: { id: string } }>("/runners/:id/pause", async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const r = runnerManager.pause(request.params.id);
    if (!r) return reply.code(404).send({ error: "Runner not found" });
    return r;
  });

  fastify.post<{ Params: { id: string } }>("/runners/:id/stop", async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const r = await runnerManager.stop(request.params.id);
    if (!r) return reply.code(404).send({ error: "Runner not found" });
    return r;
  });

  fastify.post<{ Params: { id: string } }>("/runners/:id/run-now", async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const r = runnerManager.runNow(request.params.id);
    if (!r) return reply.code(404).send({ error: "Runner not found" });
    return r;
  });

  // ─── Past runs for this runner ──────────────────────────────────────────
  fastify.get<{ Params: { id: string } }>("/runners/:id/runs", async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    const runner = runnerManager.get(request.params.id);
    if (!runner) return reply.code(404).send({ error: "Runner not found" });
    if (!runner.workspacePath) return { runs: [] };
    // Best-effort: pull runs whose worktreePath matches this runner's workspace
    const all = agentRunDatabase.listRuns({ limit: 100 });
    const runs = all.runs.filter((r) => r.worktreePath === runner.workspacePath);
    return { runs };
  });

  // ─── SSE: runner-wide event stream (status + logs) ──────────────────────
  fastify.get("/runners/events", async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const since = parseInt(
      (request.headers["last-event-id"] as string) || "0",
      10,
    );
    if (Number.isFinite(since) && since > 0) {
      for (const entry of runnerEvents.replay(since)) {
        reply.raw.write(`id: ${entry.id}\ndata: ${JSON.stringify(entry.event)}\n\n`);
      }
    }

    const handler = (entry: { id: number; event: RunnerSSEEvent }) => {
      reply.raw.write(`id: ${entry.id}\ndata: ${JSON.stringify(entry.event)}\n\n`);
    };
    runnerEvents.on("event", handler);

    const keepAlive = setInterval(() => {
      reply.raw.write(": ping\n\n");
    }, 25000);

    request.raw.on("close", () => {
      clearInterval(keepAlive);
      runnerEvents.off("event", handler);
    });
  });

  // ─── SSE: per-runner log tail ───────────────────────────────────────────
  fastify.get<{ Params: { id: string }; Querystring: { since?: string } }>(
    "/runners/:id/logs",
    async (request, reply) => {
      if (!requireAuth(request, reply)) return;
      const runner = runnerManager.get(request.params.id);
      if (!runner) return reply.code(404).send({ error: "Runner not found" });

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });

      const logPath = runnerLogPath(request.params.id);

      // 1. Send the existing log content (clipped to the last ~64KB so reconnects don't reflood).
      let initialOffset = 0;
      try {
        const stat = fs.statSync(logPath);
        const MAX_REPLAY = 64 * 1024;
        const start = Math.max(0, stat.size - MAX_REPLAY);
        initialOffset = stat.size;
        const stream = fs.createReadStream(logPath, { start, encoding: "utf8" });
        await new Promise<void>((resolve) => {
          stream.on("data", (chunk: string | Buffer) => {
            const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
            reply.raw.write(`data: ${JSON.stringify({ chunk: text })}\n\n`);
          });
          stream.on("end", () => resolve());
          stream.on("error", () => resolve());
        });
      } catch {
        // No log yet — fine.
      }

      // 2. Subscribe to live log events for this runner.
      const handler = (entry: { id: number; event: RunnerSSEEvent }) => {
        if (entry.event.type === "runner.log" && entry.event.runnerId === request.params.id) {
          reply.raw.write(`data: ${JSON.stringify({ chunk: entry.event.chunk })}\n\n`);
        }
      };
      runnerEvents.on("event", handler);

      const keepAlive = setInterval(() => {
        reply.raw.write(": ping\n\n");
      }, 25000);

      request.raw.on("close", () => {
        clearInterval(keepAlive);
        runnerEvents.off("event", handler);
      });

      void initialOffset; // tracked for future resume-from-offset support
    },
  );
}
