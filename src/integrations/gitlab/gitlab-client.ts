/**
 * GitLab API client
 * Production implementation for GitLab operations
 */

import axios, { AxiosInstance } from "axios";
import * as https from "https";
import { env } from "../../config/env";

export interface GitlabCommit {
  id: string;
  short_id: string;
  title: string;
  message: string;
  author_name: string;
  author_email: string;
  created_at: string;
  project_id: number;
}

export interface GitlabMergeRequest {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  description: string;
  state: string;
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  source_branch: string;
  target_branch: string;
  author: {
    name: string;
    email: string;
    username: string;
  };
  sha?: string;
  web_url: string;
}

export interface GitlabProject {
  id: number;
  name: string;
  name_with_namespace: string;
  path_with_namespace: string;
  web_url: string;
}

export interface GitlabPushEvent {
  object_kind: string;
  event_name: string;
  before: string;
  after: string;
  ref: string;
  ref_type: string;
  project: {
    id: number;
    name: string;
    web_url: string;
  };
  user_username: string;
  user_email: string;
  commits: Array<{
    id: string;
    message: string;
    title: string;
    author: {
      name: string;
      email: string;
    };
    timestamp: string;
  }>;
  total_commits_count: number;
}

export interface GitlabMergeRequestEvent {
  object_kind: string;
  event_type: string;
  user: {
    name: string;
    username: string;
    email: string;
  };
  project: {
    id: number;
    name: string;
    web_url: string;
  };
  object_attributes: {
    id: number;
    iid: number;
    title: string;
    description: string;
    state: string;
    created_at: string;
    updated_at: string;
    merged_at: string | null;
    action: string;
    source_branch: string;
    target_branch: string;
    author: {
      name: string;
      email: string;
    };
    url: string;
    web_url: string;
  };
}

export class GitlabClient {
  private client: AxiosInstance;
  private baseUrl: string;
  private token: string;

  constructor() {
    this.baseUrl = env.GITLAB_BASE_URL.replace(/\/$/, "");
    this.token = env.GITLAB_TOKEN;

    const httpsAgent = new https.Agent({
      rejectUnauthorized: false,
    });

    this.client = axios.create({
      baseURL: this.baseUrl,
      headers: {
        "Content-Type": "application/json",
        "PRIVATE-TOKEN": this.token,
      },
      timeout: 30000,
      httpsAgent: httpsAgent,
    });

    if (this.token) {
      this.client.interceptors.response.use(undefined, async (error) => {
        if (!axios.isAxiosError(error) || !error.config) {
          return Promise.reject(error);
        }

        const status = error.response?.status;
        const configAny = error.config as any;
        const retryCount = configAny.__retryCount || 0;

        if (retryCount >= 3) {
          return Promise.reject(error);
        }

        if (status === 429) {
          const retryAfter = error.response?.headers?.["retry-after"];
          const delay = retryAfter
            ? Number(retryAfter) * 1000
            : Math.min(2000 * Math.pow(2, retryCount), 30000);
          console.warn(
            `[GitLab] Rate limited (429), retrying in ${Math.round(delay)}ms (attempt ${retryCount + 1}/3)`,
          );
          configAny.__retryCount = retryCount + 1;
          await new Promise((resolve) => setTimeout(resolve, delay));
          return this.client.request(error.config!);
        }

        if (status && status >= 500) {
          const delay = Math.min(1000 * Math.pow(2, retryCount), 10000);
          console.warn(
            `[GitLab] Server error (${status}), retrying in ${Math.round(delay)}ms (attempt ${retryCount + 1}/3)`,
          );
          configAny.__retryCount = retryCount + 1;
          await new Promise((resolve) => setTimeout(resolve, delay));
          return this.client.request(error.config!);
        }

        return Promise.reject(error);
      });
    }
  }

  getDefaultProject(): string {
    return env.GITLAB_DEFAULT_PROJECT || "";
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  resolveProjectId(projectId?: string | number | undefined): string | number {
    if (projectId) {
      // Encode namespaced paths (e.g. "hawkio/siem" → "hawkio%2Fsiem") for URL safety
      if (typeof projectId === "string" && projectId.includes("/")) {
        return encodeURIComponent(projectId);
      }
      return projectId;
    }
    const defaultProject = this.getDefaultProject();
    if (!defaultProject) {
      throw new Error(
        "No project specified and GITLAB_DEFAULT_PROJECT is not configured. Either pass a projectId parameter or set GITLAB_DEFAULT_PROJECT in your .env file.",
      );
    }
    return encodeURIComponent(defaultProject);
  }

  isConfigured(): boolean {
    return !!this.token && this.token.length > 0;
  }

  async validateConfig(): Promise<boolean> {
    if (!this.isConfigured()) {
      return false;
    }

    try {
      await this.client.get("/api/v4/user");
      return true;
    } catch (error) {
      console.error("[GitLab] Config validation failed:", error);
      return false;
    }
  }

  async getCurrentUser(): Promise<any> {
    if (!this.isConfigured()) {
      throw new Error("GitLab client not configured");
    }

    try {
      const response = await this.client.get("/api/v4/user");
      return response.data;
    } catch (error) {
      throw new Error(
        `Failed to get current user: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  async getProject(
    projectId: string | number,
  ): Promise<GitlabProject & { default_branch: string; topics: string[] }> {
    if (!this.isConfigured()) {
      throw new Error("GitLab client not configured");
    }

    const resolvedId =
      typeof projectId === "string"
        ? encodeURIComponent(projectId)
        : projectId;

    try {
      console.log(`[GitLab] Fetching project ${resolvedId}`);
      const response = await this.client.get(`/api/v4/projects/${resolvedId}`);
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if (status === 404) {
          throw new Error(`Project ${resolvedId ?? projectId} not found or not accessible.`);
        }
      }
      throw new Error(
        `Failed to get project: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  async getProjects(): Promise<GitlabProject[]> {
    if (!this.isConfigured()) {
      throw new Error("GitLab client not configured");
    }

    try {
      console.log("[GitLab] Fetching projects");
      const response = await this.client.get("/api/v4/projects", {
        params: {
          membership: true,
          per_page: 100,
          order_by: "last_activity_at",
          sort: "desc",
        },
      });

      const projects = response.data || [];
      console.log(`[GitLab] Found ${projects.length} projects`);
      return projects;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if (status === 401) {
          throw new Error("GitLab authentication failed. Check your token.");
        }
      }
      throw new Error(
        `Failed to get projects: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  async getMergeRequests(
    projectId?: number | string,
    state?: "opened" | "closed" | "merged" | "all",
  ): Promise<GitlabMergeRequest[]> {
    if (!this.isConfigured()) {
      throw new Error("GitLab client not configured");
    }

    const resolvedId = this.resolveProjectId(projectId);

    try {
      console.log(`[GitLab] Fetching MRs for project ${resolvedId}`);
      const allMrs: any[] = [];
      let page = 1;
      let hasMore = true;
      while (hasMore) {
        const response = await this.client.get(
          `/api/v4/projects/${resolvedId}/merge_requests`,
          {
            params: {
              state: state || "opened",
              per_page: 100,
              page,
              order_by: "created_at",
              sort: "desc",
            },
          },
        );
        const batch = response.data || [];
        allMrs.push(...batch);
        hasMore = batch.length === 100;
        page++;
      }
      console.log(`[GitLab] Found ${allMrs.length} MRs`);
      return allMrs;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if (status === 401) {
          throw new Error("GitLab authentication failed.");
        } else if (status === 404) {
          throw new Error(`Project ${resolvedId} not found or not accessible.`);
        }
      }
      throw new Error(
        `Failed to get MRs: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  async getMergeRequest(
    projectId: number | string | undefined,
    mrIid: number,
  ): Promise<GitlabMergeRequest> {
    if (!this.isConfigured()) {
      throw new Error("GitLab client not configured");
    }

    const resolvedId = this.resolveProjectId(projectId);

    try {
      console.log(`[GitLab] Fetching MR !${mrIid}`);
      const response = await this.client.get(
        `/api/v4/projects/${resolvedId}/merge_requests/${mrIid}`,
      );
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if (status === 404) {
          throw new Error(`MR !${mrIid} not found in project ${resolvedId}`);
        }
      }
      throw new Error(
        `Failed to get MR: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  async createMergeRequest(
    projectId: number | string | undefined,
    params: {
      sourceBranch: string;
      targetBranch: string;
      title: string;
      description?: string;
      labels?: string;
      removeSourceBranch?: boolean;
      squash?: boolean;
    },
  ): Promise<GitlabMergeRequest> {
    if (!this.isConfigured()) {
      throw new Error("GitLab client not configured");
    }

    const resolvedId = this.resolveProjectId(projectId);

    try {
      console.log(
        `[GitLab] Creating MR: ${params.sourceBranch} -> ${params.targetBranch}`,
      );
      const response = await this.client.post(
        `/api/v4/projects/${resolvedId}/merge_requests`,
        {
          source_branch: params.sourceBranch,
          target_branch: params.targetBranch,
          title: params.title,
          description: params.description || "",
          labels: params.labels || "",
          remove_source_branch: params.removeSourceBranch ?? false,
          squash: params.squash ?? false,
        },
      );
      console.log(
        `[GitLab] MR !${response.data.iid} created: ${response.data.web_url}`,
      );
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const data = error.response?.data as any;
        if (status === 409) {
          throw new Error(
            `Merge request already exists: ${data?.message || "conflict"}`,
          );
        } else if (status === 400) {
          throw new Error(
            `Invalid MR data: ${data?.message?.join(", ") || "bad request"}`,
          );
        }
      }
      throw new Error(
        `Failed to create MR: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  async acceptMergeRequest(
    projectId: number | string | undefined,
    mrIid: number,
    options?: {
      squashCommitMessage?: string;
      shouldRemoveSourceBranch?: boolean;
      mergeWhenPipelineSucceeds?: boolean;
    },
  ): Promise<GitlabMergeRequest> {
    if (!this.isConfigured()) {
      throw new Error("GitLab client not configured");
    }

    const resolvedId = this.resolveProjectId(projectId);

    try {
      console.log(`[GitLab] Accepting MR !${mrIid}`);
      const body: Record<string, unknown> = {};
      if (options?.squashCommitMessage)
        body.squash_commit_message = options.squashCommitMessage;
      if (options?.shouldRemoveSourceBranch !== undefined)
        body.should_remove_source_branch = options.shouldRemoveSourceBranch;
      if (options?.mergeWhenPipelineSucceeds !== undefined)
        body.merge_when_pipeline_succeeds = options.mergeWhenPipelineSucceeds;

      const response = await this.client.put(
        `/api/v4/projects/${resolvedId}/merge_requests/${mrIid}/merge`,
        body,
      );
      console.log(`[GitLab] MR !${mrIid} merged`);
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const data = error.response?.data as any;
        if (status === 405) {
          throw new Error(
            `Cannot merge MR !${mrIid}: ${data?.message || "merge not allowed"}`,
          );
        } else if (status === 406) {
          throw new Error(
            `MR !${mrIid} merge conflict: ${data?.message || "conflict"}`,
          );
        }
      }
      throw new Error(
        `Failed to merge MR: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  async rebaseMergeRequest(
    projectId: number | string | undefined,
    mrIid: number,
  ): Promise<{ rebaseInProgress: boolean }> {
    if (!this.isConfigured()) {
      throw new Error("GitLab client not configured");
    }

    const resolvedId = this.resolveProjectId(projectId);

    try {
      console.log(`[GitLab] Rebasing MR !${mrIid}`);
      const response = await this.client.put(
        `/api/v4/projects/${resolvedId}/merge_requests/${mrIid}/rebase`,
      );
      console.log(`[GitLab] MR !${mrIid} rebase initiated`);
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const data = error.response?.data as any;
        if (status === 405) {
          throw new Error(
            `Cannot rebase MR !${mrIid}: ${data?.message || "rebase not allowed"}`,
          );
        } else if (status === 409) {
          throw new Error(
            `MR !${mrIid} rebase conflict: ${data?.message || "conflict during rebase"}`,
          );
        }
      }
      throw new Error(
        `Failed to rebase MR: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  async getMergeRequestStatus(
    projectId: number | string | undefined,
    mrIid: number,
  ): Promise<{
    mergeStatus: string;
    conflicts?: boolean;
    pipelineStatus?: string;
  }> {
    if (!this.isConfigured()) {
      throw new Error("GitLab client not configured");
    }

    const resolvedId = this.resolveProjectId(projectId);

    try {
      const response = await this.client.get(
        `/api/v4/projects/${resolvedId}/merge_requests/${mrIid}`,
      );
      const mr = response.data;
      return {
        mergeStatus: mr.merge_status || "unknown",
        conflicts: mr.merge_status === "cannot_be_merged",
        pipelineStatus: mr.head_pipeline?.status,
      };
    } catch (error) {
      throw new Error(
        `Failed to get MR status: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  async getCommit(
    projectId: number | string | undefined,
    sha: string,
  ): Promise<GitlabCommit> {
    if (!this.isConfigured()) {
      throw new Error("GitLab client not configured");
    }

    const resolvedId = this.resolveProjectId(projectId);

    try {
      console.log(`[GitLab] Fetching commit ${sha} from project ${resolvedId}`);
      const response = await this.client.get(
        `/api/v4/projects/${resolvedId}/repository/commits/${sha}`,
      );
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if (status === 404) {
          throw new Error(`Commit ${sha} not found in project ${resolvedId}`);
        }
      }
      throw new Error(
        `Failed to get commit: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  async getCommits(
    projectId: number | string | undefined,
    ref: string,
    since?: string,
  ): Promise<GitlabCommit[]> {
    if (!this.isConfigured()) {
      throw new Error("GitLab client not configured");
    }

    const resolvedId = this.resolveProjectId(projectId);

    try {
      console.log(
        `[GitLab] Fetching commits for ref ${ref} in project ${resolvedId}`,
      );
      const response = await this.client.get(
        `/api/v4/projects/${resolvedId}/repository/commits`,
        {
          params: {
            ref_name: ref,
            since: since,
            per_page: 100,
          },
        },
      );

      const commits = response.data || [];
      console.log(`[GitLab] Found ${commits.length} commits`);
      return commits;
    } catch (error) {
      throw new Error(
        `Failed to get commits: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  async addMergeRequestComment(
    projectId: number | string | undefined,
    mrIid: number,
    body: string,
  ): Promise<any> {
    if (!this.isConfigured()) {
      throw new Error("GitLab client not configured");
    }

    const resolvedId = this.resolveProjectId(projectId);

    try {
      console.log(`[GitLab] Adding comment to MR !${mrIid}`);
      const response = await this.client.post(
        `/api/v4/projects/${resolvedId}/merge_requests/${mrIid}/notes`,
        {
          body,
        },
      );
      console.log(`[GitLab] Comment added to MR !${mrIid}`);
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if (status === 404) {
          throw new Error(`MR !${mrIid} not found in project ${resolvedId}`);
        }
      }
      throw new Error(
        `Failed to add comment: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  async getBranches(projectId: number | string | undefined): Promise<any[]> {
    if (!this.isConfigured()) {
      throw new Error("GitLab client not configured");
    }

    const resolvedId = this.resolveProjectId(projectId);

    try {
      console.log(`[GitLab] Fetching branches for project ${resolvedId}`);
      const response = await this.client.get(
        `/api/v4/projects/${resolvedId}/repository/branches`,
        {
          params: {
            per_page: 100,
          },
        },
      );

      const branches = response.data || [];
      console.log(`[GitLab] Found ${branches.length} branches`);
      return branches;
    } catch (error) {
      throw new Error(
        `Failed to get branches: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  async listPipelines(
    projectId: number | string | undefined,
    ref?: string,
  ): Promise<any[]> {
    if (!this.isConfigured()) {
      throw new Error("GitLab client not configured");
    }

    const resolvedId = this.resolveProjectId(projectId);

    try {
      console.log(`[GitLab] Fetching pipelines for project ${resolvedId}`);
      const params: Record<string, unknown> = {
        per_page: 20,
        order_by: "id",
        sort: "desc",
      };
      if (ref) params.ref = ref;

      const response = await this.client.get(
        `/api/v4/projects/${resolvedId}/pipelines`,
        { params },
      );
      const pipelines = response.data || [];
      console.log(`[GitLab] Found ${pipelines.length} pipelines`);
      return pipelines;
    } catch (error) {
      throw new Error(
        `Failed to get pipelines: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  async getFile(
    projectId: number | string | undefined,
    filePath: string,
    ref?: string,
  ): Promise<{
    fileName: string;
    filePath: string;
    content: string;
    size: number;
    encoding: string;
  }> {
    if (!this.isConfigured()) {
      throw new Error("GitLab client not configured");
    }

    const resolvedId = this.resolveProjectId(projectId);

    try {
      const encodedPath = encodeURIComponent(filePath);
      console.log(
        `[GitLab] Fetching file ${filePath} from project ${resolvedId}`,
      );
      const params: Record<string, unknown> = {};
      if (ref) params.ref = ref;

      const response = await this.client.get(
        `/api/v4/projects/${resolvedId}/repository/files/${encodedPath}`,
        { params },
      );
      return {
        fileName: response.data.file_name,
        filePath: response.data.file_path,
        content: response.data.content,
        size: response.data.size,
        encoding: response.data.encoding,
      };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if (status === 404) {
          throw new Error(`File ${filePath} not found in project ${resolvedId}`);
        }
      }
      throw new Error(
        `Failed to get file: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  async getRepositoryTree(
    projectId: number | string | undefined,
    path?: string,
    ref?: string,
    recursive?: boolean,
  ): Promise<
    Array<{
      id: string;
      name: string;
      type: "tree" | "blob";
      path: string;
      mode: string;
    }>
  > {
    if (!this.isConfigured()) {
      throw new Error("GitLab client not configured");
    }

    const resolvedId = this.resolveProjectId(projectId);

    try {
      console.log(
        `[GitLab] Fetching repository tree${path ? ` at ${path}` : ""} from project ${resolvedId}`,
      );
      const params: Record<string, unknown> = {
        per_page: 100,
      };
      if (path) params.path = path;
      if (ref) params.ref = ref;
      if (recursive) params.recursive = true;

      // Paginate to get all results (GitLab caps at 100 per page)
      const allItems: Array<{
        id: string;
        name: string;
        type: "tree" | "blob";
        path: string;
        mode: string;
      }> = [];
      let page = 1;
      let hasMore = true;

      while (hasMore) {
        const response = await this.client.get(
          `/api/v4/projects/${resolvedId}/repository/tree`,
          { params: { ...params, page, per_page: 100 } },
        );

        const items = response.data || [];
        allItems.push(...items);

        // GitLab returns X-Next-Page header when more pages exist
        const nextPage = response.headers?.["x-next-page"];
        if (nextPage && items.length === 100) {
          page = parseInt(nextPage, 10);
        } else {
          hasMore = false;
        }
      }

      console.log(`[GitLab] Found ${allItems.length} items in repository tree`);
      return allItems;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if (status === 404) {
          throw new Error(`Repository tree not found for project ${resolvedId}`);
        }
      }
      throw new Error(
        `Failed to get repository tree: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  async searchCode(
    projectId: number | string | undefined,
    search: string,
    ref?: string,
  ): Promise<
    Array<{
      ref: string;
      path: string;
      filename: string;
      startline: number;
      data: string;
    }>
  > {
    if (!this.isConfigured()) {
      throw new Error("GitLab client not configured");
    }

    const resolvedId = this.resolveProjectId(projectId);

    try {
      console.log(
        `[GitLab] Searching code for "${search}" in project ${resolvedId}`,
      );
      const params: Record<string, unknown> = {
        search,
        per_page: 20,
      };
      if (ref) params.ref = ref;

      const response = await this.client.get(
        `/api/v4/projects/${resolvedId}/search`,
        { params: { ...params, scope: "blobs" } },
      );

      const results = (response.data || []).map((item: any) => ({
        ref: item.ref,
        path: item.path,
        filename: item.filename,
        startline: item.startline,
        data: item.data,
      }));
      console.log(`[GitLab] Found ${results.length} search results`);
      return results;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if (status === 404) {
          throw new Error(`Project ${resolvedId} not found`);
        }
      }
      throw new Error(
        `Failed to search code: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }
  async createBranch(
    projectId: number | string | undefined,
    branchName: string,
    ref: string,
  ): Promise<any> {
    if (!this.isConfigured()) {
      throw new Error("GitLab client not configured");
    }

    const resolvedId = this.resolveProjectId(projectId);

    try {
      console.log(
        `[GitLab] Creating branch ${branchName} from ${ref} in project ${resolvedId}`,
      );
      const response = await this.client.post(
        `/api/v4/projects/${resolvedId}/repository/branches`,
        {
          branch: branchName,
          ref,
        },
      );
      console.log(`[GitLab] Branch ${branchName} created`);
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const data = error.response?.data as any;
        if (status === 400) {
          throw new Error(
            `Failed to create branch: ${data?.message || "bad request"}`,
          );
        } else if (status === 409) {
          throw new Error(`Branch ${branchName} already exists`);
        }
      }
      throw new Error(
        `Failed to create branch: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  async getMergeRequestChanges(
    projectId: number | string | undefined,
    mrIid: number,
  ): Promise<{
    iid: number;
    title: string;
    changes: Array<{
      old_path: string;
      new_path: string;
      diff: string;
      new_file: boolean;
      deleted_file: boolean;
      renamed_file: boolean;
    }>;
  }> {
    if (!this.isConfigured()) {
      throw new Error("GitLab client not configured");
    }

    const resolvedId = this.resolveProjectId(projectId);

    try {
      console.log(
        `[GitLab] Fetching changes for MR !${mrIid} in project ${resolvedId}`,
      );
      const response = await this.client.get(
        `/api/v4/projects/${resolvedId}/merge_requests/${mrIid}/changes`,
      );
      const data = response.data;
      return {
        iid: data.iid,
        title: data.title,
        changes: (data.changes || []).map((c: any) => ({
          old_path: c.old_path,
          new_path: c.new_path,
          diff: c.diff,
          new_file: c.new_file,
          deleted_file: c.deleted_file,
          renamed_file: c.renamed_file,
        })),
      };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if (status === 404) {
          throw new Error(`MR !${mrIid} not found`);
        }
      }
      throw new Error(
        `Failed to get MR changes: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  async listMergeRequestNotes(
    projectId: number | string | undefined,
    mrIid: number,
    sort?: "asc" | "desc",
  ): Promise<
    Array<{
      id: number;
      body: string;
      author: { name: string; username: string };
      created_at: string;
      system: boolean;
    }>
  > {
    if (!this.isConfigured()) {
      throw new Error("GitLab client not configured");
    }

    const resolvedId = this.resolveProjectId(projectId);

    try {
      console.log(
        `[GitLab] Fetching notes for MR !${mrIid} in project ${resolvedId}`,
      );
      const allNotes: any[] = [];
      let page = 1;
      let hasMore = true;
      while (hasMore) {
        const response = await this.client.get(
          `/api/v4/projects/${resolvedId}/merge_requests/${mrIid}/notes`,
          {
            params: {
              sort: sort || "desc",
              per_page: 100,
              page,
            },
          },
        );
        const batch = response.data || [];
        allNotes.push(...batch);
        hasMore = batch.length === 100;
        page++;
      }
      const notes = allNotes.filter((n: any) => !n.system);
      console.log(`[GitLab] Found ${notes.length} notes for MR !${mrIid}`);
      return notes.map((n: any) => ({
        id: n.id,
        body: n.body,
        author: { name: n.author?.name, username: n.author?.username },
        created_at: n.created_at,
        system: n.system,
      }));
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if (status === 404) {
          throw new Error(`MR !${mrIid} not found`);
        }
      }
      throw new Error(
        `Failed to get MR notes: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  async createFile(
    projectId: number | string | undefined,
    filePath: string,
    content: string,
    commitMessage: string,
    branch: string,
    encoding?: "text" | "base64",
  ): Promise<any> {
    if (!this.isConfigured()) {
      throw new Error("GitLab client not configured");
    }

    const resolvedId = this.resolveProjectId(projectId);

    try {
      const encodedPath = encodeURIComponent(filePath);
      console.log(
        `[GitLab] Creating file ${filePath} on ${branch} in project ${resolvedId}`,
      );
      const response = await this.client.post(
        `/api/v4/projects/${resolvedId}/repository/files/${encodedPath}`,
        {
          content,
          commit_message: commitMessage,
          branch,
          encoding: encoding || "text",
        },
      );
      console.log(`[GitLab] File ${filePath} created`);
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const data = error.response?.data as any;
        if (status === 400) {
          throw new Error(
            `Failed to create file: ${data?.message || "bad request"}`,
          );
        } else if (status === 409) {
          throw new Error(`File ${filePath} already exists on ${branch}`);
        }
      }
      throw new Error(
        `Failed to create file: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  async updateFile(
    projectId: number | string | undefined,
    filePath: string,
    content: string,
    commitMessage: string,
    branch: string,
    encoding?: "text" | "base64",
  ): Promise<any> {
    if (!this.isConfigured()) {
      throw new Error("GitLab client not configured");
    }

    const resolvedId = this.resolveProjectId(projectId);

    try {
      const encodedPath = encodeURIComponent(filePath);
      console.log(
        `[GitLab] Updating file ${filePath} on ${branch} in project ${resolvedId}`,
      );
      const response = await this.client.put(
        `/api/v4/projects/${resolvedId}/repository/files/${encodedPath}`,
        {
          content,
          commit_message: commitMessage,
          branch,
          encoding: encoding || "text",
        },
      );
      console.log(`[GitLab] File ${filePath} updated`);
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const data = error.response?.data as any;
        if (status === 404) {
          throw new Error(`File ${filePath} not found on ${branch}`);
        } else if (status === 400) {
          throw new Error(
            `Failed to update file: ${data?.message || "bad request"}`,
          );
        }
      }
      throw new Error(
        `Failed to update file: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  async listIssues(
    projectId: number | string | undefined,
    state?: "opened" | "closed" | "all",
    labels?: string,
    milestone?: string,
  ): Promise<any[]> {
    if (!this.isConfigured()) {
      throw new Error("GitLab client not configured");
    }

    const resolvedId = this.resolveProjectId(projectId);

    try {
      console.log(`[GitLab] Fetching issues for project ${resolvedId}`);
      const params: Record<string, unknown> = {
        per_page: 50,
        order_by: "updated_at",
        sort: "desc",
      };
      if (state) params.state = state;
      if (labels) params.labels = labels;
      if (milestone) params.milestone = milestone;

      const response = await this.client.get(
        `/api/v4/projects/${resolvedId}/issues`,
        { params },
      );
      const issues = response.data || [];
      console.log(`[GitLab] Found ${issues.length} issues`);
      return issues;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if (status === 404) {
          throw new Error(`Project ${resolvedId} not found`);
        }
      }
      throw new Error(
        `Failed to list issues: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  async getIssue(
    projectId: number | string | undefined,
    issueIid: number,
  ): Promise<any> {
    if (!this.isConfigured()) {
      throw new Error("GitLab client not configured");
    }

    const resolvedId = this.resolveProjectId(projectId);

    try {
      console.log(
        `[GitLab] Fetching issue #${issueIid} from project ${resolvedId}`,
      );
      const response = await this.client.get(
        `/api/v4/projects/${resolvedId}/issues/${issueIid}`,
      );
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if (status === 404) {
          throw new Error(`Issue #${issueIid} not found`);
        }
      }
      throw new Error(
        `Failed to get issue: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  async createIssue(
    projectId: number | string | undefined,
    params: {
      title: string;
      description?: string;
      labels?: string;
      assigneeIds?: number[];
      milestoneId?: number;
      dueDate?: string;
    },
  ): Promise<any> {
    if (!this.isConfigured()) {
      throw new Error("GitLab client not configured");
    }

    const resolvedId = this.resolveProjectId(projectId);

    try {
      console.log(
        `[GitLab] Creating issue: ${params.title} in project ${resolvedId}`,
      );
      const body: Record<string, unknown> = {
        title: params.title,
        description: params.description || "",
      };
      if (params.labels) body.labels = params.labels;
      if (params.assigneeIds) body.assignee_ids = params.assigneeIds;
      if (params.milestoneId) body.milestone_id = params.milestoneId;
      if (params.dueDate) body.due_date = params.dueDate;

      const response = await this.client.post(
        `/api/v4/projects/${resolvedId}/issues`,
        body,
      );
      console.log(
        `[GitLab] Issue #${response.data.iid} created: ${response.data.web_url}`,
      );
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const data = error.response?.data as any;
        if (status === 400) {
          throw new Error(
            `Failed to create issue: ${data?.message?.join(", ") || "bad request"}`,
          );
        }
      }
      throw new Error(
        `Failed to create issue: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  async editIssue(
    projectId: number | string | undefined,
    issueIid: number,
    params: {
      labels?: string;
      description?: string;
      title?: string;
      stateEvent?: "close" | "reopen";
    },
  ): Promise<any> {
    if (!this.isConfigured()) {
      throw new Error("GitLab client not configured");
    }

    const resolvedId = this.resolveProjectId(projectId);

    try {
      console.log(
        `[GitLab] Updating issue #${issueIid} in project ${resolvedId}`,
      );
      const body: Record<string, unknown> = {};
      if (params.labels) body.labels = params.labels;
      if (params.description) body.description = params.description;
      if (params.title) body.title = params.title;
      if (params.stateEvent) body.state_event = params.stateEvent;

      const response = await this.client.put(
        `/api/v4/projects/${resolvedId}/issues/${issueIid}`,
        body,
      );
      console.log(`[GitLab] Issue #${issueIid} updated`);
      return response.data;
    } catch (error) {
      throw new Error(
        `Failed to update issue #${issueIid}: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  async listProjectMembers(projectId: number | string | undefined): Promise<
    Array<{
      id: number;
      name: string;
      username: string;
      access_level: number;
      avatar_url: string;
    }>
  > {
    if (!this.isConfigured()) {
      throw new Error("GitLab client not configured");
    }

    const resolvedId = this.resolveProjectId(projectId);

    try {
      console.log(`[GitLab] Fetching members for project ${resolvedId}`);
      const response = await this.client.get(
        `/api/v4/projects/${resolvedId}/members`,
        { params: { per_page: 100 } },
      );
      const members = (response.data || []).map((m: any) => ({
        id: m.id,
        name: m.name,
        username: m.username,
        access_level: m.access_level,
        avatar_url: m.avatar_url,
      }));
      console.log(`[GitLab] Found ${members.length} members`);
      return members;
    } catch (error) {
      throw new Error(
        `Failed to list members: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  async listTags(projectId: number | string | undefined): Promise<any[]> {
    if (!this.isConfigured()) {
      throw new Error("GitLab client not configured");
    }

    const resolvedId = this.resolveProjectId(projectId);

    try {
      console.log(`[GitLab] Fetching tags for project ${resolvedId}`);
      const response = await this.client.get(
        `/api/v4/projects/${resolvedId}/repository/tags`,
        { params: { per_page: 50, order_by: "updated", sort: "desc" } },
      );
      const tags = response.data || [];
      console.log(`[GitLab] Found ${tags.length} tags`);
      return tags;
    } catch (error) {
      throw new Error(
        `Failed to list tags: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  async getPipeline(
    projectId: number | string | undefined,
    pipelineId: number,
  ): Promise<any> {
    if (!this.isConfigured()) {
      throw new Error("GitLab client not configured");
    }

    const resolvedId = this.resolveProjectId(projectId);

    try {
      console.log(
        `[GitLab] Fetching pipeline ${pipelineId} from project ${resolvedId}`,
      );
      const response = await this.client.get(
        `/api/v4/projects/${resolvedId}/pipelines/${pipelineId}`,
      );
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if (status === 404) {
          throw new Error(`Pipeline ${pipelineId} not found`);
        }
      }
      throw new Error(
        `Failed to get pipeline: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  async listPipelineJobs(
    projectId: number | string | undefined,
    pipelineId: number,
  ): Promise<any[]> {
    if (!this.isConfigured()) {
      throw new Error("GitLab client not configured");
    }

    const resolvedId = this.resolveProjectId(projectId);

    try {
      console.log(
        `[GitLab] Fetching jobs for pipeline ${pipelineId} in project ${resolvedId}`,
      );
      const response = await this.client.get(
        `/api/v4/projects/${resolvedId}/pipelines/${pipelineId}/jobs`,
      );
      const jobs = response.data || [];
      console.log(`[GitLab] Found ${jobs.length} jobs`);
      return jobs;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if (status === 404) {
          throw new Error(`Pipeline ${pipelineId} not found`);
        }
      }
      throw new Error(
        `Failed to list pipeline jobs: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  async retryPipeline(
    projectId: number | string | undefined,
    pipelineId: number,
  ): Promise<any> {
    if (!this.isConfigured()) {
      throw new Error("GitLab client not configured");
    }

    const resolvedId = this.resolveProjectId(projectId);

    try {
      console.log(
        `[GitLab] Retrying pipeline ${pipelineId} in project ${resolvedId}`,
      );
      const response = await this.client.post(
        `/api/v4/projects/${resolvedId}/pipelines/${pipelineId}/retry`,
      );
      console.log(`[GitLab] Pipeline ${pipelineId} retried`);
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if (status === 404) {
          throw new Error(`Pipeline ${pipelineId} not found`);
        } else if (status === 400) {
          throw new Error(`Pipeline ${pipelineId} cannot be retried`);
        }
      }
      throw new Error(
        `Failed to retry pipeline: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  async compareRefs(
    projectId: number | string | undefined,
    from: string,
    to: string,
  ): Promise<{
    commits: Array<{ id: string; title: string; author_name: string }>;
    diffs: Array<{
      old_path: string;
      new_path: string;
      new_file: boolean;
      deleted_file: boolean;
    }>;
  }> {
    if (!this.isConfigured()) {
      throw new Error("GitLab client not configured");
    }

    const resolvedId = this.resolveProjectId(projectId);

    try {
      console.log(
        `[GitLab] Comparing ${from}...${to} in project ${resolvedId}`,
      );
      const response = await this.client.get(
        `/api/v4/projects/${resolvedId}/repository/compare`,
        { params: { from, to } },
      );
      const data = response.data;
      return {
        commits: (data.commits || []).map((c: any) => ({
          id: c.id,
          title: c.title,
          author_name: c.author_name,
        })),
        diffs: (data.diffs || []).map((d: any) => ({
          old_path: d.old_path,
          new_path: d.new_path,
          new_file: d.new_file,
          deleted_file: d.deleted_file,
        })),
      };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if (status === 404) {
          throw new Error(`Refs ${from} or ${to} not found`);
        }
      }
      throw new Error(
        `Failed to compare refs: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  async getFileBlame(
    projectId: number | string | undefined,
    filePath: string,
    ref?: string,
  ): Promise<
    Array<{
      commit: {
        id: string;
        message: string;
        author_name: string;
        authored_date: string;
      };
      lines: string[];
    }>
  > {
    if (!this.isConfigured()) {
      throw new Error("GitLab client not configured");
    }

    const resolvedId = this.resolveProjectId(projectId);

    try {
      const encodedPath = encodeURIComponent(filePath);
      console.log(
        `[GitLab] Fetching blame for ${filePath} in project ${resolvedId}`,
      );
      const params: Record<string, unknown> = {};
      if (ref) params.ref = ref;

      const response = await this.client.get(
        `/api/v4/projects/${resolvedId}/repository/files/${encodedPath}/blame`,
        { params },
      );
      return (response.data || []).map((b: any) => ({
        commit: {
          id: b.commit?.id,
          message: b.commit?.message,
          author_name: b.commit?.author_name,
          authored_date: b.commit?.authored_date,
        },
        lines: b.lines || [],
      }));
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if (status === 404) {
          throw new Error(`File ${filePath} not found`);
        }
      }
      throw new Error(
        `Failed to get blame: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }
}

export const gitlabClient = new GitlabClient();
