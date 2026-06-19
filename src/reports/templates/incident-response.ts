/**
 * Incident-response template — turns an IR investigation chat into a
 * customer-deliverable Word/PDF report.
 *
 * Sections:
 *   - Cover (handled by renderer)
 *   - Executive Summary (last assistant report-style message)
 *   - Timeline (table + SVG timeline chart pulled from any markdown tables
 *     in the assistant content that look like UTC-timestamped events)
 *   - Key Findings (parsed from the assistant content's numbered lists)
 *   - Indicators of Compromise (IP addresses + emails + message-IDs +
 *     auto-extracted from the assistant content)
 *   - Recommendations
 *   - Gaps and Unverified Items
 *   - Evidence Appendix (every tc-xxx cited by the assistant)
 */

import { conversationManager } from "../../memory/conversation-manager";
import { toolCallCache } from "../../memory/tool-cache";
import type {
  EvidenceRef,
  ReportManifest,
  ReportSection,
  TimelineChartData,
} from "../types";

const TC_REF_RE = /\b(tc-[a-f0-9]{8,16})\b/g;
const IP_V4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
// IPv6 literal — accept compressed ::, 8 hextets, and the partial-with-zero
// shorthand. Conservative enough to not eat random text.
const IP_V6_RE = /\b(?:[A-F0-9]{1,4}:){2,7}[A-F0-9:]{0,4}\b/gi;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const MESSAGE_ID_RE = /<[^<>\s@]+@[^<>\s]+>/g;
const UTC_TS_RE = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?Z?\b/g;
const UNVERIFIED_RE = /\[UNVERIFIED\][^.]*\./g;

export interface IncidentTemplateInput {
  sessionId: string;
  title?: string;
  subtitle?: string;
  customer?: string;
  author?: string;
  localTimezone?: string;
}

function extractMostRecentReport(messages: { role: string; content: string }[]): string {
  // Pick the longest assistant message in the last 8 — it's almost always
  // the final consolidated report.
  const candidates = messages
    .filter((m) => m.role === "assistant" && (m.content ?? "").trim().length > 400)
    .slice(-8);
  if (candidates.length === 0) return "";
  return candidates.sort((a, b) => (b.content ?? "").length - (a.content ?? "").length)[0].content;
}

function extractSection(body: string, heading: RegExp): string | undefined {
  const lines = body.split("\n");
  let started = false;
  let level = 0;
  const out: string[] = [];
  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (started && headingMatch && headingMatch[1].length <= level) break;
    if (!started && headingMatch && heading.test(headingMatch[2])) {
      started = true;
      level = headingMatch[1].length;
      continue;
    }
    if (started) out.push(line);
  }
  const text = out.join("\n").trim();
  return text.length > 0 ? text : undefined;
}

function extractIndicators(body: string): {
  ips: string[];
  emails: string[];
  messageIds: string[];
} {
  const ipsRaw = [
    ...(body.match(IP_V4_RE) ?? []),
    ...(body.match(IP_V6_RE) ?? []),
  ];
  // Filter common false positives (timestamps look like IPv4 with colons).
  const ips = [...new Set(ipsRaw.filter((s) => !/^\d{4}-\d/.test(s)))];
  const emails = [...new Set((body.match(EMAIL_RE) ?? []).map((s) => s.toLowerCase()))];
  const messageIds = [...new Set(body.match(MESSAGE_ID_RE) ?? [])];
  return { ips, emails, messageIds };
}

function extractTimelineFromMarkdownTable(body: string): TimelineChartData | undefined {
  // Look for a markdown table whose first column header mentions UTC / Time.
  const lines = body.split("\n");
  for (let i = 0; i < lines.length - 2; i++) {
    const header = lines[i];
    const divider = lines[i + 1];
    if (!header.includes("|") || !divider.includes("---")) continue;
    if (!/UTC|Time|When/i.test(header)) continue;
    const events: Array<{ at: string; label: string }> = [];
    for (let j = i + 2; j < lines.length; j++) {
      const row = lines[j];
      if (!row.includes("|")) break;
      const cells = row.split("|").map((c) => c.trim()).filter((c) => c.length > 0);
      if (cells.length < 2) break;
      const tsMatch = cells[0].match(UTC_TS_RE)?.[0] ?? cells.slice(0, 3).join(" ").match(UTC_TS_RE)?.[0];
      if (!tsMatch) continue;
      const ts = tsMatch.endsWith("Z") ? tsMatch : tsMatch + "Z";
      const label = (cells[2] ?? cells[1] ?? "").slice(0, 50);
      events.push({ at: ts, label });
    }
    if (events.length >= 2) {
      return { events };
    }
  }
  return undefined;
}

function extractEvidenceRefs(body: string): string[] {
  return [...new Set([...body.matchAll(TC_REF_RE)].map((m) => m[1]))];
}

export function buildIncidentManifest(input: IncidentTemplateInput): ReportManifest {
  const session = conversationManager.getSession(input.sessionId);
  const generatedAt = new Date().toISOString();
  const title = input.title ?? session?.metadata.title ?? "Incident Response Report";
  const messages = (session?.messages ?? []).map((m) => ({ role: m.role, content: m.content }));
  const reportBody = extractMostRecentReport(messages);

  // Build sections.
  const sections: ReportSection[] = [];

  // Executive summary — first paragraph of the consolidated report, or the
  // explicit "Executive Summary" / "Summary" section if one exists.
  const summary = extractSection(reportBody, /Executive Summary|^Summary$/i)
    ?? reportBody.split("\n\n")[0];
  sections.push({
    kind: "executive_summary",
    heading: "Executive summary",
    headingLevel: 1,
    body: summary.trim() || "_No summary available._",
  });

  // Timeline — table + chart.
  const timeline = extractTimelineFromMarkdownTable(reportBody);
  const timelineText = extractSection(reportBody, /Timeline|^Time line$/i);
  if (timeline || timelineText) {
    sections.push({
      kind: "timeline_table",
      heading: "Timeline",
      headingLevel: 1,
      body: timelineText,
      chart: timeline
        ? {
            kind: "timeline",
            caption: `Event density across the investigation window (${timeline.events.length} events).`,
            data: timeline,
          }
        : undefined,
    });
  }

  // Key findings
  const findings = extractSection(reportBody, /Key Findings|Findings|Detailed Findings/i);
  if (findings) {
    sections.push({
      kind: "findings",
      heading: "Key findings",
      headingLevel: 1,
      body: findings,
    });
  }

  // Indicators of compromise (autoextracted)
  const ioc = extractIndicators(reportBody);
  const iocBullets: string[] = [];
  if (ioc.ips.length > 0) iocBullets.push(`IP addresses (${ioc.ips.length}): ${ioc.ips.slice(0, 20).join(", ")}`);
  if (ioc.emails.length > 0) iocBullets.push(`Email addresses (${ioc.emails.length}): ${ioc.emails.slice(0, 20).join(", ")}`);
  if (ioc.messageIds.length > 0) iocBullets.push(`Message IDs (${ioc.messageIds.length}): ${ioc.messageIds.slice(0, 10).join(", ")}`);
  if (iocBullets.length > 0) {
    sections.push({
      kind: "indicators",
      heading: "Indicators of compromise",
      headingLevel: 1,
      bullets: iocBullets,
    });
  }

  // Recommendations
  const recs = extractSection(reportBody, /Recommendations|Recommended.*Next.*Steps|Next.*Steps/i);
  if (recs) {
    sections.push({
      kind: "recommendations",
      heading: "Recommendations and next steps",
      headingLevel: 1,
      body: recs,
    });
  }

  // Gaps and unverified
  const unverifiedMatches = [...reportBody.matchAll(UNVERIFIED_RE)].map((m) => m[0]);
  const gapsBody = extractSection(reportBody, /Gaps|Unverified|Limitations/i);
  if (gapsBody || unverifiedMatches.length > 0) {
    const bullets = unverifiedMatches.slice(0, 20).map((u) => u.trim());
    sections.push({
      kind: "gaps",
      heading: "Gaps and unverified items",
      headingLevel: 1,
      body: gapsBody,
      bullets: bullets.length > 0 ? bullets : undefined,
    });
  }

  // Evidence appendix — drawn from BOTH cited refs in the body and the live
  // tool-call cache. We dedupe by ref.
  const citedRefs = new Set(extractEvidenceRefs(reportBody));
  const cacheEntries = toolCallCache.list(input.sessionId);
  const refByCache = new Map(cacheEntries.map((e) => [e.ref, e]));
  const evidence: EvidenceRef[] = [];
  // First: every ref the report actually cited (preserve their order, then alphabetical).
  for (const ref of [...citedRefs].sort()) {
    const e = refByCache.get(ref);
    evidence.push({
      ref,
      toolName: e?.toolName,
      summary: e?.resultSummary,
      calledAt: e ? new Date(e.calledAt).toISOString() : undefined,
    });
  }
  // Then any cached entry not already cited (cap so we don't dump 600 entries).
  const cap = Number(process.env.REPORTS_EVIDENCE_CAP ?? "200");
  let extras = 0;
  for (const e of cacheEntries) {
    if (citedRefs.has(e.ref)) continue;
    if (extras >= cap) break;
    if (e.toolName === "tools.fetch_cached" || e.toolName === "tools.discover") continue;
    evidence.push({
      ref: e.ref,
      toolName: e.toolName,
      summary: e.resultSummary,
      calledAt: new Date(e.calledAt).toISOString(),
    });
    extras++;
  }

  return {
    metadata: {
      title,
      subtitle: input.subtitle ?? (input.customer ? `Incident report for ${input.customer}` : undefined),
      customer: input.customer,
      author: input.author ?? "ai-assist-tim",
      localTimezone: input.localTimezone,
      generatedAt,
      sessionId: input.sessionId,
      template: "incident-response",
    },
    sections,
    evidence,
  };
}
