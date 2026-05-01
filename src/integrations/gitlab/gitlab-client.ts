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

class GitlabClient {
  private client: AxiosInstance;
  private baseUrl: string;
  private token: string;

  constructor() {
    this.baseUrl = env.GITLAB_BASE_URL.replace(/\/$/, ""); // Remove trailing slash
    this.token = env.GITLAB_TOKEN;

    // Create HTTPS agent that accepts self-signed certificates
    // This is common for internal GitLab instances
    const httpsAgent = new https.Agent({
      rejectUnauthorized: false, // Allow self-signed certificates
    });

    // Create axios instance with base configuration
    this.client = axios.create({
      baseURL: this.baseUrl,
      headers: {
        "Content-Type": "application/json",
        "PRIVATE-TOKEN": this.token,
      },
      timeout: 30000, // 30 seconds
      httpsAgent: httpsAgent,
    });
  }

  /**
   * Check if GitLab client is configured
   */
  isConfigured(): boolean {
    return !!this.token && this.token.length > 0;
  }

  /**
   * Validate GitLab configuration
   */
  async validateConfig(): Promise<boolean> {
    if (!this.isConfigured()) {
      return false;
    }

    try {
      // Try to get current user info
      await this.client.get("/api/v4/user");
      return true;
    } catch (error) {
      console.error("[GitLab] Config validation failed:", error);
      return false;
    }
  }

  /**
   * Get current user info
   */
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

  /**
   * Get accessible projects
   */
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

  /**
   * Get merge requests for a project
   */
  async getMergeRequests(
    projectId: number | string,
    state?: "opened" | "closed" | "merged" | "all",
  ): Promise<GitlabMergeRequest[]> {
    if (!this.isConfigured()) {
      throw new Error("GitLab client not configured");
    }

    try {
      console.log(`[GitLab] Fetching MRs for project ${projectId}`);
      const response = await this.client.get(
        `/api/v4/projects/${projectId}/merge_requests`,
        {
          params: {
            state: state || "opened",
            per_page: 100,
            order_by: "created_at",
            sort: "desc",
          },
        },
      );

      const mrs = response.data || [];
      console.log(`[GitLab] Found ${mrs.length} MRs`);
      return mrs;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if (status === 401) {
          throw new Error("GitLab authentication failed.");
        } else if (status === 404) {
          throw new Error(`Project ${projectId} not found or not accessible.`);
        }
      }
      throw new Error(
        `Failed to get MRs: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  /**
   * Get commit details
   */
  async getCommit(
    projectId: number | string,
    sha: string,
  ): Promise<GitlabCommit> {
    if (!this.isConfigured()) {
      throw new Error("GitLab client not configured");
    }

    try {
      console.log(`[GitLab] Fetching commit ${sha} from project ${projectId}`);
      const response = await this.client.get(
        `/api/v4/projects/${projectId}/repository/commits/${sha}`,
      );
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if (status === 404) {
          throw new Error(`Commit ${sha} not found in project ${projectId}`);
        }
      }
      throw new Error(
        `Failed to get commit: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  /**
   * Get commits for a ref (branch/tag)
   */
  async getCommits(
    projectId: number | string,
    ref: string,
    since?: string,
  ): Promise<GitlabCommit[]> {
    if (!this.isConfigured()) {
      throw new Error("GitLab client not configured");
    }

    try {
      console.log(
        `[GitLab] Fetching commits for ref ${ref} in project ${projectId}`,
      );
      const response = await this.client.get(
        `/api/v4/projects/${projectId}/repository/commits`,
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

  /**
   * Add comment to merge request
   */
  async addMergeRequestComment(
    projectId: number | string,
    mrIid: number,
    body: string,
  ): Promise<any> {
    if (!this.isConfigured()) {
      throw new Error("GitLab client not configured");
    }

    try {
      console.log(`[GitLab] Adding comment to MR !${mrIid}`);
      const response = await this.client.post(
        `/api/v4/projects/${projectId}/merge_requests/${mrIid}/notes`,
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
          throw new Error(`MR !${mrIid} not found in project ${projectId}`);
        }
      }
      throw new Error(
        `Failed to add comment: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  /**
   * Get branches for a project
   */
  async getBranches(projectId: number | string): Promise<any[]> {
    if (!this.isConfigured()) {
      throw new Error("GitLab client not configured");
    }

    try {
      console.log(`[GitLab] Fetching branches for project ${projectId}`);
      const response = await this.client.get(
        `/api/v4/projects/${projectId}/repository/branches`,
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
}

export const gitlabClient = new GitlabClient();
