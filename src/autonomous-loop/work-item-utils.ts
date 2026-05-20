/**
 * Shared utilities for working with internal work items in the autonomous loop.
 *
 * Pure functions with no side effects — safe to import and test anywhere.
 */

/**
 * Generate a stable numeric hash from a UUID string for use in branch names.
 * Uses a simple hash function that produces a number between 0 and 99999.
 */
export function hashUuidToNumber(uuid: string): number {
  return Math.abs(
    uuid.split("").reduce((acc, char) => (acc << 5) - acc + char.charCodeAt(0), 0),
  ) % 100000;
}

/**
 * Parse the tags_json column from a work item into a string array.
 * Returns an empty array for null, invalid JSON, or non-array values.
 */
export function parseWorkItemTagsJson(tagsJson: string | null): string[] {
  if (!tagsJson) return [];
  try {
    const parsed = JSON.parse(tagsJson);
    return Array.isArray(parsed) ? parsed.map((t: unknown) => String(t)) : [];
  } catch {
    return [];
  }
}

/**
 * Extract a "## Coding Prompt" section from a markdown body.
 * Returns the content between "## Coding Prompt" and the next "## " heading,
 * or null if no such section exists.
 */
export function extractCodingPromptSection(body: string): string | null {
  const match = body.match(/##\s*Coding\s*Prompt\s*\n+([\s\S]*?)(?=\n##\s|\n*$)/i);
  if (match?.[1]) {
    return match[1].trim();
  }
  return null;
}
