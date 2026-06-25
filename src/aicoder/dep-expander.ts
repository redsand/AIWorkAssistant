/**
 * BFS-expand a work queue by following dependency chains up to their
 * roots. Extracted from src/aicoder.ts (2026-06-25).
 *
 * Handles GitHub (numeric refs), Jira (KEY-N refs), and GitLab (numeric
 * refs against `GITLAB_DEFAULT_PROJECT`). Only open issues are added.
 * Stops at MAX_HOPS to prevent runaway on circular/deep chains.
 *
 * Clients (jiraClient/gitlabClient) are injected so this module can be
 * unit-tested against fakes without standing up a real Atlassian/GitLab
 * stack. ghToken / owner / repo come through the existing signature.
 */
import axios from "axios";
import type { WorkItem } from "../autonomous-loop/types";
import { parseDependencies } from "../autonomous-loop/dependency-parser";
import { adfToText, extractJiraSprint } from "./jira-helpers";

const MAX_HOPS = 10;

export interface DepExpanderJiraClient {
  isConfigured(): boolean;
  getIssue(key: string): Promise<{
    fields?: {
      summary?: string;
      status?: { name?: string };
      project?: { key?: string };
      labels?: string[];
      description?: unknown;
      [k: string]: unknown;
    };
  }>;
}

export interface DepExpanderGitLabClient {
  isConfigured(): boolean;
  getIssue(projectId: string, iid: number): Promise<{
    iid: number;
    state: string;
    title: string;
    web_url: string;
    project_id: number;
    labels?: string[];
    description?: string;
  }>;
}

export interface DepExpanderLogger {
  logConfig(message: string): void;
}

function slugFromTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

const isJiraKey = (dep: string) => /^[A-Z][A-Z0-9]+-\d+$/.test(dep);
const isNumeric = (dep: string) => /^\d+$/.test(dep);

export interface ExpandDepsOptions {
  jiraClient: DepExpanderJiraClient;
  gitlabClient: DepExpanderGitLabClient;
  logger: DepExpanderLogger;
  items: WorkItem[];
  source: string;
  ghToken: string;
  owner: string;
  repo: string;
  gitlabProject?: string;
  jiraBaseUrl?: string;
}

export async function expandWithDependencies(
  opts: ExpandDepsOptions,
): Promise<WorkItem[]> {
  const {
    jiraClient,
    gitlabClient,
    logger,
    items,
    source,
    ghToken,
    owner,
    repo,
  } = opts;
  const gitlabProject = opts.gitlabProject || process.env.GITLAB_DEFAULT_PROJECT || "";
  const jiraBase = opts.jiraBaseUrl || process.env.JIRA_BASE_URL || "https://hawksolutionstech.atlassian.net";

  const isGitHub = source === "github" && !!ghToken && !!owner && !!repo;
  const isJira = source === "jira" && jiraClient.isConfigured();
  const isGitLab = source === "gitlab" && gitlabClient.isConfigured() && !!gitlabProject;
  if (!isGitHub && !isJira && !isGitLab) return items;

  const inPool = new Map(items.map((i) => [i.id, i]));
  const fetchedIds: string[] = [];

  const fetchGitHubIssue = async (num: number): Promise<WorkItem | null> => {
    try {
      const resp = await axios.get(
        `https://api.github.com/repos/${owner}/${repo}/issues/${num}`,
        {
          headers: {
            Authorization: `Bearer ${ghToken}`,
            Accept: "application/vnd.github+json",
          },
        },
      );
      const issue = resp.data;
      if (issue.pull_request || issue.state !== "open") return null;
      const slug = slugFromTitle(issue.title);
      return {
        id: String(issue.number),
        title: issue.title,
        number: issue.number,
        url: issue.html_url,
        owner,
        repo,
        labels: (issue.labels || []).map((l: any) =>
          typeof l === "string" ? l : l.name,
        ),
        suggestedBranch: slug ? `ai/issue-${issue.number}-${slug}` : `ai/issue-${issue.number}`,
        body: issue.body || "",
      } as WorkItem;
    } catch {
      return null;
    }
  };

  const fetchJiraIssue = async (key: string): Promise<WorkItem | null> => {
    try {
      const issue = await jiraClient.getIssue(key);
      const status = issue.fields?.status?.name ?? "";
      if (/done|closed|resolved|completed/i.test(status)) return null;
      const num = parseInt(key.split("-").pop() || "0", 10);
      const title = issue.fields?.summary || "";
      const slug = slugFromTitle(title);
      return {
        id: key,
        title,
        number: num,
        url: `${jiraBase}/browse/${key}`,
        owner: issue.fields?.project?.key || "",
        repo: issue.fields?.project?.key || "",
        labels: issue.fields?.labels || [],
        suggestedBranch: slug ? `ai/issue-${num}-${slug}` : `ai/issue-${num}`,
        body: adfToText(issue.fields?.description),
        sprint: extractJiraSprint(issue.fields),
      } as WorkItem;
    } catch {
      return null;
    }
  };

  const fetchGitLabIssue = async (num: number): Promise<WorkItem | null> => {
    try {
      const issue = await gitlabClient.getIssue(gitlabProject, num);
      if (issue.state !== "opened") return null;
      const title = issue.title || "";
      const slug = slugFromTitle(title);
      return {
        id: String(issue.iid),
        title,
        number: issue.iid,
        url: issue.web_url,
        owner: String(issue.project_id),
        repo: gitlabProject,
        labels: issue.labels || [],
        suggestedBranch: slug ? `ai/issue-${issue.iid}-${slug}` : `ai/issue-${issue.iid}`,
        body: issue.description || "",
      } as WorkItem;
    } catch {
      return null;
    }
  };

  let frontierGH = new Set<number>();
  let frontierGL = new Set<number>();
  let frontierJira = new Set<string>();
  const seedFrontier = (body: string) => {
    for (const dep of parseDependencies(body)) {
      if (isNumeric(dep)) {
        const num = parseInt(dep, 10);
        if (isGitHub && !inPool.has(dep)) frontierGH.add(num);
        if (isGitLab && !inPool.has(dep)) frontierGL.add(num);
      }
      if (isJira && isJiraKey(dep) && !inPool.has(dep)) frontierJira.add(dep);
    }
  };
  for (const item of items) seedFrontier(item.body || "");

  for (
    let hop = 0;
    hop < MAX_HOPS && (frontierGH.size > 0 || frontierGL.size > 0 || frontierJira.size > 0);
    hop++
  ) {
    const [ghResults, glResults, jiraResults] = await Promise.all([
      isGitHub ? Promise.all([...frontierGH].map(fetchGitHubIssue)) : Promise.resolve([]),
      isGitLab ? Promise.all([...frontierGL].map(fetchGitLabIssue)) : Promise.resolve([]),
      isJira ? Promise.all([...frontierJira].map(fetchJiraIssue)) : Promise.resolve([]),
    ]);
    frontierGH = new Set<number>();
    frontierGL = new Set<number>();
    frontierJira = new Set<string>();
    for (const item of [...ghResults, ...glResults, ...jiraResults]) {
      if (!item) continue;
      inPool.set(item.id, item);
      fetchedIds.push(item.id);
      seedFrontier(item.body || "");
    }
  }

  if (fetchedIds.length > 0) {
    logger.logConfig(
      `Expanded work queue with ${fetchedIds.length} dependency issue(s): ${fetchedIds.join(", ")}`,
    );
  }

  return [...inPool.values()];
}
