/**
 * Pure helpers for parsing Jira / Atlassian-shaped issue payloads.
 *
 * Extracted from src/aicoder.ts (2026-06-25). Zero side effects, zero
 * dependencies on aicoder globals — these only ever transform inputs.
 * That makes them safe to unit-test (see jira-helpers.test.ts) and safe
 * to call from other places that need the same parsing (e.g. work-item
 * import paths, ticket-bridge).
 */

/**
 * Render an Atlassian Document Format (ADF) description to plain text.
 * Tolerant of legacy plain-string descriptions and partially-shaped
 * payloads — returns "" rather than throwing on anything unexpected.
 *
 * Heading nodes are prefixed with `#` markers matching their level so
 * downstream prompt builders preserve hierarchy.
 */
export function adfToText(description: unknown): string {
  if (!description) return "";
  if (typeof description === "string") return description;
  const root = description as { content?: unknown };
  if (!Array.isArray(root.content)) return "";
  return root.content
    .map((node: any) => {
      const text =
        node?.content?.map((c: any) => c?.text || "").join(" ") || "";
      if (node?.type === "heading" && node?.attrs?.level) {
        return `${"#".repeat(node.attrs.level)} ${text}`;
      }
      return text;
    })
    .join("\n");
}

/**
 * Recursively unwrap a Jira description-shaped value into a flat string.
 * Catches both ADF tree nodes ({content: [...]}) and leaf {text} nodes,
 * concatenating with newlines. Differs from `adfToText` in that it walks
 * arbitrary depth instead of only the root content array — used when we
 * need every leaf string (e.g. extracting dep references from comments).
 */
export function jiraDescriptionToText(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map(jiraDescriptionToText).filter(Boolean).join("\n");
  }
  if (typeof value === "object") {
    const node = value as { text?: unknown; content?: unknown };
    return [
      typeof node.text === "string" ? node.text : "",
      jiraDescriptionToText(node.content),
    ]
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * Treat a Jira status name as "done-ish". Used to short-circuit work on
 * issues that are already closed before doing any expensive operations.
 */
export function isDoneStatus(status: string | undefined): boolean {
  return /done|closed|resolved|completed/i.test(status || "");
}

/**
 * Pull the sprint name out of a Jira issue's `fields` payload.
 *
 * Jira stores sprints in a customfield whose ID varies per instance
 * (10020 is the modern default; older setups use 10010 or others). Rather
 * than hardcode or require config, scan every `customfield_*` for the
 * recognizable sprint object shape (`{id, name, state, ...}[]`) and
 * return the active sprint's name. Falls back to the most-recently-named
 * sprint when none is active.
 *
 * Tolerant of legacy string-encoded sprint values (older Jira returned a
 * serialized form like `com.atlassian...[id=1,name=Sprint 12,...]`) via
 * best-effort regex extraction.
 *
 * Operators can pin a specific field via `JIRA_SPRINT_FIELD` env var to
 * skip the scan when another customfield collides on shape.
 *
 * Returns null when no sprint is associated or the field isn't present.
 */
export function extractJiraSprint(fields: unknown): string | null {
  if (!fields || typeof fields !== "object") return null;
  const fieldMap = fields as Record<string, unknown>;
  const overrideKey = process.env.JIRA_SPRINT_FIELD;
  const candidateKeys = overrideKey
    ? [overrideKey]
    : Object.keys(fieldMap).filter((k) => k.startsWith("customfield_"));

  for (const key of candidateKeys) {
    const value = fieldMap[key];
    if (!Array.isArray(value)) continue;

    // Modern object form
    const sprintObjects = value.filter(
      (v): v is { name: string; state?: string } =>
        v !== null && typeof v === "object" && typeof (v as any).name === "string",
    );
    if (sprintObjects.length) {
      const active = sprintObjects.find((s) => s.state === "active");
      return (active ?? sprintObjects[sprintObjects.length - 1]).name;
    }

    // Legacy serialized-string form
    const legacy = value.find(
      (v) => typeof v === "string" && /name=/.test(v),
    );
    if (typeof legacy === "string") {
      const m = legacy.match(/name=([^,\]]+)/);
      if (m) return m[1].trim();
    }
  }
  return null;
}
