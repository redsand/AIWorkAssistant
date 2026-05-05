import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGet, mockPost, mockInterceptorsResponseUse } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  mockInterceptorsResponseUse: vi.fn(),
}));

vi.mock("axios", () => ({
  default: {
    create: vi.fn(() => ({
      get: mockGet,
      post: mockPost,
      interceptors: {
        response: { use: mockInterceptorsResponseUse },
      },
    })),
  },
}));

vi.mock("../../../config/env", () => ({
  env: {
    JITBIT_BASE_URL: "https://test.jitbit.com/helpdesk",
    JITBIT_API_TOKEN: "test-api-token",
    JITBIT_ENABLED: "true",
  },
}));

import { JitbitClient } from "../jitbit-client";

describe("JitbitClient", () => {
  let client: JitbitClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new JitbitClient();
  });

  describe("isConfigured", () => {
    it("returns true when enabled, baseUrl, and apiToken are set", () => {
      expect(client.isConfigured()).toBe(true);
    });
  });

  describe("validateConfig", () => {
    it("returns true when listTickets succeeds", async () => {
      mockGet.mockResolvedValue({ data: [] });
      const result = await client.validateConfig();
      expect(result).toBe(true);
    });

    it("returns false when listTickets throws", async () => {
      mockGet.mockRejectedValue(new Error("Network error"));
      const result = await client.validateConfig();
      expect(result).toBe(false);
    });

    it("returns false when not configured", async () => {
      vi.doMock("../../../config/env", () => ({
        env: {
          JITBIT_BASE_URL: "",
          JITBIT_API_TOKEN: "",
          JITBIT_ENABLED: "false",
        },
      }));
      const fresh = new JitbitClient();
      expect(await fresh.validateConfig()).toBe(false);
    });
  });

  describe("listTickets", () => {
    it("calls GET /Tickets with params", async () => {
      const tickets = [{ IssueID: 1, Subject: "Test" }];
      mockGet.mockResolvedValue({ data: tickets });
      const result = await client.listTickets({ mode: "unclosed", count: 10 });
      expect(mockGet).toHaveBeenCalledWith("/Tickets", {
        params: { mode: "unclosed", count: 10 },
      });
      expect(result).toEqual(tickets);
    });
  });

  describe("getTicket", () => {
    it("calls GET /ticket with id param", async () => {
      const ticket = { IssueID: 42, Subject: "Found" };
      mockGet.mockResolvedValue({ data: ticket });
      const result = await client.getTicket(42);
      expect(mockGet).toHaveBeenCalledWith("/ticket", { params: { id: 42 } });
      expect(result).toEqual(ticket);
    });
  });

  describe("searchTickets", () => {
    it("calls GET /Search with query and params", async () => {
      const tickets = [{ IssueID: 1, Subject: "Match" }];
      mockGet.mockResolvedValue({ data: tickets });
      const result = await client.searchTickets("login error", { statusId: 1 });
      expect(mockGet).toHaveBeenCalledWith("/Search", {
        params: { query: "login error", statusId: 1 },
      });
      expect(result).toEqual(tickets);
    });
  });

  describe("listTicketComments", () => {
    it("calls GET /comments with id param", async () => {
      const comments = [{ CommentID: 1, Body: "Note" }];
      mockGet.mockResolvedValue({ data: comments });
      const result = await client.listTicketComments(5);
      expect(mockGet).toHaveBeenCalledWith("/comments", { params: { id: 5 } });
      expect(result).toEqual(comments);
    });
  });

  describe("addTicketComment", () => {
    it("posts form-urlencoded comment", async () => {
      mockPost.mockResolvedValue({ data: {} });
      await client.addTicketComment(10, "Hello world", { forTechsOnly: true });
      expect(mockPost).toHaveBeenCalledWith(
        "/comment",
        expect.any(URLSearchParams),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
      );
      const body = mockPost.mock.calls[0][1] as URLSearchParams;
      expect(body.get("id")).toBe("10");
      expect(body.get("body")).toBe("Hello world");
      expect(body.get("forTechsOnly")).toBe("true");
    });
  });

  describe("updateTicket", () => {
    it("posts form-urlencoded update", async () => {
      mockPost.mockResolvedValue({ data: {} });
      await client.updateTicket(10, { statusId: 3, priority: 1 });
      expect(mockPost).toHaveBeenCalledWith(
        "/UpdateTicket",
        expect.any(URLSearchParams),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
      );
      const body = mockPost.mock.calls[0][1] as URLSearchParams;
      expect(body.get("id")).toBe("10");
      expect(body.get("statusId")).toBe("3");
      expect(body.get("priority")).toBe("1");
    });
  });

  describe("listUsers", () => {
    it("calls GET /Users with params", async () => {
      const users = [{ UserID: 1, Username: "admin" }];
      mockGet.mockResolvedValue({ data: users });
      const result = await client.listUsers({ count: 50 });
      expect(mockGet).toHaveBeenCalledWith("/Users", { params: { count: 50 } });
      expect(result).toEqual(users);
    });
  });

  describe("getUser", () => {
    it("finds user by ID from listUsers", async () => {
      const users = [
        { UserID: 1, Username: "admin" },
        { UserID: 2, Username: "user" },
      ];
      mockGet.mockResolvedValue({ data: users });
      const result = await client.getUser(2);
      expect(result).toEqual({ UserID: 2, Username: "user" });
    });

    it("returns null when user not found", async () => {
      mockGet.mockResolvedValue({ data: [] });
      const result = await client.getUser(999);
      expect(result).toBeNull();
    });
  });

  describe("searchUsers", () => {
    it("filters users by query across name and email", async () => {
      const users = [
        { UserID: 1, Username: "admin", Email: "admin@test.com", FirstName: "Admin", LastName: "User", CompanyName: "ACME" },
        { UserID: 2, Username: "jdoe", Email: "john@acme.com", FirstName: "John", LastName: "Doe", CompanyName: "ACME" },
      ];
      mockGet.mockResolvedValue({ data: users });
      const result = await client.searchUsers("acme");
      expect(result).toHaveLength(2);
    });
  });

  describe("listCompanies", () => {
    it("calls GET /Companies with params", async () => {
      const companies = [{ CompanyID: 1, Name: "ACME" }];
      mockGet.mockResolvedValue({ data: companies });
      const result = await client.listCompanies({ count: 100 });
      expect(result).toEqual(companies);
    });
  });

  describe("getCompany", () => {
    it("finds company by ID from listCompanies", async () => {
      const companies = [{ CompanyID: 1, Name: "ACME" }, { CompanyID: 2, Name: "Globex" }];
      mockGet.mockResolvedValue({ data: companies });
      const result = await client.getCompany(2);
      expect(result).toEqual({ CompanyID: 2, Name: "Globex" });
    });

    it("returns null when company not found", async () => {
      mockGet.mockResolvedValue({ data: [] });
      const result = await client.getCompany(999);
      expect(result).toBeNull();
    });
  });

  describe("searchCompanies", () => {
    it("filters companies by query", async () => {
      const companies = [
        { CompanyID: 1, Name: "ACME Corp" },
        { CompanyID: 2, Name: "Globex Inc" },
      ];
      mockGet.mockResolvedValue({ data: companies });
      const result = await client.searchCompanies("acme");
      expect(result).toHaveLength(1);
      expect(result[0].Name).toBe("ACME Corp");
    });
  });

  describe("listCategories", () => {
    it("calls GET /categories", async () => {
      const cats = [{ CategoryID: 1, Name: "Bug" }];
      mockGet.mockResolvedValue({ data: cats });
      const result = await client.listCategories();
      expect(mockGet).toHaveBeenCalledWith("/categories");
      expect(result).toEqual(cats);
    });
  });

  describe("listStatuses", () => {
    it("calls GET /Statuses", async () => {
      const statuses = [{ StatusID: 1, Name: "Open" }];
      mockGet.mockResolvedValue({ data: statuses });
      const result = await client.listStatuses();
      expect(mockGet).toHaveBeenCalledWith("/Statuses");
      expect(result).toEqual(statuses);
    });
  });

  describe("listPriorities", () => {
    it("calls GET /Priorities", async () => {
      const priorities = [{ PriorityID: 1, Name: "Low" }];
      mockGet.mockResolvedValue({ data: priorities });
      const result = await client.listPriorities();
      expect(mockGet).toHaveBeenCalledWith("/Priorities");
      expect(result).toEqual(priorities);
    });
  });

  describe("normalizeBaseUrl", () => {
    it("strips trailing slashes and appends /api", () => {
      expect(client.getBaseUrl()).toBe("https://test.jitbit.com/helpdesk/api");
    });
  });

  describe("retry behavior", () => {
    it("sets up response interceptor on creation", () => {
      expect(mockInterceptorsResponseUse).toHaveBeenCalled();
    });
  });
});