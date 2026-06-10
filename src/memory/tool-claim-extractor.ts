import { entityMemory } from "./entity-memory";
import type { EntityType } from "./entity-types";

/**
 * Tool-claim extractor (Idea 2 from the ClaimKit roadmap).
 *
 * The shape of structured tool results — Jira issues, GitHub PRs, Tenable
 * vulnerabilities — already encodes claims. A jira.get_issue response IS
 * the set of facts ("IR-82 has status 'In Progress'", "IR-82 priority is
 * Highest"). Asking an LLM to re-extract these claims from the JSON dump
 * is wasteful: it's slow, error-prone, and competes with the main chat for
 * LLM capacity.
 *
 * This module turns structured tool results into atomic (entity, attribute,
 * value) triples deterministically. Each triple becomes a structured claim
 * on the entity, with automatic supersession when the same property is
 * re-observed with a different value.
 *
 * Benefits over RAG / LLM extraction:
 *   - Zero LLM cost per ingestion.
 *   - "What is IR-82's current status?" is a one-row SQL query, not a
 *     similarity search over fading embeddings.
 *   - "Has IR-82 changed recently?" becomes a supersession-chain query.
 *   - Cross-session continuity: an agent in a new session sees the latest
 *     known state of every entity it has ever observed.
 */

interface ExtractedClaim {
  entityType: EntityType;
  entityName: string;
  /** Optional URL-style identifier for the entity (e.g. Jira issue URL). */
  entityUrl?: string;
  /** Short summary line for the entity (used when upserting). */
  entitySummary?: string;
  attribute: string;
  value: string;
  confidence?: number;
}

/**
 * Result of extracting claims from a single tool call.
 */
export interface ToolClaimExtractionResult {
  /** Number of (entity, attribute, value) triples written. */
  claimsWritten: number;
  /** Distinct entities touched. */
  entitiesTouched: number;
  /** Supersession events triggered (existing claim → new value). */
  supersessions: number;
  /** Free-text reason if the extractor decided not to ingest. */
  skipped?: string;
}

const SUPPORTED_PRIMITIVES = new Set([
  "summary",
  "title",
  "status",
  "priority",
  "assignee",
  "reporter",
  "author",
  "owner",
  "labels",
  "type",
  "project",
  "state",
  "url",
  "branch",
  "merge_status",
  "draft",
  "merged",
  "closed",
  "severity",
  "cvss",
  "score",
  "name",
  "description",
]);

function toStringValue(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) {
    const items = v
      .map((item) => toStringValue(item))
      .filter((x): x is string => Boolean(x));
    if (items.length === 0) return null;
    return items.slice(0, 8).join(", ");
  }
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    // Common nested patterns: {name: "..."}, {displayName: "..."}, {key: "..."}.
    if (typeof obj.displayName === "string") return obj.displayName;
    if (typeof obj.name === "string") return obj.name;
    if (typeof obj.key === "string") return obj.key;
    if (typeof obj.title === "string") return obj.title;
    if (typeof obj.value === "string") return obj.value;
    return null;
  }
  return null;
}

function extractJiraClaims(data: unknown): ExtractedClaim[] {
  if (!data || typeof data !== "object") return [];
  const issue = data as Record<string, unknown>;
  const key = (issue.key as string) || (issue.id as string);
  if (!key || typeof key !== "string") return [];

  const summary = toStringValue(issue.summary) ?? toStringValue(issue.title) ?? "";
  const url = toStringValue(issue.url) ?? toStringValue(issue.self) ?? undefined;

  const claims: ExtractedClaim[] = [];
  const fields = (issue.fields as Record<string, unknown>) ?? issue;
  // Flat shape (jira.search_issues) and nested-fields shape (jira.get_issue) both work.
  const sources: Array<Record<string, unknown>> = [issue, fields];

  const addClaim = (attribute: string, raw: unknown) => {
    const v = toStringValue(raw);
    if (v) {
      claims.push({
        entityType: "jira_issue",
        entityName: key,
        entityUrl: url,
        entitySummary: summary || undefined,
        attribute,
        value: v,
      });
    }
  };

  for (const src of sources) {
    if (!src || typeof src !== "object") continue;
    if (src.summary !== undefined) addClaim("summary", src.summary);
    if (src.status !== undefined) addClaim("status", src.status);
    if (src.priority !== undefined) addClaim("priority", src.priority);
    if (src.assignee !== undefined) addClaim("assignee", src.assignee);
    if (src.reporter !== undefined) addClaim("reporter", src.reporter);
    if (src.type !== undefined) addClaim("type", src.type);
    if (src.issuetype !== undefined) addClaim("type", src.issuetype);
    if (src.project !== undefined) addClaim("project", src.project);
    if (src.labels !== undefined) addClaim("labels", src.labels);
    if (src.description !== undefined) addClaim("description", src.description);
  }

  // Deduplicate by (attribute) — last write wins (nested fields override flat).
  const byAttr = new Map<string, ExtractedClaim>();
  for (const c of claims) byAttr.set(c.attribute, c);
  return Array.from(byAttr.values());
}

function extractGitlabMrClaims(data: unknown): ExtractedClaim[] {
  if (!data || typeof data !== "object") return [];
  const mr = data as Record<string, unknown>;
  const iid = mr.iid ?? mr.id;
  const projectId = mr.project_id ?? mr.projectId;
  if (iid === undefined) return [];
  const entityName = projectId !== undefined ? `${projectId}!${iid}` : `mr-${iid}`;
  const summary = toStringValue(mr.title) ?? "";
  const url = toStringValue(mr.web_url) ?? toStringValue(mr.url) ?? undefined;

  const out: ExtractedClaim[] = [];
  const push = (attr: string, raw: unknown) => {
    const v = toStringValue(raw);
    if (v) {
      out.push({
        entityType: "gitlab_mr",
        entityName,
        entityUrl: url,
        entitySummary: summary || undefined,
        attribute: attr,
        value: v,
      });
    }
  };
  push("title", mr.title);
  push("state", mr.state);
  push("merge_status", mr.merge_status);
  push("draft", mr.draft);
  push("author", mr.author);
  push("assignee", mr.assignee);
  push("target_branch", mr.target_branch);
  push("source_branch", mr.source_branch);
  push("labels", mr.labels);
  return out;
}

function extractGithubPrClaims(data: unknown): ExtractedClaim[] {
  if (!data || typeof data !== "object") return [];
  const pr = data as Record<string, unknown>;
  const num = pr.number ?? pr.id;
  if (num === undefined) return [];
  const repo = (pr.head as { repo?: { full_name?: string } } | undefined)?.repo?.full_name
    ?? (pr.repo as string | undefined)
    ?? (pr.repository as string | undefined);
  const entityName = repo ? `${repo}#${num}` : `pr-${num}`;
  const summary = toStringValue(pr.title) ?? "";
  const url = toStringValue(pr.html_url) ?? toStringValue(pr.url) ?? undefined;

  const out: ExtractedClaim[] = [];
  const push = (attr: string, raw: unknown) => {
    const v = toStringValue(raw);
    if (v) {
      out.push({
        entityType: "github_pr",
        entityName,
        entityUrl: url,
        entitySummary: summary || undefined,
        attribute: attr,
        value: v,
      });
    }
  };
  push("title", pr.title);
  push("state", pr.state);
  push("draft", pr.draft);
  push("merged", pr.merged);
  push("closed", pr.closed_at);
  push("author", pr.user);
  push("assignee", pr.assignee);
  push("labels", pr.labels);
  push("base", pr.base);
  push("head", pr.head);
  return out;
}

function extractTenableAssetClaims(data: unknown): ExtractedClaim[] {
  if (!data || typeof data !== "object") return [];
  const asset = data as Record<string, unknown>;
  // Tenable asset payloads use uuid as the stable identifier.
  const id =
    (asset.uuid as string) ||
    (asset.id as string) ||
    (asset.asset_id as string);
  if (!id) return [];
  const name =
    toStringValue(asset.hostname) ||
    toStringValue(asset.ipv4) ||
    toStringValue(asset.fqdn) ||
    String(id);
  const out: ExtractedClaim[] = [];
  const push = (attr: string, raw: unknown) => {
    const v = toStringValue(raw);
    if (v) {
      out.push({
        entityType: "asset",
        entityName: name,
        entitySummary: toStringValue(asset.hostname) ?? undefined,
        attribute: attr,
        value: v,
      });
    }
  };
  push("name", asset.hostname);
  push("status", asset.status);
  push("severity", asset.severity);
  push("score", asset.acr_score ?? asset.exposure_score);
  push("owner", asset.system_owner ?? asset.business_owner);
  return out;
}

function extractTenableVulnClaims(data: unknown): ExtractedClaim[] {
  if (!data || typeof data !== "object") return [];
  const v = data as Record<string, unknown>;
  // A vulnerability is uniquely keyed by (asset, plugin_id) in Tenable's model,
  // but the bare plugin_id is usually what the user/agent refers to.
  const pluginId = v.plugin_id ?? v.pluginId ?? (v.plugin as Record<string, unknown> | undefined)?.id;
  const cve = v.cve;
  const entityName = pluginId ? `plugin-${pluginId}` : toStringValue(cve);
  if (!entityName) return [];
  const out: ExtractedClaim[] = [];
  const push = (attr: string, raw: unknown) => {
    const val = toStringValue(raw);
    if (val) {
      out.push({
        entityType: "vulnerability",
        entityName,
        entitySummary: toStringValue(v.name) ?? toStringValue(v.plugin_name) ?? undefined,
        attribute: attr,
        value: val,
      });
    }
  };
  push("name", v.name ?? v.plugin_name);
  push("severity", v.severity);
  push("cvss", v.cvss_base_score ?? v.cvss);
  push("score", v.vpr_score ?? v.score);
  push("status", v.state ?? v.status);
  return out;
}

function extractHawkIrCaseClaims(data: unknown): ExtractedClaim[] {
  if (!data || typeof data !== "object") return [];
  const c = data as Record<string, unknown>;
  const id = c.case_id ?? c.id ?? c.uuid;
  if (id === undefined) return [];
  const entityName = `hawk-${id}`;
  const summary = toStringValue(c.title) ?? toStringValue(c.summary) ?? "";
  const out: ExtractedClaim[] = [];
  const push = (attr: string, raw: unknown) => {
    const val = toStringValue(raw);
    if (val) {
      out.push({
        entityType: "incident",
        entityName,
        entitySummary: summary || undefined,
        attribute: attr,
        value: val,
      });
    }
  };
  push("title", c.title);
  push("status", c.status ?? c.state);
  push("severity", c.severity);
  push("assignee", c.assignee ?? c.assigned_to);
  push("priority", c.priority);
  return out;
}

function extractGithubIssueClaims(data: unknown): ExtractedClaim[] {
  if (!data || typeof data !== "object") return [];
  const issue = data as Record<string, unknown>;
  // Disambiguate from a PR: GitHub's API returns pull_request on PRs.
  if (issue.pull_request) return extractGithubPrClaims(data);
  const num = issue.number ?? issue.id;
  if (num === undefined) return [];
  const repo = (issue.repository as string | undefined) ?? (issue.repo as string | undefined);
  const entityName = repo ? `${repo}#${num}` : `issue-${num}`;
  const summary = toStringValue(issue.title) ?? "";
  const url = toStringValue(issue.html_url) ?? toStringValue(issue.url) ?? undefined;
  const out: ExtractedClaim[] = [];
  const push = (attr: string, raw: unknown) => {
    const v = toStringValue(raw);
    if (v) {
      out.push({
        entityType: "jira_issue", // Closest existing EntityType — GitHub issues are issue-like
        entityName,
        entityUrl: url,
        entitySummary: summary || undefined,
        attribute: attr,
        value: v,
      });
    }
  };
  push("title", issue.title);
  push("state", issue.state);
  push("author", issue.user);
  push("assignee", issue.assignee);
  push("labels", issue.labels);
  push("milestone", issue.milestone);
  return out;
}

/**
 * Dispatch: pick the right extractor for a tool name.
 * Returns [] for tools we don't yet support — they fall back to the
 * existing text-based ingestion path.
 */
function extractClaimsForTool(toolName: string, result: unknown): ExtractedClaim[] {
  if (!result || typeof result !== "object") return [];
  const obj = result as Record<string, unknown>;
  const data = obj.data ?? obj;
  if (!data) return [];

  const lower = toolName.toLowerCase();

  // Singular-result tools
  if (lower === "jira.get_issue" || lower === "jira.update_issue") {
    return extractJiraClaims(data);
  }
  if (lower === "gitlab.get_merge_request") {
    return extractGitlabMrClaims(data);
  }
  if (lower === "github.get_pull_request" || lower === "github.get_pr") {
    return extractGithubPrClaims(data);
  }
  if (lower === "github.get_issue") {
    return extractGithubIssueClaims(data);
  }
  if (lower === "tenable.get_asset" || lower === "tenable_cloud.get_asset") {
    return extractTenableAssetClaims(data);
  }
  if (
    lower === "tenable.get_vulnerability_details" ||
    lower === "tenable_cloud.get_vulnerability_details" ||
    lower === "tenable.get_asset_vulnerabilities"
  ) {
    return extractTenableVulnClaims(data);
  }
  if (lower === "hawk_ir.get_case" || lower === "hawk_ir.get_case_summary") {
    return extractHawkIrCaseClaims(data);
  }

  // Plural-result tools — iterate over array.
  const list = Array.isArray(data)
    ? data
    : Array.isArray((data as Record<string, unknown>).items)
      ? (data as Record<string, unknown>).items
      : Array.isArray((data as Record<string, unknown>).results)
        ? (data as Record<string, unknown>).results
        : null;

  if (Array.isArray(list)) {
    const out: ExtractedClaim[] = [];
    for (const item of list) {
      if (lower.startsWith("jira.")) out.push(...extractJiraClaims(item));
      else if (lower.startsWith("gitlab.") && lower.includes("merge_request"))
        out.push(...extractGitlabMrClaims(item));
      else if (lower.startsWith("github.") && lower.includes("pull"))
        out.push(...extractGithubPrClaims(item));
      else if (lower.startsWith("github.") && lower.includes("issue"))
        out.push(...extractGithubIssueClaims(item));
      else if (
        (lower.startsWith("tenable.") || lower.startsWith("tenable_cloud.")) &&
        lower.includes("asset")
      )
        out.push(...extractTenableAssetClaims(item));
      else if (
        (lower.startsWith("tenable.") || lower.startsWith("tenable_cloud.")) &&
        lower.includes("vuln")
      )
        out.push(...extractTenableVulnClaims(item));
      else if (lower.startsWith("hawk_ir.")) out.push(...extractHawkIrCaseClaims(item));
    }
    return out;
  }

  return [];
}

/**
 * Public entry point. Called from ingestToolResult in the tool dispatcher.
 *
 * Runs synchronously against the entity-memory SQLite store. Each claim is
 * an upsert with auto-supersession — repeating the same call refreshes
 * timestamps; observing a different value transparently records the
 * transition.
 *
 * Safe to call on any tool result; returns a no-op result with `skipped`
 * for tools we don't have an extractor for.
 */
export function ingestStructuredClaims(
  toolName: string,
  result: unknown,
  options: { source?: string; sourceId?: string; observedAt?: string } = {},
): ToolClaimExtractionResult {
  let claims: ExtractedClaim[];
  try {
    claims = extractClaimsForTool(toolName, result);
  } catch (err) {
    return {
      claimsWritten: 0,
      entitiesTouched: 0,
      supersessions: 0,
      skipped: `extractor_error: ${err instanceof Error ? err.message : "unknown"}`,
    };
  }
  if (claims.length === 0) {
    return {
      claimsWritten: 0,
      entitiesTouched: 0,
      supersessions: 0,
      skipped: "no_extractor_for_tool",
    };
  }

  const entityIdByName = new Map<string, string>();
  let supersessions = 0;
  let claimsWritten = 0;

  for (const claim of claims) {
    if (!SUPPORTED_PRIMITIVES.has(claim.attribute)) continue;

    const entityKey = `${claim.entityType}:${claim.entityName}`;
    let entityId = entityIdByName.get(entityKey);
    if (!entityId) {
      const upserted = entityMemory.upsertEntity({
        type: claim.entityType,
        name: claim.entityName,
        summary: claim.entitySummary,
        sourceUrl: claim.entityUrl,
        source: options.source ?? toolName,
        sourceId: options.sourceId,
      });
      entityId = upserted.id;
      entityIdByName.set(entityKey, entityId);
    }

    // Detect supersession: peek current value before write.
    const current = entityMemory.getCurrentClaims(entityId).find(
      (f) => f.attribute === claim.attribute,
    );
    const willSupersede =
      current !== undefined && current.value !== claim.value;

    entityMemory.setStructuredFact(entityId, claim.attribute, claim.value, {
      source: options.source ?? toolName,
      sourceId: options.sourceId,
      observedAt: options.observedAt,
      confidence: claim.confidence,
    });
    claimsWritten++;
    if (willSupersede) supersessions++;
  }

  return {
    claimsWritten,
    entitiesTouched: entityIdByName.size,
    supersessions,
  };
}
