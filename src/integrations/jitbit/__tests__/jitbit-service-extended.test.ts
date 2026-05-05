import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockIsConfigured,
  mockListStatuses,
  mockUpdateTicket,
  mockCreateTicket,
  mockDeleteTicket,
  mockMergeTickets,
  mockForwardTicket,
  mockListAssets,
  mockCreateAsset,
  mockUpdateAsset,
  mockDeleteAsset,
  mockGetAsset,
  mockGetAssetTickets,
  mockListCustomFields,
  mockGetCustomFieldValues,
  mockSetCustomFieldValue,
  mockListTags,
  mockAddTag,
  mockRemoveTag,
  mockListSections,
  mockGetTimeEntries,
  mockAddTimeEntry,
  mockListAutomationRules,
  mockTriggerAutomation,
} = vi.hoisted(() => ({
  mockIsConfigured: vi.fn(),
  mockListStatuses: vi.fn(),
  mockUpdateTicket: vi.fn(),
  mockCreateTicket: vi.fn(),
  mockDeleteTicket: vi.fn(),
  mockMergeTickets: vi.fn(),
  mockForwardTicket: vi.fn(),
  mockListAssets: vi.fn(),
  mockCreateAsset: vi.fn(),
  mockUpdateAsset: vi.fn(),
  mockDeleteAsset: vi.fn(),
  mockGetAsset: vi.fn(),
  mockGetAssetTickets: vi.fn(),
  mockListCustomFields: vi.fn(),
  mockGetCustomFieldValues: vi.fn(),
  mockSetCustomFieldValue: vi.fn(),
  mockListTags: vi.fn(),
  mockAddTag: vi.fn(),
  mockRemoveTag: vi.fn(),
  mockListSections: vi.fn(),
  mockGetTimeEntries: vi.fn(),
  mockAddTimeEntry: vi.fn(),
  mockListAutomationRules: vi.fn(),
  mockTriggerAutomation: vi.fn(),
}));

vi.mock("../jitbit-client", () => ({
  JitbitClient: vi.fn(() => ({
    isConfigured: mockIsConfigured,
    listStatuses: mockListStatuses,
    updateTicket: mockUpdateTicket,
    createTicket: mockCreateTicket,
    deleteTicket: mockDeleteTicket,
    mergeTickets: mockMergeTickets,
    forwardTicket: mockForwardTicket,
    listAssets: mockListAssets,
    createAsset: mockCreateAsset,
    updateAsset: mockUpdateAsset,
    deleteAsset: mockDeleteAsset,
    getAsset: mockGetAsset,
    getAssetTickets: mockGetAssetTickets,
    listCustomFields: mockListCustomFields,
    getCustomFieldValues: mockGetCustomFieldValues,
    setCustomFieldValue: mockSetCustomFieldValue,
    listTags: mockListTags,
    addTag: mockAddTag,
    removeTag: mockRemoveTag,
    listSections: mockListSections,
    getTimeEntries: mockGetTimeEntries,
    addTimeEntry: mockAddTimeEntry,
    listAutomationRules: mockListAutomationRules,
    triggerAutomation: mockTriggerAutomation,
    getBaseUrl: vi.fn(() => "https://test.jitbit.com/helpdesk/api"),
  })),
  jitbitClient: {
    isConfigured: mockIsConfigured,
    listStatuses: mockListStatuses,
    updateTicket: mockUpdateTicket,
    createTicket: mockCreateTicket,
    deleteTicket: mockDeleteTicket,
    mergeTickets: mockMergeTickets,
    forwardTicket: mockForwardTicket,
    listAssets: mockListAssets,
    createAsset: mockCreateAsset,
    updateAsset: mockUpdateAsset,
    deleteAsset: mockDeleteAsset,
    getAsset: mockGetAsset,
    getAssetTickets: mockGetAssetTickets,
    listCustomFields: mockListCustomFields,
    getCustomFieldValues: mockGetCustomFieldValues,
    setCustomFieldValue: mockSetCustomFieldValue,
    listTags: mockListTags,
    addTag: mockAddTag,
    removeTag: mockRemoveTag,
    listSections: mockListSections,
    getTimeEntries: mockGetTimeEntries,
    addTimeEntry: mockAddTimeEntry,
    listAutomationRules: mockListAutomationRules,
    triggerAutomation: mockTriggerAutomation,
    getBaseUrl: vi.fn(() => "https://test.jitbit.com/helpdesk/api"),
  },
}));

import { JitbitService } from "../jitbit-service";
import type { JitbitStatus } from "../types";

describe("JitbitService — Extended Methods", () => {
  let service: JitbitService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsConfigured.mockReturnValue(true);
    service = new JitbitService();
  });

  // === Ticket Lifecycle ===

  describe("createTicket", () => {
    it("delegates to client", async () => {
      mockCreateTicket.mockResolvedValue({ IssueID: 99 });
      const result = await service.createTicket({ categoryId: 5, subject: "Bug" });
      expect(mockCreateTicket).toHaveBeenCalledWith({ categoryId: 5, subject: "Bug" });
      expect(result).toEqual({ IssueID: 99 });
    });
  });

  describe("closeTicket", () => {
    it("finds Closed status and updates ticket", async () => {
      mockListStatuses.mockResolvedValue([
        { StatusID: 1, Name: "New" },
        { StatusID: 3, Name: "Closed" },
      ] as JitbitStatus[]);
      mockUpdateTicket.mockResolvedValue({});
      await service.closeTicket(42);
      expect(mockListStatuses).toHaveBeenCalled();
      expect(mockUpdateTicket).toHaveBeenCalledWith(42, { statusId: 3 });
    });

    it("also matches Resolved status", async () => {
      mockListStatuses.mockResolvedValue([
        { StatusID: 1, Name: "New" },
        { StatusID: 5, Name: "Resolved" },
      ] as JitbitStatus[]);
      mockUpdateTicket.mockResolvedValue({});
      await service.closeTicket(42);
      expect(mockUpdateTicket).toHaveBeenCalledWith(42, { statusId: 5 });
    });

    it("throws if no Closed/Resolved status found", async () => {
      mockListStatuses.mockResolvedValue([
        { StatusID: 1, Name: "New" },
        { StatusID: 2, Name: "In Progress" },
      ] as JitbitStatus[]);
      await expect(service.closeTicket(42)).rejects.toThrow("Could not find Closed status");
    });
  });

  describe("reopenTicket", () => {
    it("finds New status and updates ticket", async () => {
      mockListStatuses.mockResolvedValue([
        { StatusID: 1, Name: "New" },
        { StatusID: 3, Name: "Closed" },
      ] as JitbitStatus[]);
      mockUpdateTicket.mockResolvedValue({});
      await service.reopenTicket(42);
      expect(mockUpdateTicket).toHaveBeenCalledWith(42, { statusId: 1 });
    });

    it("falls back to Open status if New not found", async () => {
      mockListStatuses.mockResolvedValue([
        { StatusID: 2, Name: "Open" },
        { StatusID: 3, Name: "Closed" },
      ] as JitbitStatus[]);
      mockUpdateTicket.mockResolvedValue({});
      await service.reopenTicket(42);
      expect(mockUpdateTicket).toHaveBeenCalledWith(42, { statusId: 2 });
    });

    it("throws if no Open/New status found", async () => {
      mockListStatuses.mockResolvedValue([
        { StatusID: 3, Name: "Closed" },
      ] as JitbitStatus[]);
      await expect(service.reopenTicket(42)).rejects.toThrow("Could not find Open/New status");
    });
  });

  describe("assignTicket", () => {
    it("calls updateTicket with assignedUserId", async () => {
      mockUpdateTicket.mockResolvedValue({});
      await service.assignTicket(42, 5);
      expect(mockUpdateTicket).toHaveBeenCalledWith(42, { assignedUserId: 5 });
    });
  });

  describe("deleteTicket", () => {
    it("delegates to client", async () => {
      mockDeleteTicket.mockResolvedValue(null);
      await service.deleteTicket(42);
      expect(mockDeleteTicket).toHaveBeenCalledWith(42);
    });
  });

  describe("mergeTickets", () => {
    it("delegates to client", async () => {
      mockMergeTickets.mockResolvedValue(null);
      await service.mergeTickets({ targetTicketId: 1, sourceTicketIds: [2, 3] });
      expect(mockMergeTickets).toHaveBeenCalledWith({ targetTicketId: 1, sourceTicketIds: [2, 3] });
    });
  });

  describe("forwardTicket", () => {
    it("delegates to client", async () => {
      mockForwardTicket.mockResolvedValue(null);
      await service.forwardTicket(42, { toEmail: "admin@test.com" });
      expect(mockForwardTicket).toHaveBeenCalledWith(42, { toEmail: "admin@test.com" });
    });
  });

  // === Assets ===

  describe("listAssets", () => {
    it("delegates to client with params", async () => {
      mockListAssets.mockResolvedValue([{ AssetID: 1 }]);
      const result = await service.listAssets({ search: "laptop" });
      expect(mockListAssets).toHaveBeenCalledWith({ search: "laptop" });
      expect(result).toEqual([{ AssetID: 1 }]);
    });
  });

  describe("searchAssets", () => {
    it("calls listAssets with search query", async () => {
      mockListAssets.mockResolvedValue([{ AssetID: 1, Name: "Laptop" }]);
      const result = await service.searchAssets("laptop");
      expect(mockListAssets).toHaveBeenCalledWith({ search: "laptop" });
      expect(result).toEqual([{ AssetID: 1, Name: "Laptop" }]);
    });
  });

  describe("createAsset", () => {
    it("delegates to client", async () => {
      mockCreateAsset.mockResolvedValue({ AssetID: 2 });
      const result = await service.createAsset({ name: "Router" });
      expect(mockCreateAsset).toHaveBeenCalledWith({ name: "Router" });
      expect(result).toEqual({ AssetID: 2 });
    });
  });

  describe("updateAsset", () => {
    it("delegates to client", async () => {
      mockUpdateAsset.mockResolvedValue({ AssetID: 2 });
      await service.updateAsset(2, { name: "Updated" });
      expect(mockUpdateAsset).toHaveBeenCalledWith(2, { name: "Updated" });
    });
  });

  describe("deleteAsset", () => {
    it("delegates to client", async () => {
      mockDeleteAsset.mockResolvedValue(null);
      await service.deleteAsset(2);
      expect(mockDeleteAsset).toHaveBeenCalledWith(2);
    });
  });

  describe("getAssetTickets", () => {
    it("delegates to client", async () => {
      mockGetAssetTickets.mockResolvedValue([{ IssueID: 1 }]);
      const result = await service.getAssetTickets(2);
      expect(mockGetAssetTickets).toHaveBeenCalledWith(2);
      expect(result).toEqual([{ IssueID: 1 }]);
    });
  });

  // === Custom Fields ===

  describe("listCustomFields", () => {
    it("delegates to client without categoryId", async () => {
      mockListCustomFields.mockResolvedValue([]);
      await service.listCustomFields();
      expect(mockListCustomFields).toHaveBeenCalledWith(undefined);
    });

    it("delegates to client with categoryId", async () => {
      mockListCustomFields.mockResolvedValue([]);
      await service.listCustomFields(5);
      expect(mockListCustomFields).toHaveBeenCalledWith({ categoryId: 5 });
    });
  });

  describe("getCustomFieldValues", () => {
    it("delegates to client", async () => {
      mockGetCustomFieldValues.mockResolvedValue([{ FieldID: 1, Value: "IT" }]);
      const result = await service.getCustomFieldValues(42);
      expect(mockGetCustomFieldValues).toHaveBeenCalledWith(42);
      expect(result).toEqual([{ FieldID: 1, Value: "IT" }]);
    });
  });

  describe("setCustomFieldValue", () => {
    it("delegates to client", async () => {
      mockSetCustomFieldValue.mockResolvedValue(null);
      await service.setCustomFieldValue(42, 10, "Engineering");
      expect(mockSetCustomFieldValue).toHaveBeenCalledWith(42, 10, "Engineering");
    });
  });

  // === Tags ===

  describe("listTags", () => {
    it("delegates to client", async () => {
      mockListTags.mockResolvedValue([{ Name: "urgent" }]);
      const result = await service.listTags();
      expect(mockListTags).toHaveBeenCalled();
      expect(result).toEqual([{ Name: "urgent" }]);
    });
  });

  describe("addTag", () => {
    it("delegates to client", async () => {
      mockAddTag.mockResolvedValue(null);
      await service.addTag(42, "urgent");
      expect(mockAddTag).toHaveBeenCalledWith(42, "urgent");
    });
  });

  describe("removeTag", () => {
    it("delegates to client", async () => {
      mockRemoveTag.mockResolvedValue(null);
      await service.removeTag(42, "urgent");
      expect(mockRemoveTag).toHaveBeenCalledWith(42, "urgent");
    });
  });

  // === Time Tracking ===

  describe("getTimeEntries", () => {
    it("delegates to client", async () => {
      mockGetTimeEntries.mockResolvedValue([{ TimeEntryID: 1, Minutes: 30 }]);
      const result = await service.getTimeEntries(42);
      expect(mockGetTimeEntries).toHaveBeenCalledWith(42);
      expect(result).toEqual([{ TimeEntryID: 1, Minutes: 30 }]);
    });
  });

  describe("addTimeEntry", () => {
    it("delegates to client", async () => {
      mockAddTimeEntry.mockResolvedValue({ id: 1 });
      await service.addTimeEntry(42, { minutes: 60, comment: "Work done" });
      expect(mockAddTimeEntry).toHaveBeenCalledWith(42, { minutes: 60, comment: "Work done" });
    });
  });

  // === Sections ===

  describe("listSections", () => {
    it("delegates to client without categoryId", async () => {
      mockListSections.mockResolvedValue([]);
      await service.listSections();
      expect(mockListSections).toHaveBeenCalledWith(undefined);
    });

    it("delegates to client with categoryId", async () => {
      mockListSections.mockResolvedValue([]);
      await service.listSections(5);
      expect(mockListSections).toHaveBeenCalledWith(5);
    });
  });

  // === Automation ===

  describe("listAutomationRules", () => {
    it("delegates to client", async () => {
      mockListAutomationRules.mockResolvedValue([{ RuleID: 1, Name: "Auto-close" }]);
      const result = await service.listAutomationRules();
      expect(mockListAutomationRules).toHaveBeenCalledWith(undefined);
      expect(result).toEqual([{ RuleID: 1, Name: "Auto-close" }]);
    });

    it("delegates to client with categoryId", async () => {
      mockListAutomationRules.mockResolvedValue([]);
      await service.listAutomationRules(5);
      expect(mockListAutomationRules).toHaveBeenCalledWith(5);
    });
  });

  describe("triggerAutomation", () => {
    it("delegates to client", async () => {
      mockTriggerAutomation.mockResolvedValue(null);
      await service.triggerAutomation(42, 3);
      expect(mockTriggerAutomation).toHaveBeenCalledWith(42, 3);
    });
  });
});