export interface JitbitTicket {
  IssueID?: number;
  TicketID?: number;
  Priority?: number;
  PriorityName?: string;
  StatusID?: number;
  Status?: string;
  IssueDate?: string;
  Subject?: string;
  Body?: string;
  CategoryID?: number;
  Category?: string;
  CategoryName?: string;
  UserID?: number;
  UserName?: string;
  Username?: string;
  Email?: string;
  FirstName?: string;
  LastName?: string;
  CompanyID?: number | null;
  CompanyName?: string | null;
  AssignedToUserID?: number | null;
  Technician?: string | null;
  DueDate?: string | null;
  ResolvedDate?: string | null;
  LastUpdated?: string;
  UpdatedByUser?: boolean;
  UpdatedByPerformer?: boolean;
  UpdatedForTechView?: boolean;
  Tags?: Array<{ TagID?: number; Name?: string; TagCount?: number }>;
  Attachments?: unknown[];
  [key: string]: unknown;
}

export interface JitbitComment {
  CommentID: number;
  IssueID: number;
  UserID: number;
  UserName?: string;
  Email?: string;
  FirstName?: string;
  LastName?: string;
  IsSystem?: boolean;
  CommentDate?: string;
  ForTechsOnly?: boolean;
  Body?: string;
  TicketSubject?: string | null;
  Recipients?: string;
}

export interface JitbitUser {
  UserID: number;
  FirstName?: string;
  LastName?: string;
  Notes?: string | null;
  Location?: string;
  Phone?: string;
  CompanyName?: string | null;
  CompanyId?: number | null;
  CompanyID?: number | null;
  DepartmentID?: number | null;
  LastSeen?: string | null;
  Username?: string;
  Email?: string;
  IsAdmin?: boolean;
  Disabled?: boolean;
  [key: string]: unknown;
}

export interface JitbitCompany {
  CompanyID?: number;
  CompanyId?: number;
  ID?: number;
  Name?: string;
  CompanyName?: string;
  Notes?: string | null;
  [key: string]: unknown;
}

export interface JitbitCategory {
  CategoryID: number;
  Name: string;
  SectionID?: number | null;
  Section?: string | null;
  NameWithSection?: string;
  ForTechsOnly?: boolean;
  FromAddress?: string | null;
}

export interface JitbitPriority {
  PriorityID: number;
  Name: string;
}

export interface JitbitStatus {
  StatusID: number;
  Name: string;
  Color?: string | null;
  [key: string]: unknown;
}

export interface JitbitListTicketsParams {
  mode?: "all" | "unanswered" | "unclosed" | "handledbyme";
  categoryId?: number | number[];
  sectionId?: number;
  statusId?: number | number[];
  fromUserId?: number;
  fromCompanyId?: number;
  handledByUserID?: number;
  tagName?: string;
  dateFrom?: string;
  dateTo?: string;
  updatedFrom?: string;
  updatedTo?: string;
  updatedByType?: "tech" | "cust";
  dueInDays?: number;
  includeCustomFields?: boolean;
  subscribedOnly?: boolean;
  count?: number;
  offset?: number;
}

export interface JitbitSearchTicketsParams {
  fromUserId?: number;
  categoryId?: number | number[];
  statusId?: number | number[];
  assignedToUserId?: number;
  dateFrom?: string;
  dateTo?: string;
}

export interface JitbitListUsersParams {
  count?: number;
  page?: number;
  listMode?: "all" | "techs" | "admins" | "regular" | "disabled";
  departmentId?: number;
  companyId?: number;
}

export interface JitbitListCompaniesParams {
  count?: number;
  page?: number;
}

export interface JitbitTicketUpdatePatch {
  categoryId?: number;
  priority?: number;
  date?: string;
  userId?: number;
  dueDate?: string | null;
  closeDate?: string | null;
  assignedUserId?: number;
  timeSpentInSeconds?: number;
  statusId?: number;
  tags?: string;
  subject?: string;
  body?: string;
}

// === Ticket Lifecycle ===

export interface JitbitCreateTicketParams {
  categoryId: number;
  subject: string;
  body?: string;
  priorityId?: number;
  userId?: number;
  assignedToUserId?: number;
  forTechsOnly?: boolean;
  tags?: string;
  companyId?: number;
  dueDate?: string;
  cc?: string;
  source?: "email" | "widget" | "api";
  customFields?: Record<string, string>;
  parentId?: number;
}

export interface JitbitMergeTicketsParams {
  targetTicketId: number;
  sourceTicketIds: number[];
}

export interface JitbitForwardTicketParams {
  toEmail: string;
  ccEmails?: string[];
  body?: string;
}

// === Attachments ===

export interface JitbitAttachment {
  ID: number;
  FileName?: string;
  FileSize?: number;
  CreatedDate?: string;
  UserID?: number;
  UserName?: string;
  ContentType?: string;
  IssueID?: number;
  [key: string]: unknown;
}

export interface JitbitAddAttachmentParams {
  fileName: string;
  data: Buffer;
  commentBody?: string;
}

// === Assets ===

export interface JitbitAsset {
  AssetID?: number;
  Name?: string;
  CategoryID?: number;
  Category?: string;
  CompanyID?: number;
  CompanyName?: string;
  SerialNumber?: string;
  Notes?: string;
  CustomFields?: JitbitAssetCustomField[];
  CreatedDate?: string;
  UpdatedDate?: string;
  [key: string]: unknown;
}

export interface JitbitAssetCustomField {
  FieldID: number;
  Name: string;
  Value?: string;
}

export interface JitbitListAssetsParams {
  page?: number;
  assignedToUserId?: number;
  assignedToCompanyId?: number;
  assignedToDepartmentId?: number;
  assignedToTicketId?: number;
  nameprefix?: string;
  includeDisabled?: boolean;
  // Non-API convenience field used locally for search filtering
  search?: string;
}

export interface JitbitCreateAssetParams {
  modelName: string;
  manufacturer?: string;
  type?: string;
  supplier?: string;
  serialNumber?: string;
  location?: string;
  comments?: string;
  quantity?: number;
  companyId?: number;
}

export interface JitbitUpdateAssetParams extends Partial<JitbitCreateAssetParams> {}

// === Custom Fields ===

export interface JitbitCustomField {
  FieldID: number;
  Name: string;
  Type?: string;
  Values?: string;
  Required?: boolean;
  CategoryID?: number;
  SectionID?: number;
  [key: string]: unknown;
}

export interface JitbitCustomFieldValue {
  FieldID: number;
  Name: string;
  Value?: string;
  Type?: string;
}

// === Tags ===

export interface JitbitTag {
  TagID?: number;
  Name: string;
  TagCount?: number;
}

// === Sections ===

export interface JitbitSection {
  SectionID: number;
  Name: string;
  CategoryID?: number;
  [key: string]: unknown;
}

// === Time Tracking ===

export interface JitbitTimeEntry {
  TimeEntryID?: number;
  TicketID?: number;
  UserID?: number;
  UserName?: string;
  Minutes: number;
  Date?: string;
  Comment?: string;
  Billable?: boolean;
  [key: string]: unknown;
}

export interface JitbitAddTimeEntryParams {
  timeSpentInSeconds: number;
  statusId?: number;
}

// === Automation ===

export interface JitbitAutomationRule {
  RuleID: number;
  Name: string;
  CategoryID?: number;
  Enabled?: boolean;
  [key: string]: unknown;
}
