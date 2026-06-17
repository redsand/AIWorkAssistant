// --- Dependency resolution ---
//
// Parses dependency references ("depends on #12", "blocked by FOO-3",
// "do not start until BAR-9") out of issue bodies. Code examples in issue
// bodies (fenced or inline code) frequently contain this same syntax as
// documentation; those must NOT be treated as real dependencies, so code
// content is stripped before matching.

const DEPENDENCY_RE = /\b(?:depends\s+on|blocked\s+by|requires|prerequisite\s*:\s*)\s*#(\d+)/gi;
const JIRA_DEPENDENCY_RE = /\b(?:depends\s+on|blocked\s+by|requires|prerequisite\s*:\s*)\s*:?\s*([A-Z][A-Z0-9]+-\d+(?:\s*,\s*[A-Z][A-Z0-9]+-\d+)*)/gi;
const DO_NOT_START_UNTIL_RE = /\bdo\s+not\s+start\b[\s\S]{0,160}?\buntil\b[\s\S]{0,80}?([A-Z][A-Z0-9]+-\d+|#\d+)/gi;
const JIRA_KEY_RE = /\b[A-Z][A-Z0-9]+-\d+\b/g;

export function parseDependencies(body: string): string[] {
  // Strip fenced code blocks first (they may contain backticks), then inline
  // code spans, so dependency syntax shown as documentation is not extracted.
  const strippedBody = body
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]*`/g, "");

  const refs = new Set<string>();
  let match: RegExpExecArray | null;
  const re = new RegExp(DEPENDENCY_RE.source, DEPENDENCY_RE.flags);
  while ((match = re.exec(strippedBody)) !== null) {
    refs.add(match[1]);
  }

  const jiraRe = new RegExp(JIRA_DEPENDENCY_RE.source, JIRA_DEPENDENCY_RE.flags);
  while ((match = jiraRe.exec(strippedBody)) !== null) {
    const keys = match[1].match(JIRA_KEY_RE) || [];
    for (const key of keys) refs.add(key.toUpperCase());
  }

  const doNotStartRe = new RegExp(DO_NOT_START_UNTIL_RE.source, DO_NOT_START_UNTIL_RE.flags);
  while ((match = doNotStartRe.exec(strippedBody)) !== null) {
    const ref = match[1];
    refs.add(ref.startsWith("#") ? ref.slice(1) : ref.toUpperCase());
  }

  return [...refs];
}
