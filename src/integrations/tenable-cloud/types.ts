/** Per-request API key override — required for multi-customer usage */
export interface TenableRequestOptions {
  accessKey?: string;
  secretKey?: string;
}

// ── Vulnerabilities ──────────────────────────────────────────────────────────

export type TenableSeverity = "critical" | "high" | "medium" | "low" | "info";

export interface TenableVulnerability {
  asset: {
    agent_uuid?: string;
    bios_uuid?: string;
    device_type?: string;
    fqdn?: string[];
    hostname?: string;
    id: string;
    ipv4?: string[];
    ipv6?: string[];
    mac_address?: string[];
    netbios_name?: string;
    operating_system?: string[];
  };
  first_found: string;
  last_found: string;
  output?: string;
  plugin: {
    cvss3_base_score?: number;
    cvss_base_score?: number;
    cve?: string[];
    description?: string;
    exploit_available?: boolean;
    family?: string;
    family_id?: number;
    id: number;
    name: string;
    patch_publication_date?: string;
    publication_date?: string;
    risk_factor?: string;
    solution?: string;
    synopsis?: string;
    type?: string;
  };
  port: {
    port: number;
    protocol: string;
    service?: string;
  };
  scan: {
    completed_at?: string;
    schedule_uuid?: string;
    started_at?: string;
    uuid?: string;
  };
  severity: number;
  severity_id: number;
  severity_modification_type: string;
  state: string;
}

export interface TenableVulnExportFilter {
  since?: number;
  cidr_range?: string;
  first_found?: number;
  last_found?: number;
  last_fixed?: number;
  plugin_family?: string[];
  plugin_id?: number[];
  port?: number[];
  severity?: TenableSeverity[];
  state?: string[];
  tag?: { category: string; value: string }[];
}

// ── Assets ───────────────────────────────────────────────────────────────────

export interface TenableAsset {
  id: string;
  has_plugin_results: boolean;
  created_at: string;
  updated_at: string;
  first_seen: string;
  last_seen: string;
  last_scan_time?: string;
  last_authenticated_scan_date?: string;
  last_licensed_scan_date?: string;
  agent_uuid?: string[];
  bios_uuid?: string[];
  device_type?: string[];
  fqdn?: string[];
  hostname?: string[];
  ipv4?: string[];
  ipv6?: string[];
  mac_address?: string[];
  netbios_name?: string[];
  operating_system?: string[];
  sources?: TenableAssetSource[];
  tags?: TenableAssetTag[];
  exposure_score?: number;
  acr_score?: number;
}

export interface TenableAssetSource {
  name: string;
  first_seen: string;
  last_seen: string;
}

export interface TenableAssetTag {
  tag_uuid: string;
  tag_key: string;
  tag_value: string;
  added_by: string;
  added_at: string;
  source: string;
}

export interface TenableAssetExportFilter {
  chunk_size?: number;
  filters?: {
    created_at?: number;
    updated_at?: number;
    terminated_at?: number;
    deleted_at?: number;
    first_scan_time?: number;
    last_assessed?: number;
    last_authenticated_scan_date?: number;
    servicenow_sysid?: boolean;
    sources?: string[];
    has_plugin_results?: boolean;
    tag?: { category: string; value: string }[];
  };
}

export interface TenableExportStatus {
  uuid: string;
  status: string;
  chunks_available?: number[];
}

// ── Scans ────────────────────────────────────────────────────────────────────

export interface TenableScan {
  id: number;
  uuid?: string;
  name: string;
  type: string;
  owner: string;
  owner_id?: number;
  enabled: boolean;
  folder_id?: number;
  status: string;
  shared?: number;
  user_permissions?: number;
  creation_date?: number;
  last_modification_date?: number;
  timezone?: string;
  rrules?: string;
  starttime?: string;
  template_uuid?: string;
  scanner_id?: number;
  scanner_uuid?: string;
}

export interface TenableScanDetails {
  info: {
    status?: string;
    policy?: string;
    targets?: string;
    uuid?: string;
    name?: string;
    scan_start?: number;
    scan_end?: number;
    hostcount?: number;
    user_permissions?: number;
    folder_id?: number;
    scanner_name?: string;
  };
  hosts?: TenableScanHost[];
  vulnerabilities?: TenableScanVulnerability[];
  history?: TenableScanHistory[];
  filters?: unknown[];
  notes?: unknown[];
}

export interface TenableScanHost {
  host_id: number;
  hostname?: string;
  critical?: number;
  high?: number;
  medium?: number;
  low?: number;
  info?: number;
  score?: number;
  severity?: number;
}

export interface TenableScanVulnerability {
  plugin_id: number;
  plugin_name: string;
  plugin_family: string;
  count: number;
  severity?: number;
}

export interface TenableScanHistory {
  history_id: number;
  uuid?: string;
  status?: string;
  creation_date?: number;
  last_modification_date?: number;
  is_archived?: boolean;
}

export interface TenableScanTemplate {
  uuid: string;
  name: string;
  title?: string;
  description?: string;
  cloud_only?: boolean;
  subscription_only?: boolean;
  is_agent?: boolean;
  more_info?: string;
}

// ── Policies ─────────────────────────────────────────────────────────────────

export interface TenablePolicy {
  id: number;
  template_uuid?: string;
  name: string;
  description?: string;
  owner_id?: number;
  owner?: string;
  shared?: number;
  user_permissions?: number;
  creation_date?: number;
  last_modification_date?: number;
  visibility?: string;
  no_target?: boolean;
}

// ── Networks ─────────────────────────────────────────────────────────────────

export interface TenableNetwork {
  uuid: string;
  name: string;
  description?: string;
  owner_uuid?: string;
  created?: string;
  modified?: string;
  scanner_count?: number;
  assets_ttl_days?: number;
  is_default?: boolean;
}

// ── Tags ─────────────────────────────────────────────────────────────────────

export interface TenableTagCategory {
  uuid: string;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
  name: string;
  description?: string;
  reserved?: boolean;
  value_count?: number;
}

export interface TenableTagValue {
  uuid: string;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
  category_uuid: string;
  category_name?: string;
  value: string;
  description?: string;
  type?: string;
}

// ── Users ────────────────────────────────────────────────────────────────────

export interface TenableUser {
  id: number;
  uuid?: string;
  username: string;
  name?: string;
  email?: string;
  type?: string;
  permissions?: number;
  enabled?: boolean;
  login_fail_count?: number;
  lastlogin?: number;
  uuid_id?: string;
}

// ── Groups ───────────────────────────────────────────────────────────────────

export interface TenableGroup {
  id: number;
  name: string;
  permissions?: number;
  user_count?: number;
  uuid?: string;
}

// ── Agents ───────────────────────────────────────────────────────────────────

export interface TenableAgent {
  id: number;
  uuid?: string;
  name?: string;
  platform?: string;
  distro?: string;
  ip?: string;
  last_scanned?: number;
  last_connect?: number;
  plugin_feed_id?: string;
  core_version?: string;
  linked_on?: number;
  last_seen?: number;
  groups?: { id: number; name: string }[];
  status?: string;
}

export interface TenableAgentGroup {
  id: number;
  uuid?: string;
  name: string;
  owner_id?: number;
  owner?: string;
  owner_uuid?: string;
  creation_date?: number;
  last_modification_date?: number;
  agents_count?: number;
}

// ── Scanners ─────────────────────────────────────────────────────────────────

export interface TenableScanner {
  id: number;
  uuid?: string;
  name: string;
  type?: string;
  status?: string;
  engine_version?: string;
  platform?: string;
  loaded_plugin_set?: string;
  linked?: number;
  owner?: string;
  pool?: boolean;
  creation_date?: number;
  last_connect?: number;
  network_name?: string;
}

// ── Exclusions ───────────────────────────────────────────────────────────────

export interface TenableExclusion {
  id: number;
  name: string;
  description?: string;
  creation_date?: number;
  last_modification_date?: number;
  schedule?: {
    enabled: boolean;
    starttime?: string;
    endtime?: string;
    timezone?: string;
    rrules?: {
      freq: string;
      interval?: number;
      byweekday?: string;
      bymonthday?: number;
    };
  };
  members: string;
}

// ── Credentials ──────────────────────────────────────────────────────────────

export interface TenableCredential {
  uuid: string;
  created_date?: string;
  created_by?: string;
  last_modification_date?: string;
  last_modified_by?: string;
  name: string;
  description?: string;
  category?: { id: string; name: string };
  type?: { id: string; name: string };
  user_permissions?: string;
}

// ── Plugins ──────────────────────────────────────────────────────────────────

export interface TenablePluginFamily {
  id: number;
  name: string;
  type?: string;
  count?: number;
}

export interface TenablePlugin {
  id: number;
  name: string;
  family_name?: string;
  attributes?: { attribute_name: string; attribute_value: string }[];
}

// ── Alerts ───────────────────────────────────────────────────────────────────

export interface TenableAlert {
  id: number;
  name: string;
  enabled?: boolean;
  description?: string;
  filter?: unknown;
  action?: unknown[];
  last_trigger_time?: number;
  creation_date?: number;
  last_modification_date?: number;
  owner?: string;
  owner_id?: number;
  schedule?: unknown;
}

// ── Audit Log ────────────────────────────────────────────────────────────────

export interface TenableAuditLog {
  id: string;
  action: string;
  actor: { id: string; name: string };
  crud: string;
  description?: string;
  fields?: { key: string; value: string }[];
  is_anonymous?: boolean;
  is_failure?: boolean;
  received: string;
  target?: { id: string; name: string; type: string };
}

// ── Access Groups ────────────────────────────────────────────────────────────

export interface TenableAccessGroup {
  id: string;
  name: string;
  access_group_type?: string;
  created_at?: string;
  updated_at?: string;
  created_by?: string;
  updated_by?: string;
  status?: string;
  all_users?: boolean;
  all_assets?: boolean;
  rules?: unknown[];
  principals?: unknown[];
  version?: number;
}

// ── Remediation Rules ────────────────────────────────────────────────────────

export interface TenableRemediationRule {
  rule_id: string;
  description?: string;
  last_seen?: string;
  reason?: string;
  recast_as?: number;
  recast_reason?: string;
}

// ── Container Security ───────────────────────────────────────────────────────

export interface TenableContainerImage {
  id?: string;
  name?: string;
  tag?: string;
  digest?: string;
  os?: string;
  os_version?: string;
  status?: string;
  findings_counts?: {
    malware?: number;
    potentially_unwanted_programs?: number;
    total?: number;
  };
  risk_score?: number;
  last_scanned?: string;
}

// ── Workbench summary types ──────────────────────────────────────────────────

export interface TenableWorkbenchAsset {
  id: string;
  has_plugin_results?: boolean;
  created_at?: string;
  updated_at?: string;
  first_seen?: string;
  last_seen?: string;
  fqdn?: string[];
  hostname?: string[];
  ipv4?: string[];
  ipv6?: string[];
  operating_system?: string[];
  device_type?: string[];
  sources?: TenableAssetSource[];
  tags?: TenableAssetTag[];
  severities?: {
    count: number;
    level: number;
    name: string;
  }[];
  exposure_score?: number;
  acr_score?: number;
  last_scan_target?: string;
  network_id?: string;
}
