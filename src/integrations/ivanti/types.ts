/**
 * Ivanti Neurons Cloud API request/response types.
 *
 * Covers the four API families we expose as tools:
 *   - People & Device Inventory (OData, custom GET token)
 *   - Neurons Bots (OAuth2 client_credentials)
 *   - Patch Management (OAuth2 client_credentials)
 *   - App Distribution (OAuth2 client_credentials)
 */

export interface IvantiClientConfig {
  hostname: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
  authUrl?: string;
  scope?: string;
  botsHost?: string;
  patchHost?: string;
  appDistHost?: string;
  mdmHost?: string;
  mdmUsername?: string;
  mdmPassword?: string;
  mdmPartitionId?: string;
  nztaHost?: string;
  nztaDsid?: string;
  timeout?: number;
  debug?: boolean;
}

export interface IvantiTokenResponse {
  access_token: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

export interface IvantiRequestOptions {
  baseUrl?: string;
  params?: Record<string, unknown>;
  data?: unknown;
  headers?: Record<string, string>;
  authMode?: "oauth" | "inventory" | "mdm" | "nzta";
}

export interface IvantiHttpResponse<T = unknown> {
  data: T;
  status: number;
  headers: Record<string, string>;
}

export interface IvantiDeviceSummary {
  id: string | null;
  name: string | null;
  hostname: string | null;
  ip: string | null;
  owner: string | null;
  osType: string | null;
  osVersion: string | null;
  model: string | null;
  manufacturer: string | null;
  lastSeen: string | null;
  status: string | null;
  raw?: unknown;
}

export interface IvantiPersonSummary {
  id: string | null;
  name: string | null;
  email: string | null;
  userName: string | null;
  department: string | null;
  title: string | null;
  manager: string | null;
  raw?: unknown;
}

export interface IvantiLookupResult {
  counts: { devices?: number; people?: number };
  devices: IvantiDeviceSummary[];
  people: IvantiPersonSummary[];
}

export interface IvantiLookupParams {
  query?: string;
  scope?: "all" | "devices" | "people";
  ip?: string;
  hostname?: string;
  email?: string;
  user?: string;
  limit?: number;
  raw?: boolean;
}

export interface IvantiODataParams {
  $top?: number;
  $filter?: string;
  $select?: string;
  $skip?: number;
  $orderby?: string;
}

export interface IvantiPatchParams extends Record<string, unknown> {
  Filter?: string;
  OrderBy?: string;
  PageNumber?: number;
  PageSize?: number;
}

export interface IvantiBotRunBody {
  botDefinitionId: string;
  agentIds: string[];
  inputs?: Array<{ inputId: string; inputValue: string }>;
}

export interface IvantiCvesToPatchGroupBody {
  cveIds: string[];
  patchGroupName?: string;
  dataUpdateErrorPolicy?: "Omit" | "Include" | "Fail";
}

export interface IvantiCatalogBody {
  packageName: string;
  platform?: string;
  version?: string;
  publisher?: string;
  category?: string;
  notes?: string;
  showInAnalystView?: boolean;
  icon?: string;
  iconPrefix?: string;
}

export interface IvantiDistributionBody {
  distributionName: string;
  packageId: string;
  revision?: number;
  platform?: string;
  priority?: number;
  enabled?: boolean;
  type?: string;
  scheduledTime?: string;
  scheduledTimeIsUtc?: boolean;
  targets?: {
    devices?: Array<{ discoveryId: string; displayName?: string }>;
    deviceGroups?: Array<{ groupId: string; displayName?: string }>;
    ldapGroups?: Array<{ groupName: string; groupDomain?: string }>;
  };
}

export interface IvantiOnDemandInstallBody {
  packageId: string;
  revision?: number;
  discoveryId: string;
  displayName?: string;
}

export interface IvantiInstalledSoftwareParams {
  deviceId?: string;
  deviceName?: string;
  packageName?: string;
  state?: string;
  $top?: number;
  $filter?: string;
  $select?: string;
  $skip?: number;
  $orderby?: string;
  allPages?: boolean;
}

export interface IvantiMdmGroupsParams {
  type?: "device" | "user";
  $top?: number;
  $filter?: string;
  $select?: string;
  $skip?: number;
  $orderby?: string;
}

export type IvantiModule = "inventory" | "bots" | "patch" | "appdist" | "mdm" | "nzta";
