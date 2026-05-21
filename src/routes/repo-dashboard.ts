/**
 * Kibana-style issue dashboard API.
 *
 * GET /api/repo-dashboard/repos — list repos with non-zero issue counts
 * GET /api/repo-dashboard/issues — fetch issues for a repo
 * GET /api/repo-dashboard/dependencies — dependency edges for graph visualization
 * GET /api/repo-dashboard/sprints — fetch sprints for a repo
 * GET /api/repo-dashboard/burndown — calculate burndown data for a sprint
 */

import { FastifyInstance } from "fastify";
import { githubClient } from "../integrations/github/github-client";
import { gitlabClient } from "../integrations/gitlab/gitlab-client";
import { jiraClient } from "../integrations/jira/jira-client";
import { workItemDatabase } from "../work-items/database";
import { env } from "../config/env";
import type { WorkItemStatus } from "../work-items/types";

const MAX_ISSUES = 200;

const issueCache = new Map<string, { data: DashboardIssue[]; fetchedAt: number; lastAccessed: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CACHE_SIZE = 100;

export function invalidateIssueCache(platform: string, repo: string): void {
  issueCache.delete(`${platform}:${repo}`);
}

// ─── Platform repo types ─────────────────────────────────────────────────────

export interface RepoInfo {
  platform: "github" | "gitlab" | "jira" | "work_items";
  repoKey: string;
  repoName: string;
  issueCount: number;
  openCount: number;
}

export interface DependencyRef {
  id: string;
  label: string;
  platform?: string;
  repo?: string;
  external: boolean;
}

export interface DashboardIssue {
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
  dependencies: DependencyRef[];
  sprint?: string;
}

// ─── Sprint types ────────────────────────────────────────────────────────────

export interface DashboardSprint {
  id: string;
  name: string;
  state: string;
  startDate: string;
  endDate: string;
  totalPoints: number;
  completedPoints: number;
  platform: string;
  repo: string;
  description?: string;
}

export interface BurndownData {
  labels: string[];
  ideal: number[];
  actual: number[];
}

export interface DependencyGraph {
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
    dashes?: boolean;
    color?: { color: string; hover?: string };
  }>;
}

// ─── Normalization helpers ───────────────────────────────────────────────────

const DEP_RE =
  /\b(?:depends\s+on|blocked\s+by|requires|prerequisite\s*:\s*)\s*(?:(?:JIRA:|Jira:)([A-Z]+-\d+)|(?:GH:|GitHub:)(?:([\w.-]+\/[\w.-]+))?#(\d+)|(?:GL:|GitLab:)(?:([\w.-]+(?:\/[\w.-]+)?))?#(\d+)|#(\d+))\b/gi;

export function parseDependencies(body: string): DependencyRef[] {
  if (!body) return [];
  const seen = new Set<string>();
  const result: DependencyRef[] = [];
  const matches = body.matchAll(DEP_RE);
  for (const m of matches) {
    const label = m[0].trim();
    let id: string;
    let platform: string | undefined;
    let repo: string | undefined;
    let external = false;

    if (m[1]) {
      id = m[1];
      platform = "jira";
      external = true;
    } else if (m[3]) {
      id = m[3];
      platform = "github";
      repo = m[2] || undefined;
      external = true;
    } else if (m[5]) {
      id = m[5];
      platform = "gitlab";
      repo = m[4] || undefined;
      external = true;
    } else if (m[6]) {
      id = m[6];
    } else {
      continue;
    }

    if (!seen.has(id)) {
      seen.add(id);
      result.push({ id, label, platform, repo, external });
    }
  }
  return result;
}

export function constructExternalUrl(dep: DependencyRef): string {
  if (dep.platform === "jira") {
    const base = env.JIRA_BASE_URL;
    if (base) return `${base}/browse/${dep.id}`;
  }
  if (dep.platform === "github") {
    const ownerRepo = dep.repo || `${env.GITHUB_DEFAULT_OWNER}/${env.GITHUB_DEFAULT_REPO}`;
    return `https://github.com/${ownerRepo}/issues/${dep.id}`;
  }
  if (dep.platform === "gitlab") {
    const project = dep.repo || env.GITLAB_DEFAULT_PROJECT || "";
    const base = (env.GITLAB_BASE_URL || "https://gitlab.com").replace(/\/api\/v4$/, "");
    const encodedProject = encodeURIComponent(project);
    return `${base}/${encodedProject}/-/issues/${dep.id}`;
  }
  return "";
}

export function normalizeStatus(
  raw: string | null | undefined,
  platform: string,
  labels?: string[],
): string {
  if (!raw) return "unknown";
  const s = raw.toLowerCase().trim();

  if (platform === "github") {
    if (s === "open") {
      if (labels?.some((l) => l.toLowerCase() === "in progress")) return "in_progress";
      return "open";
    }
    if (s === "closed") return "done";
    return "unknown";
  }
  if (platform === "gitlab") {
    if (s === "opened") {
      if (labels?.some((l) => l.toLowerCase() === "in progress")) return "in_progress";
      return "open";
    }
    if (s === "closed") return "done";
    return "unknown";
  }
  if (platform === "jira") {
    if (["to do", "new", "backlog", "open", "reopened"].includes(s))
      return "open";
    if (["in progress", "in review", "reviewing"].includes(s))
      return "in_progress";
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

export function normalizePriority(
  raw: string | null | undefined,
  labels: string[],
): string {
  const sources = [raw, ...labels]
    .filter(Boolean)
    .map((s) => s!.toLowerCase().trim());

  if (
    sources.some((s) => ["highest", "blocker", "critical", "crit"].includes(s))
  )
    return "critical";
  if (
    sources.some(
      (s) =>
        s === "high" || s.startsWith("priority: high") || s.startsWith("p1"),
    )
  )
    return "high";
  if (
    sources.some(
      (s) =>
        s === "medium" ||
        s.startsWith("priority: medium") ||
        s.startsWith("p2") ||
        s === "normal",
    )
  )
    return "medium";
  if (
    sources.some(
      (s) =>
        s === "low" ||
        s.startsWith("priority: low") ||
        s.startsWith("p3") ||
        s === "minor" ||
        s === "trivial",
    )
  )
    return "low";

  return "unknown";
}

// ─── Transition helpers ─────────────────────────────────────────────────────

const VALID_TRANSITION_STATUSES = ["open", "in_progress", "blocked", "done"] as const;

const STATUS_TO_WORK_ITEMS: Record<string, WorkItemStatus> = {
  open: "proposed",
  in_progress: "active",
  blocked: "blocked",
  done: "done",
};

const JIRA_STATUS_TARGETS: Record<string, string[]> = {
  open: ["to do", "new", "backlog", "open", "reopened"],
  in_progress: ["in progress", "in review"],
  blocked: ["blocked", "on hold"],
  done: ["done", "resolved", "closed"],
};

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
        const issues = await githubClient.listIssues(
          "all",
          undefined,
          owner,
          name,
        );
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
            openCount: openedIssues.filter((i: any) => i.state === "opened")
              .length,
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
              (i: any) =>
                !["Done", "Resolved", "Closed"].includes(
                  i.fields?.status?.name || "",
                ),
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
    const { total } = workItemDatabase.listWorkItems({
      includeArchived: false,
      limit: 1,
    });
    if (total === 0) return result;

    // Group by source — each external source is displayed as a "repo"
    const bySource = new Map<string, { total: number; open: number }>();
    const allItems = workItemDatabase.listWorkItems({
      includeArchived: false,
      limit: MAX_ISSUES,
    });
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

  const issues = await githubClient.listIssues(
    "all",
    undefined,
    owner,
    repoName,
  );
  return issues
    .filter((i: any) => !i.pull_request)
    .map((i: any) => ({
      id: String(i.number),
      externalId: `#${i.number}`,
      title: i.title || "",
      url: i.html_url || "",
      status: normalizeStatus(i.state, "github", (i.labels || []).map((l: any) => (typeof l === "string" ? l : l.name))),
      priority: normalizePriority(
        null,
        (i.labels || []).map((l: any) => (typeof l === "string" ? l : l.name)),
      ),
      assignee: i.assignee?.login || null,
      labels: (i.labels || [])
        .map((l: any) => (typeof l === "string" ? l : l.name))
        .filter(Boolean),
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
      status: normalizeStatus(i.state, "gitlab", i.labels || []),
      priority: normalizePriority(null, i.labels || []),
      assignee: i.assignee?.username || i.assignee?.name || null,
      labels: i.labels || [],
      platform: "gitlab",
      repo: repoId,
      createdAt: i.created_at || "",
      updatedAt: i.updated_at || "",
      dependencies: parseDependencies(i.description || ""),
      sprint: i.milestone ? `gl-milestone-${i.milestone.id}` : undefined,
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
    dependencies: parseDependencies(wi.description),
  }));
}

// ─── Sprint fetchers ────────────────────────────────────────────────────────

async function fetchGitHubSprints(
  repo: string,
): Promise<{ sprints: DashboardSprint[]; issues: DashboardIssue[] }> {
  const parts = repo.split("/");
  const owner = parts[0] || env.GITHUB_DEFAULT_OWNER;
  const repoName = parts[1] || env.GITHUB_DEFAULT_REPO;

  try {
    const milestones = await githubClient.listMilestones(
      "open",
      owner,
      repoName,
    );
    const sprints: DashboardSprint[] = milestones
      .filter((m: any) => m.state === "open")
      .map((m: any) => {
        return {
          id: `gh-milestone-${m.number}`,
          name: m.title || `Milestone ${m.number}`,
          state: m.state === "open" ? "active" : "closed",
          startDate: m.created_at || "",
          endDate: m.due_on || "",
          totalPoints: 0,
          completedPoints: 0,
          platform: "github",
          repo,
          description: m.description || undefined,
        };
      });

    let issues: DashboardIssue[] = [];
    try {
      const rawIssues = await githubClient.listIssues(
        "all",
        undefined,
        owner,
        repoName,
      );
      issues = rawIssues
        .filter((i: any) => !i.pull_request)
        .map((i: any) => {
          const milestone = i.milestone;
          const sprintLabel = ((i.labels || [])
            .map((l: any) => (typeof l === "string" ? l : l.name))
            .filter(Boolean) as string[])
            .find((l) => l.startsWith("sprint/") || l.startsWith("iteration/"));
          const sprint: string | undefined = milestone
            ? `gh-milestone-${milestone.number}`
            : sprintLabel
              ? `gh-label-${sprintLabel}`
              : "";
          return {
            id: String(i.number),
            externalId: `#${i.number}`,
            title: i.title || "",
            url: i.html_url || "",
            status: normalizeStatus(i.state, "github", (i.labels || []).map((l: any) => typeof l === "string" ? l : l.name)),
            priority: normalizePriority(
              null,
              (i.labels || []).map((l: any) =>
                typeof l === "string" ? l : l.name,
              ),
            ),
            assignee: i.assignee?.login || null,
            labels: (i.labels || [])
              .map((l: any) => (typeof l === "string" ? l : l.name))
              .filter(Boolean),
            platform: "github",
            repo,
            createdAt: i.created_at || "",
            updatedAt: i.updated_at || "",
            dependencies: parseDependencies(i.body || ""),
            sprint,
          };
        });
    } catch {
      /* fall through with empty issues */
    }

    for (const sprint of sprints) {
      const sprintIssues = issues.filter((i) => i.sprint === sprint.id);
      sprint.totalPoints = sprintIssues.length;
      sprint.completedPoints = sprintIssues.filter((i) =>
        i.status === "done",
      ).length;
    }

    return { sprints, issues };
  } catch (err: any) {
    return { sprints: [], issues: [] };
  }
}

async function fetchJiraSprints(
  projectKey: string,
): Promise<{ sprints: DashboardSprint[]; issues: DashboardIssue[] }> {
  try {
    const jiraSprints = await jiraClient.getSprints(projectKey);
    const sprints: DashboardSprint[] = jiraSprints.map((s) => ({
      id: `jira-sprint-${s.id}`,
      name: s.name,
      state: s.state,
      startDate: s.startDate || "",
      endDate: s.endDate || "",
      totalPoints: 0,
      completedPoints: 0,
      platform: "jira",
      repo: projectKey,
      description: s.goal || undefined,
    }));

    let allIssues: DashboardIssue[] = [];
    for (const sprint of jiraSprints) {
      try {
        const sprintIssues = await jiraClient.getSprintIssues(sprint.id);
        const mapped: DashboardIssue[] = sprintIssues.map((i: any) => ({
          id: i.key,
          externalId: i.key,
          title: i.fields?.summary || "",
          url: `${env.JIRA_BASE_URL}/browse/${i.key}`,
          status: normalizeStatus(i.fields?.status?.name, "jira"),
          priority: normalizePriority(
            i.fields?.priority?.name,
            i.fields?.labels || [],
          ),
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
                  ?.map((c: any) =>
                    c.content?.map((cc: any) => cc.text).join(""),
                  )
                  .join("\n") || "",
          ),
          sprint: `jira-sprint-${sprint.id}`,
        }));
        allIssues = allIssues.concat(mapped);
      } catch {
        /* skip sprint issues on error */
      }
    }

    for (const sprint of sprints) {
      const sprintIssues = allIssues.filter((i) => i.sprint === sprint.id);
      const doneStatuses = ["done"];
      sprint.totalPoints = sprintIssues.length;
      sprint.completedPoints = sprintIssues.filter((i: any) =>
        doneStatuses.includes(i.status),
      ).length;
    }

    return { sprints, issues: allIssues };
  } catch (err: any) {
    return { sprints: [], issues: [] };
  }
}

async function fetchGitLabSprints(
  repoId: string,
): Promise<{ sprints: DashboardSprint[]; issues: DashboardIssue[] }> {
  try {
    const milestones = await gitlabClient.listMilestones(repoId, "active");
    const sprints: DashboardSprint[] = milestones.map((m: any) => ({
      id: `gl-milestone-${m.id}`,
      name: m.title || `Milestone ${m.id}`,
      state: m.state === "active" ? "active" : "closed",
      startDate: m.start_date || m.created_at || "",
      endDate: m.due_date || "",
      totalPoints: 0,
      completedPoints: 0,
      platform: "gitlab",
      repo: repoId,
      description: m.description || undefined,
    }));

    let issues: DashboardIssue[] = [];
    try {
      const rawIssues = await gitlabClient.listIssues(repoId, "all");
      issues = rawIssues.map((i: any) => {
        const milestone = i.milestone;
        return {
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
          dependencies: parseDependencies(i.description || ""),
          sprint: milestone ? `gl-milestone-${milestone.id}` : undefined,
        };
      });
    } catch {
      /* fall through with empty issues */
    }

    for (const sprint of sprints) {
      const sprintIssues = issues.filter((i) => i.sprint === sprint.id);
      sprint.totalPoints = sprintIssues.length;
      sprint.completedPoints = sprintIssues.filter(
        (i) => i.status === "done",
      ).length;
    }

    return { sprints, issues };
  } catch {
    return { sprints: [], issues: [] };
  }
}

export function calculateBurndown(
  sprint: DashboardSprint,
  issues: DashboardIssue[],
): BurndownData {
  const startDate = new Date(sprint.startDate);
  const endDate = new Date(sprint.endDate);
  if (
    isNaN(startDate.getTime()) ||
    isNaN(endDate.getTime()) ||
    endDate <= startDate
  ) {
    return { labels: [], ideal: [], actual: [] };
  }

  const totalDays = Math.ceil(
    (endDate.getTime() - startDate.getTime()) / 86400000,
  );
  const labels: string[] = [];
  const ideal: number[] = [];
  const actual: number[] = [];

  const doneStatuses = new Set(["done"]);
  const sprintIssues = issues.filter((i) => i.sprint === sprint.id);
  const totalPoints = sprintIssues.length;

  for (let d = 0; d <= totalDays; d++) {
    const day = new Date(startDate.getTime() + d * 86400000);
    labels.push(
      day.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
    );
    ideal.push(Math.round((totalPoints * (totalDays - d)) / totalDays));
    const remaining = sprintIssues.filter((issue) => {
      if (doneStatuses.has(issue.status)) {
        const completedDate = new Date(issue.updatedAt);
        return completedDate > day;
      }
      return true;
    }).length;
    actual.push(remaining);
  }

  return { labels, ideal, actual };
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
    Querystring: { repo: string; platform: string; limit?: string; since?: string; _t?: string };
  }>("/issues", async (request) => {
    const { repo, platform, limit: limitRaw, since, _t } = request.query;
    const limit = Math.min(parseInt(limitRaw || "50", 10) || 50, MAX_ISSUES);
    const bypassCache = Boolean(_t);

    if (since !== undefined && since !== "") {
      const sinceDate = new Date(since);
      if (isNaN(sinceDate.getTime())) {
        return { issues: [], total: 0, error: "Invalid since parameter: must be a valid ISO date string" };
      }
    }

    const cacheKey = `${platform}:${repo}`;
    let issues: DashboardIssue[] = [];

    try {
      const now = Date.now();
      const cached = issueCache.get(cacheKey);
      if (!bypassCache && cached && now - cached.fetchedAt < CACHE_TTL_MS) {
        request.log.debug({ cacheKey }, "issue cache hit");
        cached.lastAccessed = now;
        issues = cached.data;
      } else {
        request.log.debug({ cacheKey }, "issue cache miss");
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
            issues = await fetchWorkItemIssues(
              repo as import("../work-items/types").WorkItemSource,
            );
            break;
        }
        if (issueCache.size >= MAX_CACHE_SIZE) {
          // LRU eviction: remove the least recently accessed entry
          let lruKey: string | undefined;
          let lruAccess = Infinity;
          for (const [k, v] of issueCache.entries()) {
            if (v.lastAccessed < lruAccess) {
              lruAccess = v.lastAccessed;
              lruKey = k;
            }
          }
          if (lruKey !== undefined) issueCache.delete(lruKey);
        }
        issueCache.set(cacheKey, { data: issues, fetchedAt: now, lastAccessed: now });
      }
    } catch (err: any) {
      return {
        issues: [],
        total: 0,
        error: err.message || "Failed to fetch issues",
      };
    }

    const sinceFilter = since && since !== "" ? since : null;
    const filtered = sinceFilter
      ? issues.filter((i) => i.updatedAt >= sinceFilter)
      : issues;

    return { issues: filtered.slice(0, limit), total: filtered.length };
  });

  fastify.get<{
    Querystring: { repo: string; platform: string; includeExternal?: string };
  }>("/dependencies", async (request) => {
    const { repo, platform, includeExternal } = request.query;
    const showExternal = includeExternal === "true";

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
          issues = await fetchWorkItemIssues(
            repo as import("../work-items/types").WorkItemSource,
          );
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
        if (!dep.external && issueIds.has(dep.id)) {
          edges.push({
            from: issue.id,
            to: dep.id,
            label: dep.label,
          });
        }
      }
    }

    if (showExternal) {
      try {
        const ghostNodeIds = new Set<string>();
        for (const issue of issues) {
          for (const dep of issue.dependencies) {
            if (!dep.external) continue;
            if (!ghostNodeIds.has(dep.id)) {
              ghostNodeIds.add(dep.id);
              nodes.push({
                id: dep.id,
                label: dep.label,
                title: dep.label,
                status: "unknown",
                priority: "unknown",
                url: constructExternalUrl(dep),
              });
            }
            edges.push({
              from: issue.id,
              to: dep.id,
              label: dep.label,
              dashes: true,
              color: { color: "#f59e0b" },
            });
          }
        }
      } catch {
        // External dep building failed, return internal graph only
      }
    }

    return { nodes, edges };
  });

  fastify.get<{
    Querystring: { platform: string; repo: string };
  }>("/sprints", async (request) => {
    const { platform, repo } = request.query;
    if (!platform || !repo) {
      return {
        sprints: [],
        issues: [],
        error: "platform and repo are required",
      };
    }

    try {
      switch (platform) {
        case "github":
          return await fetchGitHubSprints(repo);
        case "gitlab":
          return await fetchGitLabSprints(repo);
        case "jira":
          return await fetchJiraSprints(repo);
        default:
          return { sprints: [], issues: [] };
      }
    } catch (err: any) {
      return {
        sprints: [],
        issues: [],
        error: err.message || "Failed to fetch sprints",
      };
    }
  });

  fastify.get<{
    Querystring: { platform: string; repo: string; sprintId: string };
  }>("/burndown", async (request) => {
    const { platform, repo, sprintId } = request.query;
    if (!platform || !repo || !sprintId) {
      return {
        labels: [],
        ideal: [],
        actual: [],
        error: "platform, repo, and sprintId are required",
      };
    }

    try {
      let sprints: DashboardSprint[] = [];
      let issues: DashboardIssue[] = [];

      switch (platform) {
        case "github":
          ({ sprints, issues } = await fetchGitHubSprints(repo));
          break;
        case "gitlab":
          ({ sprints, issues } = await fetchGitLabSprints(repo));
          break;
        case "jira":
          ({ sprints, issues } = await fetchJiraSprints(repo));
          break;
        default:
          return { labels: [], ideal: [], actual: [] };
      }

      const sprint = sprints.find((s) => s.id === sprintId);
      if (!sprint) {
        return { labels: [], ideal: [], actual: [], error: "Sprint not found" };
      }

      const burndown = calculateBurndown(sprint, issues);
      return {
        sprint,
        labels: burndown.labels,
        ideal: burndown.ideal,
        actual: burndown.actual,
      };
    } catch (err: any) {
      return {
        labels: [],
        ideal: [],
        actual: [],
        error: err.message || "Failed to calculate burndown",
      };
    }
  });

  // ─── Sprint Management Routes ──────────────────────────────────────────────

  fastify.post<{
    Body: {
      platform: string;
      repo: string;
      name: string;
      startDate?: string;
      endDate?: string;
      description?: string;
    };
  }>("/sprints", async (request, reply) => {
    const { platform, repo, name, startDate, endDate, description } = request.body;
    if (!platform || !repo || !name) {
      return reply.code(400).send({
        error: "platform, repo, and name are required",
      });
    }

    try {
      switch (platform) {
        case "github": {
          const [owner, repoName] = repo.split("/");
          if (!owner || !repoName) {
            return reply.code(400).send({ error: "Invalid GitHub repo format. Use owner/repo." });
          }
          const result = await githubClient.createMilestone(
            { title: name, description, due_on: endDate },
            owner,
            repoName,
          );
          return reply.code(201).send({
            sprint: {
              id: `gh-milestone-${result.number}`,
              name: result.title,
              state: result.state === "open" ? "active" : "closed",
              startDate: result.created_at || "",
              endDate: result.due_on || "",
              totalPoints: 0,
              completedPoints: 0,
              platform: "github",
              repo,
              description: result.description || undefined,
            } as DashboardSprint,
          });
        }
        case "gitlab": {
          const result = await gitlabClient.createMilestone(repo, {
            title: name,
            description,
            due_date: endDate,
            start_date: startDate,
          });
          return reply.code(201).send({
            sprint: {
              id: `gl-milestone-${result.id}`,
              name: result.title,
              state: result.state === "active" ? "active" : "closed",
              startDate: result.start_date || result.created_at || "",
              endDate: result.due_date || "",
              totalPoints: 0,
              completedPoints: 0,
              platform: "gitlab",
              repo,
              description: result.description || undefined,
            } as DashboardSprint,
          });
        }
        case "jira": {
          const result = await jiraClient.createSprint({
            projectKey: repo,
            name,
            goal: description,
            startDate,
            endDate,
          });
          return reply.code(201).send({
            sprint: {
              id: `jira-sprint-${result.id}`,
              name: result.name,
              state: result.state,
              startDate: result.startDate || "",
              endDate: result.endDate || "",
              totalPoints: 0,
              completedPoints: 0,
              platform: "jira",
              repo,
              description: result.goal || undefined,
            } as DashboardSprint,
          });
        }
        default:
          return reply.code(400).send({
            error: `Unsupported platform: ${platform}. Use github, gitlab, or jira.`,
          });
      }
    } catch (err: any) {
      return reply.code(500).send({
        error: err.message || "Failed to create sprint/milestone",
      });
    }
  });

  fastify.put<{
    Params: { sprintId: string };
    Body: {
      platform: string;
      repo: string;
      name?: string;
      startDate?: string;
      endDate?: string;
      description?: string;
      state?: string;
    };
  }>("/sprints/:sprintId", async (request, reply) => {
    const { sprintId } = request.params;
    const { platform, repo, name, startDate, endDate, description, state } = request.body;
    if (!platform || !repo || !sprintId) {
      return reply.code(400).send({
        error: "platform, repo, and sprintId (in URL path) are required",
      });
    }

    try {
      switch (platform) {
        case "github": {
          const [owner, repoName] = repo.split("/");
          if (!owner || !repoName) {
            return reply.code(400).send({ error: "Invalid GitHub repo format." });
          }
          const milestoneNumber = parseInt(sprintId.replace("gh-milestone-", ""), 10);
          if (isNaN(milestoneNumber)) {
            return reply.code(400).send({ error: "Invalid GitHub milestone ID" });
          }
          const ghState = state === "closed" ? "closed" as const
            : state === "active" ? "open" as const
            : undefined;
          const result = await githubClient.updateMilestone(
            milestoneNumber,
            { title: name, description, due_on: endDate, state: ghState },
            owner,
            repoName,
          );
          return {
            sprint: {
              id: `gh-milestone-${result.number}`,
              name: result.title,
              state: result.state === "open" ? "active" : "closed",
              startDate: result.created_at || "",
              endDate: result.due_on || "",
              totalPoints: 0,
              completedPoints: 0,
              platform: "github",
              repo,
              description: result.description || undefined,
            } as DashboardSprint,
          };
        }
        case "gitlab": {
          const milestoneId = parseInt(sprintId.replace("gl-milestone-", ""), 10);
          if (isNaN(milestoneId)) {
            return reply.code(400).send({ error: "Invalid GitLab milestone ID" });
          }
          const glStateEvent = state === "closed" ? "close" as const
            : state === "active" ? "activate" as const
            : undefined;
          const result = await gitlabClient.updateMilestone(repo, milestoneId, {
            title: name,
            description,
            due_date: endDate,
            start_date: startDate,
            state_event: glStateEvent,
          });
          return {
            sprint: {
              id: `gl-milestone-${result.id}`,
              name: result.title,
              state: result.state === "active" ? "active" : "closed",
              startDate: result.start_date || result.created_at || "",
              endDate: result.due_date || "",
              totalPoints: 0,
              completedPoints: 0,
              platform: "gitlab",
              repo,
              description: result.description || undefined,
            } as DashboardSprint,
          };
        }
        case "jira": {
          const jiraSprintId = parseInt(sprintId.replace("jira-sprint-", ""), 10);
          if (isNaN(jiraSprintId)) {
            return reply.code(400).send({ error: "Invalid Jira sprint ID" });
          }
          const jiraState = state as "active" | "closed" | undefined;
          const result = await jiraClient.updateSprint(jiraSprintId, {
            name,
            goal: description,
            startDate,
            endDate,
            state: jiraState,
          });
          return {
            sprint: {
              id: `jira-sprint-${result.id}`,
              name: result.name,
              state: result.state,
              startDate: result.startDate || "",
              endDate: result.endDate || "",
              totalPoints: 0,
              completedPoints: 0,
              platform: "jira",
              repo,
              description: result.goal || undefined,
            } as DashboardSprint,
          };
        }
        default:
          return reply.code(400).send({
            error: `Unsupported platform: ${platform}. Use github, gitlab, or jira.`,
          });
      }
    } catch (err: any) {
      return reply.code(500).send({
        error: err.message || "Failed to update sprint/milestone",
      });
    }
  });

  fastify.delete<{
    Params: { sprintId: string };
    Body: { platform: string; repo: string };
  }>("/sprints/:sprintId", async (request, reply) => {
    const { sprintId } = request.params;
    const { platform, repo } = request.body;
    if (!platform || !repo || !sprintId) {
      return reply.code(400).send({
        error: "platform, repo, and sprintId (in URL path) are required",
      });
    }

    try {
      switch (platform) {
        case "github": {
          const [owner, repoName] = repo.split("/");
          if (!owner || !repoName) {
            return reply.code(400).send({ error: "Invalid GitHub repo format." });
          }
          const milestoneNumber = parseInt(sprintId.replace("gh-milestone-", ""), 10);
          if (isNaN(milestoneNumber)) {
            return reply.code(400).send({ error: "Invalid GitHub milestone ID" });
          }
          await githubClient.deleteMilestone(milestoneNumber, owner, repoName);
          invalidateIssueCache("github", repo);
          return { success: true };
        }
        case "gitlab": {
          const milestoneId = parseInt(sprintId.replace("gl-milestone-", ""), 10);
          if (isNaN(milestoneId)) {
            return reply.code(400).send({ error: "Invalid GitLab milestone ID" });
          }
          await gitlabClient.deleteMilestone(repo, milestoneId);
          invalidateIssueCache("gitlab", repo);
          return { success: true };
        }
        case "jira": {
          const jiraSprintId = parseInt(sprintId.replace("jira-sprint-", ""), 10);
          if (isNaN(jiraSprintId)) {
            return reply.code(400).send({ error: "Invalid Jira sprint ID" });
          }
          await jiraClient.updateSprint(jiraSprintId, { state: "closed" });
          invalidateIssueCache("jira", repo);
          return { success: true };
        }
        default:
          return reply.code(400).send({
            error: `Unsupported platform: ${platform}.`,
          });
      }
    } catch (err: any) {
      return reply.code(500).send({
        error: err.message || "Failed to delete sprint/milestone",
      });
    }
  });

  fastify.post<{
    Body: { issueId: string; platform: string; repo: string; status: string };
  }>("/transition", async (request) => {
    const { issueId, platform, repo, status } = request.body || {};

    if (!issueId || !platform || !repo || !status) {
      return {
        success: false,
        error: "issueId, platform, repo, and status are required",
      };
    }

    if (!VALID_TRANSITION_STATUSES.includes(status as any)) {
      return {
        success: false,
        error: `Invalid status "${status}". Must be one of: ${VALID_TRANSITION_STATUSES.join(", ")}`,
      };
    }

    try {
      switch (platform) {
        case "github": {
          if (status === "done") {
            const [owner, repoName] = repo.split("/");
            await githubClient.updateIssue(
              Number(issueId),
              { state: "closed" },
              owner,
              repoName,
            );
          } else if (status === "open") {
            const [owner, repoName] = repo.split("/");
            await githubClient.updateIssue(
              Number(issueId),
              { state: "open" },
              owner,
              repoName,
            );
          } else {
            return {
              success: false,
              error: `Cannot transition GitHub issue to "${status}". GitHub only supports open and closed states.`,
            };
          }
          break;
        }
        case "gitlab": {
          if (status === "done") {
            await gitlabClient.editIssue(repo, Number(issueId), {
              stateEvent: "close",
            });
          } else if (status === "open") {
            await gitlabClient.editIssue(repo, Number(issueId), {
              stateEvent: "reopen",
            });
          } else {
            return {
              success: false,
              error: `Cannot transition GitLab issue to "${status}". GitLab only supports open and closed states via this endpoint.`,
            };
          }
          break;
        }
        case "jira": {
          const targetNames = JIRA_STATUS_TARGETS[status] || [];
          const transitions = await jiraClient.getTransitions(issueId);
          const match = transitions.find((t: any) => {
            const toName = (t.to?.name || "").toLowerCase().trim();
            return targetNames.includes(toName);
          });
          if (!match) {
            return {
              success: false,
              error: `No available transition to "${status}" for ${issueId}. Available: ${transitions.map((t: any) => t.name).join(", ") || "none"}`,
            };
          }
          await jiraClient.transitionIssue(
            issueId,
            match.id,
            `Transitioned via dashboard to ${status}`,
          );
          break;
        }
        case "work_items": {
          const wiStatus = STATUS_TO_WORK_ITEMS[status];
          if (!wiStatus) {
            return {
              success: false,
              error: `Cannot map status "${status}" to work item status.`,
            };
          }
          const result = workItemDatabase.updateWorkItem(issueId, {
            status: wiStatus,
          });
          if (!result) {
            return {
              success: false,
              error: `Work item ${issueId} not found`,
            };
          }
          break;
        }
        default:
          return {
            success: false,
            error: `Unsupported platform "${platform}"`,
          };
      }

      invalidateIssueCache(platform, repo);
      return { success: true };
    } catch (err: any) {
      return {
        success: false,
        error: err.message || "Failed to transition issue",
      };
    }
  });
}
