import { entityMemory } from "../memory/entity-memory";
import type { EntityFact, MemoryEntity } from "../memory/entity-types";

/**
 * Entity-claims context injector (Idea 2: tool results as claims).
 *
 * When the user's query mentions entity-ID-shaped tokens (IR-82, foo/bar#123,
 * !456, etc.), look those entities up in entity-memory and build a structured
 * claim sheet — current values for every attribute we've observed, plus a
 * note when supersession history exists.
 *
 * This is the moment ClaimKit beats RAG decisively:
 *   - RAG retrieves a fading embedding of "Jira issue IR-82 has status..." chunks.
 *   - ClaimKit returns a one-row lookup of the CURRENT status, time-stamped,
 *     with the supersession chain available on demand.
 *
 * The injector adds a dedicated `entity_claims` section to the context packet,
 * sized small (claims are atomic) but always-on when entities match.
 */

const ENTITY_PATTERNS: Array<{ regex: RegExp; normalize: (m: RegExpMatchArray) => string }> = [
  // Jira-style: IR-82, ABC-1234. Two+ uppercase letters - digits.
  { regex: /\b[A-Z]{2,10}-\d+\b/g, normalize: (m) => m[0] },
  // GitHub PR/issue: owner/repo#123 or repo#123.
  { regex: /\b([\w.-]+\/)?[\w.-]+#\d+\b/g, normalize: (m) => m[0] },
  // GitLab MR shorthand: !123 (project context implicit).
  { regex: /(?:^|\s|[(\[])!\d+\b/g, normalize: (m) => m[0].trim().replace(/^[(\[]/, "") },
];

/**
 * Extract candidate entity-ID tokens from arbitrary text.
 * Returns deduplicated raw tokens — entity-memory will normalize for lookup.
 */
export function extractEntityIds(text: string): string[] {
  const found = new Set<string>();
  for (const { regex, normalize } of ENTITY_PATTERNS) {
    // Reset lastIndex since the regex is created with /g and is shared.
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const id = normalize(match);
      if (id && id.length >= 3 && id.length <= 60) found.add(id);
      if (found.size >= 20) break; // Safety cap
    }
    if (found.size >= 20) break;
  }
  return Array.from(found);
}

export interface EntityClaimsSection {
  /** Number of entities matched in memory. */
  entityCount: number;
  /** Total claims included across all entities. */
  claimCount: number;
  /** Number of entities with supersession history (changed values). */
  entitiesWithHistory: number;
  /**
   * Number of recent (<24h) cross-source contradictions flagged for the
   * agent to surface to the user. Idea 3.
   */
  contradictionCount: number;
  /** Rendered text for the context section, or null if no matches. */
  content: string | null;
}

/**
 * Build a structured-claims context section for the given user query.
 * Returns content=null when no entity IDs match memory — caller should
 * skip the section entirely.
 */
export function buildEntityClaimsSection(query: string): EntityClaimsSection {
  const ids = extractEntityIds(query);
  if (ids.length === 0) {
    return { entityCount: 0, claimCount: 0, entitiesWithHistory: 0, contradictionCount: 0, content: null };
  }

  const entities = entityMemory.getEntitiesByNormalizedNames(ids);
  if (entities.length === 0) {
    return { entityCount: 0, claimCount: 0, entitiesWithHistory: 0, contradictionCount: 0, content: null };
  }

  const lines: string[] = ["=== STRUCTURED CLAIMS (current, time-stamped, from prior tool results) ==="];
  let totalClaims = 0;
  let withHistory = 0;
  const contradictionLines: string[] = [];

  for (const entity of entities.slice(0, 8)) {
    const claims = entityMemory.getCurrentClaims(entity.id);
    if (claims.length === 0) continue;

    const header = `## ${entity.name}` + (entity.summary ? ` — ${entity.summary.substring(0, 80)}` : "");
    lines.push("");
    lines.push(header);

    const sourceUrl = entity.sourceUrl ? `  (source: ${entity.sourceUrl})` : "";
    if (sourceUrl) lines.push(sourceUrl);

    let entityHasHistory = false;
    for (const claim of claims) {
      const observed = formatRelative(claim.updatedAt);
      const sourceTag = claim.source ? ` via ${formatSource(claim.source)}` : "";
      // Each claim line is structured so the model can cite it back as:
      // [IR-82.status, observed 2h ago via jira.get_issue]
      lines.push(
        `- ${claim.attribute}: ${claim.value}   _[observed ${observed}${sourceTag}]_`,
      );
      totalClaims++;

      // Look up history for this attribute. If >1 entry, the value has
      // changed at least once — surface that.
      const history = entityMemory.getClaimHistory(entity.id, claim.attribute!);
      if (history.length > 1) {
        entityHasHistory = true;
        const prior = history[1];
        const priorWhen = formatRelative(prior.createdAt);
        lines.push(
          `    _prior value: ${prior.value} (until ${priorWhen})_`,
        );

        // Idea 3: contradiction surfacing. When the prior value flipped
        // recently (< 24h) AND sources disagree, the user might be operating
        // on stale info. Build a separate contradiction note that the agent
        // is instructed to surface PROACTIVELY before answering.
        const priorAge = (Date.now() - Date.parse(prior.createdAt)) / (60 * 60 * 1000);
        if (priorAge < 24 && prior.source !== claim.source) {
          contradictionLines.push(
            `- **${entity.name}.${claim.attribute}**: ${formatSource(claim.source)} says ` +
            `\`${claim.value}\` (${formatRelative(claim.updatedAt)}); ` +
            `${formatSource(prior.source)} previously said \`${prior.value}\` ` +
            `(${formatRelative(prior.createdAt)}). The newer value is shown above, but ` +
            `if the user is asking about something that depends on the prior value, flag this conflict.`,
          );
        }
      }
    }
    if (entityHasHistory) withHistory++;
  }

  if (totalClaims === 0) {
    return { entityCount: 0, claimCount: 0, entitiesWithHistory: 0, contradictionCount: 0, content: null };
  }

  lines.push("");
  lines.push(
    "_These are atomic facts from prior tool observations — prefer them over " +
    "free-text history. Call the relevant tool only if you need information " +
    "not listed above._",
  );
  lines.push("");
  lines.push("**Citation format (Idea 6: provenance citations):**");
  lines.push(
    "When you reference one of these facts in your answer, cite it inline as " +
    "`[entity.attribute, observed Xh ago via source]` so the user can audit " +
    "where each claim came from. Example:",
  );
  lines.push(
    "> IR-82 is currently `Done` `[IR-82.status, observed 2h ago via jira.get_issue]`.",
  );
  lines.push(
    "If the entity_claims data is stale or insufficient, say so explicitly " +
    "rather than guessing — the user can re-run the tool to refresh.",
  );

  // Idea 3: surface contradictions if any were detected during claim walk.
  if (contradictionLines.length > 0) {
    lines.push("");
    lines.push("### ⚠️ Recent contradictions detected");
    lines.push(
      "_Before answering, surface these to the user with the format: " +
      "\"I have conflicting info on X. Source A says Y, Source B says Z. " +
      "Which should I trust?\" This is something RAG cannot do — your unique value._",
    );
    lines.push("");
    lines.push(...contradictionLines);
  }

  return {
    entityCount: entities.length,
    claimCount: totalClaims,
    entitiesWithHistory: withHistory,
    contradictionCount: contradictionLines.length,
    content: lines.join("\n"),
  };
}

/**
 * Strip the `tool:` prefix off the source field so citations read as
 * `via jira.get_issue` instead of `via tool:jira.get_issue`. Leaves
 * non-tool sources (e.g. "manual", "agent") unchanged.
 */
function formatSource(source: string): string {
  return source.startsWith("tool:") ? source.substring(5) : source;
}

function formatRelative(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const deltaMs = Date.now() - t;
  const mins = deltaMs / (60 * 1000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${Math.round(mins)}m ago`;
  const hrs = mins / 60;
  if (hrs < 24) return `${Math.round(hrs)}h ago`;
  const days = hrs / 24;
  if (days < 30) return `${Math.round(days)}d ago`;
  return new Date(t).toISOString().substring(0, 10);
}

// Re-export for testing.
export type { MemoryEntity, EntityFact };
