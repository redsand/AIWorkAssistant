import { jitbitClient, JitbitClient } from "./jitbit-client";
import type {
  JitbitAddAttachmentParams,
  JitbitAddTimeEntryParams,
  JitbitAsset,
  JitbitAttachment,
  JitbitAutomationRule,
  JitbitComment,
  JitbitCompany,
  JitbitCreateAssetParams,
  JitbitCreateTicketParams,
  JitbitCustomField,
  JitbitCustomFieldValue,
  JitbitForwardTicketParams,
  JitbitListAssetsParams,
  JitbitMergeTicketsParams,
  JitbitSection,
  JitbitTag,
  JitbitTicket,
  JitbitTimeEntry,
  JitbitUpdateAssetParams,
  JitbitUser,
} from "./types";

export interface CustomerSnapshot {
  company: JitbitCompany | null;
  users: JitbitUser[];
  openTickets: JitbitTicket[];
  recentTickets: JitbitTicket[];
  highPriorityOpenTickets: JitbitTicket[];
  summary: {
    companyId?: number;
    companyName?: string;
    userCount: number;
    openTicketCount: number;
    recentTicketCount: number;
    highPriorityOpenTicketCount: number;
  };
}

export class JitbitService {
  constructor(private client: JitbitClient = jitbitClient) {}

  isConfigured(): boolean {
    return this.client.isConfigured();
  }

  async validateConfig(): Promise<boolean> {
    return this.client.validateConfig();
  }

  async getRecentCustomerActivity(params: {
    days?: number;
    limit?: number;
  } = {}): Promise<JitbitTicket[]> {
    const days = params.days ?? 7;
    const limit = params.limit ?? 25;
    const updatedFrom = this.daysAgo(days);
    return this.client.listTickets({
      mode: "all",
      updatedFrom,
      count: limit,
    });
  }

  async searchTickets(
    query: string,
    params: {
      assignedToUserId?: number;
      fromUserId?: number;
      dateFrom?: string;
      dateTo?: string;
      categoryId?: number;
      statusId?: number;
    } = {},
  ): Promise<JitbitTicket[]> {
    return this.client.searchTickets(query, params);
  }

  async addTicketComment(
    ticketId: number | string,
    body: string,
    options: { forTechsOnly?: boolean } = {},
  ): Promise<unknown> {
    return this.client.addTicketComment(ticketId, body, options);
  }

  async getOpenSupportRequests(params: {
    companyId?: number;
    limit?: number;
  } = {}): Promise<JitbitTicket[]> {
    return this.client.listTickets({
      mode: "unclosed",
      fromCompanyId: params.companyId,
      count: params.limit ?? 25,
    });
  }

  async getCustomerSnapshot(
    companyIdOrName: number | string,
  ): Promise<CustomerSnapshot> {
    const company =
      typeof companyIdOrName === "number" || /^\d+$/.test(String(companyIdOrName))
        ? await this.client.getCompany(companyIdOrName)
        : (await this.client.searchCompanies(String(companyIdOrName)))[0] || null;

    const companyId = this.companyId(company);
    const companyName = this.companyName(company) || String(companyIdOrName);
    const [users, openTickets, recentTickets] = await Promise.all([
      companyId ? this.client.listUsers({ companyId, count: 100 }) : this.client.searchUsers(companyName),
      this.getOpenSupportRequests({ companyId, limit: 50 }),
      companyId
        ? this.client.listTickets({ mode: "all", fromCompanyId: companyId, count: 50 })
        : this.client.searchTickets(companyName, {}),
    ]);

    const highPriorityOpenTickets = openTickets.filter((ticket) =>
      this.isHighPriority(ticket),
    );

    return {
      company,
      users,
      openTickets,
      recentTickets,
      highPriorityOpenTickets,
      summary: {
        companyId,
        companyName,
        userCount: users.length,
        openTicketCount: openTickets.length,
        recentTicketCount: recentTickets.length,
        highPriorityOpenTicketCount: highPriorityOpenTickets.length,
      },
    };
  }

  async summarizeTicketForAssistant(ticketId: number | string): Promise<{
    ticket: JitbitTicket;
    comments: JitbitComment[];
    summary: string;
  }> {
    const [ticket, comments] = await Promise.all([
      this.client.getTicket(ticketId),
      this.client.listTicketComments(ticketId),
    ]);
    const latestComment = comments
      .slice()
      .sort(
        (a, b) =>
          new Date(b.CommentDate || 0).getTime() -
          new Date(a.CommentDate || 0).getTime(),
      )[0];
    const summary = [
      `Ticket ${this.ticketId(ticket)}: ${ticket.Subject || "(no subject)"}`,
      `Status: ${ticket.Status || ticket.StatusID || "unknown"}`,
      `Priority: ${ticket.PriorityName || (ticket.Priority ?? "unknown")}`,
      `Customer: ${this.customerName(ticket) || "unknown"}`,
      `Updated: ${ticket.LastUpdated || ticket.IssueDate || "unknown"}`,
      latestComment ? `Latest comment: ${this.compact(latestComment.Body || "", 500)}` : "No comments found",
    ].join("\n");
    return { ticket, comments, summary };
  }

  async findTicketsNeedingFollowup(params: {
    daysSinceUpdate?: number;
    limit?: number;
  } = {}): Promise<JitbitTicket[]> {
    const daysSinceUpdate = params.daysSinceUpdate ?? 3;
    const updatedTo = this.daysAgo(daysSinceUpdate);
    const tickets = await this.client.listTickets({
      mode: "unclosed",
      updatedTo,
      count: params.limit ?? 25,
    });
    return tickets.filter((ticket) => !ticket.ResolvedDate);
  }

  async findHighPriorityOpenTickets(limit: number = 25): Promise<JitbitTicket[]> {
    const tickets = await this.client.listTickets({
      mode: "unclosed",
      count: Math.max(limit, 50),
    });
    return tickets.filter((ticket) => this.isHighPriority(ticket)).slice(0, limit);
  }

  // === Ticket Lifecycle ===

  async createTicket(params: JitbitCreateTicketParams): Promise<JitbitTicket> {
    return this.client.createTicket(params);
  }

  async closeTicket(ticketId: number | string): Promise<unknown> {
    const statuses = await this.client.listStatuses();
    const closedStatus = statuses.find(
      (s) => s.Name.toLowerCase() === "closed" || s.Name.toLowerCase() === "resolved",
    );
    if (!closedStatus) throw new Error("Could not find Closed status");
    return this.client.updateTicket(ticketId, { statusId: closedStatus.StatusID });
  }

  async reopenTicket(ticketId: number | string): Promise<unknown> {
    const statuses = await this.client.listStatuses();
    const openStatus = statuses.find(
      (s) => s.Name.toLowerCase() === "new" || s.Name.toLowerCase() === "open",
    );
    if (!openStatus) throw new Error("Could not find Open/New status");
    return this.client.updateTicket(ticketId, { statusId: openStatus.StatusID });
  }

  async assignTicket(ticketId: number | string, assignedUserId: number): Promise<unknown> {
    return this.client.updateTicket(ticketId, { assignedUserId });
  }

  async deleteTicket(ticketId: number): Promise<unknown> {
    return this.client.deleteTicket(ticketId);
  }

  async mergeTickets(params: JitbitMergeTicketsParams): Promise<unknown> {
    return this.client.mergeTickets(params);
  }

  async forwardTicket(ticketId: number, params: JitbitForwardTicketParams): Promise<unknown> {
    return this.client.forwardTicket(ticketId, params);
  }

  async subscribeToTicket(ticketId: number, userId?: number): Promise<unknown> {
    return this.client.subscribeToTicket(ticketId, userId);
  }

  async unsubscribeFromTicket(ticketId: number, userId?: number): Promise<unknown> {
    return this.client.unsubscribeFromTicket(ticketId, userId);
  }

  // === Attachments ===

  async listAttachments(ticketId: number): Promise<JitbitAttachment[]> {
    return this.client.listAttachments(ticketId);
  }

  async getAttachment(attachmentId: number): Promise<unknown> {
    return this.client.getAttachment(attachmentId);
  }

  async addAttachment(ticketId: number, params: JitbitAddAttachmentParams): Promise<unknown> {
    return this.client.addAttachment(ticketId, params);
  }

  async deleteAttachment(attachmentId: number): Promise<unknown> {
    return this.client.deleteAttachment(attachmentId);
  }

  // === Assets ===

  async listAssets(params: JitbitListAssetsParams = {}): Promise<JitbitAsset[]> {
    return this.client.listAssets(params);
  }

  async getAsset(assetId: number): Promise<JitbitAsset> {
    return this.client.getAsset(assetId);
  }

  async createAsset(params: JitbitCreateAssetParams): Promise<JitbitAsset> {
    return this.client.createAsset(params);
  }

  async updateAsset(assetId: number, params: JitbitUpdateAssetParams): Promise<JitbitAsset> {
    return this.client.updateAsset(assetId, params);
  }

  async deleteAsset(assetId: number): Promise<unknown> {
    return this.client.deleteAsset(assetId);
  }

  async searchAssets(query: string): Promise<JitbitAsset[]> {
    return this.client.listAssets({ search: query });
  }

  async getAssetTickets(assetId: number): Promise<JitbitTicket[]> {
    return this.client.getAssetTickets(assetId);
  }

  // === Custom Fields ===

  async listCustomFields(categoryId?: number): Promise<JitbitCustomField[]> {
    return this.client.listCustomFields(categoryId ? { categoryId } : undefined);
  }

  async getCustomFieldValues(ticketId: number): Promise<JitbitCustomFieldValue[]> {
    return this.client.getCustomFieldValues(ticketId);
  }

  async setCustomFieldValue(ticketId: number, fieldId: number, value: string): Promise<unknown> {
    return this.client.setCustomFieldValue(ticketId, fieldId, value);
  }

  // === Tags ===

  async listTags(): Promise<JitbitTag[]> {
    return this.client.listTags();
  }

  async addTag(ticketId: number, tagName: string): Promise<unknown> {
    return this.client.addTag(ticketId, tagName);
  }

  async removeTag(ticketId: number, tagName: string): Promise<unknown> {
    return this.client.removeTag(ticketId, tagName);
  }

  // === Sections ===

  async listSections(categoryId?: number): Promise<JitbitSection[]> {
    return this.client.listSections(categoryId);
  }

  // === Time Tracking ===

  async getTimeEntries(ticketId: number): Promise<JitbitTimeEntry[]> {
    return this.client.getTimeEntries(ticketId);
  }

  async addTimeEntry(ticketId: number, params: JitbitAddTimeEntryParams): Promise<unknown> {
    return this.client.addTimeEntry(ticketId, params);
  }

  async deleteTimeEntry(entryId: number): Promise<unknown> {
    return this.client.deleteTimeEntry(entryId);
  }

  // === Automation ===

  async listAutomationRules(categoryId?: number): Promise<JitbitAutomationRule[]> {
    return this.client.listAutomationRules(categoryId);
  }

  async triggerAutomation(ticketId: number, ruleId: number): Promise<unknown> {
    return this.client.triggerAutomation(ticketId, ruleId);
  }

  private isHighPriority(ticket: JitbitTicket): boolean {
    const priorityName = String(ticket.PriorityName || "").toLowerCase();
    return (
      Number(ticket.Priority) >= 1 ||
      priorityName.includes("high") ||
      priorityName.includes("critical")
    );
  }

  private daysAgo(days: number): string {
    const date = new Date();
    date.setDate(date.getDate() - days);
    return date.toISOString().slice(0, 10);
  }

  private ticketId(ticket: JitbitTicket): number | string {
    return ticket.TicketID || ticket.IssueID || "unknown";
  }

  private customerName(ticket: JitbitTicket): string {
    return (
      ticket.CompanyName ||
      [ticket.FirstName, ticket.LastName].filter(Boolean).join(" ") ||
      ticket.UserName ||
      ticket.Username ||
      ticket.Email ||
      ""
    );
  }

  private companyId(company: JitbitCompany | null): number | undefined {
    const id = company?.CompanyID ?? company?.CompanyId ?? company?.ID;
    return typeof id === "number" ? id : undefined;
  }

  private companyName(company: JitbitCompany | null): string | undefined {
    return company?.Name || company?.CompanyName;
  }

  private compact(value: string, max: number): string {
    const normalized = value.replace(/\s+/g, " ").trim();
    return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
  }
}

export const jitbitService = new JitbitService();
