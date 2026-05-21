import { FastifyInstance } from "fastify";
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
import type {
  KanbanCard,
  KanbanAgent,
  KanbanBoardResponse,
  KanbanColumn,
} from "../kanban/types";
import { resolveEdges } from "../kanban/edges.js";

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
}
