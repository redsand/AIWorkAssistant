import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGet, mockPost, mockDelete, mockPut, mockInterceptorsResponseUse } =
  vi.hoisted(() => ({
    mockGet: vi.fn(),
    mockPost: vi.fn(),
    mockDelete: vi.fn(),
    mockPut: vi.fn(),
    mockInterceptorsResponseUse: vi.fn(),
  }));

vi.mock("axios", () => ({
  default: {
    create: vi.fn(() => ({
      get: mockGet,
      post: mockPost,
      delete: mockDelete,
      put: mockPut,
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

describe("JitbitClient — Extended Methods", () => {
  let client: JitbitClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new JitbitClient();
  });

  // === Ticket Lifecycle ===

  describe("createTicket", () => {
    it("posts form-encoded to /Ticket with required fields", async () => {
      mockPost.mockResolvedValue({ data: { IssueID: 99 } });
      const result = await client.createTicket({ categoryId: 5, subject: "New ticket" });
      expect(mockPost).toHaveBeenCalledWith("/Ticket", expect.any(URLSearchParams), {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
      const body = mockPost.mock.calls[0][1] as URLSearchParams;
      expect(body.get("categoryId")).toBe("5");
      expect(body.get("subject")).toBe("New ticket");
      expect(result).toEqual({ IssueID: 99 });
    });

    it("includes optional fields when provided", async () => {
      mockPost.mockResolvedValue({ data: { IssueID: 100 } });
      await client.createTicket({
        categoryId: 5,
        subject: "Test",
        body: "Description",
        priorityId: 2,
        tags: "urgent",
        companyId: 10,
      });
      const body = mockPost.mock.calls[0][1] as URLSearchParams;
      expect(body.get("body")).toBe("Description");
      expect(body.get("priorityId")).toBe("2");
      expect(body.get("tags")).toBe("urgent");
      expect(body.get("companyId")).toBe("10");
    });
  });

  describe("deleteTicket", () => {
    it("calls DELETE /Ticket with id param", async () => {
      mockDelete.mockResolvedValue({ data: null });
      await client.deleteTicket(42);
      expect(mockDelete).toHaveBeenCalledWith("/Ticket", { params: { id: 42 } });
    });
  });

  describe("mergeTickets", () => {
    it("posts JSON body to /MergeTickets", async () => {
      mockPost.mockResolvedValue({ data: null });
      await client.mergeTickets({ targetTicketId: 1, sourceTicketIds: [2, 3] });
      expect(mockPost).toHaveBeenCalledWith("/MergeTickets", {
        targetTicketId: 1,
        sourceTicketIds: [2, 3],
      });
    });
  });

  describe("forwardTicket", () => {
    it("posts form-encoded to /ForwardTicket", async () => {
      mockPost.mockResolvedValue({ data: null });
      await client.forwardTicket(42, { toEmail: "admin@test.com" });
      expect(mockPost).toHaveBeenCalledWith("/ForwardTicket", expect.any(URLSearchParams), {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
      const body = mockPost.mock.calls[0][1] as URLSearchParams;
      expect(body.get("id")).toBe("42");
      expect(body.get("to")).toBe("admin@test.com");
    });

    it("includes cc and body when provided", async () => {
      mockPost.mockResolvedValue({ data: null });
      await client.forwardTicket(42, { toEmail: "a@b.com", ccEmails: ["c@d.com"], body: "FYI" });
      const body = mockPost.mock.calls[0][1] as URLSearchParams;
      expect(body.get("cc")).toBe("c@d.com");
      expect(body.get("body")).toBe("FYI");
    });
  });

  describe("subscribeToTicket", () => {
    it("posts to /Subscribe with id param", async () => {
      mockPost.mockResolvedValue({ data: null });
      await client.subscribeToTicket(42);
      expect(mockPost).toHaveBeenCalledWith("/Subscribe", null, { params: { id: 42 } });
    });

    it("includes optional userId", async () => {
      mockPost.mockResolvedValue({ data: null });
      await client.subscribeToTicket(42, 5);
      expect(mockPost).toHaveBeenCalledWith("/Subscribe", null, { params: { id: 42, userId: 5 } });
    });
  });

  describe("unsubscribeFromTicket", () => {
    it("calls DELETE /Subscribe with id", async () => {
      mockDelete.mockResolvedValue({ data: null });
      await client.unsubscribeFromTicket(42);
      expect(mockDelete).toHaveBeenCalledWith("/Subscribe", { params: { id: 42 } });
    });
  });

  // === Attachments ===

  describe("listAttachments", () => {
    it("calls GET /Ticket/{id}/Attachments", async () => {
      const attachments = [{ ID: 1, FileName: "doc.pdf" }];
      mockGet.mockResolvedValue({ data: attachments });
      const result = await client.listAttachments(42);
      expect(mockGet).toHaveBeenCalledWith("/Ticket/42/Attachments");
      expect(result).toEqual(attachments);
    });
  });

  describe("getAttachment", () => {
    it("calls GET /Attachment/{id} with arraybuffer", async () => {
      mockGet.mockResolvedValue({ data: Buffer.from("file-content") });
      const result = await client.getAttachment(7);
      expect(mockGet).toHaveBeenCalledWith("/Attachment/7", { responseType: "arraybuffer" });
      expect(result).toBeDefined();
    });
  });

  describe("addAttachment", () => {
    it("posts multipart/form-data to /Ticket/{id}/Attachments", async () => {
      mockPost.mockResolvedValue({ data: { id: 8 } });
      const result = await client.addAttachment(42, {
        fileName: "report.pdf",
        data: Buffer.from("pdf-content"),
        commentBody: "See attached",
      });
      expect(mockPost).toHaveBeenCalledWith("/Ticket/42/Attachments", expect.any(FormData));
      expect(result).toEqual({ id: 8 });
    });
  });

  describe("deleteAttachment", () => {
    it("calls DELETE /Attachment/{id}", async () => {
      mockDelete.mockResolvedValue({ data: null });
      await client.deleteAttachment(7);
      expect(mockDelete).toHaveBeenCalledWith("/Attachment/7");
    });
  });

  // === Assets ===

  describe("listAssets", () => {
    it("calls GET /Assets with params", async () => {
      const assets = [{ AssetID: 1, Name: "Laptop" }];
      mockGet.mockResolvedValue({ data: assets });
      const result = await client.listAssets({ search: "laptop", count: 10 });
      expect(mockGet).toHaveBeenCalledWith("/Assets", { params: { search: "laptop", count: 10 } });
      expect(result).toEqual(assets);
    });
  });

  describe("getAsset", () => {
    it("calls GET /Assets/{id}", async () => {
      const asset = { AssetID: 1, Name: "Server" };
      mockGet.mockResolvedValue({ data: asset });
      const result = await client.getAsset(1);
      expect(mockGet).toHaveBeenCalledWith("/Assets/1");
      expect(result).toEqual(asset);
    });
  });

  describe("createAsset", () => {
    it("posts JSON to /Assets", async () => {
      mockPost.mockResolvedValue({ data: { AssetID: 2 } });
      const result = await client.createAsset({ name: "Router", serialNumber: "SN-001" });
      expect(mockPost).toHaveBeenCalledWith("/Assets", { name: "Router", serialNumber: "SN-001" });
      expect(result).toEqual({ AssetID: 2 });
    });
  });

  describe("updateAsset", () => {
    it("calls PUT /Assets/{id} with JSON body", async () => {
      mockPut.mockResolvedValue({ data: { AssetID: 2 } });
      const result = await client.updateAsset(2, { name: "Updated Router" });
      expect(mockPut).toHaveBeenCalledWith("/Assets/2", { name: "Updated Router" });
      expect(result).toEqual({ AssetID: 2 });
    });
  });

  describe("deleteAsset", () => {
    it("calls DELETE /Assets/{id}", async () => {
      mockDelete.mockResolvedValue({ data: null });
      await client.deleteAsset(2);
      expect(mockDelete).toHaveBeenCalledWith("/Assets/2");
    });
  });

  describe("getAssetTickets", () => {
    it("calls GET /Assets/{id}/Tickets", async () => {
      const tickets = [{ IssueID: 1 }];
      mockGet.mockResolvedValue({ data: tickets });
      const result = await client.getAssetTickets(2);
      expect(mockGet).toHaveBeenCalledWith("/Assets/2/Tickets");
      expect(result).toEqual(tickets);
    });
  });

  // === Custom Fields ===

  describe("listCustomFields", () => {
    it("calls GET /CustomFields", async () => {
      const fields = [{ FieldID: 1, Name: "Department" }];
      mockGet.mockResolvedValue({ data: fields });
      const result = await client.listCustomFields();
      expect(mockGet).toHaveBeenCalledWith("/CustomFields", { params: undefined });
      expect(result).toEqual(fields);
    });

    it("supports categoryId filter", async () => {
      mockGet.mockResolvedValue({ data: [] });
      await client.listCustomFields({ categoryId: 5 });
      expect(mockGet).toHaveBeenCalledWith("/CustomFields", { params: { categoryId: 5 } });
    });
  });

  describe("setCustomFieldValue", () => {
    it("posts form-encoded to /CustomFields/{fieldId}/Value", async () => {
      mockPost.mockResolvedValue({ data: null });
      await client.setCustomFieldValue(42, 10, "Engineering");
      expect(mockPost).toHaveBeenCalledWith(
        "/CustomFields/10/Value",
        expect.any(URLSearchParams),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
      );
      const body = mockPost.mock.calls[0][1] as URLSearchParams;
      expect(body.get("id")).toBe("42");
      expect(body.get("value")).toBe("Engineering");
    });
  });

  describe("getCustomFieldValues", () => {
    it("calls GET /CustomFields/Values with id", async () => {
      const values = [{ FieldID: 1, Name: "Dept", Value: "IT" }];
      mockGet.mockResolvedValue({ data: values });
      const result = await client.getCustomFieldValues(42);
      expect(mockGet).toHaveBeenCalledWith("/CustomFields/Values", { params: { id: 42 } });
      expect(result).toEqual(values);
    });
  });

  // === Tags ===

  describe("listTags", () => {
    it("calls GET /Tags", async () => {
      const tags = [{ Name: "urgent", TagCount: 5 }];
      mockGet.mockResolvedValue({ data: tags });
      const result = await client.listTags();
      expect(mockGet).toHaveBeenCalledWith("/Tags");
      expect(result).toEqual(tags);
    });
  });

  describe("addTag", () => {
    it("posts to /Tag with id and name params", async () => {
      mockPost.mockResolvedValue({ data: null });
      await client.addTag(42, "urgent");
      expect(mockPost).toHaveBeenCalledWith("/Tag", null, { params: { id: 42, name: "urgent" } });
    });
  });

  describe("removeTag", () => {
    it("calls DELETE /Tag with id and name params", async () => {
      mockDelete.mockResolvedValue({ data: null });
      await client.removeTag(42, "urgent");
      expect(mockDelete).toHaveBeenCalledWith("/Tag", { params: { id: 42, name: "urgent" } });
    });
  });

  // === Sections ===

  describe("listSections", () => {
    it("calls GET /Sections", async () => {
      const sections = [{ SectionID: 1, Name: "General" }];
      mockGet.mockResolvedValue({ data: sections });
      const result = await client.listSections();
      expect(mockGet).toHaveBeenCalledWith("/Sections", { params: undefined });
      expect(result).toEqual(sections);
    });

    it("supports categoryId filter", async () => {
      mockGet.mockResolvedValue({ data: [] });
      await client.listSections(5);
      expect(mockGet).toHaveBeenCalledWith("/Sections", { params: { categoryId: 5 } });
    });
  });

  // === Time Tracking ===

  describe("getTimeEntries", () => {
    it("calls GET /Ticket/{id}/TimeTracking", async () => {
      const entries = [{ TimeEntryID: 1, Minutes: 30 }];
      mockGet.mockResolvedValue({ data: entries });
      const result = await client.getTimeEntries(42);
      expect(mockGet).toHaveBeenCalledWith("/Ticket/42/TimeTracking");
      expect(result).toEqual(entries);
    });
  });

  describe("addTimeEntry", () => {
    it("posts JSON to /Ticket/{id}/TimeTracking", async () => {
      mockPost.mockResolvedValue({ data: { id: 1 } });
      await client.addTimeEntry(42, { minutes: 60, comment: "Testing", billable: true });
      expect(mockPost).toHaveBeenCalledWith("/Ticket/42/TimeTracking", {
        minutes: 60,
        comment: "Testing",
        billable: true,
      });
    });
  });

  describe("deleteTimeEntry", () => {
    it("calls DELETE /TimeTracking/{id}", async () => {
      mockDelete.mockResolvedValue({ data: null });
      await client.deleteTimeEntry(7);
      expect(mockDelete).toHaveBeenCalledWith("/TimeTracking/7");
    });
  });

  // === Automation ===

  describe("listAutomationRules", () => {
    it("calls GET /AutomationRules", async () => {
      const rules = [{ RuleID: 1, Name: "Auto-close" }];
      mockGet.mockResolvedValue({ data: rules });
      const result = await client.listAutomationRules();
      expect(mockGet).toHaveBeenCalledWith("/AutomationRules", { params: undefined });
      expect(result).toEqual(rules);
    });

    it("supports categoryId filter", async () => {
      mockGet.mockResolvedValue({ data: [] });
      await client.listAutomationRules(5);
      expect(mockGet).toHaveBeenCalledWith("/AutomationRules", { params: { categoryId: 5 } });
    });
  });

  describe("triggerAutomation", () => {
    it("posts to /AutomationRules/{ruleId}/Execute with ticket id", async () => {
      mockPost.mockResolvedValue({ data: null });
      await client.triggerAutomation(42, 3);
      expect(mockPost).toHaveBeenCalledWith("/AutomationRules/3/Execute", null, {
        params: { id: 42 },
      });
    });
  });
});