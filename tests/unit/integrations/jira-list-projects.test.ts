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

import axios from "axios";
import { JiraClient } from "../../../src/integrations/jira/jira-client";

function createClient(): {
  client: JiraClient;
  mockGet: ReturnType<typeof vi.fn>;
} {
  const mockGet = vi.fn();
  vi.mocked(axios.create).mockReturnValue({
    get: mockGet,
    post: vi.fn(),
    put: vi.fn(),
  } as any);

  const TestableJiraClient = JiraClient as any;
  const client = new TestableJiraClient();
  return { client, mockGet };
}

describe("Jira list projects", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("jiraClient.getProjects()", () => {
    it("should call the Jira API and return projects with key and name", async () => {
      const { client, mockGet } = createClient();
      mockGet.mockResolvedValue({
        data: [
          { key: "PROJ", name: "Main Project" },
          { key: "ENG", name: "Engineering" },
          { key: "OPS", name: "Operations" },
        ],
      });

      const projects = await client.getProjects();

      expect(mockGet).toHaveBeenCalledWith("/rest/api/3/project", {
        params: { fields: "key,name" },
      });
      expect(projects).toEqual([
        { key: "PROJ", name: "Main Project" },
        { key: "ENG", name: "Engineering" },
        { key: "OPS", name: "Operations" },
      ]);
    });

    it("should return an empty array when no projects exist", async () => {
      const { client, mockGet } = createClient();
      mockGet.mockResolvedValue({ data: [] });

      const projects = await client.getProjects();

      expect(projects).toEqual([]);
    });

    it("should strip extra fields and only return key and name", async () => {
      const { client, mockGet } = createClient();
      mockGet.mockResolvedValue({
        data: [
          {
            key: "PROJ",
            name: "Main Project",
            id: "10001",
            projectTypeKey: "software",
            style: "next-gen",
            lead: { displayName: "Admin" },
          },
        ],
      });

      const projects = await client.getProjects();

      expect(projects).toEqual([{ key: "PROJ", name: "Main Project" }]);
    });

    it("should throw a descriptive error when the API call fails", async () => {
      const { client, mockGet } = createClient();
      mockGet.mockRejectedValue(new Error("Network error"));

      await expect(client.getProjects()).rejects.toThrow(
        "Failed to get projects: Network error",
      );
    });

    it("should throw when Jira client is not configured", async () => {
      const { client } = createClient();
      (client as any).email = "";
      (client as any).apiToken = "";

      expect(client.isConfigured()).toBe(false);

      await expect(client.getProjects()).rejects.toThrow(
        "Jira client not configured",
      );
    });
  });

  describe("jiraClient.getProject()", () => {
    it("should fetch a single project by key", async () => {
      const { client, mockGet } = createClient();
      mockGet.mockResolvedValue({
        data: {
          key: "PROJ",
          name: "Main Project",
          id: "10001",
          projectTypeKey: "software",
          style: "next-gen",
        },
      });

      const project = await client.getProject("PROJ");

      expect(mockGet).toHaveBeenCalledWith("/rest/api/3/project/PROJ");
      expect(project).toEqual({
        key: "PROJ",
        name: "Main Project",
        id: "10001",
        projectTypeKey: "software",
        style: "next-gen",
      });
    });

    it("should throw when project not found", async () => {
      const { client, mockGet } = createClient();
      const error = new Error("Not Found");
      (error as any).response = { status: 404 };
      vi.mocked(axios.isAxiosError).mockReturnValue(true);
      mockGet.mockRejectedValue(error);

      await expect(client.getProject("MISSING")).rejects.toThrow(
        "Jira project MISSING not found",
      );
    });
  });
});
