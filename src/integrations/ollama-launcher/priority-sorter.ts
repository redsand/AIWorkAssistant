/**
 * Priority-based ticket sorting for AiRemoteCoder.
 *
 * Two modes:
 *   label  — extract priority from title prefix [P0]–[P4] or label names
 *            (critical, high, medium, low, p0–p4). Sort by priority ascending.
 *   auto   — call an LLM to rank tickets considering phase dependencies
 *            and context. Falls back to label sorting if the LLM call fails.
 */

import axios from "axios";

export type PriorityMode = "label" | "auto";

export interface PrioritizableItem {
  number: number;
  title: string;
  url: string;
  labels?: string[];
  body?: string;
}

const PRIORITY_MAP: Record<string, number> = {
  critical: 0,
  blocker: 0,
  p0: 0,
  high: 1,
  p1: 1,
  urgent: 1,
  medium: 2,
  p2: 2,
  normal: 2,
  low: 3,
  p3: 3,
  p4: 4,
  p5: 5,
};

const TITLE_PRIORITY_RE = /\[(P(\d))\]/i;
const TRACKING_NUMBER_RE = /\[[^\]]+#(\d+)\]/;

/**
 * Extract a tracking number from title patterns like [ClaimKit #5] or [IR #82].
 * Returns the number, or Infinity if no tracking number is found (so unnumbered
 * items sort last when used as a tiebreaker).
 */
export function extractTrackingNumber(title: string): number {
  const match = title.match(TRACKING_NUMBER_RE);
  return match ? parseInt(match[1], 10) : Infinity;
}

/**
 * Extract a numeric priority from a work item.
 * Checks title prefix first ([P0]–[P4]), then label names.
 * Lower number = higher priority. Defaults to 99 (lowest).
 */
export function extractPriority(item: PrioritizableItem): number {
  // Check title prefix first: [P0], [P1], [P2], [P3], [P4]
  const titleMatch = item.title.match(TITLE_PRIORITY_RE);
  if (titleMatch) {
    return parseInt(titleMatch[2], 10);
  }

  // Check labels
  const labels = (item.labels || []).map((l) =>
    typeof l === "string" ? l.toLowerCase() : (l as any).name?.toLowerCase() ?? "",
  );

  let best = 99;
  for (const label of labels) {
    if (label in PRIORITY_MAP) {
      best = Math.min(best, PRIORITY_MAP[label]);
    }
  }

  return best;
}

/**
 * Compare two items for priority ordering.
 *
 * Ordering rules (in priority order):
 * 1. Explicit priority from [P0]–[P4] title prefix or label (lower = first)
 * 2. Tracking/sequence number from [ProjectName #N] title patterns (lower = first)
 * 3. Stable by original position
 *
 * Dependency ordering ("depends on #X" in body) is applied separately
 * by enforceDependencyOrder() after the primary sort.
 */
function comparePriority(a: PrioritizableItem, b: PrioritizableItem): number {
  // 1. Explicit priority
  const pa = extractPriority(a);
  const pb = extractPriority(b);
  if (pa !== pb) return pa - pb;

  // 2. Tracking/sequence number tiebreaker
  const sa = extractTrackingNumber(a.title);
  const sb = extractTrackingNumber(b.title);
  if (sa !== sb) return sa - sb;

  // 3. Oldest first (lowest issue number) when all priorities equal
  return a.number - b.number;
}

/**
 * Sort items by priority using label/title extraction.
 * Lower priority number = processed first. Equal priorities are tiebroken by
 * tracking numbers ([ClaimKit #5] before [ClaimKit #8]) and dependency declarations.
 */
export function sortByLabelPriority(items: PrioritizableItem[]): PrioritizableItem[] {
  return [...items].sort((a, b) => comparePriority(a, b));
}

/**
 * Reorder items so that dependencies come before their dependents.
 * If item A's body contains "depends on #B" and B is also in the list,
 * B is moved before A. Circular dependencies are left in original order.
 *
 * This is called after the primary sort to ensure dependency ordering
 * is always honored regardless of other priority signals.
 */
export function enforceDependencyOrder(items: PrioritizableItem[]): PrioritizableItem[] {
  const byNumber = new Map(items.map((item) => [item.number, item]));
  const depOf = new Map<number, number[]>(); // issue → list of issues that depend on it

  const DEP_RE = /\b(?:depends\s+on|blocked\s+by|requires|prerequisite\s*:\s*)\s*#(\d+)/gi;

  for (const item of items) {
    const body = item.body || "";
    let match: RegExpExecArray | null;
    while ((match = DEP_RE.exec(body)) !== null) {
      const depNum = parseInt(match[1], 10);
      if (byNumber.has(depNum)) {
        if (!depOf.has(depNum)) depOf.set(depNum, []);
        depOf.get(depNum)!.push(item.number);
      }
    }
    DEP_RE.lastIndex = 0; // reset for next item (global regex)
  }

  if (depOf.size === 0) return items;

  // Topological sort: for each dependency edge (dep → dependent),
  // ensure dep appears before dependent
  const result = [...items];

  // Keep reordering until stable (handles transitive deps)
  let changed = true;
  let iterations = 0;
  while (changed && iterations < items.length) {
    changed = false;
    iterations++;
    for (const [depNum, dependents] of depOf) {
      const depIdx = result.findIndex((i) => i.number === depNum);
      if (depIdx === -1) continue;
      for (const depNum2 of dependents) {
        const depIdx2 = result.findIndex((i) => i.number === depNum2);
        if (depIdx2 !== -1 && depIdx > depIdx2) {
          // Move dependency before dependent
          const [moved] = result.splice(depIdx, 1);
          result.splice(depIdx2, 0, moved);
          changed = true;
        }
      }
    }
  }

  return result;
}

/**
 * Use an LLM to rank tickets. Sends the list of available issues and asks
 * the model to return them in priority order, considering phase dependencies
 * and context.
 *
 * Falls back to label sorting if the LLM call fails.
 */
export async function sortByAutoPriority(
  items: PrioritizableItem[],
  apiUrl: string,
  apiKey: string,
): Promise<PrioritizableItem[]> {
  if (items.length <= 1) return items;

  const ticketList = items
    .map((item, i) => `${i + 1}. #${item.number}: ${item.title} (${item.url})${item.labels?.length ? ` [${item.labels.join(", ")}]` : ""}`)
    .join("\n");

  const systemPrompt = `You are a project manager prioritizing work tickets. Given the list of tickets below, return them in priority order — highest priority first. Consider:
- Phase dependencies: earlier phases (P0, P1) block later ones (P3, P4)
- Business impact: critical/blocker issues first
- If a ticket depends on another being completed first, rank the dependency higher
- Default to label/title priority if uncertain

Respond with ONLY the ticket numbers in priority order, one per line, like:
42
17
46`;

  try {
    const resp = await axios.post(
      `${apiUrl}/api/chat`,
      {
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: ticketList },
        ],
        max_tokens: 256,
        temperature: 0.1,
      },
      {
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        timeout: 30000,
      },
    );

    const text: string = resp.data?.choices?.[0]?.message?.content ?? resp.data?.content ?? "";
    const ranked = text
      .split("\n")
      .map((line: string) => parseInt(line.trim().replace(/^#/, ""), 10))
      .filter((n: number) => !isNaN(n));

    if (ranked.length === 0) {
      return sortByLabelPriority(items);
    }

    // Build a map of issue number -> item for fast lookup
    const byNumber = new Map(items.map((item) => [item.number, item]));

    // Return items in LLM-ranked order, appending any items the LLM didn't rank
    const result: PrioritizableItem[] = [];
    const seen = new Set<number>();

    for (const num of ranked) {
      const item = byNumber.get(num);
      if (item && !seen.has(num)) {
        result.push(item);
        seen.add(num);
      }
    }

    // Append any items the LLM didn't rank
    for (const item of items) {
      if (!seen.has(item.number)) {
        result.push(item);
      }
    }

    return result;
  } catch {
    // Fall back to label-based sorting if LLM call fails
    return sortByLabelPriority(items);
  }
}

/**
 * Sort items by the configured priority mode.
 * Accepts any item shape that has number, title, url, and optional labels/body.
 */
export async function prioritizeItems<T extends PrioritizableItem>(
  items: T[],
  mode: PriorityMode,
  apiUrl: string,
  apiKey: string,
): Promise<T[]> {
  let sorted: T[];
  if (mode === "auto") {
    sorted = await sortByAutoPriority(items, apiUrl, apiKey) as T[];
  } else {
    sorted = sortByLabelPriority(items) as T[];
  }
  // Always enforce dependency ordering as a final pass.
  // This ensures "depends on #X" declarations in issue bodies
  // are honored regardless of the primary sort mode.
  return enforceDependencyOrder(sorted) as T[];
}