import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockIsConfigured,
  mockValidateConfig,
  mockListTickets,
  mockGetTicket,
  mockSearchTickets,
  mockListTicketComments,
  mockAddTicketComment,
  mockListUsers,
  mockSearchUsers,
  mockListCompanies,
  mockGetCompany,
  mockSearchCompanies,
} = vi.hoisted(() => ({
  mockIsConfigured: vi.fn(),
  mockValidateConfig: vi.fn(),
  mockListTickets: vi.fn(),
  mockGetTicket: vi.fn(),
  mockSearchTickets: vi.fn(),
  mockListTicketComments: vi.fn(),
  mockAddTicketComment: vi.fn(),
  mockListUsers: vi.fn(),
  mockSearchUsers: vi.fn(),
  mockListCompanies: vi.fn(),
  mockGetCompany: vi.fn(),
  mockSearchCompanies: vi.fn(),
}));

vi.mock("../jitbit-client", () => ({
  JitbitClient: vi.fn(() => ({
    isConfigured: mockIsConfigured,
    validateConfig: mockValidateConfig,
    listTickets: mockListTickets,
    getTicket: mockGetTicket,
    searchTickets: mockSearchTickets,
    listTicketComments: mockListTicketComments,
    addTicketComment: mockAddTicketComment,
    listUsers: mockListUsers,
    searchUsers: mockSearchUsers,
    listCompanies: mockListCompanies,
    getCompany: mockGetCompany,
    searchCompanies: mockSearchCompanies,
    getBaseUrl: vi.fn(() => "https://test.jitbit.com/helpdesk/api"),
  })),
  jitbitClient: {
    isConfigured: mockIsConfigured,
    validateConfig: mockValidateConfig,
    listTickets: mockListTickets,
    getTicket: mockGetTicket,
    searchTickets: mockSearchTickets,
    listTicketComments: mockListTicketComments,
    addTicketComment: mockAddTicketComment,
    listUsers: mockListUsers,
    searchUsers: mockSearchUsers,
    listCompanies: mockListCompanies,
    getCompany: mockGetCompany,
    searchCompanies: mockSearchCompanies,
    getBaseUrl: vi.fn(() => "https://test.jitbit.com/helpdesk/api"),
  },
}));

import { JitbitService } from "../jitbit-service";
import type { JitbitTicket, JitbitCompany, JitbitComment } from "../types";

describe("JitbitService", () => {
  let service: JitbitService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsConfigured.mockReturnValue(true);
    service = new JitbitService();
  });

  describe("isConfigured", () => {
    it("delegates to client", () => {
      mockIsConfigured.mockReturnValue(true);
      expect(service.isConfigured()).toBe(true);
      mockIsConfigured.mockReturnValue(false);
      expect(service.isConfigured()).toBe(false);
    });
  });

  describe("validateConfig", () => {
    it("delegates to client", async () => {
      mockValidateConfig.mockResolvedValue(true);
      const result = await service.validateConfig();
      expect(result).toBe(true);
    });
  });

  describe("getRecentCustomerActivity", () => {
    it("lists tickets with default params (7 days, limit 25)", async () => {
      const tickets: JitbitTicket[] = [{ IssueID: 1, Subject: "Recent" }];
      mockListTickets.mockResolvedValue(tickets);
      const result = await service.getRecentCustomerActivity();
      expect(mockListTickets).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: "all",
          count: 25,
        }),
      );
      expect(result).toEqual(tickets);
    });

    it("uses custom days and limit", async () => {
      mockListTickets.mockResolvedValue([]);
      await service.getRecentCustomerActivity({ days: 14, limit: 10 });
      expect(mockListTickets).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: "all",
          count: 10,
          updatedFrom: expect.any(String),
        }),
      );
    });
  });

  describe("searchTickets", () => {
    it("delegates to client with query and params", async () => {
      const tickets: JitbitTicket[] = [{ IssueID: 1 }];
      mockSearchTickets.mockResolvedValue(tickets);
      const result = await service.searchTickets("error", { statusId: 1 });
      expect(mockSearchTickets).toHaveBeenCalledWith("error", { statusId: 1 });
      expect(result).toEqual(tickets);
    });
  });

  describe("addTicketComment", () => {
    it("delegates to client", async () => {
      mockAddTicketComment.mockResolvedValue({});
      const result = await service.addTicketComment(42, "Update note", { forTechsOnly: true });
      expect(mockAddTicketComment).toHaveBeenCalledWith(42, "Update note", { forTechsOnly: true });
      expect(result).toEqual({});
    });
  });

  describe("getOpenSupportRequests", () => {
    it("lists unclosed tickets", async () => {
      const tickets: JitbitTicket[] = [{ IssueID: 1, Status: "Open" }];
      mockListTickets.mockResolvedValue(tickets);
      const result = await service.getOpenSupportRequests();
      expect(mockListTickets).toHaveBeenCalledWith(
        expect.objectContaining({ mode: "unclosed", count: 25 }),
      );
      expect(result).toEqual(tickets);
    });

    it("filters by companyId when provided", async () => {
      mockListTickets.mockResolvedValue([]);
      await service.getOpenSupportRequests({ companyId: 5, limit: 10 });
      expect(mockListTickets).toHaveBeenCalledWith({
        mode: "unclosed",
        fromCompanyId: 5,
        count: 10,
      });
    });
  });

  describe("getCustomerSnapshot", () => {
    it("looks up company by numeric ID", async () => {
      const company: JitbitCompany = { CompanyID: 5, Name: "ACME" };
      mockGetCompany.mockResolvedValue(company);
      mockListUsers.mockResolvedValue([]);
      mockListTickets.mockResolvedValue([]);
      mockSearchTickets.mockResolvedValue([]);

      const result = await service.getCustomerSnapshot(5);
      expect(mockGetCompany).toHaveBeenCalledWith(5);
      expect(result.company).toEqual(company);
      expect(result.summary.companyId).toBe(5);
      expect(result.summary.companyName).toBe("ACME");
    });

    it("searches company by name when given a string", async () => {
      const company: JitbitCompany = { CompanyID: 5, Name: "ACME Corp" };
      mockSearchCompanies.mockResolvedValue([company]);
      mockListUsers.mockResolvedValue([]);
      mockListTickets.mockResolvedValue([]);
      mockSearchTickets.mockResolvedValue([]);

      const result = await service.getCustomerSnapshot("ACME");
      expect(mockSearchCompanies).toHaveBeenCalledWith("ACME");
      expect(result.company).toEqual(company);
    });

    it("aggregates users, open tickets, recent tickets, and high-priority tickets", async () => {
      const company: JitbitCompany = { CompanyID: 5, Name: "ACME" };
      mockGetCompany.mockResolvedValue(company);
      mockListUsers.mockResolvedValue([{ UserID: 1 }, { UserID: 2 }]);
      mockListTickets.mockResolvedValue([
        { IssueID: 1, Priority: 2, PriorityName: "High", Status: "Open" },
        { IssueID: 2, Priority: 0, PriorityName: "Low", Status: "Open" },
      ]);

      const result = await service.getCustomerSnapshot(5);
      expect(result.summary.userCount).toBe(2);
      expect(result.summary.openTicketCount).toBe(2);
      expect(result.summary.highPriorityOpenTicketCount).toBe(1);
    });
  });

  describe("summarizeTicketForAssistant", () => {
    it("fetches ticket and comments, returns summary string", async () => {
      const ticket: JitbitTicket = {
        IssueID: 42,
        TicketID: 42,
        Subject: "Login broken",
        Status: "Open",
        PriorityName: "High",
        CompanyName: "ACME",
        LastUpdated: "2025-01-15",
      };
      const comments: JitbitComment[] = [
        { CommentID: 1, IssueID: 42, UserID: 1, Body: "First comment", CommentDate: "2025-01-15T10:00:00Z" },
        { CommentID: 2, IssueID: 42, UserID: 2, Body: "Second comment", CommentDate: "2025-01-16T10:00:00Z" },
      ];
      mockGetTicket.mockResolvedValue(ticket);
      mockListTicketComments.mockResolvedValue(comments);

      const result = await service.summarizeTicketForAssistant(42);
      expect(result.ticket).toEqual(ticket);
      expect(result.comments).toEqual(comments);
      expect(result.summary).toContain("Ticket 42");
      expect(result.summary).toContain("Login broken");
      expect(result.summary).toContain("High");
      expect(result.summary).toContain("Second comment");
    });

    it("handles ticket with no comments", async () => {
      const ticket: JitbitTicket = { IssueID: 1, Subject: "Test" };
      mockGetTicket.mockResolvedValue(ticket);
      mockListTicketComments.mockResolvedValue([]);

      const result = await service.summarizeTicketForAssistant(1);
      expect(result.summary).toContain("No comments found");
    });
  });

  describe("findTicketsNeedingFollowup", () => {
    it("lists unclosed tickets updated before cutoff", async () => {
      const tickets: JitbitTicket[] = [
        { IssueID: 1, Subject: "Stale" },
      ];
      mockListTickets.mockResolvedValue(tickets);
      const result = await service.findTicketsNeedingFollowup({ daysSinceUpdate: 5, limit: 10 });
      expect(mockListTickets).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: "unclosed",
          count: 10,
        }),
      );
      expect(result).toEqual(tickets);
    });

    it("filters out resolved tickets", async () => {
      const tickets: JitbitTicket[] = [
        { IssueID: 1, ResolvedDate: "2025-01-01" },
        { IssueID: 2 },
      ];
      mockListTickets.mockResolvedValue(tickets);
      const result = await service.findTicketsNeedingFollowup({ daysSinceUpdate: 3 });
      expect(result).toHaveLength(1);
      expect(result[0].IssueID).toBe(2);
    });

    it("uses default params", async () => {
      mockListTickets.mockResolvedValue([]);
      await service.findTicketsNeedingFollowup();
      expect(mockListTickets).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: "unclosed",
          count: 25,
        }),
      );
    });
  });

  describe("findHighPriorityOpenTickets", () => {
    it("filters unclosed tickets by high priority", async () => {
      const tickets: JitbitTicket[] = [
        { IssueID: 1, Priority: 2, PriorityName: "Critical" },
        { IssueID: 2, Priority: 1, PriorityName: "High" },
        { IssueID: 3, Priority: -1, PriorityName: "Low" },
      ];
      mockListTickets.mockResolvedValue(tickets);
      const result = await service.findHighPriorityOpenTickets(10);
      expect(result).toHaveLength(2);
    });

    it("respects limit parameter", async () => {
      const tickets: JitbitTicket[] = Array.from({ length: 10 }, (_, i) => ({
        IssueID: i,
        Priority: 2,
        PriorityName: "Critical",
      }));
      mockListTickets.mockResolvedValue(tickets);
      const result = await service.findHighPriorityOpenTickets(3);
      expect(result).toHaveLength(3);
    });
  });
});