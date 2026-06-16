import type { ChatMessage } from "../agent/providers/types";
import type { ScoredMessage } from "./types";
import { CHARS_PER_TOKEN } from "./types";
import { tokenize, jaccardSimilarity } from "./compressor";

const FRESHNESS_BOOST = 0.5;
const QUERY_RELEVANCE_BOOST = 0.35;
const DEDUP_THRESHOLD = 0.72;

const DOMAIN_KEYWORDS = new Set([
  "jira", "gitlab", "github", "commit", "branch", "merge", "deploy",
  "endpoint", "api", "database", "migration", "schema", "bug", "feature",
  "issue", "ticket", "sprint", "roadmap", "architecture", "service",
  "component", "module", "interface", "function", "class", "method",
  "test", "build", "ci", "cd", "docker", "kubernetes", "config",
  "error", "exception", "stack", "trace", "log", "debug", "perf",
  "security", "auth", "token", "key", "certificate", "encrypt",
]);

export function computeImportance(message: ChatMessage): number {
  let score = 0.3;

  if (message.role === "system") return 1.0;
  if (message.role === "tool") {
    score += message.content.length > 50 ? 0.4 : 0.1;
    return Math.min(score, 1.0);
  }

  const content = message.content || "";
  if (content.length > 100) score += 0.15;
  if (content.length > 500) score += 0.1;
  if (content.length > 1500) score += 0.1;

  const contentTokens = tokenize(content);
  let keywordMatches = 0;
  for (const token of contentTokens) {
    if (DOMAIN_KEYWORDS.has(token)) keywordMatches++;
  }
  score += Math.min(keywordMatches * 0.05, 0.3);

  if (message.tool_calls && message.tool_calls.length > 0) {
    score += 0.3;
  }

  return Math.min(score, 1.0);
}

function computeRecency(_message: ChatMessage, _now: Date): number {
  return 1.0;
}

function computeFreshness(
  _message: ChatMessage,
  messages: ChatMessage[],
  index: number,
): number {
  if (index >= messages.length - 2) return 1.0;
  if (index >= messages.length - 4) return 0.75;
  if (index >= messages.length - 6) return 0.5;
  return FRESHNESS_BOOST;
}

function computeQueryRelevance(message: ChatMessage, query: string): number {
  if (!query) return 0;
  const msgTokens = tokenize(message.content || "");
  const queryTokens = tokenize(query);
  const sim = jaccardSimilarity(msgTokens, queryTokens);
  return sim * QUERY_RELEVANCE_BOOST;
}

export function scoreMessages(
  messages: ChatMessage[],
  query: string,
): ScoredMessage[] {
  const now = new Date();

  return messages.map((message, index) => {
    const importanceScore = computeImportance(message);
    const recencyScore = computeRecency(message, now);
    const freshnessScore = computeFreshness(message, messages, index);
    const queryRelevance = computeQueryRelevance(message, query);

    const effectiveWeight =
      importanceScore * recencyScore * freshnessScore + queryRelevance;

    const tokens = Math.ceil((message.content || "").length / CHARS_PER_TOKEN);

    return {
      index,
      message,
      importanceScore,
      recencyScore,
      freshnessScore,
      queryRelevance,
      effectiveWeight,
      tokens,
    };
  });
}

export function deduplicateByJaccard(
  scored: ScoredMessage[],
  threshold: number = DEDUP_THRESHOLD,
): ScoredMessage[] {
  if (scored.length <= 1) return scored;

  const result: ScoredMessage[] = [];
  const lastUserIndex = [...scored]
    .reverse()
    .find((item) => item.message.role === "user")?.index;

  // Pre-tokenize only messages that participate in deduplication to avoid O(n²) repeated tokenization.
  const tokenCache = new Map<number, Set<string>>();
  for (const item of scored) {
    if (
      item.index === lastUserIndex ||
      item.message.role === "tool" ||
      (item.message.role === "assistant" && item.message.tool_calls?.length)
    ) {
      continue;
    }
    tokenCache.set(item.index, tokenize(item.message.content || ""));
  }

  for (const item of scored) {
    if (
      item.index === lastUserIndex ||
      item.message.role === "tool" ||
      (item.message.role === "assistant" && item.message.tool_calls?.length)
    ) {
      result.push(item);
      continue;
    }

    const itemTokens = tokenCache.get(item.index)!;
    let isDuplicate = false;

    for (const kept of result) {
      if (
        kept.index === lastUserIndex ||
        kept.message.role === "tool" ||
        (kept.message.role === "assistant" && kept.message.tool_calls?.length)
      ) {
        continue;
      }
      const keptTokens = tokenCache.get(kept.index)!;
      const sim = jaccardSimilarity(itemTokens, keptTokens);
      if (sim >= threshold) {
        isDuplicate = true;
        break;
      }
    }

    if (!isDuplicate) {
      result.push(item);
    }
  }

  return result;
}

export function selectMessages(
  scored: ScoredMessage[],
  tokenBudget: number,
): ScoredMessage[] {
  const sorted = [...scored].sort((a, b) => b.effectiveWeight - a.effectiveWeight);
  const byIndex = new Map(scored.map((item) => [item.index, item]));
  const maxIndex = scored.reduce((max, item) => Math.max(max, item.index), -1);

  const systemMsgs = sorted.filter((s) => s.message.role === "system");
  const otherMsgs = sorted.filter((s) => s.message.role !== "system");

  let usedTokens = systemMsgs.reduce((sum, s) => sum + s.tokens, 0);
  const selected: ScoredMessage[] = [...systemMsgs];
  const selectedIndices = new Set(selected.map((s) => s.index));

  const toolGroupFor = (item: ScoredMessage): ScoredMessage[] => {
    if (item.message.role === "assistant" && item.message.tool_calls?.length) {
      const group = [item];
      let next = item.index + 1;
      while (next <= maxIndex) {
        const candidate = byIndex.get(next);
        if (!candidate || candidate.message.role !== "tool") break;
        group.push(candidate);
        next++;
      }
      return group;
    }

    if (item.message.role === "tool") {
      let previous = item.index - 1;
      while (previous >= 0) {
        const candidate = byIndex.get(previous);
        if (!candidate) break;
        if (candidate.message.role === "tool") {
          previous--;
          continue;
        }
        if (candidate.message.role === "assistant" && candidate.message.tool_calls?.length) {
          return toolGroupFor(candidate);
        }
        break;
      }
    }

    return [item];
  };

  const addGroup = (group: ScoredMessage[]): boolean => {
    const missing = group.filter((item) => !selectedIndices.has(item.index));
    const groupTokens = missing.reduce((sum, item) => sum + item.tokens, 0);
    if (usedTokens + groupTokens > tokenBudget) return false;
    usedTokens += groupTokens;
    for (const item of missing) {
      selected.push(item);
      selectedIndices.add(item.index);
    }
    return true;
  };

  const addRequired = (item: ScoredMessage): void => {
    if (selectedIndices.has(item.index)) return;
    usedTokens += item.tokens;
    selected.push(item);
    selectedIndices.add(item.index);
  };

  const lastUserMsg = [...otherMsgs]
    .reverse()
    .find((s) => s.message.role === "user");
  if (lastUserMsg && !selected.includes(lastUserMsg)) {
    addRequired(lastUserMsg);
  }

  // Goal anchor: also force-include the chronologically FIRST user message
  // in the current task window. Without this, multi-turn follow-ups like
  // "keep going" / "i asked about X" lose the original goal — the first
  // user message gets evicted because big tool outputs outscore it on
  // effectiveWeight. Window is bounded to the last CURRENT_TASK_WINDOW
  // messages so we don't surface an unrelated user message from way earlier.
  const CURRENT_TASK_WINDOW = 20;
  const windowStart = Math.max(0, maxIndex - CURRENT_TASK_WINDOW);
  const firstUserInWindow = scored.find(
    (s) => s.index >= windowStart && s.message.role === "user",
  );
  if (
    firstUserInWindow &&
    firstUserInWindow.index !== lastUserMsg?.index &&
    !selectedIndices.has(firstUserInWindow.index)
  ) {
    addRequired(firstUserInWindow);
  }

  for (const msg of otherMsgs) {
    if (selectedIndices.has(msg.index)) continue;
    addGroup(toolGroupFor(msg));
  }

  return selected.sort((a, b) => a.index - b.index);
}
