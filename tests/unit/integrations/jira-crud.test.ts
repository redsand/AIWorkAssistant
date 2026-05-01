import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("axios", () => {
  const mockInstance = {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
  };
  return {
    default: {
      create: vi.fn(() => mockInstance),
      isAxiosError: vi.fn(),
    },
  };
});

vi.mock("../../../src/config/env", () => ({
  env: {
    JIRA_BASE_URL: "https://test.atlassian.net",
    JIRA_EMAIL: "test@example.com",
    JIRA_API_TOKEN: "test-token",
    GITLAB_BASE_URL: "https://gitlab.com",
    GITLAB_TOKEN: "",
    GITLAB_WEBHOOK_SECRET: "",
    PORT: 3050,
    NODE_ENV: "test",
    AUTH_USERNAME: "admin",
    AUTH_PASSWORD: "test",
    AUTH_SESSION_SECRET: "test-secret",
    OPENCODE_API_URL: "https://api.opencode.com/v1",
    OPENCODE_API_KEY: "",
    JIRA_PROJECT_KEYS: [],
    ENABLE_CALENDAR_WRITE: false,
    ENABLE_JIRA_TRANSITIONS: true,
    ENABLE_GITLAB_WEBHOOKS: true,
  },
}));

vi.mock("../../../src/audit/logger", () => ({
  auditLogger: {
    log: vi.fn(async () => {}),
  },
}));

vi.mock("../../../src/integrations/jira/jira-service", () => ({
  jiraService: {
    getAssignedIssues: vi.fn(),
    getIssue: vi.fn(),
    addComment: vi.fn(),
    transitionIssue: vi.fn(),
    createProject: vi.fn(),
    getProject: vi.fn(),
  },
}));

vi.mock("../../../src/integrations/gitlab/gitlab-client", () => ({
  gitlabClient: {
    getMergeRequests: vi.fn(),
    getCommit: vi.fn(),
  },
}));

vi.mock("../../../src/integrations/file/calendar-service", () => ({
  fileCalendarService: {
    listEvents: vi.fn(),
    createFocusBlock: vi.fn(),
    createHealthBlock: vi.fn(),
  },
}));

vi.mock("../../../src/productivity/daily-planner", () => ({
  dailyPlanner: {
    generatePlan: vi.fn(),
  },
}));

import axios from "axios";
import { JiraClient } from "../../../src/integrations/jira/jira-client";
import { jiraClient } from "../../../src/integrations/jira/jira-client";
import { dispatchToolCall } from "../../../src/agent/tool-dispatcher";

function createMockedClient(): {
  client: JiraClient;
  mockGet: ReturnType<typeof vi.fn>;
  mockPost: ReturnType<typeof vi.fn>;
  mockPut: ReturnType<typeof vi.fn>;
} {
  const mockGet = vi.fn();
  const mockPost = vi.fn();
  const mockPut = vi.fn();
  vi.mocked(axios.create).mockReturnValue({
    get: mockGet,
    post: mockPost,
    put: mockPut,
  } as any);

  const TestableJiraClient = JiraClient as any;
  const client = new TestableJiraClient();
  return { client, mockGet, mockPost, mockPut };
}

describe("Jira CRUD Operations", () => {
  describe("jiraClient.createIssue()", () => {
    it("should create an issue with required fields", async () => {
      const { client, mockPost } = createMockedClient();
      mockPost.mockResolvedValue({
        data: { key: "PROJ-1", id: "10001" },
      });

      const result = await client.createIssue({
        project: "PROJ",
        summary: "Test issue",
        issueType: "Task",
      });

      expect(result.key).toBe("PROJ-1");
      expect(mockPost).toHaveBeenCalledWith("/rest/api/3/issue", {
        fields: {
          project: { key: "PROJ" },
          summary: "Test issue",
          issuetype: { name: "Task" },
        },
      });
    });

    it("should create an issue with description and assignee", async () => {
      const { client, mockPost } = createMockedClient();
      mockPost.mockResolvedValue({
        data: { key: "PROJ-2", id: "10002" },
      });

      const result = await client.createIssue({
        project: "PROJ",
        summary: "Bug report",
        description: "Something broke",
        issueType: "Bug",
        assignee: "john@example.com",
      });

      expect(result.key).toBe("PROJ-2");
      const call = mockPost.mock.calls[0];
      expect(call[1].fields.description).toBeDefined();
      expect(call[1].fields.assignee).toEqual({
        name: "john@example.com",
      });
    });

    it("should throw when not configured", async () => {
      const { client } = createMockedClient();
      (client as any).email = "";
      (client as any).apiToken = "";

      await expect(
        client.createIssue({
          project: "PROJ",
          summary: "Test",
          issueType: "Task",
        }),
      ).rejects.toThrow("Jira client not configured");
    });

    it("should throw descriptive error on 400", async () => {
      const { client, mockPost } = createMockedClient();
      const error: any = new Error("Bad Request");
      error.response = { status: 400, data: { errors: ["Invalid data"] } };
      vi.mocked(axios.isAxiosError).mockReturnValue(true);
      mockPost.mockRejectedValue(error);

      await expect(
        client.createIssue({
          project: "PROJ",
          summary: "Test",
          issueType: "Task",
        }),
      ).rejects.toThrow("Invalid issue data");
    });
  });

  describe("jiraClient.updateIssue()", () => {
    it("should update issue fields via PUT", async () => {
      const { client, mockPut } = createMockedClient();
      mockPut.mockResolvedValue({ data: {} });

      await client.updateIssue("PROJ-1", { summary: "Updated title" });

      expect(mockPut).toHaveBeenCalledWith("/rest/api/3/issue/PROJ-1", {
        fields: { summary: "Updated title" },
      });
    });

    it("should throw on 404", async () => {
      const { client, mockPut } = createMockedClient();
      const error: any = new Error("Not Found");
      error.response = { status: 404 };
      vi.mocked(axios.isAxiosError).mockReturnValue(true);
      mockPut.mockRejectedValue(error);

      await expect(
        client.updateIssue("MISSING-1", { summary: "x" }),
      ).rejects.toThrow("not found");
    });

    it("should throw on 403 permission denied", async () => {
      const { client, mockPut } = createMockedClient();
      const error: any = new Error("Forbidden");
      error.response = { status: 403 };
      vi.mocked(axios.isAxiosError).mockReturnValue(true);
      mockPut.mockRejectedValue(error);

      await expect(
        client.updateIssue("PROJ-1", { summary: "x" }),
      ).rejects.toThrow("No permission");
    });
  });

  describe("jiraClient.getTransitions()", () => {
    it("should return available transitions", async () => {
      const { client, mockGet } = createMockedClient();
      mockGet.mockResolvedValue({
        data: {
          transitions: [
            { id: "31", name: "Done", to: { name: "Done", id: "41" } },
            {
              id: "21",
              name: "In Progress",
              to: { name: "In Progress", id: "31" },
            },
          ],
        },
      });

      const transitions = await client.getTransitions("PROJ-1");

      expect(transitions).toHaveLength(2);
      expect(transitions[0].name).toBe("Done");
      expect(mockGet).toHaveBeenCalledWith(
        "/rest/api/3/issue/PROJ-1/transitions",
      );
    });

    it("should throw on 404", async () => {
      const { client, mockGet } = createMockedClient();
      const error: any = new Error("Not Found");
      error.response = { status: 404 };
      vi.mocked(axios.isAxiosError).mockReturnValue(true);
      mockGet.mockRejectedValue(error);

      await expect(client.getTransitions("MISSING-1")).rejects.toThrow(
        "not found",
      );
    });
  });

  describe("jiraClient.transitionIssue()", () => {
    it("should transition with comment", async () => {
      const { client, mockPost } = createMockedClient();
      mockPost.mockResolvedValue({ data: {} });

      await client.transitionIssue("PROJ-1", "31", "Closing this");

      expect(mockPost).toHaveBeenCalledWith(
        "/rest/api/3/issue/PROJ-1/transitions",
        expect.objectContaining({
          transition: { id: "31" },
          update: expect.any(Object),
        }),
      );
    });

    it("should transition without comment", async () => {
      const { client, mockPost } = createMockedClient();
      mockPost.mockResolvedValue({ data: {} });

      await client.transitionIssue("PROJ-1", "31");

      const call = mockPost.mock.calls[0];
      expect(call[1].update).toBeUndefined();
    });

    it("should throw on invalid transition (400)", async () => {
      const { client, mockPost } = createMockedClient();
      const error: any = new Error("Bad Request");
      error.response = { status: 400 };
      vi.mocked(axios.isAxiosError).mockReturnValue(true);
      mockPost.mockRejectedValue(error);

      await expect(client.transitionIssue("PROJ-1", "999")).rejects.toThrow(
        "Invalid transition",
      );
    });
  });

  describe("jiraClient.getComments()", () => {
    it("should return parsed comments", async () => {
      const { client, mockGet } = createMockedClient();
      mockGet.mockResolvedValue({
        data: {
          comments: [
            {
              id: "1",
              author: { displayName: "Tim" },
              body: {
                content: [
                  {
                    content: [{ text: "Looks good" }],
                  },
                ],
              },
              created: "2025-01-01T00:00:00.000Z",
            },
          ],
        },
      });

      const comments = await client.getComments("PROJ-1");

      expect(comments).toHaveLength(1);
      expect(comments[0].author).toBe("Tim");
      expect(comments[0].body).toBe("Looks good");
    });

    it("should return empty array when no comments", async () => {
      const { client, mockGet } = createMockedClient();
      mockGet.mockResolvedValue({ data: { comments: [] } });

      const comments = await client.getComments("PROJ-1");

      expect(comments).toEqual([]);
    });

    it("should throw on 404", async () => {
      const { client, mockGet } = createMockedClient();
      const error: any = new Error("Not Found");
      error.response = { status: 404 };
      vi.mocked(axios.isAxiosError).mockReturnValue(true);
      mockGet.mockRejectedValue(error);

      await expect(client.getComments("MISSING-1")).rejects.toThrow(
        "not found",
      );
    });
  });

  describe("jiraClient.searchIssues()", () => {
    it("should search with JQL via POST and return issues", async () => {
      const { client, mockPost } = createMockedClient();
      mockPost.mockResolvedValue({
        data: {
          issues: [
            {
              key: "PROJ-1",
              fields: {
                summary: "Test issue",
                status: { name: "Open" },
                assignee: { displayName: "Tim" },
                priority: { name: "High" },
                issuetype: { name: "Bug" },
                project: { key: "PROJ", name: "Project" },
                created: "2025-01-01",
              },
            },
          ],
        },
      });

      const issues = await client.searchIssues(
        "project = PROJ AND status = Open",
      );

      expect(issues).toHaveLength(1);
      expect(issues[0].key).toBe("PROJ-1");
      expect(mockPost).toHaveBeenCalledWith("/rest/api/3/search/jql", {
        jql: "project = PROJ AND status = Open",
        maxResults: 50,
        fields: expect.arrayContaining(["summary", "status", "assignee"]),
      });
    });

    it("should throw on invalid JQL (400)", async () => {
      const { client, mockPost } = createMockedClient();
      const error: any = new Error("Bad Request");
      error.response = {
        status: 400,
        data: { errorMessages: ["Invalid JQL"] },
      };
      vi.mocked(axios.isAxiosError).mockReturnValue(true);
      mockPost.mockRejectedValue(error);

      await expect(client.searchIssues("invalid jql !!!")).rejects.toThrow(
        "Invalid JQL",
      );
    });

    it("should return empty array when no results", async () => {
      const { client, mockPost } = createMockedClient();
      mockPost.mockResolvedValue({ data: { issues: [] } });

      const issues = await client.searchIssues("project = NONEXISTENT");

      expect(issues).toEqual([]);
    });
  });
});

describe("Tool Dispatcher: Jira CRUD", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("jira.create_issue", () => {
    it("should create an issue via dispatcher", async () => {
      vi.spyOn(jiraClient, "isConfigured").mockReturnValue(true);
      vi.spyOn(jiraClient, "createIssue").mockResolvedValue({
        key: "PROJ-5",
        id: "10005",
      } as any);
      vi.spyOn(jiraClient, "getBaseUrl").mockReturnValue(
        "https://test.atlassian.net",
      );

      const result = await dispatchToolCall("jira.create_issue", {
        project: "PROJ",
        summary: "New ticket",
        description: "Details here",
        issueType: "Task",
      });

      expect(result.success).toBe(true);
      expect((result.data as any).key).toBe("PROJ-5");
    });

    it("should fail when project is missing", async () => {
      vi.spyOn(jiraClient, "isConfigured").mockReturnValue(true);

      const result = await dispatchToolCall("jira.create_issue", {
        summary: "No project",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("project and summary are required");
    });

    it("should fail when summary is missing", async () => {
      vi.spyOn(jiraClient, "isConfigured").mockReturnValue(true);

      const result = await dispatchToolCall("jira.create_issue", {
        project: "PROJ",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("project and summary are required");
    });
  });

  describe("jira.update_issue", () => {
    it("should update specified fields", async () => {
      vi.spyOn(jiraClient, "isConfigured").mockReturnValue(true);
      vi.spyOn(jiraClient, "updateIssue").mockResolvedValue(undefined);

      const result = await dispatchToolCall("jira.update_issue", {
        key: "PROJ-1",
        summary: "Updated summary",
        priority: "High",
      });

      expect(result.success).toBe(true);
      expect((result.data as any).updatedFields).toContain("summary");
      expect((result.data as any).updatedFields).toContain("priority");
    });

    it("should fail when key is missing", async () => {
      vi.spyOn(jiraClient, "isConfigured").mockReturnValue(true);

      const result = await dispatchToolCall("jira.update_issue", {
        summary: "No key",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("key is required");
    });

    it("should fail when no fields provided", async () => {
      vi.spyOn(jiraClient, "isConfigured").mockReturnValue(true);

      const result = await dispatchToolCall("jira.update_issue", {
        key: "PROJ-1",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("No fields provided");
    });
  });

  describe("jira.close_issue", () => {
    it("should close an issue by finding Done transition", async () => {
      vi.spyOn(jiraClient, "isConfigured").mockReturnValue(true);
      vi.spyOn(jiraClient, "getTransitions").mockResolvedValue([
        {
          id: "31",
          name: "Done",
          to: { name: "Done", id: "41" },
        },
      ]);
      vi.spyOn(jiraClient, "transitionIssue").mockResolvedValue(undefined);

      const result = await dispatchToolCall("jira.close_issue", {
        key: "PROJ-1",
        comment: "Completed",
      });

      expect(result.success).toBe(true);
      expect((result.data as any).transitionedTo).toBe("Done");
    });

    it("should find Closed transition", async () => {
      vi.spyOn(jiraClient, "isConfigured").mockReturnValue(true);
      vi.spyOn(jiraClient, "getTransitions").mockResolvedValue([
        {
          id: "51",
          name: "Close",
          to: { name: "Closed", id: "61" },
        },
      ]);
      vi.spyOn(jiraClient, "transitionIssue").mockResolvedValue(undefined);

      const result = await dispatchToolCall("jira.close_issue", {
        key: "PROJ-2",
      });

      expect(result.success).toBe(true);
      expect((result.data as any).transitionedTo).toBe("Closed");
    });

    it("should find Resolved transition", async () => {
      vi.spyOn(jiraClient, "isConfigured").mockReturnValue(true);
      vi.spyOn(jiraClient, "getTransitions").mockResolvedValue([
        {
          id: "71",
          name: "Resolve",
          to: { name: "Resolved", id: "81" },
        },
      ]);
      vi.spyOn(jiraClient, "transitionIssue").mockResolvedValue(undefined);

      const result = await dispatchToolCall("jira.close_issue", {
        key: "PROJ-3",
      });

      expect(result.success).toBe(true);
      expect((result.data as any).transitionedTo).toBe("Resolved");
    });

    it("should fail when no close transition found", async () => {
      vi.spyOn(jiraClient, "isConfigured").mockReturnValue(true);
      vi.spyOn(jiraClient, "getTransitions").mockResolvedValue([
        {
          id: "21",
          name: "Start",
          to: { name: "In Progress", id: "31" },
        },
      ]);

      const result = await dispatchToolCall("jira.close_issue", {
        key: "PROJ-4",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("No close/complete transition found");
    });

    it("should fail when key is missing", async () => {
      vi.spyOn(jiraClient, "isConfigured").mockReturnValue(true);

      const result = await dispatchToolCall("jira.close_issue", {});

      expect(result.success).toBe(false);
      expect(result.error).toContain("key is required");
    });
  });

  describe("jira.search_issues", () => {
    it("should search and return formatted results", async () => {
      vi.spyOn(jiraClient, "isConfigured").mockReturnValue(true);
      vi.spyOn(jiraClient, "searchIssues").mockResolvedValue([
        {
          key: "PROJ-1",
          fields: {
            summary: "Bug",
            status: { name: "Open" },
            assignee: { displayName: "Tim" },
            priority: { name: "High" },
            issuetype: { name: "Bug" },
            project: { key: "PROJ" },
            created: "2025-01-01",
          },
        },
        {
          key: "PROJ-2",
          fields: {
            summary: "Task",
            status: { name: "In Progress" },
            assignee: null,
            priority: { name: "Low" },
            issuetype: { name: "Task" },
            project: { key: "PROJ" },
            created: "2025-01-02",
          },
        },
      ] as any);

      const result = await dispatchToolCall("jira.search_issues", {
        jql: "project = PROJ ORDER BY created DESC",
        limit: 10,
      });

      expect(result.success).toBe(true);
      const data = result.data as any[];
      expect(data).toHaveLength(2);
      expect(data[0].key).toBe("PROJ-1");
      expect(data[0].assignee).toBe("Tim");
      expect(data[1].assignee).toBe("Unassigned");
    });

    it("should fail when jql is missing", async () => {
      vi.spyOn(jiraClient, "isConfigured").mockReturnValue(true);

      const result = await dispatchToolCall("jira.search_issues", {});

      expect(result.success).toBe(false);
      expect(result.error).toContain("jql query is required");
    });
  });

  describe("jira.list_transitions", () => {
    it("should return transitions for an issue", async () => {
      vi.spyOn(jiraClient, "isConfigured").mockReturnValue(true);
      vi.spyOn(jiraClient, "getTransitions").mockResolvedValue([
        {
          id: "21",
          name: "Start Progress",
          to: { name: "In Progress", id: "31" },
        },
        { id: "31", name: "Done", to: { name: "Done", id: "41" } },
      ]);

      const result = await dispatchToolCall("jira.list_transitions", {
        key: "PROJ-1",
      });

      expect(result.success).toBe(true);
      const data = result.data as any[];
      expect(data).toHaveLength(2);
      expect(data[0].to).toBe("In Progress");
    });

    it("should fail when key is missing", async () => {
      vi.spyOn(jiraClient, "isConfigured").mockReturnValue(true);

      const result = await dispatchToolCall("jira.list_transitions", {});

      expect(result.success).toBe(false);
      expect(result.error).toContain("key is required");
    });
  });

  describe("jira.get_comments", () => {
    it("should return comments for an issue", async () => {
      vi.spyOn(jiraClient, "isConfigured").mockReturnValue(true);
      vi.spyOn(jiraClient, "getComments").mockResolvedValue([
        {
          id: "c1",
          author: "Alice",
          body: "First comment",
          created: "2025-01-01T00:00:00Z",
        },
      ]);

      const result = await dispatchToolCall("jira.get_comments", {
        key: "PROJ-1",
      });

      expect(result.success).toBe(true);
      const data = result.data as any[];
      expect(data).toHaveLength(1);
      expect(data[0].author).toBe("Alice");
      expect(data[0].body).toBe("First comment");
    });

    it("should fail when key is missing", async () => {
      vi.spyOn(jiraClient, "isConfigured").mockReturnValue(true);

      const result = await dispatchToolCall("jira.get_comments", {});

      expect(result.success).toBe(false);
      expect(result.error).toContain("key is required");
    });
  });

  describe("unknown tool", () => {
    it("should return error for unknown tool name", async () => {
      const result = await dispatchToolCall("jira.nonexistent", {});
      expect(result.success).toBe(false);
      expect(result.error).toContain("Unknown tool");
    });
  });
});
