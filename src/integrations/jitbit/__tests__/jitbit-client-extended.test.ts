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
    it("posts form-encoded id/id2 to /MergeTickets", async () => {
      mockPost.mockResolvedValue({ data: null });
      await client.mergeTickets(1, 2);
      const payload = mockPost.mock.calls[0][1] as URLSearchParams;
      expect(payload.get("id")).toBe("1");
      expect(payload.get("id2")).toBe("2");
      expect(mockPost.mock.calls[0][0]).toBe("/MergeTickets");
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
    it("posts form-encoded to /AddSubscriber", async () => {
      mockPost.mockResolvedValue({ data: null });
      await client.subscribeToTicket(42);
      const [url, body] = mockPost.mock.calls[0];
      expect(url).toBe("/AddSubscriber");
      expect((body as URLSearchParams).get("id")).toBe("42");
    });

    it("includes optional userId", async () => {
      mockPost.mockResolvedValue({ data: null });
      await client.subscribeToTicket(42, 5);
      const body = mockPost.mock.calls[0][1] as URLSearchParams;
      expect(body.get("userId")).toBe("5");
    });
  });

  describe("unsubscribeFromTicket", () => {
    it("posts form-encoded to /RemoveSubscriber", async () => {
      mockPost.mockResolvedValue({ data: null });
      await client.unsubscribeFromTicket(42);
      const [url, body] = mockPost.mock.calls[0];
      expect(url).toBe("/RemoveSubscriber");
      expect((body as URLSearchParams).get("id")).toBe("42");
    });
  });

  // === Attachments ===

  describe("listAttachments", () => {
    it("calls GET /Attachments?id=", async () => {
      const attachments = [{ ID: 1, FileName: "doc.pdf" }];
      mockGet.mockResolvedValue({ data: attachments });
      const result = await client.listAttachments(42);
      expect(mockGet).toHaveBeenCalledWith("/Attachments", { params: { id: 42 } });
      expect(result).toEqual(attachments);
    });
  });

  describe("getAttachment", () => {
    it("calls GET /attachment?id= with arraybuffer", async () => {
      mockGet.mockResolvedValue({ data: Buffer.from("file-content") });
      await client.getAttachment(7);
      expect(mockGet).toHaveBeenCalledWith("/attachment", { params: { id: 7 }, responseType: "arraybuffer" });
    });
  });

  describe("addAttachment", () => {
    it("posts multipart/form-data to /AttachFile with ticket id in body", async () => {
      mockPost.mockResolvedValue({ data: { id: 8 } });
      const result = await client.addAttachment(42, {
        fileName: "report.pdf",
        data: Buffer.from("pdf-content"),
      });
      const [url, body] = mockPost.mock.calls[0];
      expect(url).toBe("/AttachFile");
      expect(body).toBeInstanceOf(FormData);
      expect(result).toEqual({ id: 8 });
    });
  });

  describe("deleteAttachment", () => {
    it("calls GET /DeleteFile?id= (Jitbit uses GET for delete)", async () => {
      mockGet.mockResolvedValue({ data: null });
      await client.deleteAttachment(7);
      expect(mockGet).toHaveBeenCalledWith("/DeleteFile", { params: { id: 7 } });
    });
  });

  // === Assets ===

  describe("listAssets", () => {
    it("calls GET /Assets with params", async () => {
      const assets = [{ AssetID: 1 }];
      mockGet.mockResolvedValue({ data: assets });
      const result = await client.listAssets({ page: 2 });
      expect(mockGet).toHaveBeenCalledWith("/Assets", { params: { page: 2 } });
      expect(result).toEqual(assets);
    });
  });

  describe("getAsset", () => {
    it("calls GET /Asset?id=", async () => {
      const asset = { AssetID: 1 };
      mockGet.mockResolvedValue({ data: asset });
      const result = await client.getAsset(1);
      expect(mockGet).toHaveBeenCalledWith("/Asset", { params: { id: 1 } });
      expect(result).toEqual(asset);
    });
  });

  describe("createAsset", () => {
    it("posts form-encoded to /Asset", async () => {
      mockPost.mockResolvedValue({ data: { AssetID: 2 } });
      await client.createAsset({ modelName: "Router", serialNumber: "SN-001" });
      const [url, body] = mockPost.mock.calls[0];
      expect(url).toBe("/Asset");
      expect(body).toBeInstanceOf(URLSearchParams);
      expect((body as URLSearchParams).get("modelName")).toBe("Router");
    });
  });

  describe("updateAsset", () => {
    it("posts form-encoded to /UpdateAsset with id", async () => {
      mockPost.mockResolvedValue({ data: { AssetID: 2 } });
      await client.updateAsset(2, { modelName: "Updated Router" });
      const [url, body] = mockPost.mock.calls[0];
      expect(url).toBe("/UpdateAsset");
      expect((body as URLSearchParams).get("id")).toBe("2");
      expect((body as URLSearchParams).get("modelName")).toBe("Updated Router");
    });
  });

  describe("disableAsset", () => {
    it("posts form-encoded to /DisableAsset", async () => {
      mockPost.mockResolvedValue({ data: null });
      await client.disableAsset(2);
      const [url, body] = mockPost.mock.calls[0];
      expect(url).toBe("/DisableAsset");
      expect((body as URLSearchParams).get("assetId")).toBe("2");
    });
  });

  // === Custom Fields ===

  describe("listCustomFields", () => {
    it("calls GET /CustomFields when no categoryId", async () => {
      const fields = [{ FieldID: 1, Name: "Department" }];
      mockGet.mockResolvedValue({ data: fields });
      const result = await client.listCustomFields();
      expect(mockGet).toHaveBeenCalledWith("/CustomFields");
      expect(result).toEqual(fields);
    });

    it("calls GET /CustomFieldsForCategory when categoryId provided", async () => {
      mockGet.mockResolvedValue({ data: [] });
      await client.listCustomFields({ categoryId: 5 });
      expect(mockGet).toHaveBeenCalledWith("/CustomFieldsForCategory", { params: { categoryId: 5 } });
    });
  });

  describe("setCustomFieldValue", () => {
    it("posts form-encoded to /SetCustomField with ticketId, fieldId, value", async () => {
      mockPost.mockResolvedValue({ data: null });
      await client.setCustomFieldValue(42, 10, "Engineering");
      const [url, body] = mockPost.mock.calls[0];
      expect(url).toBe("/SetCustomField");
      expect((body as URLSearchParams).get("ticketId")).toBe("42");
      expect((body as URLSearchParams).get("fieldId")).toBe("10");
      expect((body as URLSearchParams).get("value")).toBe("Engineering");
    });
  });

  describe("getCustomFieldValues", () => {
    it("calls GET /TicketCustomFields?id=", async () => {
      const values = [{ FieldID: 1, Value: "IT" }];
      mockGet.mockResolvedValue({ data: values });
      const result = await client.getCustomFieldValues(42);
      expect(mockGet).toHaveBeenCalledWith("/TicketCustomFields", { params: { id: 42 } });
      expect(result).toEqual(values);
    });
  });

  // === Tags ===

  describe("listTags", () => {
    it("calls GET /Tags", async () => {
      const tags = [{ Name: "urgent" }];
      mockGet.mockResolvedValue({ data: tags });
      const result = await client.listTags();
      expect(mockGet).toHaveBeenCalledWith("/Tags");
      expect(result).toEqual(tags);
    });
  });

  describe("addTag", () => {
    it("posts form-encoded to /TagTicket", async () => {
      mockPost.mockResolvedValue({ data: null });
      await client.addTag(42, "urgent");
      const [url, body] = mockPost.mock.calls[0];
      expect(url).toBe("/TagTicket");
      expect((body as URLSearchParams).get("ticketId")).toBe("42");
      expect((body as URLSearchParams).get("name")).toBe("urgent");
    });
  });

  describe("removeTag", () => {
    it("throws unsupported error", async () => {
      await expect(client.removeTag(42, "urgent")).rejects.toThrow("does not support removing");
    });
  });

  // === Time Tracking ===

  describe("getTimeEntries", () => {
    it("calls GET /TimeSpentLog?ticketId=", async () => {
      const entries = [{ TimeEntryID: 1 }];
      mockGet.mockResolvedValue({ data: entries });
      const result = await client.getTimeEntries(42);
      expect(mockGet).toHaveBeenCalledWith("/TimeSpentLog", { params: { ticketId: 42 } });
      expect(result).toEqual(entries);
    });
  });

  describe("addTimeEntry", () => {
    it("posts form-encoded to /AddTimeSpent", async () => {
      mockPost.mockResolvedValue({ data: { id: 1 } });
      await client.addTimeEntry(42, { timeSpentInSeconds: 3600 });
      const [url, body] = mockPost.mock.calls[0];
      expect(url).toBe("/AddTimeSpent");
      expect((body as URLSearchParams).get("ticketId")).toBe("42");
      expect((body as URLSearchParams).get("timeSpentInSeconds")).toBe("3600");
    });
  });

  describe("deleteTimeEntry", () => {
    it("throws unsupported error", async () => {
      await expect(client.deleteTimeEntry(7)).rejects.toThrow("does not support deleting");
    });
  });

  // === Automation ===

  describe("getAutomationRule", () => {
    it("calls GET /Rule/{id}", async () => {
      const rule = { RuleID: 1, Name: "Auto-close" };
      mockGet.mockResolvedValue({ data: rule });
      const result = await client.getAutomationRule(1);
      expect(mockGet).toHaveBeenCalledWith("/Rule/1");
      expect(result).toEqual(rule);
    });
  });

  describe("disableAutomationRule", () => {
    it("posts to /DisableRule/{id}", async () => {
      mockPost.mockResolvedValue({ data: null });
      await client.disableAutomationRule(3);
      expect(mockPost).toHaveBeenCalledWith("/DisableRule/3", null);
    });
  });
});