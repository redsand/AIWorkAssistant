/**
 * Jira REST API client
 * Production implementation for Jira Cloud
 */

import axios, { AxiosInstance } from "axios";
import { env } from "../../config/env";

export interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary: string;
    description?: any;
    status: {
      name: string;
      id: string;
    };
    assignee?: {
      displayName: string;
      emailAddress: string;
    } | null;
    priority: {
      name: string;
      id: string;
    };
    issuetype: {
      name: string;
      id: string;
    };
    created: string;
    updated: string;
    project: {
      key: string;
      name: string;
    };
  };
}

export interface JiraComment {
  id: string;
  body: any;
  created: string;
  author: {
    displayName: string;
    emailAddress: string;
  };
}

export interface JiraTransition {
  id: string;
  name: string;
  to: {
    name: string;
    id: string;
  };
}

export interface JiraUser {
  displayName: string;
  emailAddress: string;
  accountId: string;
}

export interface JiraProject {
  key: string;
  name: string;
  id: string;
  projectTypeKey: string;
  style: string;
}

export class JiraClient {
  private client: AxiosInstance;
  private baseUrl: string;
  private email: string;
  private apiToken: string;

  constructor() {
    this.baseUrl = env.JIRA_BASE_URL.replace(/\/$/, "");
    this.email = env.JIRA_EMAIL;
    this.apiToken = env.JIRA_API_TOKEN;

    this.client = axios.create({
      baseURL: this.baseUrl,
      auth: {
        username: this.email,
        password: this.apiToken,
      },
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    });
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * Check if Jira client is configured
   */
  isConfigured(): boolean {
    return !!this.email && !!this.email.includes("@") && !!this.apiToken;
  }

  /**
   * Validate Jira configuration
   */
  async validateConfig(): Promise<boolean> {
    if (!this.isConfigured()) {
      return false;
    }

    try {
      // Try to get current user info
      await this.client.get("/rest/api/3/myself");
      return true;
    } catch (error) {
      console.error("[Jira] Config validation failed:", error);
      return false;
    }
  }

  /**
   * Get issue by key
   */
  async getIssue(key: string): Promise<JiraIssue> {
    if (!this.isConfigured()) {
      throw new Error("Jira client not configured");
    }

    try {
      console.log(`[Jira] Fetching issue: ${key}`);
      const response = await this.client.get(`/rest/api/3/issue/${key}`);
      console.log(
        `[Jira] Issue ${key} retrieved: ${response.data.fields.summary}`,
      );
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if (status === 404) {
          throw new Error(`Jira issue ${key} not found`);
        } else if (status === 401) {
          throw new Error(
            "Jira authentication failed. Check your credentials.",
          );
        } else if (status === 403) {
          throw new Error(`Jira permission denied for issue ${key}`);
        }
      }
      throw new Error(
        `Failed to get Jira issue ${key}: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  /**
   * Search issues with JQL
   */
  async searchIssues(
    jql: string,
    maxResults: number = 50,
  ): Promise<JiraIssue[]> {
    if (!this.isConfigured()) {
      throw new Error("Jira client not configured");
    }

    try {
      console.log(`[Jira] Searching issues: ${jql}`);

      const response = await this.client.post("/rest/api/3/search/jql", {
        jql,
        maxResults,
        fields: [
          "summary",
          "status",
          "assignee",
          "priority",
          "issuetype",
          "created",
          "updated",
          "project",
        ],
      });

      const issues = response.data.issues || [];
      console.log(`[Jira] Found ${issues.length} issues`);
      return issues;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const data = error.response?.data as any;

        if (status === 400) {
          const errors = data?.errors || {};
          const errorMessages = data?.errorMessages || [];
          const details = [
            ...Object.entries(errors).map(([k, v]) => `${k}: ${v}`),
            ...errorMessages,
          ].join("; ");
          throw new Error(`Invalid JQL query: ${details || "Invalid JQL syntax"}`);
        } else if (status === 401) {
          throw new Error(
            "Jira authentication failed. Check your credentials.",
          );
        }
      }
      throw new Error(
        `Failed to search Jira issues: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  /**
   * Get issues assigned to user
   */
  async getAssignedIssues(status?: string): Promise<JiraIssue[]> {
    if (!this.isConfigured()) {
      throw new Error("Jira client not configured");
    }

    try {
      // Get current user first
      const user = await this.getCurrentUser();

      // Try using JQL first
      try {
        let jql = `assignee = "${user.accountId}"`;
        if (status) {
          jql += ` AND status = "${status}"`;
        } else {
          // Default: exclude completed issues so they don't appear in planner/calendar views
          jql += ` AND statusCategory != Done`;
        }
        jql += " ORDER BY created DESC";

        console.log("[Jira] Fetching assigned issues via JQL");
        return await this.searchIssues(jql, 50);
      } catch (jqlError) {
        // Fallback: Try to get issues from each project
        console.log("[Jira] JQL failed, trying project-based approach");

        const projects = await this.getProjects();
        const allIssues: JiraIssue[] = [];

        for (const project of projects) {
          try {
            const response = await this.client.get(
              `/rest/api/2/issue/${project.key}`,
              {
                params: {
                  jql: `assignee = "${user.accountId}"`,
                  maxResults: 50,
                  fields: [
                    "summary",
                    "status",
                    "assignee",
                    "priority",
                    "issuetype",
                    "created",
                    "updated",
                    "project",
                  ],
                },
              },
            );

            if (response.data.issues) {
              allIssues.push(...response.data.issues);
            }
          } catch (projectError) {
            // Skip projects we can't access
            console.log(
              `[Jira] Skipping project ${project.key}:`,
              (projectError as Error).message,
            );
          }
        }

        return allIssues;
      }
    } catch (error) {
      throw new Error(
        `Failed to get assigned issues: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  /**
   * Add comment to issue
   */
  async addComment(key: string, body: string): Promise<JiraComment> {
    if (!this.isConfigured()) {
      throw new Error("Jira client not configured");
    }

    try {
      console.log(`[Jira] Adding comment to ${key}`);
      const response = await this.client.post(
        `/rest/api/3/issue/${key}/comment`,
        {
          body: {
            type: "doc",
            version: 1,
            content: [
              {
                type: "paragraph",
                content: [
                  {
                    type: "text",
                    text: body,
                  },
                ],
              },
            ],
          },
        },
      );

      console.log(`[Jira] Comment added to ${key}`);
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if (status === 404) {
          throw new Error(`Jira issue ${key} not found`);
        } else if (status === 403) {
          throw new Error(`No permission to comment on issue ${key}`);
        }
      }
      throw new Error(
        `Failed to add comment to ${key}: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  async getComments(
    key: string,
  ): Promise<
    Array<{ id: string; author: string; body: string; created: string }>
  > {
    if (!this.isConfigured()) {
      throw new Error("Jira client not configured");
    }

    try {
      const response = await this.client.get(
        `/rest/api/3/issue/${key}/comment`,
      );
      const comments = response.data.comments || [];
      return comments.map((c: any) => ({
        id: c.id,
        author: c.author?.displayName || "Unknown",
        body:
          c.body?.content
            ?.map((p: any) => p.content?.map((t: any) => t.text).join(""))
            .join("\n") || "",
        created: c.created,
      }));
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        throw new Error(`Jira issue ${key} not found`);
      }
      throw new Error(
        `Failed to get comments for ${key}: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  /**
   * Get available transitions for issue
   */
  async getTransitions(key: string): Promise<JiraTransition[]> {
    if (!this.isConfigured()) {
      throw new Error("Jira client not configured");
    }

    try {
      console.log(`[Jira] Fetching transitions for ${key}`);
      const response = await this.client.get(
        `/rest/api/3/issue/${key}/transitions`,
      );
      const transitions = response.data.transitions || [];
      console.log(`[Jira] Found ${transitions.length} transitions for ${key}`);
      return transitions;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if (status === 404) {
          throw new Error(`Jira issue ${key} not found`);
        }
      }
      throw new Error(
        `Failed to get transitions for ${key}: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  /**
   * Transition issue to new status
   */
  async transitionIssue(
    key: string,
    transitionId: string,
    comment?: string,
  ): Promise<void> {
    if (!this.isConfigured()) {
      throw new Error("Jira client not configured");
    }

    try {
      console.log(`[Jira] Transitioning ${key} to ${transitionId}`);

      const payload: any = {
        transition: {
          id: transitionId,
        },
      };

      if (comment) {
        payload.update = {
          comment: [
            {
              add: {
                body: {
                  type: "doc",
                  version: 1,
                  content: [
                    {
                      type: "paragraph",
                      content: [
                        {
                          type: "text",
                          text: comment,
                        },
                      ],
                    },
                  ],
                },
              },
            },
          ],
        };
      }

      await this.client.post(`/rest/api/3/issue/${key}/transitions`, payload);
      console.log(`[Jira] Issue ${key} transitioned successfully`);
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if (status === 404) {
          throw new Error(`Jira issue ${key} not found`);
        } else if (status === 400) {
          throw new Error(`Invalid transition for issue ${key}`);
        } else if (status === 403) {
          throw new Error(`No permission to transition issue ${key}`);
        }
      }
      throw new Error(
        `Failed to transition issue ${key}: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  /**
   * Create new issue
   */
  async createIssue(params: {
    project: string;
    summary: string;
    description?: string;
    issueType: string;
    assignee?: string;
  }): Promise<JiraIssue> {
    if (!this.isConfigured()) {
      throw new Error("Jira client not configured");
    }

    try {
      console.log("[Jira] Creating issue:", params.summary);

      const payload: any = {
        fields: {
          project: {
            key: params.project,
          },
          summary: params.summary,
          issuetype: {
            name: params.issueType,
          },
        },
      };

      if (params.description) {
        payload.fields.description = {
          type: "doc",
          version: 1,
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: params.description,
                },
              ],
            },
          ],
        };
      }

      if (params.assignee) {
        payload.fields.assignee = {
          name: params.assignee,
        };
      }

      const response = await this.client.post("/rest/api/3/issue", payload);
      console.log(`[Jira] Issue ${response.data.key} created`);
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const data = error.response?.data as any;
        if (status === 400) {
          const errors = data?.errors || {};
          const errorMessages = data?.errorMessages || [];
          const details = [
            ...Object.entries(errors).map(([k, v]) => `${k}: ${v}`),
            ...errorMessages,
          ].join("; ");
          throw new Error(`Invalid issue data: ${details || "Unknown error"}`);
        } else if (status === 403) {
          throw new Error("No permission to create issue in this project");
        }
      }
      throw new Error(
        `Failed to create issue: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  /**
   * Bulk create multiple issues in a single request.
   * Falls back to sequential creation if the bulk endpoint fails.
   */
  async bulkCreateIssues(
    issues: Array<{
      project: string;
      summary: string;
      description?: string;
      issueType: string;
      assignee?: string;
    }>,
  ): Promise<Array<{ key: string; summary: string; status: string; error?: string }>> {
    if (!this.isConfigured()) {
      throw new Error("Jira client not configured");
    }

    const results: Array<{ key: string; summary: string; status: string; error?: string }> = [];

    // Try bulk endpoint first
    try {
      const payload = {
        issueUpdates: issues.map((issue) => {
          const fields: any = {
            project: { key: issue.project },
            summary: issue.summary,
            issuetype: { name: issue.issueType || "Task" },
          };
          if (issue.description) {
            fields.description = {
              type: "doc",
              version: 1,
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: issue.description }],
                },
              ],
            };
          }
          if (issue.assignee) {
            fields.assignee = { name: issue.assignee };
          }
          return { fields };
        }),
      };

      console.log(`[Jira] Bulk creating ${issues.length} issues`);
      const response = await this.client.post(
        "/rest/api/3/issue/bulk",
        payload,
      );

      if (response.data?.issues) {
        for (let i = 0; i < response.data.issues.length; i++) {
          const created = response.data.issues[i];
          results.push({
            key: created.key,
            summary: issues[i]?.summary || created.key,
            status: "created",
          });
        }
      }

      // Handle any errors returned for individual issues
      if (response.data?.errors) {
        for (const err of response.data.errors) {
          results.push({
            key: "",
            summary: err.message || "Unknown error",
            status: "failed",
            error: err.message,
          });
        }
      }

      return results;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        console.warn(
          `[Jira] Bulk create failed (${status}), falling back to sequential`,
        );
      } else {
        console.warn("[Jira] Bulk create failed, falling back to sequential");
      }
    }

    // Fallback: create one at a time
    for (const issue of issues) {
      try {
        const result = await this.createIssue(issue);
        results.push({
          key: result.key,
          summary: issue.summary,
          status: "created",
        });
      } catch (error) {
        results.push({
          key: "",
          summary: issue.summary,
          status: "failed",
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    return results;
  }

  /**
   * Add labels to an issue (preserves existing labels)
   */
  async addLabels(key: string, labels: string[]): Promise<void> {
    if (!this.isConfigured()) {
      throw new Error("Jira client not configured");
    }

    try {
      const issue = await this.getIssue(key);
      const existing: string[] = issue.fields?.labels || [];
      const merged = [...new Set([...existing, ...labels])];
      await this.updateIssue(key, { labels: merged });
      console.log(`[Jira] Added labels ${labels.join(", ")} to ${key}`);
    } catch (error) {
      throw new Error(
        `Failed to add labels to ${key}: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  /**
   * Update issue fields
   */
  async updateIssue(
    key: string,
    fields: Record<string, unknown>,
  ): Promise<void> {
    if (!this.isConfigured()) {
      throw new Error("Jira client not configured");
    }

    try {
      console.log(`[Jira] Updating ${key}:`, Object.keys(fields));
      await this.client.put(`/rest/api/3/issue/${key}`, { fields });
      console.log(`[Jira] Issue ${key} updated successfully`);
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if (status === 404) {
          throw new Error(`Jira issue ${key} not found`);
        } else if (status === 400) {
          throw new Error(`Invalid field data for issue ${key}`);
        } else if (status === 403) {
          throw new Error(`No permission to edit issue ${key}`);
        }
      }
      throw new Error(
        `Failed to update issue ${key}: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  /**
   * Get current user info
   */
  async getCurrentUser(): Promise<JiraUser> {
    if (!this.isConfigured()) {
      throw new Error("Jira client not configured");
    }

    try {
      const response = await this.client.get("/rest/api/3/myself");
      return response.data;
    } catch (error) {
      throw new Error(
        `Failed to get current user: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  /**
   * Get available projects
   */
  async getProjects(): Promise<Array<{ key: string; name: string }>> {
    if (!this.isConfigured()) {
      throw new Error("Jira client not configured");
    }

    try {
      const response = await this.client.get("/rest/api/3/project", {
        params: {
          fields: "key,name",
        },
      });

      return response.data.map((p: any) => ({
        key: p.key,
        name: p.name,
      }));
    } catch (error) {
      throw new Error(
        `Failed to get projects: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  /**
   * Get a single project by key
   */
  async getProject(key: string): Promise<JiraProject> {
    if (!this.isConfigured()) {
      throw new Error("Jira client not configured");
    }

    try {
      console.log(`[Jira] Fetching project: ${key}`);
      const response = await this.client.get(`/rest/api/3/project/${key}`);
      const data = response.data;
      return {
        key: data.key,
        name: data.name,
        id: data.id,
        projectTypeKey: data.projectTypeKey,
        style: data.style,
      };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if (status === 404) {
          throw new Error(`Jira project ${key} not found`);
        } else if (status === 403) {
          throw new Error(`No permission to access project ${key}`);
        }
      }
      throw new Error(
        `Failed to get project ${key}: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  /**
   * Create a new Jira project
   */
  async createProject(params: {
    key: string;
    name: string;
    projectType?: string;
    projectTemplate?: string;
    description?: string;
    leadAccountId?: string;
    url?: string;
  }): Promise<JiraProject> {
    if (!this.isConfigured()) {
      throw new Error("Jira client not configured");
    }

    try {
      console.log(`[Jira] Creating project: ${params.key} - ${params.name}`);

      let leadAccountId = params.leadAccountId;
      if (!leadAccountId) {
        const currentUser = await this.getCurrentUser();
        leadAccountId = currentUser.accountId;
      }

      const projectType = params.projectType || "software";
      const templates: Record<string, string> = {
        software: "com.pyxis.greenhopper.jira:gh-scrum-template",
        business:
          "com.atlassian.jira-core-project-templates:jira-core-scrum-management",
        service_desk: "com.atlassian.servicedesk.simplified-service-desk:it-v2",
      };

      const payload: any = {
        key: params.key,
        name: params.name,
        projectTypeKey: projectType,
        projectTemplateKey:
          params.projectTemplate ||
          templates[projectType] ||
          templates.software,
        leadAccountId,
        assigneeType: "PROJECT_LEAD",
        description: params.description || "",
        url: params.url || "",
      };

      const response = await this.client.post("/rest/api/3/project", payload);
      const data = response.data;
      console.log(`[Jira] Project ${data.key} created successfully`);
      return {
        key: data.key,
        name: data.name,
        id: data.id,
        projectTypeKey: data.projectTypeKey,
        style: data.style,
      };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const data = error.response?.data as any;
        if (status === 400) {
          const errors = data?.errors || {};
          const errorMessages = data?.errorMessages || [];
          const details = [
            ...Object.entries(errors).map(([k, v]) => `${k}: ${v}`),
            ...errorMessages,
          ].join("; ");
          throw new Error(
            `Invalid project data: ${details || "Unknown error"}`,
          );
        } else if (status === 401) {
          throw new Error(
            "Jira authentication failed. Check your credentials.",
          );
        } else if (status === 403) {
          throw new Error(
            "No permission to create projects. Ensure your API token has project admin rights.",
          );
        } else if (status === 409) {
          throw new Error(`Project with key ${params.key} already exists.`);
        }
      }
      throw new Error(
        `Failed to create project: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }
}

export const jiraClient = new JiraClient();
