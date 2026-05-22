import { FastifyInstance } from "fastify";
import type { ChildProcess } from "child_process";
import { githubClient } from "../integrations/github/github-client";
import { gitlabClient } from "../integrations/gitlab/gitlab-client";
import { jiraClient } from "../integrations/jira/jira-client";
import { workItemDatabase } from "../work-items/database";
import { agentRunDatabase } from "../agent-runs/database";
import { env } from "../config/env";
import {
  parseDependencies,
  normalizeStatus,
  normalizePriority,
  type DashboardIssue,
  type DependencyRef,
} from "./repo-dashboard";
import { makeBranchName } from "./autonomous-loop";
import { runAgent, type AgentConfig } from "../autonomous-loop/agent-runner";
import type {
  KanbanCard,
  KanbanAgent,
  KanbanBoardResponse,
  KanbanColumn,
  KanbanSSEEvent,
} from "../kanban/types";
import { resolveEdges } from "../kanban/edges.js";
import { kanbanEvents } from "../kanban/events.js";
import { createWorktree, removeWorktree, isClean, listWorktrees } from "../kanban/worktree-manager.js";
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "node:fs";
import * as path from "node:path";

const execFileAsync = promisify(execFile);

/**
 * Validates that a worktree path from the DB is a real git worktree under a
 * sane root — prevents path-traversal and arbitrary-filesystem-execution attacks.
 */
function validateWorktreePath(worktreePath: string): string | null {
  // Must be an absolute path
  if (!path.isAbsolute(worktreePath)) return null;

  const resolved = path.resolve(worktreePath);

  // Reject path traversal
  if (resolved.includes("..")) return null;

  // Must exist as a directory on disk
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) return null;
  } catch {
    return null;
  }

  // Must have a .git file (worktree marker, not a directory)
  const gitPath = path.join(resolved, ".git");
  try {
    const gitStat = fs.statSync(gitPath);
    if (!gitStat.isFile()) return null;
  } catch {
    return null;
  }

  return resolved;
}

/**
 * Detects the default branch of a git repo by asking the worktree's origin.
 * Falls back to "main" when detection fails.
 */
async function getDefaultBranch(worktreePath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", [
      "symbolic-ref", "refs/remotes/origin/HEAD",
    ], { cwd: worktreePath });
    const match = stdout.trim().match(/^refs\/remotes\/origin\/(.+)$/);
    return match ? match[1] : "main";
  } catch {
    return "main";
  }
}

const MAX_ISSUES = 200;

// ─── Status → Column mapping ────────────────────────────────────────────────

function toColumn(normalizedStatus: string): KanbanColumn {
  switch (normalizedStatus) {
    case "in_progress":
      return "in_flight";
    case "blocked":
      return "blocked";
    case "done":
      return "done";
    default:
      return "backlog";
  }
}

// ─── Cache (shared pattern with repo-dashboard) ─────────────────────────────

const boardCache = new Map<string, { data: KanbanBoardResponse; fetchedAt: number; lastAccessed: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_SIZE = 50;

export function invalidateBoardCache(): void {
  boardCache.clear();
}

// ─── Issue fetchers (reuse repo-dashboard logic) ────────────────────────────

async function fetchGitHubIssues(repo: string): Promise<DashboardIssue[]> {
  const [owner, repoName] = repo.split("/");
  if (!owner || !repoName) return [];
  const issues = await githubClient.listIssues("all", undefined, owner, repoName);
  return issues
    .filter((i: any) => !i.pull_request)
    .map((i: any) => ({
      id: String(i.number),
      externalId: `#${i.number}`,
      title: i.title || "",
      url: i.html_url || "",
      status: normalizeStatus(i.state, "github", (i.labels || []).map((l: any) => (typeof l === "string" ? l : l.name))),
      priority: normalizePriority(null, (i.labels || []).map((l: any) => (typeof l === "string" ? l : l.name))),
      assignee: i.assignee?.login || null,
      labels: (i.labels || []).map((l: any) => (typeof l === "string" ? l : l.name)).filter(Boolean),
      platform: "github",
      repo,
      createdAt: i.created_at || "",
      updatedAt: i.updated_at || "",
      dependencies: parseDependencies(i.body || "", { platform: "github", repo }),
    }));
}

async function fetchGitLabIssues(repoId: string): Promise<DashboardIssue[]> {
  const issues = await gitlabClient.listIssues(repoId, "all");
  return issues.map((i: any) => ({
    id: String(i.iid || i.id),
    externalId: `!${i.iid || i.id}`,
    title: i.title || "",
    url: i.web_url || "",
    status: normalizeStatus(i.state, "gitlab", i.labels || []),
    priority: normalizePriority(null, i.labels || []),
    assignee: i.assignee?.username || i.assignee?.name || null,
    labels: i.labels || [],
    platform: "gitlab",
    repo: repoId,
    createdAt: i.created_at || "",
    updatedAt: i.updated_at || "",
    dependencies: parseDependencies(i.description || "", { platform: "gitlab", repo: repoId }),
    sprint: i.milestone ? `gl-milestone-${i.milestone.id}` : undefined,
  }));
}

async function fetchJiraIssues(projectKey: string): Promise<DashboardIssue[]> {
  const issues = await jiraClient.searchIssues(
    `project = ${projectKey} ORDER BY created DESC`,
    MAX_ISSUES,
  );
  return issues.map((i: any) => ({
    id: i.key,
    externalId: i.key,
    title: i.fields?.summary || "",
    url: `${env.JIRA_BASE_URL}/browse/${i.key}`,
    status: normalizeStatus(i.fields?.status?.name, "jira"),
    priority: normalizePriority(i.fields?.priority?.name, []),
    assignee: i.fields?.assignee?.displayName || null,
    labels: i.fields?.labels || [],
    platform: "jira",
    repo: projectKey,
    createdAt: i.fields?.created || "",
    updatedAt: i.fields?.updated || "",
    dependencies: parseDependencies(
      typeof i.fields?.description === "string"
        ? i.fields.description
        : i.fields?.description?.content
            ?.map((c: any) => c.content?.map((cc: any) => cc.text).join(""))
            .join("\n") || "",
      { platform: "jira", repo: projectKey },
    ),
  }));
}

async function fetchWorkItemIssues(
  source: import("../work-items/types").WorkItemSource,
): Promise<DashboardIssue[]> {
  const { items } = workItemDatabase.listWorkItems({
    source,
    includeArchived: false,
    limit: MAX_ISSUES,
  });
  return items.map((wi) => ({
    id: wi.id,
    externalId: wi.sourceExternalId || wi.id.slice(0, 8),
    title: wi.title,
    url: wi.sourceUrl || "",
    status: normalizeStatus(wi.status, "work_items"),
    priority: wi.priority,
    assignee: wi.owner || null,
    labels: [],
    platform: "work_items",
    repo: source,
    createdAt: wi.createdAt,
    updatedAt: wi.updatedAt,
    dependencies: parseDependencies(wi.description, { platform: "work_items", repo: source }),
  }));
}

// ─── Repo discovery ─────────────────────────────────────────────────────────

async function discoverRepos(): Promise<Array<{ platform: string; repo: string }>> {
  const repos: Array<{ platform: string; repo: string }> = [];

  // GitHub
  if (env.GITHUB_TOKEN && env.GITHUB_DEFAULT_OWNER) {
    try {
      const ghRepos = await githubClient.listRepositories();
      for (const r of ghRepos) {
        const owner = r.owner?.login || env.GITHUB_DEFAULT_OWNER;
        repos.push({ platform: "github", repo: `${owner}/${r.name}` });
      }
    } catch { /* skip */ }
  }

  // GitLab
  if (env.GITLAB_TOKEN) {
    try {
      const glProjects = await gitlabClient.getProjects();
      for (const p of glProjects) {
        const pid = p.id?.toString() || p.path_with_namespace || "";
        if (pid) repos.push({ platform: "gitlab", repo: pid });
      }
    } catch { /* skip */ }
  }

  // Jira
  if (env.JIRA_BASE_URL && env.JIRA_API_TOKEN) {
    try {
      const jiraProjects = await jiraClient.getProjects();
      for (const p of jiraProjects) {
        repos.push({ platform: "jira", repo: p.key });
      }
    } catch { /* skip */ }
  }

  // Work items
  try {
    const { total } = workItemDatabase.listWorkItems({ includeArchived: false, limit: 1 });
    if (total > 0) {
      const allItems = workItemDatabase.listWorkItems({ includeArchived: false, limit: MAX_ISSUES });
      const sources = new Set(allItems.items.map((i) => i.source));
      for (const source of sources) {
        repos.push({ platform: "work_items", repo: source });
      }
    }
  } catch { /* skip */ }

  return repos;
}

// ─── Board builder ──────────────────────────────────────────────────────────

function buildDependencyKey(dep: DependencyRef, context: { platform: string; repo: string }): string {
  const platform = dep.platform || context.platform;
  const repo = dep.repo || context.repo;
  return `${platform}:${repo}:${dep.id}`;
}

async function buildBoard(filters: {
  repos?: string[];
  agents?: string[];
  sprint?: string;
  priority?: string;
  assignee?: string;
}): Promise<KanbanBoardResponse> {
  let repos = await discoverRepos();

  // Apply repo filter
  if (filters.repos && filters.repos.length > 0) {
    const repoSet = new Set(filters.repos);
    repos = repos.filter((r) => repoSet.has(r.repo));
  }

  // Fetch issues from all repos in parallel
  const fetchPromises = repos.map(async ({ platform, repo }) => {
    try {
      switch (platform) {
        case "github": return await fetchGitHubIssues(repo);
        case "gitlab": return await fetchGitLabIssues(repo);
        case "jira": return await fetchJiraIssues(repo);
        case "work_items": return await fetchWorkItemIssues(repo as any);
        default: return [];
      }
    } catch {
      return [];
    }
  });

  const results = await Promise.allSettled(fetchPromises);
  let allIssues: DashboardIssue[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") {
      allIssues.push(...r.value);
    }
  }

  // Apply filters
  if (filters.priority) {
    allIssues = allIssues.filter((i) => i.priority === filters.priority);
  }
  if (filters.assignee) {
    allIssues = allIssues.filter(
      (i) => i.assignee?.toLowerCase() === filters.assignee!.toLowerCase(),
    );
  }
  if (filters.sprint) {
    allIssues = allIssues.filter((i) => i.sprint === filters.sprint);
  }

  // Deduplicate by platform:repo:id
  const seenKeys = new Set<string>();
  const deduped: DashboardIssue[] = [];
  for (const issue of allIssues) {
    const key = `${issue.platform}:${issue.repo}:${issue.id}`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      deduped.push(issue);
    }
  }

  // Build agent_runs lookup: find active (running) runs for each issue
  const agentRunMap = new Map<string, string>();
  try {
    const runningRuns = agentRunDatabase.listRuns({ status: "running", limit: 1000 });
    for (const run of runningRuns.runs) {
      if (run.issuePlatform && run.issueRepo && run.issueId) {
        const key = `${run.issuePlatform}:${run.issueRepo}:${run.issueId}`;
        if (!agentRunMap.has(key)) {
          agentRunMap.set(key, run.id);
        }
      }
    }
  } catch { /* agent_runs unavailable */ }

  // Build deps-by-card-key map for edge resolution
  const depsByCardKey = new Map<string, DependencyRef[]>();

  // Map issues to cards
  const cards: KanbanCard[] = deduped.map((issue) => {
    const key = `${issue.platform}:${issue.repo}:${issue.id}`;
    const depKeys = issue.dependencies.map((dep) =>
      buildDependencyKey(dep, { platform: issue.platform, repo: issue.repo }),
    );
    depsByCardKey.set(key, issue.dependencies);
    return {
      key,
      platform: issue.platform as KanbanCard["platform"],
      repo: issue.repo,
      id: issue.id,
      externalId: issue.externalId,
      title: issue.title,
      url: issue.url,
      status: issue.status,
      column: toColumn(issue.status),
      priority: issue.priority as KanbanCard["priority"],
      assignee: issue.assignee,
      labels: issue.labels,
      sprint: issue.sprint,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      dependencyKeys: depKeys,
      activeAgentRunId: agentRunMap.get(key) ?? null,
    };
  });

  // Resolve edges and ghost nodes via shared helper
  const { edges, ghostNodes } = resolveEdges(cards, depsByCardKey);

  // Build repo summary
  const repoCounts = new Map<string, { platform: string; count: number }>();
  for (const card of cards) {
    const rk = `${card.platform}:${card.repo}`;
    const existing = repoCounts.get(rk);
    if (existing) {
      existing.count++;
    } else {
      repoCounts.set(rk, { platform: card.platform, count: 1 });
    }
  }
  const reposSummary = Array.from(repoCounts.entries()).map(([rk, { platform, count }]) => ({
    platform,
    repo: rk.split(":").slice(1).join(":"),
    cardCount: count,
  }));

  return {
    cards,
    edges,
    ghostNodes,
    agents: [] as KanbanAgent[],
    repos: reposSummary,
    generatedAt: new Date().toISOString(),
  };
}

// ─── Fastify plugin ─────────────────────────────────────────────────────────

export async function kanbanRoutes(fastify: FastifyInstance) {
  // ─── GET /token-status — which platforms have write tokens configured ─────
  // Protected by global authMiddleware (not in PUBLIC_PATHS).

  fastify.get("/token-status", async (request) => {
    request.log.info("Token status checked");
    return {
      github: !!(env.GITHUB_TOKEN && env.GITHUB_DEFAULT_OWNER),
      gitlab: !!env.GITLAB_TOKEN,
      jira: !!(env.JIRA_API_TOKEN && env.JIRA_EMAIL),
      work_items: true,
    };
  });

  fastify.get<{
    Querystring: {
      "repos[]"?: string | string[];
      "agents[]"?: string | string[];
      sprint?: string;
      priority?: string;
      assignee?: string;
    };
  }>("/board", async (request) => {
    const q = request.query;
    const repos = q["repos[]"]
      ? Array.isArray(q["repos[]"]) ? q["repos[]"] : [q["repos[]"]]
      : undefined;
    const agents = q["agents[]"]
      ? Array.isArray(q["agents[]"]) ? q["agents[]"] : [q["agents[]"]]
      : undefined;

    const filters = {
      repos,
      agents,
      sprint: q.sprint,
      priority: q.priority,
      assignee: q.assignee,
    };

    // Build cache key from filter fingerprint
    const cacheKey = `board:${JSON.stringify(filters)}`;
    const now = Date.now();
    const cached = boardCache.get(cacheKey);
    if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
      cached.lastAccessed = now;
      return cached.data;
    }

    const board = await buildBoard(filters);

    if (boardCache.size >= MAX_CACHE_SIZE) {
      let lruKey: string | undefined;
      let lruAccess = Infinity;
      for (const [k, v] of boardCache.entries()) {
        if (v.lastAccessed < lruAccess) {
          lruAccess = v.lastAccessed;
          lruKey = k;
        }
      }
      if (lruKey !== undefined) boardCache.delete(lruKey);
    }
    boardCache.set(cacheKey, { data: board, fetchedAt: now, lastAccessed: now });

    return board;
  });

  // ─── SSE stream ────────────────────────────────────────────────────────────

  fastify.get("/stream", (request, reply) => {
    reply.hijack();
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no");
    reply.raw.flushHeaders();

    // Replay missed events if client sends Last-Event-ID
    const lastId = request.headers["last-event-id"];
    if (lastId) {
      const sinceId = parseInt(Array.isArray(lastId) ? lastId[0] : lastId, 10);
      if (!isNaN(sinceId)) {
        for (const entry of kanbanEvents.replay(sinceId)) {
          reply.raw.write(`id: ${entry.id}\nevent: ${entry.event.type}\ndata: ${JSON.stringify(entry.event)}\n\n`);
        }
      }
    }

    const onEvent = (entry: { id: number; event: KanbanSSEEvent }) => {
      reply.raw.write(`id: ${entry.id}\nevent: ${entry.event.type}\ndata: ${JSON.stringify(entry.event)}\n\n`);
    };

    kanbanEvents.on("event", onEvent);

    const heartbeat = setInterval(() => {
      reply.raw.write(": ping\n\n");
    }, 15_000);

    const cleanup = () => {
      kanbanEvents.off("event", onEvent);
      clearInterval(heartbeat);
    };

    request.raw.on("close", cleanup);
  });

  // ─── GET /agents — running agents for rail ──────────────────────────────

  fastify.get("/agents", async () => {
    const { runs } = agentRunDatabase.listRuns({ status: "running", limit: 50 });
    return runs.map((run) => {
      let lastTool: string | null = null;
      let toolLoopCount = run.toolLoopCount;
      try {
        const steps = agentRunDatabase.getRunSteps(run.id);
        const lastStep = steps[steps.length - 1];
        if (lastStep?.toolName) {
          lastTool = lastStep.toolName;
          toolLoopCount = steps.length;
        }
      } catch { /* no steps */ }

      return {
        agentRunId: run.id,
        agent: (run.mode === "interactive" ? "claude" : "claude") as KanbanAgent["agent"],
        model: run.model,
        status: "running" as const,
        cardKey: run.issuePlatform && run.issueRepo && run.issueId
          ? `${run.issuePlatform}:${run.issueRepo}:${run.issueId}`
          : null,
        startedAt: run.startedAt,
        lastActivityAt: run.lastActivityAt,
        toolLoopCount,
        lastTool,
      } satisfies KanbanAgent;
    });
  });

  // ─── In-memory child process registry for stop ─────────────────────────────

  const activeChildren = new Map<string, ChildProcess>();
  const VALID_PLATFORMS = new Set(["github", "gitlab", "jira", "work_items"]);
  const VALID_AGENTS = new Set(["claude", "codex", "opencode"]);
  const REPO_PATH_RE = /^[a-zA-Z0-9._\-/]+$/;

  // ─── GET /worktrees — list all tracked worktrees with disk-state reconcile ─

  interface WorktreeEntry {
    agentRunId: string;
    path: string;
    branch: string;
    cardKey: string | null;
    onDisk: boolean;
    isClean: boolean | null;
    state: "active" | "orphan" | "ghost";
  }

  fastify.get("/worktrees", async () => {
    // 1. Get all runs that have a worktree path
    const allRuns = agentRunDatabase.listRuns({ status: undefined, limit: 10000 });
    const tracked = allRuns.runs.filter((r) => r.worktreePath);

    // 2. Build DB entries map (path → run info)
    const dbByPath = new Map<string, { runId: string; branch: string; cardKey: string | null }>();
    for (const run of tracked) {
      dbByPath.set(path.resolve(run.worktreePath!), {
        runId: run.id,
        branch: run.branch ?? "",
        cardKey: run.issuePlatform && run.issueRepo && run.issueId
          ? `${run.issuePlatform}:${run.issueRepo}:${run.issueId}`
          : null,
      });
    }

    // 3. Get on-disk worktrees from all known repo roots
    const repoPaths = new Set<string>();
    for (const run of tracked) {
      const repoPath = resolveRepoPath(run.issuePlatform ?? "github", run.issueRepo ?? "");
      repoPaths.add(repoPath);
    }
    // Always include cwd as fallback to discover ghost worktrees
    repoPaths.add(process.cwd());

    const diskByPath = new Map<string, { branch: string; head: string }>();
    for (const repoPath of repoPaths) {
      try {
        const wts = await listWorktrees(repoPath);
        for (const wt of wts) {
          diskByPath.set(path.resolve(wt.path), { branch: wt.branch, head: wt.head });
        }
      } catch { /* repo may not have worktrees */ }
    }

    // 4. Reconcile
    const entries: WorktreeEntry[] = [];
    const allPaths = new Set([...dbByPath.keys(), ...diskByPath.keys()]);

    for (const wtPath of allPaths) {
      const inDb = dbByPath.get(wtPath);
      const onDisk = diskByPath.has(wtPath);

      if (inDb && onDisk) {
        let clean: boolean | null = null;
        try {
          clean = await isClean(wtPath);
        } catch { /* worktree may be locked */ }
        entries.push({
          agentRunId: inDb.runId,
          path: wtPath,
          branch: inDb.branch,
          cardKey: inDb.cardKey,
          onDisk: true,
          isClean: clean,
          state: "active",
        });
      } else if (inDb && !onDisk) {
        entries.push({
          agentRunId: inDb.runId,
          path: wtPath,
          branch: inDb.branch,
          cardKey: inDb.cardKey,
          onDisk: false,
          isClean: null,
          state: "orphan",
        });
      } else if (!inDb && onDisk) {
        const disk = diskByPath.get(wtPath)!;
        let clean: boolean | null = null;
        try {
          clean = await isClean(wtPath);
        } catch { /* locked */ }
        entries.push({
          agentRunId: "",
          path: wtPath,
          branch: disk.branch,
          cardKey: null,
          onDisk: true,
          isClean: clean,
          state: "ghost",
        });
      }
    }

    return entries;
  });

  // ─── GET /settings — kanban settings ─────────────────────────────────────────

  fastify.get("/settings", async () => {
    const hours = agentRunDatabase.getKanbanSetting("autoCleanupHours");
    return {
      autoCleanupHours: hours !== null ? Number(hours) : 24,
    };
  });

  // ─── PUT /settings — update kanban settings ──────────────────────────────────

  fastify.put<{
    Body: { autoCleanupHours?: number };
  }>("/settings", async (request, reply) => {
    const body = request.body ?? {};
    if (body.autoCleanupHours !== undefined) {
      const hours = Number(body.autoCleanupHours);
      if (!Number.isFinite(hours) || hours < 0) {
        return reply.status(400).send({ error: "autoCleanupHours must be a non-negative number" });
      }
      agentRunDatabase.setKanbanSetting("autoCleanupHours", String(hours));
    }
    const hours = agentRunDatabase.getKanbanSetting("autoCleanupHours");
    return { autoCleanupHours: hours !== null ? Number(hours) : 24 };
  });

  // Note: authentication is enforced by the global authMiddleware registered
  // in the app setup — these routes are NOT in PUBLIC_PATHS.

  function sanitizeRepo(repo: string): string | null {
    const trimmed = repo.trim();
    if (!trimmed || !REPO_PATH_RE.test(trimmed) || trimmed.includes("..")) {
      return null;
    }
    return trimmed;
  }

  // ─── POST /cards/:platform/:id/start ──────────────────────────────────
  // Repo is passed in the body since it may contain "/" (e.g. "owner/repo").

  fastify.post<{
    Params: { platform: string; id: string };
    Body: {
      repo: string;
      agent?: "claude" | "codex" | "opencode";
      model?: string;
      apiProvider?: "opencode" | "zai";
      baseBranch?: string;
    };
  }>("/cards/:platform/:id/start", async (request, reply) => {
    const { platform, id } = request.params;
    const body = request.body ?? {};
    const rawRepo = body.repo ?? "";
    const agent = body.agent ?? "claude";

    // Input validation
    if (!VALID_PLATFORMS.has(platform)) {
      return reply.status(400).send({ error: `Invalid platform: ${platform}` });
    }
    if (!VALID_AGENTS.has(agent)) {
      return reply.status(400).send({ error: `Invalid agent: ${agent}` });
    }
    const repo = sanitizeRepo(rawRepo);
    if (!repo) {
      return reply.status(400).send({ error: "Missing or invalid repo" });
    }

    // Duplicate-run guard
    const runningRuns = agentRunDatabase.listRuns({ status: "running", limit: 1000 });
    const existing = runningRuns.runs.find(
      (r) => r.issuePlatform === platform && r.issueRepo === repo && r.issueId === id,
    );
    if (existing) {
      return reply.status(409).send({ error: "Agent already running for this card", agentRunId: existing.id });
    }

    // 1. Look up the card
    const card = await findCard(platform, repo, id);
    if (!card) {
      return reply.status(404).send({ error: "Card not found" });
    }

    // 2. Derive branch name
    const issueNumber = parseInt(id, 10);
    const branch = makeBranchName(isNaN(issueNumber) ? 0 : issueNumber, card.title);

    // 3. Determine repo path for worktree creation
    const repoPath = resolveRepoPath(platform, repo);

    // 4. Create worktree
    let worktreePath: string;
    try {
      worktreePath = await createWorktree({
        repoPath,
        branch,
        baseBranch: body.baseBranch ?? "main",
      });
    } catch (err) {
      return reply.status(500).send({ error: `Worktree creation failed: ${(err as Error).message}` });
    }

    // 5. Create agent run with linkage
    const run = agentRunDatabase.startRun({
      userId: "kanban",
      mode: "interactive",
      issueId: id,
      issuePlatform: platform,
      issueRepo: repo,
      worktreePath,
      branch,
    });

    request.log.info({ agentRunId: run.id, platform, repo, id, agent }, "Agent started");

    // 6. Build prompt
    const prompt = [
      `# ${card.title}`,
      "",
      card.description ?? "",
      "",
      "Read AGENTS.md",
    ].join("\n");

    // 7. Spawn agent
    const cfg: AgentConfig = {
      agent,
      workspace: worktreePath,
      model: body.model,
      apiProvider: body.apiProvider ?? null,
    };

    let stepCounter = 0;
    let lastStepEmit = 0;

    runAgent(prompt, cfg, null, undefined, undefined, (child) => {
      activeChildren.set(run.id, child);
    }, (_stepInfo) => {
      stepCounter++;
      const now = Date.now();
      if (now - lastStepEmit >= 1000) {
        lastStepEmit = now;
        kanbanEvents.emitEvent({
          type: "agent.step",
          agentRunId: run.id,
          toolName: "output",
          stepOrder: stepCounter,
        });
      }
    })
      .then((result) => {
        activeChildren.delete(run.id);
        if (result.exitCode === 0 || result.finDetected) {
          agentRunDatabase.completeRun(run.id, {
            toolLoopCount: stepCounter,
            model: body.model,
          });
          kanbanEvents.emitEvent({
            type: "agent.completed",
            agentRunId: run.id,
            status: "completed",
          });
          request.log.info({ agentRunId: run.id, steps: stepCounter }, "Agent completed");
        } else {
          agentRunDatabase.failRun(run.id, result.stderr || `Agent exited with code ${result.exitCode}`);
          kanbanEvents.emitEvent({
            type: "agent.completed",
            agentRunId: run.id,
            status: "failed",
            errorMessage: result.stderr || `Agent exited with code ${result.exitCode}`,
          });
          request.log.info({ agentRunId: run.id, exitCode: result.exitCode }, "Agent failed");
        }
        kanbanEvents.emitEvent({
          type: "worktree.changed",
          path: worktreePath,
          status: "active",
        });
      })
      .catch((err) => {
        activeChildren.delete(run.id);
        agentRunDatabase.failRun(run.id, (err as Error).message);
        kanbanEvents.emitEvent({
          type: "agent.completed",
          agentRunId: run.id,
          status: "failed",
          errorMessage: (err as Error).message,
        });
        request.log.error({ agentRunId: run.id, err }, "Agent threw");
      });

    // 8. Emit agent.started
    kanbanEvents.emitEvent({
      type: "agent.started",
      agent: {
        agentRunId: run.id,
        agent,
        model: body.model ?? null,
        status: "running",
        cardKey: `${platform}:${repo}:${id}`,
        startedAt: run.startedAt,
        lastActivityAt: run.lastActivityAt,
        toolLoopCount: 0,
        lastTool: null,
      },
    });

    invalidateBoardCache();

    return reply.send({
      agentRunId: run.id,
      worktreePath,
      branch,
      status: "started",
    });
  });

  // ─── POST /cards/:platform/:id/stop ───────────────────────────────────
  // Repo is passed in the body since it may contain "/" (e.g. "owner/repo").

  fastify.post<{
    Params: { platform: string; id: string };
    Body: { repo: string };
  }>("/cards/:platform/:id/stop", async (request, reply) => {
    const { platform, id } = request.params;
    const rawRepo = request.body?.repo ?? "";

    const repo = sanitizeRepo(rawRepo);
    if (!repo) {
      return reply.status(400).send({ error: "Missing or invalid repo" });
    }

    // Find running agent run for this card
    const runningRuns = agentRunDatabase.listRuns({ status: "running", limit: 1000 });
    const match = runningRuns.runs.find(
      (r) => r.issuePlatform === platform && r.issueRepo === repo && r.issueId === id,
    );

    if (!match) {
      return reply.status(404).send({ error: "No running agent found for this card" });
    }

    // SIGTERM the child if still alive
    const child = activeChildren.get(match.id);
    if (child && !child.killed) {
      child.kill("SIGTERM");
    }
    activeChildren.delete(match.id);

    agentRunDatabase.failRun(match.id, "stopped_by_user");

    request.log.info({ agentRunId: match.id, platform, repo, id }, "Agent stopped by user");

    kanbanEvents.emitEvent({
      type: "agent.completed",
      agentRunId: match.id,
      status: "failed",
      errorMessage: "stopped_by_user",
    });

    if (match.worktreePath) {
      kanbanEvents.emitEvent({
        type: "worktree.changed",
        path: match.worktreePath,
        status: "active",
      });
    }

    invalidateBoardCache();

    return reply.send({ agentRunId: match.id, status: "stopped" });
  });

  // ─── GET /cards/:platform/:repo/:id — card detail ────────────────────────

  fastify.get<{
    Params: { platform: string; repo: string; id: string };
  }>("/cards/:platform/:repo/:id", async (request, reply) => {
    const { platform, repo, id } = request.params;

    if (!VALID_PLATFORMS.has(platform)) {
      return reply.status(400).send({ error: `Invalid platform: ${platform}` });
    }

    const sanitizedRepo = sanitizeRepo(repo);
    if (!sanitizedRepo) {
      return reply.status(400).send({ error: "Invalid repo" });
    }

    // 1. Fetch card info (title + description)
    const cardInfo = await findCard(platform, sanitizedRepo, id);
    if (!cardInfo) {
      return reply.status(404).send({ error: "Card not found" });
    }

    // 2. Build KanbanCard from the card info
    const cardKey = `${platform}:${sanitizedRepo}:${id}`;
    const card: KanbanCard = {
      key: cardKey,
      platform: platform as KanbanCard["platform"],
      repo: sanitizedRepo,
      id,
      externalId: platform === "jira" ? id : `#${id}`,
      title: cardInfo.title,
      url: "",
      status: "",
      column: "backlog",
      priority: "unknown",
      assignee: null,
      labels: [],
      createdAt: "",
      updatedAt: "",
      dependencyKeys: [],
      activeAgentRunId: null,
    };

    // 3. Fetch comments from the platform
    const comments = await fetchComments(platform, sanitizedRepo, id);

    // 4. Look up agent run
    let agentRun: import("../agent-runs/types").AgentRunWithSteps | null = null;
    try {
      const runs = agentRunDatabase.listRuns({ status: undefined, limit: 1000 });
      const match = runs.runs.find(
        (r) => r.issuePlatform === platform && r.issueRepo === sanitizedRepo && r.issueId === id,
      );
      if (match) {
        const withSteps = agentRunDatabase.getRunWithSteps(match.id);
        if (withSteps) agentRun = withSteps;
        card.activeAgentRunId = match.id;
      }
    } catch { /* no agent runs */ }

    // 5. Worktree info
    let worktree: (import("../kanban/worktree-manager").WorktreeInfo & { isClean: boolean }) | null = null;
    if (agentRun?.worktreePath) {
      try {
        const validatedPath = validateWorktreePath(agentRun.worktreePath);
        if (validatedPath) {
          const clean = await isClean(validatedPath);
          worktree = {
            path: validatedPath,
            branch: agentRun.branch ?? "",
            head: "",
            locked: false,
            prunable: false,
            isClean: clean,
          };
        }
      } catch { /* worktree gone */ }
    }

    return {
      card,
      description: cardInfo.description ?? "",
      comments,
      agentRun,
      worktree,
      diffUrl: worktree ? `/api/kanban/cards/${platform}/${sanitizedRepo}/${id}/diff` : null,
    };
  });

  // ─── GET /cards/:platform/:repo/:id/diff ─────────────────────────────────

  fastify.get<{
    Params: { platform: string; repo: string; id: string };
  }>("/cards/:platform/:repo/:id/diff", async (request, reply) => {
    const { platform, repo, id } = request.params;

    if (!VALID_PLATFORMS.has(platform)) {
      return reply.status(400).send({ error: `Invalid platform: ${platform}` });
    }

    const sanitizedRepo = sanitizeRepo(repo);
    if (!sanitizedRepo) {
      return reply.status(400).send({ error: "Invalid repo" });
    }

    // Find the agent run to get the worktree path
    let rawWorktreePath: string | null = null;
    try {
      const runs = agentRunDatabase.listRuns({ status: undefined, limit: 1000 });
      const match = runs.runs.find(
        (r) => r.issuePlatform === platform && r.issueRepo === sanitizedRepo && r.issueId === id,
      );
      if (match) {
        rawWorktreePath = match.worktreePath;
      }
    } catch { /* no runs */ }

    if (!rawWorktreePath) {
      return reply.status(404).send({ error: "No worktree for this card" });
    }

    // Validate path is a real git worktree (prevents arbitrary filesystem access)
    const worktreePath = validateWorktreePath(rawWorktreePath);
    if (!worktreePath) {
      return reply.status(400).send({ error: "Invalid worktree path" });
    }

    try {
      const baseBranch = await getDefaultBranch(worktreePath);
      const { stdout } = await execFileAsync("git", [
        "-C", worktreePath,
        "diff", `${baseBranch}..HEAD`,
      ], { maxBuffer: 10 * 1024 * 1024 });
      return reply.type("text/plain").send(stdout);
    } catch (err) {
      return reply.status(500).send({ error: `Diff failed: ${(err as Error).message}` });
    }
  });

  // ─── POST /cards/:platform/:repo/:id/comment ─────────────────────────────

  fastify.post<{
    Params: { platform: string; repo: string; id: string };
    Body: { body: string };
  }>("/cards/:platform/:repo/:id/comment", async (request, reply) => {
    const { platform, repo, id } = request.params;
    const commentBody = request.body?.body;

    if (!VALID_PLATFORMS.has(platform)) {
      return reply.status(400).send({ error: `Invalid platform: ${platform}` });
    }

    const sanitizedRepo = sanitizeRepo(repo);
    if (!sanitizedRepo) {
      return reply.status(400).send({ error: "Invalid repo" });
    }

    if (!commentBody || typeof commentBody !== "string") {
      return reply.status(400).send({ error: "Missing comment body" });
    }

    try {
      await addComment(platform, sanitizedRepo, id, commentBody);
      return reply.send({ ok: true });
    } catch (err) {
      return reply.status(500).send({ error: `Comment failed: ${(err as Error).message}` });
    }
  });

  // ─── GitHub label helpers ────────────────────────────────────────────────

  function extractGitHubLabels(labels: any[]): string[] {
    return (labels || [])
      .map((l: any) => (typeof l === "string" ? l : l.name))
      .filter(Boolean);
  }

  function removeStatusLabels(labels: string[]): string[] {
    return labels.filter(
      (l) => l.toLowerCase() !== "blocked" && l.toLowerCase() !== "in progress",
    );
  }

  // ─── POST /cards/:platform/:repo/:id/move — drag-and-drop status transition ─

  const COLUMN_TO_NORMALIZED: Record<KanbanColumn, string> = {
    backlog: "open",
    in_flight: "in_progress",
    blocked: "blocked",
    done: "done",
  };

  const VALID_COLUMNS = new Set<KanbanColumn>(["backlog", "in_flight", "blocked", "done"]);

  fastify.post<{
    Params: { platform: string; repo: string; id: string };
    Body: { column: KanbanColumn };
  }>("/cards/:platform/:repo/:id/move", async (request, reply) => {
    const { platform, repo, id } = request.params;
    const column = request.body?.column;

    if (!VALID_PLATFORMS.has(platform)) {
      return reply.status(400).send({ error: `Invalid platform: ${platform}` });
    }

    const sanitizedRepo = sanitizeRepo(repo);
    if (!sanitizedRepo) {
      return reply.status(400).send({ error: "Invalid repo" });
    }

    if (!column || !VALID_COLUMNS.has(column)) {
      return reply.status(400).send({ error: `Invalid column: ${column}. Must be one of: ${Array.from(VALID_COLUMNS).join(", ")}` });
    }

    try {
      switch (platform) {
        case "github": {
          const [owner, repoName] = sanitizedRepo.split("/");
          if (!owner || !repoName) {
            return reply.status(400).send({ error: "Invalid GitHub repo format" });
          }
          const issueNum = Number(id);
          if (!Number.isFinite(issueNum)) {
            return reply.status(400).send({ error: "Invalid issue id: must be a number" });
          }

          if (column === "done") {
            const current = await githubClient.getIssue(issueNum, owner, repoName);
            if (!current) {
              return reply.status(404).send({ error: "Issue not found" });
            }
            const currentLabels = extractGitHubLabels(current.labels);
            const cleanedLabels = removeStatusLabels(currentLabels);
            await githubClient.updateIssue(issueNum, { state: "closed", labels: cleanedLabels }, owner, repoName);
          } else if (column === "backlog") {
            const current = await githubClient.getIssue(issueNum, owner, repoName);
            if (!current) {
              return reply.status(404).send({ error: "Issue not found" });
            }
            const currentLabels = extractGitHubLabels(current.labels);
            const cleanedLabels = removeStatusLabels(currentLabels);
            await githubClient.updateIssue(issueNum, { state: "open", labels: cleanedLabels }, owner, repoName);
          } else {
            // blocked or in_flight — manage labels
            const current = await githubClient.getIssue(issueNum, owner, repoName);
            if (!current) {
              return reply.status(404).send({ error: "Issue not found" });
            }
            const currentLabels = extractGitHubLabels(current.labels);
            const labelToAdd = column === "blocked" ? "blocked" : "in progress";
            const updatedLabels = [...new Set([...currentLabels, labelToAdd])];
            await githubClient.updateIssue(issueNum, { labels: updatedLabels }, owner, repoName);
          }
          break;
        }

        case "gitlab": {
          const issueIid = Number(id);
          if (!Number.isFinite(issueIid)) {
            return reply.status(400).send({ error: "Invalid issue id: must be a number" });
          }

          if (column === "done") {
            const current = await gitlabClient.getIssue(sanitizedRepo, issueIid);
            if (!current) {
              return reply.status(404).send({ error: "Issue not found" });
            }
            const currentLabels: string[] = (current?.labels || []);
            const cleanedLabels = currentLabels.filter(
              (l) => l.toLowerCase() !== "blocked" && l.toLowerCase() !== "in progress",
            ).join(",");
            await gitlabClient.editIssue(sanitizedRepo, issueIid, { stateEvent: "close", labels: cleanedLabels });
          } else if (column === "backlog") {
            const current = await gitlabClient.getIssue(sanitizedRepo, issueIid);
            if (!current) {
              return reply.status(404).send({ error: "Issue not found" });
            }
            const currentLabels: string[] = (current.labels || []);
            const cleanedLabels = currentLabels.filter(
              (l) => l.toLowerCase() !== "blocked" && l.toLowerCase() !== "in progress",
            ).join(",");
            await gitlabClient.editIssue(sanitizedRepo, issueIid, { stateEvent: "reopen", labels: cleanedLabels });
          } else {
            // blocked or in_flight — manage labels
            const current = await gitlabClient.getIssue(sanitizedRepo, issueIid);
            if (!current) {
              return reply.status(404).send({ error: "Issue not found" });
            }
            const currentLabels: string[] = (current.labels || []);
            const labelToAdd = column === "blocked" ? "blocked" : "in progress";
            const updatedLabels = [...new Set([...currentLabels, labelToAdd])].join(",");
            await gitlabClient.editIssue(sanitizedRepo, issueIid, { labels: updatedLabels });
          }
          break;
        }

        case "jira": {
          const statusTargets: Record<string, string[]> = {
            open: ["to do", "new", "backlog", "open", "reopened"],
            in_progress: ["in progress", "in review"],
            blocked: ["blocked", "on hold"],
            done: ["done", "resolved", "closed"],
          };
          const targetNames = statusTargets[COLUMN_TO_NORMALIZED[column]] || [];
          const transitions = await jiraClient.getTransitions(id);
          const match = (transitions || []).find((t: any) => {
            const toName = (t.to?.name || "").toLowerCase().trim();
            return targetNames.includes(toName);
          });
          if (!match) {
            return reply.status(409).send({
              error: `No available transition to "${column}" for ${id}. Available: ${(transitions || []).map((t: any) => t.name).join(", ") || "none"}`,
            });
          }
          await jiraClient.transitionIssue(id, match.id, `Moved via kanban board to ${column}`);
          break;
        }

        case "work_items": {
          const statusMap: Record<string, string> = {
            open: "proposed",
            in_progress: "active",
            blocked: "blocked",
            done: "done",
          };
          const wiStatus = statusMap[COLUMN_TO_NORMALIZED[column]];
          if (!wiStatus) {
            return reply.status(400).send({ error: `Cannot map column "${column}" to work item status` });
          }
          const result = workItemDatabase.updateWorkItem(id, { status: wiStatus as any });
          if (!result) {
            return reply.status(404).send({ error: `Work item ${id} not found` });
          }
          break;
        }

        default:
          return reply.status(400).send({ error: `Unsupported platform: ${platform}` });
      }

      // Emit SSE event and invalidate cache
      const cardKey = `${platform}:${sanitizedRepo}:${id}`;
      kanbanEvents.emitEvent({
        type: "card.updated",
        card: {
          key: cardKey,
          platform: platform as KanbanCard["platform"],
          repo: sanitizedRepo,
          id,
          externalId: id,
          title: "",
          url: "",
          status: COLUMN_TO_NORMALIZED[column],
          column,
          priority: "unknown",
          assignee: null,
          labels: [],
          createdAt: "",
          updatedAt: new Date().toISOString(),
          dependencyKeys: [],
          activeAgentRunId: null,
        },
      });

      request.log.info({ platform, repo: sanitizedRepo, id, column, cardKey }, "Card moved");

      invalidateBoardCache();

      return { ok: true, column };
    } catch (err) {
      return reply.status(500).send({ error: `Move failed: ${(err as Error).message}` });
    }
  });

  // ─── DELETE /worktrees/:id — cleanup worktree ────────────────────────────

  fastify.delete<{
    Params: { id: string };
    Querystring: { force?: string };
  }>("/worktrees/:id", async (request, reply) => {
    const { id: runId } = request.params;
    const force = request.query.force === "true";

    const run = agentRunDatabase.getRun(runId);
    if (!run) {
      return reply.status(404).send({ error: "Agent run not found" });
    }

    if (!run.worktreePath) {
      return reply.status(404).send({ error: "No worktree for this run" });
    }

    // Check if worktree still exists on disk
    if (fs.existsSync(run.worktreePath)) {
      try {
        const clean = await isClean(run.worktreePath);
        if (!clean && !force) {
          return reply.status(409).send({ error: "Worktree has uncommitted changes. Use ?force=true to override." });
        }
      } catch { /* if isClean fails, proceed with force */ }
    }

    try {
      await removeWorktree(run.worktreePath, { force: true });

      kanbanEvents.emitEvent({
        type: "worktree.changed",
        path: run.worktreePath,
        status: "removed",
      });

      return reply.send({ ok: true });
    } catch (err) {
      return reply.status(500).send({ error: `Cleanup failed: ${(err as Error).message}` });
    }
  });
}

// ─── Helpers for start/stop ────────────────────────────────────────────────────

interface CardInfo {
  title: string;
  description?: string;
}

async function findCard(platform: string, repo: string, id: string): Promise<CardInfo | null> {
  try {
    switch (platform) {
      case "github": {
        const [owner, repoName] = repo.split("/");
        if (!owner || !repoName) return null;
        const issue = await githubClient.getIssue(parseInt(id, 10), owner, repoName);
        if (!issue) return null;
        return { title: issue.title || "", description: issue.body || "" };
      }
      case "gitlab": {
        const issue = await gitlabClient.getIssue(repo, parseInt(id, 10));
        if (!issue) return null;
        return { title: issue.title || "", description: issue.description || "" };
      }
      case "jira": {
        const issue = await jiraClient.getIssue(id);
        if (!issue) return null;
        const title = issue.fields?.summary || "";
        const desc = typeof issue.fields?.description === "string"
          ? issue.fields.description
          : issue.fields?.description?.content
              ?.map((c: any) => c.content?.map((cc: any) => cc.text).join(""))
              .join("\n") || "";
        return { title, description: desc };
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function resolveRepoPath(platform: string, repo: string): string {
  // For now, resolve local repo path from env + platform conventions.
  // GitHub repos use owner/repo format and map to a local clone.
  if (platform === "github") {
    const repoName = repo.includes("/") ? repo.split("/")[1] : repo;
    // Common local clone locations
    const candidates = [
      `./${repoName}`,
      `../${repoName}`,
    ];
    for (const c of candidates) {
      try {
        const fs = require("fs");
        if (fs.existsSync(c)) return require("path").resolve(c);
      } catch { /* skip */ }
    }
  }
  // Fallback: use cwd
  return process.cwd();
}

async function fetchComments(
  platform: string,
  repo: string,
  id: string,
): Promise<Array<{ author: string; body: string; createdAt: string }>> {
  try {
    switch (platform) {
      case "github": {
        const [owner, repoName] = repo.split("/");
        if (!owner || !repoName) return [];
        const comments = await githubClient.listIssueComments(parseInt(id, 10), owner, repoName);
        return (comments || []).map((c: any) => ({
          author: c.user?.login || "unknown",
          body: c.body || "",
          createdAt: c.created_at || "",
        }));
      }
      case "gitlab": {
        const notes = await gitlabClient.listIssueNotes(repo, parseInt(id, 10));
        return (notes || []).map((n: any) => ({
          author: n.author?.username || n.author?.name || "unknown",
          body: n.body || "",
          createdAt: n.created_at || "",
        }));
      }
      case "jira": {
        const comments = await jiraClient.getComments(id);
        return (comments || []).map((c: any) => ({
          author: c.author?.displayName || c.author?.name || "unknown",
          body: typeof c.body === "string" ? c.body : JSON.stringify(c.body),
          createdAt: c.created || "",
        }));
      }
      default:
        return [];
    }
  } catch {
    return [];
  }
}

async function addComment(
  platform: string,
  repo: string,
  id: string,
  body: string,
): Promise<void> {
  switch (platform) {
    case "github": {
      const [owner, repoName] = repo.split("/");
      if (!owner || !repoName) throw new Error("Invalid GitHub repo");
      await githubClient.addIssueComment(parseInt(id, 10), body, owner, repoName);
      break;
    }
    case "gitlab": {
      await gitlabClient.addIssueNote(repo, parseInt(id, 10), body);
      break;
    }
    case "jira": {
      await jiraClient.addComment(id, body);
      break;
    }
    default:
      throw new Error(`Comments not supported for platform: ${platform}`);
  }
}
