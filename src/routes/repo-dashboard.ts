/**
 * Kibana-style issue dashboard API.
 *
 * GET /api/repo-dashboard/repos — list repos with non-zero issue counts
 * GET /api/repo-dashboard/issues — fetch issues for a repo
 * GET /api/repo-dashboard/dependencies — dependency edges for graph visualization
 */

import { FastifyInstance } from "fastify";
import { githubClient } from "../integrations/github/github-client";
import { gitlabClient } from "../integrations/gitlab/gitlab-client";
import { jiraClient } from "../integrations/jira/jira-client";
import { workItemDatabase } from "../work-items/database";
import { env } from "../config/env";

const MAX_ISSUES = 200;

// ─── Platform repo types ─────────────────────────────────────────────────────

interface RepoInfo {
  platform: "github" | "gitlab" | "jira" | "work_items";
  repoKey: string;
  repoName: string;
  issueCount: number;
  openCount: number;
}

interface DashboardIssue {
  id: string;
  externalId: string;
  title: string;
  url: string;
  status: string;
  priority: string;
  assignee: string | null;
  labels: string[];
  platform: string;
  repo: string;
  createdAt: string;
  updatedAt: string;
  dependencies: Array<{ id: string; label: string }>;
}

interface DependencyGraph {
  nodes: Array<{
    id: string;
    label: string;
    title: string;
    status: string;
    priority: string;
    url: string;
  }>;
  edges: Array<{
    from: string;
    to: string;
    label: string;
  }>;
}

// ─── Normalization helpers ───────────────────────────────────────────────────

const DEP_RE = /\b(?:depends\s+on|blocked\s+by|requires|prerequisite\s*:\s*)\s*#(\d+)/gi;

function parseDependencies(body: string): Array<{ id: string; label: string }> {
  if (!body) return [];
  const seen = new Set<string>();
  const result: Array<{ id: string; label: string }> = [];
  const matches = body.matchAll(DEP_RE);
  for (const m of matches) {
    const id = m[1];
    const label = m[0].trim();
    if (!seen.has(id)) {
      seen.add(id);
      result.push({ id, label });
    }
  }
  return result;
}

function normalizeStatus(raw: string | null | undefined, platform: string): string {
  if (!raw) return "unknown";
  const s = raw.toLowerCase().trim();

  if (platform === "github") {
    if (s === "open") return "open";
    if (s === "closed") return "done";
    return "unknown";
  }
  if (platform === "gitlab") {
    if (s === "opened") return "open";
    if (s === "closed") return "done";
    return "unknown";
  }
  if (platform === "jira") {
    if (["to do", "new", "backlog", "open", "reopened"].includes(s)) return "open";
    if (["in progress", "in review", "reviewing"].includes(s)) return "in_progress";
    if (["done", "resolved", "closed", "complete"].includes(s)) return "done";
    if (["blocked", "on hold"].includes(s)) return "blocked";
    return "open";
  }
  if (platform === "work_items") {
    if (["proposed", "planned", "waiting"].includes(s)) return "open";
    if (s === "active") return "in_progress";
    if (["done", "archived"].includes(s)) return "done";
    if (s === "blocked") return "blocked";
    return "open";
  }
  return "unknown";
}

function normalizePriority(raw: string | null | undefined, labels: string[]): string {
  const sources = [raw, ...labels].filter(Boolean).map((s) => s!.toLowerCase().trim());

  if (sources.some((s) => ["highest", "blocker", "critical", "crit"].includes(s))) return "critical";
  if (sources.some((s) => s === "high" || s.startsWith("priority: high") || s.startsWith("p1"))) return "high";
  if (sources.some((s) => s === "medium" || s.startsWith("priority: medium") || s.startsWith("p2") || s === "normal")) return "medium";
  if (sources.some((s) => s === "low" || s.startsWith("priority: low") || s.startsWith("p3") || s === "minor" || s === "trivial")) return "low";

  return "unknown";
}

// ─── GitHub helpers ──────────────────────────────────────────────────────────

async function getGitHubRepos(): Promise<RepoInfo[]> {
  const result: RepoInfo[] = [];
  if (!env.GITHUB_TOKEN || !env.GITHUB_DEFAULT_OWNER) return result;

  try {
    const repos = await githubClient.listRepositories();
    const defOwner = env.GITHUB_DEFAULT_OWNER;

    for (const repo of repos) {
      const owner = repo.owner?.login || defOwner;
      const name = repo.name;
      const key = `${owner}/${name}`;

      try {
        const issues = await githubClient.listIssues("all", undefined, owner, name);
        const filtered = issues.filter((i: any) => !i.pull_request);
        if (filtered.length > 0) {
          result.push({
            platform: "github",
            repoKey: key,
            repoName: key,
            issueCount: filtered.length,
            openCount: filtered.filter((i: any) => i.state === "open").length,
          });
        }
      } catch {
        // Skip repos that fail to fetch
      }
    }
  } catch {
    // GitHub not available
  }

  return result;
}

// ─── GitLab helpers ──────────────────────────────────────────────────────────

async function getGitLabRepos(): Promise<RepoInfo[]> {
  const result: RepoInfo[] = [];
  if (!env.GITLAB_TOKEN) return result;

  try {
    const projects = await gitlabClient.getProjects();
    for (const project of projects) {
      const pid = project.id?.toString() || project.path_with_namespace || "";
      if (!pid) continue;

      try {
        const openedIssues = await gitlabClient.listIssues(pid, "all");
        if (openedIssues.length > 0) {
          result.push({
            platform: "gitlab",
            repoKey: pid,
            repoName: project.name_with_namespace || project.name || pid,
            issueCount: openedIssues.length,
            openCount: openedIssues.filter((i: any) => i.state === "opened").length,
          });
        }
      } catch {
        // Skip
      }
    }
  } catch {
    // GitLab not available
  }

  return result;
}

// ─── Jira helpers ────────────────────────────────────────────────────────────

async function getJiraRepos(): Promise<RepoInfo[]> {
  const result: RepoInfo[] = [];
  if (!env.JIRA_BASE_URL || !env.JIRA_API_TOKEN) return result;

  try {
    const projects = await jiraClient.getProjects();
    for (const project of projects) {
      try {
        const issues = await jiraClient.searchIssues(
          `project = ${project.key} ORDER BY created DESC`,
          MAX_ISSUES,
        );
        if (issues.length > 0) {
          result.push({
            platform: "jira",
            repoKey: project.key,
            repoName: project.name || project.key,
            issueCount: issues.length,
            openCount: issues.filter(
              (i: any) => !["Done", "Resolved", "Closed"].includes(i.fields?.status?.name || ""),
            ).length,
          });
        }
      } catch {
        // Skip
      }
    }
  } catch {
    // Jira not available
  }

  return result;
}

// ─── Work Items helpers ──────────────────────────────────────────────────────

async function getWorkItemRepos(): Promise<RepoInfo[]> {
  const result: RepoInfo[] = [];
  try {
    const { total } = workItemDatabase.listWorkItems({ includeArchived: false, limit: 1 });
    if (total === 0) return result;

    // Group by source — each external source is displayed as a "repo"
    const bySource = new Map<string, { total: number; open: number }>();
    const allItems = workItemDatabase.listWorkItems({ includeArchived: false, limit: MAX_ISSUES });
    for (const item of allItems.items) {
      const key = item.source;
      if (!bySource.has(key)) bySource.set(key, { total: 0, open: 0 });
      const entry = bySource.get(key)!;
      entry.total++;
      if (!["done", "archived"].includes(item.status)) entry.open++;
    }

    for (const [source, counts] of bySource) {
      if (counts.total > 0) {
        result.push({
          platform: "work_items",
          repoKey: source,
          repoName: `Internal (${source})`,
          issueCount: counts.total,
          openCount: counts.open,
        });
      }
    }
  } catch {
    // DB not available
  }
  return result;
}

// ─── Issue fetching ──────────────────────────────────────────────────────────

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
      status: normalizeStatus(i.state, "github"),
      priority: normalizePriority(null, (i.labels || []).map((l: any) => (typeof l === "string" ? l : l.name))),
      assignee: i.assignee?.login || null,
      labels: (i.labels || []).map((l: any) => (typeof l === "string" ? l : l.name)).filter(Boolean),
      platform: "github",
      repo,
      createdAt: i.created_at || "",
      updatedAt: i.updated_at || "",
      dependencies: parseDependencies(i.body || ""),
    }));
}

async function fetchGitLabIssues(repoId: string): Promise<DashboardIssue[]> {
  const issues = await gitlabClient.listIssues(repoId, "all");
  return issues.map((i: any) => {
    const webUrl = i.web_url || "";
    return {
      id: String(i.iid || i.id),
      externalId: `!${i.iid || i.id}`,
      title: i.title || "",
      url: webUrl,
      status: normalizeStatus(i.state, "gitlab"),
      priority: normalizePriority(null, i.labels || []),
      assignee: i.assignee?.username || i.assignee?.name || null,
      labels: i.labels || [],
      platform: "gitlab",
      repo: repoId,
      createdAt: i.created_at || "",
      updatedAt: i.updated_at || "",
      dependencies: parseDependencies(i.description || ""),
    };
  });
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
    ),
  }));
}

async function fetchWorkItemIssues(source: import("../work-items/types").WorkItemSource): Promise<DashboardIssue[]> {
  const { items } = workItemDatabase.listWorkItems({ source, includeArchived: false, limit: MAX_ISSUES });
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
    dependencies: parseDependencies(wi.description),
  }));
}

// ─── Fastify plugin ──────────────────────────────────────────────────────────

export async function repoDashboardRoutes(fastify: FastifyInstance) {
  fastify.get("/repos", async (_request, _reply) => {
    const results = await Promise.allSettled([
      getGitHubRepos(),
      getGitLabRepos(),
      getJiraRepos(),
      getWorkItemRepos(),
    ]);

    const repos: RepoInfo[] = [];
    for (const result of results) {
      if (result.status === "fulfilled") {
        repos.push(...result.value);
      }
    }

    repos.sort((a, b) => b.issueCount - a.issueCount);
    return { repos };
  });

  fastify.get<{
    Querystring: { repo: string; platform: string; limit?: string };
  }>("/issues", async (request) => {
    const { repo, platform, limit: limitRaw } = request.query;
    const limit = Math.min(parseInt(limitRaw || "50", 10) || 50, MAX_ISSUES);

    let issues: DashboardIssue[] = [];

    try {
      switch (platform) {
        case "github":
          issues = await fetchGitHubIssues(repo);
          break;
        case "gitlab":
          issues = await fetchGitLabIssues(repo);
          break;
        case "jira":
          issues = await fetchJiraIssues(repo);
          break;
        case "work_items":
          issues = await fetchWorkItemIssues(repo as import("../work-items/types").WorkItemSource);
          break;
      }
    } catch (err: any) {
      return { issues: [], total: 0, error: err.message || "Failed to fetch issues" };
    }

    return { issues: issues.slice(0, limit), total: issues.length };
  });

  fastify.get<{
    Querystring: { repo: string; platform: string };
  }>("/dependencies", async (request) => {
    const { repo, platform } = request.query;

    let issues: DashboardIssue[] = [];
    try {
      switch (platform) {
        case "github":
          issues = await fetchGitHubIssues(repo);
          break;
        case "gitlab":
          issues = await fetchGitLabIssues(repo);
          break;
        case "jira":
          issues = await fetchJiraIssues(repo);
          break;
        case "work_items":
          issues = await fetchWorkItemIssues(repo as import("../work-items/types").WorkItemSource);
          break;
        default:
          return { nodes: [], edges: [] };
      }
    } catch {
      return { nodes: [], edges: [] };
    }

    const issueIds = new Set(issues.map((i) => i.id));
    const nodes: DependencyGraph["nodes"] = issues.map((i) => ({
      id: i.id,
      label: i.externalId,
      title: i.title,
      status: i.status,
      priority: i.priority,
      url: i.url,
    }));

    const edges: DependencyGraph["edges"] = [];
    for (const issue of issues) {
      for (const dep of issue.dependencies) {
        if (issueIds.has(dep.id)) {
          edges.push({
            from: issue.id,
            to: dep.id,
            label: dep.label,
          });
        }
      }
    }

    return { nodes, edges };
  });
}
