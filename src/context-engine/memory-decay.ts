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

  for (const item of scored) {
    const itemTokens = tokenize(item.message.content || "");
    let isDuplicate = false;

    for (const kept of result) {
      const keptTokens = tokenize(kept.message.content || "");
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

  const systemMsgs = sorted.filter((s) => s.message.role === "system");
  const otherMsgs = sorted.filter((s) => s.message.role !== "system");

  let usedTokens = systemMsgs.reduce((sum, s) => sum + s.tokens, 0);
  const selected: ScoredMessage[] = [...systemMsgs];

  const lastUserMsg = [...otherMsgs]
    .reverse()
    .find((s) => s.message.role === "user");
  if (lastUserMsg && !selected.includes(lastUserMsg)) {
    usedTokens += lastUserMsg.tokens;
    selected.push(lastUserMsg);
  }

  for (const msg of otherMsgs) {
    if (selected.includes(msg)) continue;
    if (usedTokens + msg.tokens > tokenBudget) continue;
    usedTokens += msg.tokens;
    selected.push(msg);
  }

  return selected.sort((a, b) => a.index - b.index);
}