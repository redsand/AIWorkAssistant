/**
 * Generic template — works for any chat session. Picks the last large
 * assistant message as the "main report" and surfaces tool refs as evidence.
 */

import { conversationManager } from "../../memory/conversation-manager";
import { toolCallCache } from "../../memory/tool-cache";
import type { EvidenceRef, ReportManifest, ReportSection } from "../types";

export interface GenericTemplateInput {
  sessionId: string;
  title?: string;
  subtitle?: string;
  customer?: string;
  author?: string;
  localTimezone?: string;
}

export function buildGenericManifest(input: GenericTemplateInput): ReportManifest {
  const session = conversationManager.getSession(input.sessionId);
  const generatedAt = new Date().toISOString();
  const title = input.title ?? session?.metadata.title ?? "Investigation Report";

  const sections: ReportSection[] = [];

  // Executive summary = the most recent meaningful assistant message.
  const assistantContent = (session?.messages ?? [])
    .filter((m) => m.role === "assistant" && (m.content ?? "").trim().length > 200)
    .slice(-1)[0]?.content?.trim() ?? "_No assistant content available._";
  sections.push({
    kind: "executive_summary",
    heading: "Summary",
    headingLevel: 1,
    body: assistantContent,
  });

  // Evidence appendix from the tool-call cache (if any)
  let evidence: EvidenceRef[] = [];
  if (session?.id) {
    const entries = toolCallCache.list(session.id);
    evidence = entries
      .filter((e) => e.toolName !== "tools.fetch_cached" && e.toolName !== "tools.discover")
      .map((e) => ({
        ref: e.ref,
        toolName: e.toolName,
        summary: e.resultSummary,
        calledAt: new Date(e.calledAt).toISOString(),
      }));
  }

  return {
    metadata: {
      title,
      subtitle: input.subtitle,
      customer: input.customer,
      author: input.author ?? "ai-assist-tim",
      localTimezone: input.localTimezone,
      generatedAt,
      sessionId: input.sessionId,
      template: "generic",
    },
    sections,
    evidence,
  };
}
