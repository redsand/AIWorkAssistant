import axios, { AxiosInstance, AxiosError } from "axios";
import { env } from "../../config/env";

export class GithubClient {
  private client: AxiosInstance;
  private defaultOwner: string;
  private defaultRepo: string;
  private maxRetries = 3;

  constructor() {
    this.defaultOwner = env.GITHUB_DEFAULT_OWNER;
    this.defaultRepo = env.GITHUB_DEFAULT_REPO;

    this.client = axios.create({
      baseURL: env.GITHUB_BASE_URL || "https://api.github.com",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      timeout: 30000,
    });

    if (env.GITHUB_TOKEN) {
      this.client.interceptors.response.use(
        undefined,
        async (error: AxiosError) => {
          const config = error.config as any;
          if (!config) return Promise.reject(error);

          config.__retryCount = config.__retryCount || 0;

          const status = error.response?.status;
          if (status === 401 || status === 403 || status === 404) {
            return Promise.reject(error);
          }

          if (status === 429) {
            const retryAfter = error.response?.headers?.["retry-after"];
            const delay = retryAfter
              ? Number(retryAfter) * 1000
              : Math.min(4000 * Math.pow(2, config.__retryCount), 60000);
            console.warn(
              `[GitHub] Rate limited (429), waiting ${Math.round(delay)}ms (attempt ${config.__retryCount + 1}/${this.maxRetries})`,
            );
            await new Promise((r) =>
              setTimeout(r, delay + Math.random() * 500),
            );
          } else if (status && status >= 500) {
            const delay = Math.min(
              1000 * Math.pow(2, config.__retryCount),
              30000,
            );
            console.warn(
              `[GitHub] Server error (${status}), retrying in ${Math.round(delay)}ms (attempt ${config.__retryCount + 1}/${this.maxRetries})`,
            );
            await new Promise((r) =>
              setTimeout(r, delay + Math.random() * 1000),
            );
          } else if (!status) {
            const delay = Math.min(
              1000 * Math.pow(2, config.__retryCount),
              30000,
            );
            console.warn(
              `[GitHub] Network error, retrying in ${Math.round(delay)}ms (attempt ${config.__retryCount + 1}/${this.maxRetries})`,
            );
            await new Promise((r) =>
              setTimeout(r, delay + Math.random() * 1000),
            );
          }

          config.__retryCount += 1;
          if (config.__retryCount > this.maxRetries) {
            return Promise.reject(error);
          }

          return this.client.request(config);
        },
      );
    }
  }

  resolveRepo(owner?: string, repo?: string): { owner: string; repo: string } {
    const o = owner || this.defaultOwner;
    const r = repo || this.defaultRepo;
    if (!o || !r) {
      throw new Error(
        "No owner/repo specified and GITHUB_DEFAULT_OWNER/GITHUB_DEFAULT_REPO not configured.",
      );
    }
    return { owner: o, repo: r };
  }

  isConfigured(): boolean {
    return !!env.GITHUB_TOKEN && env.GITHUB_TOKEN.length > 0;
  }

  async validateConfig(): Promise<boolean> {
    if (!this.isConfigured()) return false;
    try {
      await this.client.get("/user");
      return true;
    } catch {
      return false;
    }
  }

  async getCurrentUser(): Promise<any> {
    const response = await this.client.get("/user");
    return response.data;
  }

  async listRepositories(
    affilitation?: "owner" | "collaborator" | "organization_member",
    perPage?: number,
  ): Promise<any[]> {
    const params: Record<string, unknown> = {
      sort: "updated",
      direction: "desc",
      per_page: perPage || 50,
    };
    if (affilitation) params.affilitation = affilitation;

    const response = await this.client.get("/user/repos", { params });
    console.log(`[GitHub] Found ${response.data.length} repositories`);
    return response.data;
  }

  async getRepository(owner?: string, repo?: string): Promise<any> {
    const { owner: o, repo: r } = this.resolveRepo(owner, repo);
    console.log(`[GitHub] Fetching repo ${o}/${r}`);
    const response = await this.client.get(`/repos/${o}/${r}`);
    return response.data;
  }

  async listBranches(owner?: string, repo?: string): Promise<any[]> {
    const { owner: o, repo: r } = this.resolveRepo(owner, repo);
    console.log(`[GitHub] Fetching branches for ${o}/${r}`);
    const response = await this.client.get(`/repos/${o}/${r}/branches`, {
      params: { per_page: 100 },
    });
    console.log(`[GitHub] Found ${response.data.length} branches`);
    return response.data;
  }

  async createBranch(
    branchName: string,
    ref: string,
    owner?: string,
    repo?: string,
  ): Promise<any> {
    const { owner: o, repo: r } = this.resolveRepo(owner, repo);
    console.log(
      `[GitHub] Creating branch ${branchName} from ${ref} in ${o}/${r}`,
    );
    const response = await this.client.post(`/repos/${o}/${r}/git/refs`, {
      ref: `refs/heads/${branchName}`,
      sha: ref,
    });
    console.log(`[GitHub] Branch ${branchName} created`);
    return response.data;
  }

  async listTags(owner?: string, repo?: string): Promise<any[]> {
    const { owner: o, repo: r } = this.resolveRepo(owner, repo);
    console.log(`[GitHub] Fetching tags for ${o}/${r}`);
    const response = await this.client.get(`/repos/${o}/${r}/tags`, {
      params: { per_page: 50 },
    });
    console.log(`[GitHub] Found ${response.data.length} tags`);
    return response.data;
  }

  async getTree(
    path?: string,
    ref?: string,
    owner?: string,
    repo?: string,
    recursive?: boolean,
  ): Promise<any[]> {
    const { owner: o, repo: r } = this.resolveRepo(owner, repo);
    const treeRef = ref || "HEAD";
    console.log(
      `[GitHub] Fetching tree${path ? ` at ${path}` : ""} for ${o}/${r} ref=${treeRef}`,
    );

    let treeSha = treeRef;
    if (path) {
      const refData = await this.client.get(
        `/repos/${o}/${r}/git/ref/heads/${treeRef === "HEAD" ? (await this.getRepository(o, r)).default_branch : treeRef}`,
      );
      const baseTreeSha = refData.data.object.sha;
      const baseTree = await this.client.get(
        `/repos/${o}/${r}/git/trees/${baseTreeSha}`,
        {
          params: { recursive: "1" },
        },
      );

      const items = baseTree.data.tree.filter((item: any) =>
        item.path.startsWith(path.endsWith("/") ? path : path + "/"),
      );
      const filtered = recursive
        ? items
        : items.filter((item: any) => {
            const relativePath = item.path.slice(
              path.endsWith("/") ? path.length : path.length + 1,
            );
            return !relativePath.includes("/") || relativePath.endsWith("/");
          });
      console.log(`[GitHub] Found ${filtered.length} items`);
      return filtered;
    }

    const response = await this.client.get(
      `/repos/${o}/${r}/git/trees/${treeSha}`,
      {
        params: { recursive: recursive ? "1" : "0" },
      },
    );
    console.log(`[GitHub] Found ${response.data.tree.length} items`);
    return response.data.tree;
  }

  async getFile(
    filePath: string,
    ref?: string,
    owner?: string,
    repo?: string,
  ): Promise<{
    name: string;
    path: string;
    content: string;
    encoding: string;
    size: number;
    sha: string;
  }> {
    const { owner: o, repo: r } = this.resolveRepo(owner, repo);
    console.log(`[GitHub] Fetching file ${filePath} from ${o}/${r}`);
    const params: Record<string, unknown> = {};
    if (ref) params.ref = ref;

    const response = await this.client.get(
      `/repos/${o}/${r}/contents/${filePath}`,
      { params },
    );
    return {
      name: response.data.name,
      path: response.data.path,
      content: response.data.content,
      encoding: response.data.encoding,
      size: response.data.size,
      sha: response.data.sha,
    };
  }

  async createFile(
    filePath: string,
    content: string,
    commitMessage: string,
    branch: string,
    owner?: string,
    repo?: string,
  ): Promise<any> {
    const { owner: o, repo: r } = this.resolveRepo(owner, repo);
    console.log(`[GitHub] Creating file ${filePath} on ${branch} in ${o}/${r}`);
    const response = await this.client.put(
      `/repos/${o}/${r}/contents/${filePath}`,
      {
        message: commitMessage,
        content: Buffer.from(content).toString("base64"),
        branch,
      },
    );
    console.log(`[GitHub] File ${filePath} created`);
    return response.data;
  }

  async updateFile(
    filePath: string,
    content: string,
    commitMessage: string,
    branch: string,
    sha: string,
    owner?: string,
    repo?: string,
  ): Promise<any> {
    const { owner: o, repo: r } = this.resolveRepo(owner, repo);
    console.log(`[GitHub] Updating file ${filePath} on ${branch} in ${o}/${r}`);
    const response = await this.client.put(
      `/repos/${o}/${r}/contents/${filePath}`,
      {
        message: commitMessage,
        content: Buffer.from(content).toString("base64"),
        branch,
        sha,
      },
    );
    console.log(`[GitHub] File ${filePath} updated`);
    return response.data;
  }

  async getFileBlame(
    filePath: string,
    ref?: string,
    owner?: string,
    repo?: string,
  ): Promise<any> {
    const { owner: o, repo: r } = this.resolveRepo(owner, repo);
    console.log(`[GitHub] Fetching blame for ${filePath} in ${o}/${r}`);
    const params: Record<string, unknown> = {};
    if (ref) params.ref = ref;

    const response = await this.client.get(`/repos/${o}/${r}/commits`, {
      params: { path: filePath, per_page: 20, ...(ref ? { sha: ref } : {}) },
    });
    return response.data;
  }

  async searchCode(
    query: string,
    owner?: string,
    repo?: string,
  ): Promise<any[]> {
    const { owner: o, repo: r } = this.resolveRepo(owner, repo);
    const q = `${query} repo:${o}/${r}`;
    console.log(`[GitHub] Searching code for "${query}" in ${o}/${r}`);
    const response = await this.client.get("/search/code", {
      params: { q, per_page: 20 },
    });
    const items = (response.data.items || []).map((item: any) => ({
      name: item.name,
      path: item.path,
      sha: item.sha,
    }));
    console.log(`[GitHub] Found ${items.length} search results`);
    return items;
  }

  async listCommits(
    ref?: string,
    path?: string,
    perPage?: number,
    owner?: string,
    repo?: string,
  ): Promise<any[]> {
    const { owner: o, repo: r } = this.resolveRepo(owner, repo);
    console.log(`[GitHub] Fetching commits for ${o}/${r}`);
    const params: Record<string, unknown> = { per_page: perPage || 30 };
    if (ref) params.sha = ref;
    if (path) params.path = path;

    const response = await this.client.get(`/repos/${o}/${r}/commits`, {
      params,
    });
    console.log(`[GitHub] Found ${response.data.length} commits`);
    return response.data;
  }

  async getCommit(ref: string, owner?: string, repo?: string): Promise<any> {
    const { owner: o, repo: r } = this.resolveRepo(owner, repo);
    console.log(`[GitHub] Fetching commit ${ref} from ${o}/${r}`);
    const response = await this.client.get(`/repos/${o}/${r}/commits/${ref}`);
    return response.data;
  }

  async compareRefs(
    base: string,
    head: string,
    owner?: string,
    repo?: string,
  ): Promise<any> {
    const { owner: o, repo: r } = this.resolveRepo(owner, repo);
    console.log(`[GitHub] Comparing ${base}...${head} in ${o}/${r}`);
    const response = await this.client.get(
      `/repos/${o}/${r}/compare/${base}...${head}`,
    );
    return {
      commits: (response.data.commits || []).map((c: any) => ({
        sha: c.sha,
        message: c.commit?.message,
        author: c.commit?.author?.name,
      })),
      files: (response.data.files || []).map((f: any) => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        patch: f.patch,
      })),
    };
  }

  async listPullRequests(
    state?: "open" | "closed" | "all",
    owner?: string,
    repo?: string,
  ): Promise<any[]> {
    const { owner: o, repo: r } = this.resolveRepo(owner, repo);
    console.log(`[GitHub] Fetching PRs for ${o}/${r}`);
    const response = await this.client.get(`/repos/${o}/${r}/pulls`, {
      params: {
        state: state || "open",
        per_page: 50,
        sort: "updated",
        direction: "desc",
      },
    });
    console.log(`[GitHub] Found ${response.data.length} PRs`);
    return response.data;
  }

  async getPullRequest(
    prNumber: number,
    owner?: string,
    repo?: string,
  ): Promise<any> {
    const { owner: o, repo: r } = this.resolveRepo(owner, repo);
    console.log(`[GitHub] Fetching PR #${prNumber} from ${o}/${r}`);
    const response = await this.client.get(
      `/repos/${o}/${r}/pulls/${prNumber}`,
    );
    return response.data;
  }

  async createPullRequest(
    params: {
      title: string;
      body?: string;
      head: string;
      base: string;
      draft?: boolean;
    },
    owner?: string,
    repo?: string,
  ): Promise<any> {
    const { owner: o, repo: r } = this.resolveRepo(owner, repo);
    console.log(
      `[GitHub] Creating PR: ${params.head} -> ${params.base} in ${o}/${r}`,
    );
    const response = await this.client.post(`/repos/${o}/${r}/pulls`, {
      title: params.title,
      body: params.body || "",
      head: params.head,
      base: params.base,
      draft: params.draft || false,
    });
    console.log(
      `[GitHub] PR #${response.data.number} created: ${response.data.html_url}`,
    );
    return response.data;
  }

  async mergePullRequest(
    prNumber: number,
    options?: {
      commitTitle?: string;
      mergeMethod?: "merge" | "squash" | "rebase";
    },
    owner?: string,
    repo?: string,
  ): Promise<any> {
    const { owner: o, repo: r } = this.resolveRepo(owner, repo);
    console.log(`[GitHub] Merging PR #${prNumber} in ${o}/${r}`);
    const body: Record<string, unknown> = {};
    if (options?.commitTitle) body.commit_title = options.commitTitle;
    if (options?.mergeMethod) body.merge_method = options.mergeMethod;

    const response = await this.client.put(
      `/repos/${o}/${r}/pulls/${prNumber}/merge`,
      body,
    );
    console.log(`[GitHub] PR #${prNumber} merged`);
    return response.data;
  }

  async listPullRequestComments(
    prNumber: number,
    owner?: string,
    repo?: string,
  ): Promise<any[]> {
    const { owner: o, repo: r } = this.resolveRepo(owner, repo);
    console.log(`[GitHub] Fetching comments for PR #${prNumber} in ${o}/${r}`);
    const response = await this.client.get(
      `/repos/${o}/${r}/pulls/${prNumber}/comments`,
      { params: { per_page: 50 } },
    );
    return response.data;
  }

  async addPullRequestComment(
    prNumber: number,
    body: string,
    owner?: string,
    repo?: string,
  ): Promise<any> {
    const { owner: o, repo: r } = this.resolveRepo(owner, repo);
    console.log(`[GitHub] Adding comment to PR #${prNumber} in ${o}/${r}`);
    const response = await this.client.post(
      `/repos/${o}/${r}/issues/${prNumber}/comments`,
      { body },
    );
    console.log(`[GitHub] Comment added to PR #${prNumber}`);
    return response.data;
  }

  async getPullRequestFiles(
    prNumber: number,
    owner?: string,
    repo?: string,
  ): Promise<any[]> {
    const { owner: o, repo: r } = this.resolveRepo(owner, repo);
    console.log(`[GitHub] Fetching files for PR #${prNumber} in ${o}/${r}`);
    const response = await this.client.get(
      `/repos/${o}/${r}/pulls/${prNumber}/files`,
      { params: { per_page: 100 } },
    );
    return response.data;
  }

  async listIssues(
    state?: "open" | "closed" | "all",
    labels?: string,
    owner?: string,
    repo?: string,
  ): Promise<any[]> {
    const { owner: o, repo: r } = this.resolveRepo(owner, repo);
    console.log(`[GitHub] Fetching issues for ${o}/${r}`);
    const params: Record<string, unknown> = {
      state: state || "open",
      per_page: 50,
      sort: "updated",
      direction: "desc",
    };
    if (labels) params.labels = labels;

    const response = await this.client.get(`/repos/${o}/${r}/issues`, {
      params,
    });
    console.log(`[GitHub] Found ${response.data.length} issues`);
    return response.data;
  }

  async getIssue(
    issueNumber: number,
    owner?: string,
    repo?: string,
  ): Promise<any> {
    const { owner: o, repo: r } = this.resolveRepo(owner, repo);
    console.log(`[GitHub] Fetching issue #${issueNumber} from ${o}/${r}`);
    const response = await this.client.get(
      `/repos/${o}/${r}/issues/${issueNumber}`,
    );
    return response.data;
  }

  async createIssue(
    params: {
      title: string;
      body?: string;
      labels?: string[];
      assignees?: string[];
      milestone?: number;
    },
    owner?: string,
    repo?: string,
  ): Promise<any> {
    const { owner: o, repo: r } = this.resolveRepo(owner, repo);
    console.log(`[GitHub] Creating issue: ${params.title} in ${o}/${r}`);
    const body: Record<string, unknown> = {
      title: params.title,
      body: params.body || "",
    };
    if (params.labels) body.labels = params.labels;
    if (params.assignees) body.assignees = params.assignees;
    if (params.milestone) body.milestone = params.milestone;

    const response = await this.client.post(`/repos/${o}/${r}/issues`, body);
    console.log(
      `[GitHub] Issue #${response.data.number} created: ${response.data.html_url}`,
    );
    return response.data;
  }

  async updateIssue(
    issueNumber: number,
    params: {
      title?: string;
      body?: string;
      state?: "open" | "closed";
      labels?: string[];
      assignees?: string[];
    },
    owner?: string,
    repo?: string,
  ): Promise<any> {
    const { owner: o, repo: r } = this.resolveRepo(owner, repo);
    console.log(`[GitHub] Updating issue #${issueNumber} in ${o}/${r}`);
    const body: Record<string, unknown> = {};
    if (params.title) body.title = params.title;
    if (params.body) body.body = params.body;
    if (params.state) body.state = params.state;
    if (params.labels) body.labels = params.labels;
    if (params.assignees) body.assignees = params.assignees;

    const response = await this.client.patch(
      `/repos/${o}/${r}/issues/${issueNumber}`,
      body,
    );
    console.log(`[GitHub] Issue #${issueNumber} updated`);
    return response.data;
  }

  async listIssueComments(
    issueNumber: number,
    owner?: string,
    repo?: string,
  ): Promise<any[]> {
    const { owner: o, repo: r } = this.resolveRepo(owner, repo);
    console.log(
      `[GitHub] Fetching comments for issue #${issueNumber} in ${o}/${r}`,
    );
    const response = await this.client.get(
      `/repos/${o}/${r}/issues/${issueNumber}/comments`,
      { params: { per_page: 50 } },
    );
    return response.data;
  }

  async addIssueComment(
    issueNumber: number,
    body: string,
    owner?: string,
    repo?: string,
  ): Promise<any> {
    const { owner: o, repo: r } = this.resolveRepo(owner, repo);
    console.log(
      `[GitHub] Adding comment to issue #${issueNumber} in ${o}/${r}`,
    );
    const response = await this.client.post(
      `/repos/${o}/${r}/issues/${issueNumber}/comments`,
      { body },
    );
    console.log(`[GitHub] Comment added to issue #${issueNumber}`);
    return response.data;
  }

  async listCollaborators(owner?: string, repo?: string): Promise<any[]> {
    const { owner: o, repo: r } = this.resolveRepo(owner, repo);
    console.log(`[GitHub] Fetching collaborators for ${o}/${r}`);
    const response = await this.client.get(`/repos/${o}/${r}/collaborators`, {
      params: { per_page: 100 },
    });
    console.log(`[GitHub] Found ${response.data.length} collaborators`);
    return response.data;
  }

  async listWorkflows(owner?: string, repo?: string): Promise<any[]> {
    const { owner: o, repo: r } = this.resolveRepo(owner, repo);
    console.log(`[GitHub] Fetching workflows for ${o}/${r}`);
    try {
      const response = await this.client.get(
        `/repos/${o}/${r}/actions/workflows`,
      );
      console.log(`[GitHub] Found ${response.data.total_count} workflows`);
      return response.data.workflows;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        console.log(`[GitHub] Actions not available for ${o}/${r}`);
        return [];
      }
      throw error;
    }
  }

  async listWorkflowRuns(
    workflowId?: string | number,
    owner?: string,
    repo?: string,
  ): Promise<any[]> {
    const { owner: o, repo: r } = this.resolveRepo(owner, repo);
    console.log(`[GitHub] Fetching workflow runs for ${o}/${r}`);
    const url = workflowId
      ? `/repos/${o}/${r}/actions/workflows/${workflowId}/runs`
      : `/repos/${o}/${r}/actions/runs`;
    const response = await this.client.get(url, {
      params: { per_page: 20 },
    });
    console.log(`[GitHub] Found ${response.data.total_count} runs`);
    return response.data.workflow_runs;
  }

  async getWorkflowRun(
    runId: number,
    owner?: string,
    repo?: string,
  ): Promise<any> {
    const { owner: o, repo: r } = this.resolveRepo(owner, repo);
    console.log(`[GitHub] Fetching workflow run ${runId} from ${o}/${r}`);
    const response = await this.client.get(
      `/repos/${o}/${r}/actions/runs/${runId}`,
    );
    return response.data;
  }

  async listWorkflowRunJobs(
    runId: number,
    owner?: string,
    repo?: string,
  ): Promise<any[]> {
    const { owner: o, repo: r } = this.resolveRepo(owner, repo);
    console.log(`[GitHub] Fetching jobs for run ${runId} in ${o}/${r}`);
    const response = await this.client.get(
      `/repos/${o}/${r}/actions/runs/${runId}/jobs`,
    );
    return response.data.jobs;
  }

  async reRunWorkflow(
    runId: number,
    owner?: string,
    repo?: string,
  ): Promise<void> {
    const { owner: o, repo: r } = this.resolveRepo(owner, repo);
    console.log(`[GitHub] Re-running workflow ${runId} in ${o}/${r}`);
    await this.client.post(`/repos/${o}/${r}/actions/runs/${runId}/rerun`);
    console.log(`[GitHub] Workflow ${runId} re-run requested`);
  }

  async listReleases(owner?: string, repo?: string): Promise<any[]> {
    const { owner: o, repo: r } = this.resolveRepo(owner, repo);
    console.log(`[GitHub] Fetching releases for ${o}/${r}`);
    const response = await this.client.get(`/repos/${o}/${r}/releases`, {
      params: { per_page: 20 },
    });
    console.log(`[GitHub] Found ${response.data.length} releases`);
    return response.data;
  }

  async createRelease(
    params: {
      tagName: string;
      name?: string;
      body?: string;
      targetCommitish?: string;
      draft?: boolean;
      prerelease?: boolean;
    },
    owner?: string,
    repo?: string,
  ): Promise<any> {
    const { owner: o, repo: r } = this.resolveRepo(owner, repo);
    console.log(`[GitHub] Creating release ${params.tagName} in ${o}/${r}`);
    const body: Record<string, unknown> = {
      tag_name: params.tagName,
      name: params.name || params.tagName,
      body: params.body || "",
      draft: params.draft || false,
      prerelease: params.prerelease || false,
    };
    if (params.targetCommitish) body.target_commitish = params.targetCommitish;

    const response = await this.client.post(`/repos/${o}/${r}/releases`, body);
    console.log(`[GitHub] Release created: ${response.data.html_url}`);
    return response.data;
  }
}

export const githubClient = new GithubClient();
