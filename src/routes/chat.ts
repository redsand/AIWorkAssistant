/**
 * Chat route for AI Assistant integration
 */

import { FastifyInstance } from "fastify";
import { z } from "zod";
import { getSystemPrompt, aiClient } from "../agent";
import type { ToolCall } from "../agent/providers/types";
import { shouldUseContextEngine, assembleContext } from "../context-engine";
import {
  getToolsForRequest,
  getToolsByCategory,
  getToolCategories,
} from "../agent/tool-registry";
import { todoManager } from "../agent/todo-manager";
import { knowledgeStore } from "../agent/knowledge-store";
import { knowledgeGraph } from "../agent/knowledge-graph";
import { codebaseIndexer } from "../agent/codebase-indexer";
import { dispatchToolCall, resolveToolName, recordAndCheckIdenticalCall, recordToolResultEmpty } from "../agent/tool-dispatcher";
import { toolCallCache } from "../memory/tool-cache";
import { AGENT_MODES } from "../config/constants";
import type { Tool, ChatMessage } from "../agent/opencode-client";
import { githubClient } from "../integrations/github/github-client";
import { jitbitClient } from "../integrations/jitbit/jitbit-client";
import { gitlabClient } from "../integrations/gitlab/gitlab-client";
import { jiraClient } from "../integrations/jira/jira-client";
import { conversationManager } from "../memory/conversation-manager";
import { env } from "../config/env";
import { agentRunDatabase } from "../agent-runs/database";
import { sanitizeValue } from "../agent-runs/sanitizer";
import { setOnReapCallback } from "../agent-runs/reaper";
import { zaiRateLimiter } from "../agent/providers/zai-rate-limiter";
import { providerSettings } from "../agent/provider-settings";
import { runProviderPreflight } from "../agent/provider-preflight";
import type { AIProviderName } from "../agent/provider-settings";
import { errorLog } from "../observability/error-log";
import { claimKitAdapter } from "../context-engine/adapters/claimkit-adapter";
import { embeddingService } from "../agent/embedding-service";
import { comparisonRunDatabase } from "../comparison-runs/database";
import type { GroundingHandle } from "../context-engine/types";
import { entityMemory } from "../memory/entity-memory";
import { extractEntityIds } from "../context-engine/entity-claims-injector";

const MAX_SYSTEM_PROMPT_LENGTH = 4000;

const adminUserIds: Set<string> = new Set(
  (env.ADMIN_USER_IDS || "").split(",").map((s) => s.trim()).filter(Boolean),
);

function canOverrideSystemPrompt(userId: string): boolean {
  return adminUserIds.size > 0 && adminUserIds.has(userId);
}


const chatRequestSchema = z.object({
  message: z.string(),
  mode: z
    .enum([AGENT_MODES.PRODUCTIVITY, AGENT_MODES.ENGINEERING])
    .default(AGENT_MODES.PRODUCTIVITY),
  userId: z.string().default("user"),
  sessionId: z.string().nullable().optional(),
  context: z.object({}).optional(),
  includeTools: z.boolean().default(true),
  includeMemory: z.boolean().default(true),
  systemPrompt: z.string().max(MAX_SYSTEM_PROMPT_LENGTH).optional(),
  model: z.string().optional(),
  resend: z.boolean().optional(),
});

const providerSelectionSchema = z.object({
  provider: z.enum(["opencode", "zai", "ollama", "openai"]),
  model: z.string().optional(),
  // Optional saved provider host (provider_hosts.id). Null = clear override.
  hostId: z.string().nullable().optional(),
});

const providerModelsQuerySchema = z.object({
  refresh: z.union([z.literal("true"), z.literal("false"), z.boolean()]).optional(),
});

function getRunProviderMetadata(requestedModel?: string): {
  provider: string;
  model: string;
} {
  const current = providerSettings.getCurrent();
  return {
    provider: current.provider,
    model: requestedModel ?? current.model,
  };
}

function resolveRequestModel(requestedModel?: string): string | undefined {
  const current = providerSettings.getCurrent();
  return requestedModel === current.model ? requestedModel : undefined;
}

function logChatError(input: {
  category: string;
  message: string;
  error?: unknown;
  userId?: string;
  sessionId?: string | null;
  runId?: string | null;
  context?: Record<string, unknown>;
}) {
  const provider = providerSettings.getCurrent();
  void errorLog.log({
    source: "chat",
    severity: "error",
    category: input.category,
    message: input.message,
    error: input.error,
    userId: input.userId,
    sessionId: input.sessionId,
    runId: input.runId,
    context: {
      provider: provider.provider,
      model: provider.model,
      ...input.context,
    },
  });
}

const createSessionSchema = z.object({
  userId: z.string(),
  mode: z.enum([AGENT_MODES.PRODUCTIVITY, AGENT_MODES.ENGINEERING]),
  title: z.string().optional(),
  tags: z.array(z.string()).optional(),
  context: z.object({}).optional(),
});

const MAX_TOOL_LOOPS = env.MAX_TOOL_LOOPS;
const MAX_TOOL_LOOPS_HARD = env.MAX_TOOL_LOOPS_HARD;
const JOB_TIMEOUT_MS = env.AGENT_JOB_TIMEOUT_MS;
const JOB_TIMEOUT_ENABLED = JOB_TIMEOUT_MS > 0;

class ToolLoopLimitError extends Error {
  constructor(limit: number) {
    super(
      `The agent reached the maximum of ${limit} tool loops before producing a final response. Ask it to continue with a narrower scope or fewer searches.`,
    );
    this.name = "ToolLoopLimitError";
  }
}

class JobCancelledError extends Error {
  constructor(message = "Run cancelled by user") {
    super(message);
    this.name = "JobCancelledError";
  }
}

class JobTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(
      `The agent job timed out after ${Math.round(timeoutMs / 60000)} minutes. ` +
      `This can happen with many tool loops or when the AI provider is rate-limiting. ` +
      `Try narrowing the scope or splitting into smaller requests.`,
    );
    this.name = "JobTimeoutError";
  }
}

/**
 * Classifies an error as transient/retryable. Used to decide whether to
 * roll back assistant+tool messages on run failure: for retryable errors
 * (rate limits, 5xx, network blips, timeouts), keep the partial state so
 * a follow-up turn can continue with goal context intact. The repair
 * passes (repairOrphanedToolCalls/repairConversationState) handle any
 * dangling tool calls. Permanent errors (auth, validation, 400) still
 * roll back to avoid poisoning the next request.
 */
function isRetryableTransientError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error instanceof JobTimeoutError) return true;
  if (error instanceof ToolLoopLimitError) return true;
  const msg = error.message.toLowerCase();
  return (
    msg.includes("rate limit") ||
    msg.includes("rate-limited") ||
    msg.includes("rate limited") ||
    msg.includes("429") ||
    msg.includes("throttle") ||
    msg.includes("server error (5") ||
    msg.includes(" 502 ") ||
    msg.includes(" 503 ") ||
    msg.includes(" 504 ") ||
    msg.includes("timed out") ||
    msg.includes("timeout") ||
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("econnrefused") ||
    msg.includes("network") ||
    msg.includes("socket hang up")
  );
}

interface ProcessingJob {
  sessionId: string;
  status: "processing" | "completed" | "failed";
  startedAt: Date;
  lastActivityAt: Date;
  completedAt?: Date;
  runId?: string | null;
  cancelled: boolean;
  cancelReason?: string;
  // Signals provider HTTP calls (ollama/zai/opencode streaming) to abort.
  // Without this, cancellation only set `cancelled=true` and was checked
  // between tool-loop iterations; an inflight streaming POST stayed alive
  // (and held its aiRequestLimiter slot) until the upstream closed the
  // socket — observed leaking slots for 48m in session 926107f7.
  abortController: AbortController;
  events: Array<{ event: string; data: unknown }>;
  subscribers: Set<(event: string, data: unknown) => void>;
  // Steering messages queued by the user mid-run. Drained at the top of
  // each tool-loop iteration and injected as a user message in the
  // conversation, so the model sees them on the next turn without the
  // chat being cancelled and restarted.
  steeringQueue: string[];
}

const processingJobs = new Map<string, ProcessingJob>();

// Register a hook so the agent-run reaper can also abort the in-memory job
// when it marks a run stale. Without this, the DB row flips to 'failed' but
// the inflight provider HTTP call keeps running and its aiRequestLimiter slot
// stays held until the upstream socket closes (root cause of session
// 926107f7's "queued for 120s but no slot opened" errors).
setOnReapCallback((sessionIds) => {
  for (const sid of sessionIds) {
    const job = processingJobs.get(sid);
    if (!job || job.status !== "processing") continue;
    cancelProcessingJob(sid, "Reaped by stale-run sweeper");
  }
});

// Persists which tool categories have been discovered per session so they are
// pre-expanded on subsequent requests instead of requiring a repeat tools.discover call.
const sessionDiscoveredCategories = new Map<string, Set<string>>();

interface SessionUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  messageCount: number;
}
// Exported for testing so tests can seed/reset per-session usage without
// going through the full streaming pipeline.
export const sessionUsageMap = new Map<string, SessionUsage>();

// Lifetime totals since server start — keyed by provider name.
// Reset on server restart; use ZAI_TOKEN_BUDGET to show remaining.
const providerLifetimeUsage = new Map<string, { promptTokens: number; completionTokens: number; totalTokens: number }>();

function recordProviderUsage(provider: string, usage: { promptTokens: number; completionTokens: number; totalTokens: number }) {
  const entry = providerLifetimeUsage.get(provider) ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  entry.promptTokens += usage.promptTokens;
  entry.completionTokens += usage.completionTokens;
  entry.totalTokens += usage.totalTokens;
  providerLifetimeUsage.set(provider, entry);
}

function buildCategoryToolDefs(mode: string, category: string) {
  return getToolsByCategory(mode, category).map((tool) => {
    const properties: Record<string, unknown> = {};
    for (const [key, param] of Object.entries(tool.params)) {
      const { required: _, ...rest } = param as any;
      properties[key] = rest;
    }
    return {
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: "object",
          properties,
          required: Object.entries(tool.params)
            .filter(([_, param]) => (param as any).required)
            .map(([name]) => name),
        },
      },
    };
  });
}

function preExpandFromSession(sessionId: string, mode: string, expandedTools: Tool[]) {
  const knownCategories = sessionDiscoveredCategories.get(sessionId);
  if (!knownCategories) return;
  const existingNames = new Set(expandedTools.map((t) => t.function.name));
  for (const category of knownCategories) {
    for (const td of buildCategoryToolDefs(mode, category)) {
      if (!existingNames.has(td.function.name)) {
        expandedTools.push(td);
        existingNames.add(td.function.name);
      }
    }
  }
}

function capExpandedTools(expandedTools: Tool[], coreTools: Tool[]): Tool[] {
  const maxTools = aiClient.getMaxTools();
  if (!maxTools || expandedTools.length <= maxTools) return expandedTools;

  const coreCount = coreTools.length;
  if (coreCount >= maxTools) {
    return expandedTools.slice(0, maxTools);
  }

  const discoveredBudget = maxTools - coreCount;
  const discovered = expandedTools.slice(coreCount);
  const drop = discovered.length - discoveredBudget;
  if (drop > 0) {
    console.warn(
      `[Chat] Expanded tools ${expandedTools.length} exceeds provider limit ${maxTools}. Evicting ${drop} oldest discovered tools.`,
    );
    return [...expandedTools.slice(0, coreCount), ...discovered.slice(drop)];
  }
  return expandedTools;
}

function recordDiscoveredCategory(sessionId: string, category: string) {
  if (!sessionDiscoveredCategories.has(sessionId)) {
    sessionDiscoveredCategories.set(sessionId, new Set());
  }
  sessionDiscoveredCategories.get(sessionId)!.add(category);
}

function getOrCreateJob(sessionId: string): ProcessingJob {
  let job = processingJobs.get(sessionId);
  if (!job) {
    job = {
      sessionId,
      status: "processing",
      startedAt: new Date(),
      lastActivityAt: new Date(),
      cancelled: false,
      abortController: new AbortController(),
      events: [],
      subscribers: new Set(),
      steeringQueue: [],
    };
    processingJobs.set(sessionId, job);
  } else if (job.abortController.signal.aborted) {
    // Reuse the job slot but replace the spent controller so a brand-new
    // run starts with a fresh signal.
    job.abortController = new AbortController();
  }
  return job;
}

function emitJobEvent(sessionId: string, event: string, data: unknown) {
  const job = processingJobs.get(sessionId);
  if (!job) return;
  job.lastActivityAt = new Date();
  if (job.runId) {
    try { agentRunDatabase.touchRun(job.runId); } catch (e) { console.error("[AgentRuns]", e); }
  }
  job.events.push({ event, data });
  for (const subscriber of job.subscribers) {
    try {
      subscriber(event, data);
    } catch {}
  }
}

function assertJobActive(job: ProcessingJob) {
  if (job.cancelled) {
    throw new JobCancelledError(job.cancelReason);
  }
}

function cancelProcessingJob(
  sessionId: string,
  reason = "Run cancelled by user",
): boolean {
  const job = processingJobs.get(sessionId);
  if (!job || job.status !== "processing") return false;

  job.cancelled = true;
  job.cancelReason = reason;
  job.status = "failed";
  job.completedAt = new Date();
  job.lastActivityAt = new Date();
  // Abort any inflight provider HTTP call so the limiter slot is released
  // immediately. Without this, a stalled streaming request keeps its slot
  // until the upstream closes the socket (observed: 48 minutes for a stale
  // ollama run, which blocked subsequent requests with "queued for 120s").
  try { job.abortController.abort(reason); } catch (e) { console.error("[Chat] abortController.abort failed", e); }

  if (job.runId) {
    try { agentRunDatabase.cancelRun(job.runId, reason); } catch (e) { console.error("[AgentRuns]", e); }
  }

  emitJobEvent(sessionId, "error", {
    error: "Run cancelled",
    message: reason,
    cancelled: true,
  });

  return true;
}

function parseStoredToolContent(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

function compactToolResultForContext(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const obj = result as Record<string, unknown>;
  const data = obj.data as Record<string, unknown> | undefined;
  if (data && typeof data === "object" && data.summary) {
    return {
      success: obj.success,
      data: {
        summary: data.summary,
        export_uuid: data.export_uuid,
        chunks_downloaded: data.chunks_downloaded,
        total_vulnerabilities: data.total_vulnerabilities,
        total_assets: data.total_assets,
        elapsed_seconds: data.elapsed_seconds,
        _guidance: data._guidance,
      },
    };
  }

  // Compact search results (gitlab.search_code, local.search_code, etc.) by
  // truncating the code snippet in later hits. The first few results keep
  // their full data so the model can understand the code, while later hits
  // are reduced to metadata + a preview. This dramatically reduces context
  // bloat from repeated search_code calls (each can be 3-15KB of snippets).
  if (Array.isArray(data)) {
    const FULL_HITS = 3; // Keep full data for the first N results
    const PREVIEW_LINES = 5; // How many lines to keep for truncated hits
    const needsCompaction = data.length > FULL_HITS &&
      data.some((item: any) => typeof item?.data === "string" && item.data.length > 200);
    if (needsCompaction) {
      return {
        success: obj.success,
        data: data.map((item: any, i: number) => {
          if (i < FULL_HITS) return item;
          if (typeof item?.data !== "string") return item;
          const lines = item.data.split("\n");
          if (lines.length <= PREVIEW_LINES + 1) return item;
          return {
            ...item,
            data: lines.slice(0, PREVIEW_LINES).join("\n") + `\n...[${lines.length - PREVIEW_LINES} more lines — use gitlab.get_file to read the full file]`,
          };
        }),
      };
    }
  }

  return result;
}

function compactToolResultForMemory(_toolName: string, result: unknown): unknown {
  // Previously this stripped `data.result` from tools.fetch_cached responses
  // before persistence, replacing it with a short `result_summary` string. The
  // intent was to avoid storing the same blob twice (cache + session). The
  // unintended effect: on the next user turn, session reload showed only the
  // summary, so the agent (correctly) concluded its data was gone and re-
  // fetched in a loop ("context window is fighting me").
  //
  // Now we keep the actual fetched data and rely on:
  //   1. The 4K cap in stringifyToolResultForMemory (truncates large results)
  //   2. rehydrateCachedToolResults on load (restores full data from cache
  //      when still available — see the helper near repairConversationState)
  //
  // This way: cache hits give full fidelity, cache misses still preserve
  // ~4K of actual data instead of just a one-line summary.
  return compactToolResultForContext(result);
}

function stringifyToolResultForContext(result: unknown): string {
  const content = JSON.stringify(compactToolResultForContext(result));
  const maxChars = 25_000;
  if (content.length <= maxChars) return content;
  const omitted = content.length - maxChars;
  return `${content.substring(0, maxChars)}\n...[TRUNCATED: ${omitted} chars omitted — you MUST re-query with a narrower scope (smaller date range, fewer fields). Do NOT summarize or proceed from this partial data.]`;
}

function stringifyToolResultForMemory(toolName: string, result: unknown): string {
  const compacted = compactToolResultForMemory(toolName, result);
  const content = JSON.stringify(compacted);
  // 16K cap is large enough that typical fetch_cached results (10-15KB
  // jira issues, github PR details, etc.) survive without mid-JSON truncation.
  // Previous 4K cap was producing unparseable JSON that the model misread
  // as "data was pruned" — see compactToolResultForMemory for context.
  const maxChars = 16_000;
  if (content.length <= maxChars) return content;

  // OVERSIZED: previously we truncated mid-JSON and appended a sentinel.
  // That broke JSON.parse on session reload, so rehydrateCachedToolResults
  // silently skipped — observed in session 926107f7: 89 messages, 13MB of
  // data permanently lost from the model's view even though the Redis cache
  // still had every result.
  //
  // Now: if the result carries a cache ref, persist a TINY valid-JSON
  // pointer ({_cached_from_ref, _oversized}). rehydrateCachedToolResults
  // then finds the ref and restores the full payload from the live cache.
  // Storage stays small AND the model gets full fidelity on next load.
  let ref: string | undefined;
  if (compacted && typeof compacted === "object") {
    const obj = compacted as Record<string, unknown>;
    if (typeof obj._cached_from_ref === "string") ref = obj._cached_from_ref;
    else if (typeof obj._cached_ref === "string") ref = obj._cached_ref;
    else if (obj.data && typeof obj.data === "object") {
      const d = obj.data as Record<string, unknown>;
      if (typeof d._cached_ref === "string") ref = d._cached_ref;
      else if (typeof d.ref === "string") ref = d.ref;
    }
  }
  if (ref) {
    return JSON.stringify({
      _cached_from_ref: ref,
      _oversized: true,
      _original_bytes: content.length,
      _note: `Tool result (${content.length} bytes) too large for inline storage. Live data is in the session cache and will be rehydrated on next load via ref ${ref}.`,
    });
  }
  // No ref recoverable — fall back to the legacy truncate behavior so
  // rehydration at least sees a sentinel suffix it can recognize.
  return `${content.substring(0, maxChars)}\n...[tool result compacted for session memory: ${content.length - maxChars} chars omitted]`;
}

function getMessageSequenceIssue(messages: ChatMessage[]): string | null {
  const firstNonSystem = messages.findIndex((m) => m.role !== "system");
  if (firstNonSystem !== -1 && messages[firstNonSystem].role !== "user") {
    return `first non-system message at index ${firstNonSystem} is ${messages[firstNonSystem].role}`;
  }

  for (let i = 1; i < messages.length; i++) {
    const prev = messages[i - 1];
    const curr = messages[i];
    if (prev.role === curr.role && curr.role !== "tool" && curr.role !== "system") {
      return `consecutive ${curr.role} messages at index ${i - 1} and ${i}`;
    }
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const toolCalls = msg.role === "assistant" ? msg.tool_calls : undefined;
    if (!toolCalls?.length) continue;
    const expected = new Set(toolCalls.map((tc) => tc.id).filter(Boolean));
    const actual = new Set<string>();
    let j = i + 1;
    while (j < messages.length && messages[j].role === "tool") {
      const toolCallId = messages[j].tool_call_id;
      if (toolCallId) actual.add(toolCallId);
      j++;
    }
    const missing = [...expected].filter((id) => !actual.has(id));
    if (missing.length > 0) {
      return `assistant tool call at index ${i} is missing tool result(s): ${missing.join(",")}`;
    }
  }

  return null;
}

function warnIfInvalidModelMessages(messages: ChatMessage[], source: string): void {
  const issue = getMessageSequenceIssue(messages);
  if (!issue) return;
  console.warn("[Chat] Invalid model message sequence", {
    source,
    issue,
    roles: messages.map((m, index) => `${index}:${m.role}`).join(" "),
  });
}

/**
 * After context pruning, an assistant message's tool_calls may reference IDs
 * that had their corresponding tool-result messages pruned away. This produces
 * an "Invalid model message sequence" error on the next API call.
 *
 * Repair strategy: scan for orphaned tool call IDs and inject a minimal
 * placeholder tool result so the sequence stays valid. Logging keeps the
 * event visible without crashing.
 */
function repairOrphanedToolCalls(messages: ChatMessage[]): ChatMessage[] {
  const repaired: ChatMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    repaired.push(msg);
    if (msg.role !== "assistant" || !msg.tool_calls?.length) continue;

    const expectedIds = new Set(msg.tool_calls.map((tc) => tc.id).filter(Boolean));
    let j = i + 1;
    while (j < messages.length && messages[j].role === "tool") {
      const id = messages[j].tool_call_id;
      if (id) expectedIds.delete(id);
      j++;
    }
    for (const missingId of expectedIds) {
      // Structural repair: an earlier assistant message has tool_calls
      // whose results aren't in the message chain. Insert a neutral
      // placeholder so the API call stays valid. The phrasing is
      // deliberately bland — earlier versions used "pruned from context
      // window" verbatim, which primed the model to repeat that complaint
      // even when its actual tool results were intact.
      console.warn(`[Chat] Inserting placeholder for unpaired tool_call_id ${missingId}`);
      repaired.push({
        role: "tool",
        content:
          "{ \"_placeholder\": true, " +
          "\"_note\": \"Tool result not present in this message chain. " +
          "If this data is needed, call the original tool again or use the matching tools.fetch_cached ref from the session manifest.\" }",
        tool_call_id: missingId,
        name: msg.tool_calls.find((tc) => tc.id === missingId)?.function?.name ?? "unknown",
      } as ChatMessage);
    }
  }
  return repaired;
}

function ensureFirstNonSystemIsUser(messages: ChatMessage[]): ChatMessage[] {
  const firstNonSystemIdx = messages.findIndex((m) => m.role !== "system");
  if (
    firstNonSystemIdx !== -1 &&
    messages[firstNonSystemIdx].role !== "user"
  ) {
    console.warn(
      `[Chat] Inserting placeholder user before first non-system message (${messages[firstNonSystemIdx].role})`,
    );
    messages.splice(firstNonSystemIdx, 0, {
      role: "user",
      content: "[conversation continues]",
    });
  }
  return messages;
}

/**
 * Repairs conversation state left orphaned by a crashed run:
 *
 * 1. Consecutive user messages — when a run crashes before producing an assistant
 *    response, the next user message appends directly after the prior one. Merge
 *    them so the sequence stays valid for all providers.
 *
 * 2. Dangling tool results at end — when a run crashes after executing tools but
 *    before the model responded, the conversation ends with role=tool messages
 *    that have no following assistant. Strip them ONLY if they are truly orphaned
 *    (no matching assistant tool_calls precede them). Valid trailing tool results
 *    that belong to a preceding assistant message are preserved so the model can
 *    process them in the next iteration of the tool loop.
 */
function repairConversationState(messages: ChatMessage[]): ChatMessage[] {
  // Pass 1: merge consecutive non-system same-role messages (handles user+user).
  // System messages are allowed to stack and are left alone.
  const merged: ChatMessage[] = [];
  for (const msg of messages) {
    const last = merged[merged.length - 1];
    if (
      last &&
      last.role === msg.role &&
      msg.role !== "system" &&
      msg.role !== "tool" &&
      typeof last.content === "string" &&
      typeof msg.content === "string"
    ) {
      console.warn(`[Chat] Merging consecutive ${msg.role} messages (orphaned run state)`);
      merged[merged.length - 1] = { ...last, content: `${last.content}\n\n${msg.content}` };
    } else {
      merged.push(msg);
    }
  }

  // Pass 2: trim trailing tool messages ONLY if they are truly orphaned — i.e.,
  // they don't belong to a preceding assistant message's tool_calls. Valid tool
  // results (the current tool loop iteration's results awaiting the next model
  // turn) must be preserved so the model can act on them.
  let end = merged.length;
  while (end > 0 && merged[end - 1].role === "tool") {
    end--;
  }
  if (end < merged.length) {
    // Collect the tool_call_ids of the trailing tool results
    const trailingToolIds = new Set<string>();
    for (let i = end; i < merged.length; i++) {
      if (merged[i].tool_call_id) {
        trailingToolIds.add(merged[i].tool_call_id!);
      }
    }

    // Walk backward from the first trailing tool result to find the nearest
    // assistant message with tool_calls whose IDs cover these tool results.
    let matchedAssistant = false;
    for (let i = end - 1; i >= 0; i--) {
      if (merged[i].role === "assistant" && merged[i].tool_calls?.length) {
        const assistantIds = new Set(
          merged[i].tool_calls!.map((tc) => tc.id).filter(Boolean),
        );
        // If ANY trailing tool result ID matches this assistant's calls,
        // the tool results belong to this assistant and are valid — don't trim.
        for (const id of trailingToolIds) {
          if (assistantIds.has(id)) {
            matchedAssistant = true;
            break;
          }
        }
        break; // Only check the nearest preceding assistant with tool_calls
      }
      // Stop searching if we hit another tool result that's part of a different
      // group — the trailing results are past a message boundary.
      if (merged[i].role !== "tool" && merged[i].role !== "assistant") {
        break;
      }
    }

    if (!matchedAssistant) {
      console.warn(`[Chat] Trimming ${merged.length - end} dangling tool result(s) at end of conversation (orphaned run state)`);
      return merged.slice(0, end);
    }
  }

  return merged;
}

/**
 * Re-inline cached tool results when loading session messages for the LLM.
 *
 * Two compaction patterns persist stubs to session storage to save disk space:
 *
 * 1. Original large tool calls store a stub in the LLM-facing response with
 *    `_cached_ref` + `_cached_size` + `_cached_summary` so the agent sees a
 *    pointer instead of 100KB inline. The agent can call tools.fetch_cached
 *    to retrieve.
 *
 * 2. tools.fetch_cached results are stripped by compactToolResultForMemory
 *    before persistence — `data.result` is replaced with a short summary so
 *    we don't store the same blob twice (cache + session).
 *
 * On the live turn the agent sees the full data. On the NEXT user turn the
 * session reloads with only the stubs/summaries, and the agent (correctly)
 * concludes its data is gone, re-queries, gets stubbed again, and loops.
 *
 * This pass walks the loaded session and, for each tool message that contains
 * a ref pointing to a still-valid cache entry, swaps in the actual cached
 * result. If the cache has expired, the stub stays put.
 */
async function rehydrateCachedToolResults(
  messages: ChatMessage[],
  sessionId: string,
): Promise<ChatMessage[]> {
  // Ensure Redis-backed entries are loaded into memory before lookup. Cheap
  // no-op on already-warmed sessions.
  await toolCallCache.warmSession(sessionId);

  let rehydratedCount = 0;
  let missingCount = 0;
  let salvageCount = 0;
  // Heal map: tool_call_id → new content. Persisted back to session.json at
  // the end so subsequent loads don't have to redo the salvage work and
  // remain readable even if the Redis entry later expires.
  const healMap = new Map<string, string>();

  const result = messages.map((msg) => {
    if (msg.role !== "tool" || typeof msg.content !== "string") return msg;

    let parsed: any;
    try {
      parsed = JSON.parse(msg.content);
    } catch {
      // Salvage path for legacy "tool result compacted for session memory"
      // truncations that left invalid JSON. If the truncated prefix still
      // contains a recognizable cache ref, restore the full result from
      // cache. Recovers the 13MB of data lost in session 926107f7 (and any
      // similar long sessions) on next load.
      const refMatch = msg.content.match(/"_cached_from_ref"\s*:\s*"(tc-[A-Za-z0-9]+)"/)
        || msg.content.match(/"_cached_ref"\s*:\s*"(tc-[A-Za-z0-9]+)"/)
        || msg.content.match(/"ref"\s*:\s*"(tc-[A-Za-z0-9]+)"/);
      if (refMatch) {
        const entry = toolCallCache.getByRef(refMatch[1]);
        if (entry && entry.result && typeof entry.result === "object") {
          rehydratedCount++;
          salvageCount++;
          const healed = JSON.stringify({
            _cached_from_ref: entry.ref,
            _cached_from_tool: entry.toolName,
            _cached_at: new Date(entry.calledAt).toISOString(),
            _salvaged_from_truncated: true,
            ...(entry.result as Record<string, unknown>),
          });
          if (msg.tool_call_id) healMap.set(msg.tool_call_id, healed);
          return { ...msg, content: healed };
        }
        missingCount++;
      }
      return msg;
    }
    if (!parsed || typeof parsed !== "object") return msg;

    // NEW shape (current handleToolsFetchCached output): the original tool
    // result spread at top level with `_cached_from_ref` metadata. If the
    // stored content was truncated to fit the 16K cap, rehydrate from cache.
    if (typeof parsed._cached_from_ref === "string") {
      const entry = toolCallCache.getByRef(parsed._cached_from_ref);
      if (entry && entry.result && typeof entry.result === "object") {
        rehydratedCount++;
        const healed = JSON.stringify({
          _cached_from_ref: entry.ref,
          _cached_from_tool: entry.toolName,
          _cached_at: new Date(entry.calledAt).toISOString(),
          ...(entry.result as Record<string, unknown>),
        });
        // Only heal-to-disk if the persisted form was the tiny pointer
        // (oversized stub). Don't bloat session.json by inlining 400KB
        // when the original was already there.
        if (parsed._oversized === true && msg.tool_call_id) {
          healMap.set(msg.tool_call_id, healed);
        }
        return { ...msg, content: healed };
      }
      missingCount++;
      return msg;
    }

    // LEGACY shape (sessions created before the fetch_cached restructure):
    // tools.fetch_cached compacted-for-memory shape with data.ref + data._note
    // mentioning "compacted in session memory". The result was stripped from
    // session storage entirely — without rehydration the agent sees only a
    // result_summary stub and concludes its data is gone, looping.
    //
    // Deliberately NOT rehydrating original large-call stubs (`_cached_ref` +
    // `_instructions` at top level) — those represent results the agent chose
    // not to fetch; inlining them could be hundreds of KB and blow the budget.
    const data = parsed.data;
    if (
      data &&
      typeof data === "object" &&
      typeof data.ref === "string" &&
      typeof data._note === "string" &&
      data._note.includes("compacted in session memory")
    ) {
      const entry = toolCallCache.getByRef(data.ref);
      if (entry) {
        rehydratedCount++;
        return {
          ...msg,
          content: JSON.stringify({
            success: true,
            data: {
              ref: data.ref,
              tool: data.tool,
              params: data.params,
              called_at: data.called_at,
              result: entry.result,
            },
          }),
        };
      }
      missingCount++;
    }

    return msg;
  });

  if (rehydratedCount > 0 || missingCount > 0) {
    console.log(
      `[Chat] Rehydrated ${rehydratedCount} fetch_cached result(s)` +
        (salvageCount > 0 ? ` (${salvageCount} salvaged from truncated)` : "") +
        (missingCount > 0 ? `; ${missingCount} cache miss(es) — entries may have expired` : ""),
    );
  }
  // Persist healed tool messages so the salvage work survives subsequent
  // loads even if the Redis cache entries later expire.
  if (healMap.size > 0) {
    try {
      conversationManager.healToolMessages(sessionId, healMap);
    } catch (err) {
      console.warn(`[Chat] heal-to-disk failed for session ${sessionId}:`, err instanceof Error ? err.message : err);
    }
  }
  return result;
}

/**
 * Dispatch a tool call through the in-session cache (Layers 1 + 4).
 * - If the (canonical_tool_name, params) hash is already in cache, return the
 *   prior result without executing.
 * - Otherwise execute, store the result in the cache (large results stay full
 *   in the cache; only a summary+ref goes into chat context).
 * - The returned `contextValue` is what should be put into the assistant
 *   conversation messages; it may be a compacted ref-pointer for large results.
 */
async function dispatchToolCallCached(
  sessionId: string | null | undefined,
  toolName: string,
  params: Record<string, unknown>,
  userId: string,
  skipPolicyCheck: boolean,
  ctx: { messages: ChatMessage[]; mode: string },
  toolCallId: string,
): Promise<{ result: any; contextValue: any; cached: boolean }> {
  const canonical = resolveToolName(toolName);

  // Guardrail must fire BEFORE the cache lookup. The 0a6a8d8d incident
  // was 14 identical cached calls in 5 minutes — without this check, the
  // cache served instantly and the model loop ran free.
  if (sessionId) {
    const guard = recordAndCheckIdenticalCall(sessionId, canonical, params);
    if (guard.blocked) {
      console.warn(
        `[Chat] identical-call guardrail blocked '${canonical}' (count=${guard.count}) on session ${sessionId}`,
      );
      const blocked = { success: false, error: guard.error };
      return { result: blocked, contextValue: blocked, cached: false };
    }
  }

  if (sessionId) {
    await toolCallCache.warmSession(sessionId);
    const hit = toolCallCache.get(sessionId, canonical, params);
    if (hit) {
      const wrapped = toolCallCache.wrapCachedAsResult(hit);
      return { result: wrapped, contextValue: wrapped, cached: true };
    }
  }

  const result = await dispatchToolCall(
    toolName,
    params,
    userId,
    skipPolicyCheck,
    ctx,
  );

  let contextValue: unknown = result;
  if (sessionId && toolCallCache.isCacheable(canonical) && result && (result as any).success !== false) {
    const entry = toolCallCache.set(sessionId, canonical, params, result, toolCallId);
    contextValue = toolCallCache.compactForContext(entry);
    if (contextValue !== result) {
      contextValue = {
        success: true,
        _cached_ref: entry.ref,
        _cached_size: entry.resultSize,
        _cached_summary: entry.resultSummary,
        _instructions:
          `Tool call succeeded. Full result (${entry.resultSize} bytes, ${entry.resultSummary}) is in the session cache. ` +
          `To read it, call tools.fetch_cached({ref:"${entry.ref}"}). Treat the fetched data as authoritative.`,
      };
    } else if (
      contextValue &&
      typeof contextValue === "object" &&
      !Array.isArray(contextValue) &&
      !(contextValue as Record<string, unknown>)._cached_ref
    ) {
      // Result was under the LARGE_RESULT_THRESHOLD (so kept inline) but is
      // still cacheable. Inject _cached_ref at top-level so the persistence
      // path can recover the full data on reload even if storage truncation
      // cuts mid-JSON. Closes the 16–50K gap where a 30KB hawk_ir.search_logs
      // would persist as old-shape truncation with no ref to salvage.
      contextValue = {
        ...(contextValue as Record<string, unknown>),
        _cached_ref: entry.ref,
      };
    }
  }

  return { result, contextValue, cached: false };
}

/**
 * Inject (or refresh) the tool-call manifest as a system message in the
 * outgoing message list (Layer 2). The manifest describes every cached tool
 * call this session — surviving conversation pruning because we re-inject it
 * on every model call.
 *
 * Marker: the first 60 chars of the manifest text are recognized so we can
 * strip any prior manifest before adding the fresh one.
 */
const MANIFEST_MARKER = "=== TOOL CALLS ALREADY EXECUTED THIS SESSION ===";
function injectManifest(messages: ChatMessage[], sessionId: string | null | undefined): ChatMessage[] {
  if (!sessionId) return messages;
  const manifest = toolCallCache.buildManifest(sessionId);
  const stripped = messages.filter(
    (m) => !(m.role === "system" && typeof m.content === "string" && m.content.startsWith(MANIFEST_MARKER)),
  );
  if (!manifest) return stripped;
  const firstNonSystemIdx = stripped.findIndex((m) => m.role !== "system");
  const insertAt = firstNonSystemIdx === -1 ? stripped.length : firstNonSystemIdx;
  return [
    ...stripped.slice(0, insertAt),
    { role: "system", content: manifest },
    ...stripped.slice(insertAt),
  ];
}

// Marker so the previous turn's pin can be stripped and replaced. Must match
// the prefix recognized by providers' pruneToContextWindow protection list.
export const USER_DIRECTIVES_MARKER = "=== PINNED USER DIRECTIVES (chronological) ===";

/**
 * Pin all non-trivial user messages as a system-prompt addendum so directives
 * survive the conversation-manager's last-30-messages truncation AND the
 * provider's aggressive prune. Without this, corrections older than ~30 turns
 * are invisible to the model and the user has to repeat themselves
 * (observed in session 926107f7: same correction issued 4+ times).
 *
 * Mirrors the injectManifest shape: strip any prior pin, append fresh one.
 */
export function injectUserDirectives(messages: ChatMessage[], sessionId: string | null | undefined): ChatMessage[] {
  if (!sessionId) return messages;
  const stripped = messages.filter(
    (m) => !(m.role === "system" && typeof m.content === "string" && m.content.startsWith(USER_DIRECTIVES_MARKER)),
  );
  const directives = conversationManager.getUserDirectives(sessionId);
  if (directives.length === 0) return stripped;

  const lines = directives.map((d) => {
    const time = d.timestamp instanceof Date
      ? d.timestamp.toISOString().slice(11, 19) + " UTC"
      : String(d.timestamp);
    // Keep each directive on one line for compact rendering. Newlines in
    // multi-line user messages become " · " separators.
    const oneLine = d.content.replace(/\s+/g, " ").trim();
    return `- [${time}] ${oneLine}`;
  });

  const block = [
    USER_DIRECTIVES_MARKER,
    "These are the user's instructions and corrections from this session, in",
    "chronological order. Treat them as authoritative; they supersede anything",
    "you may have inferred from earlier truncated context. Later directives",
    "override earlier ones if they conflict.",
    "",
    ...lines,
  ].join("\n");

  const firstNonSystemIdx = stripped.findIndex((m) => m.role !== "system");
  const insertAt = firstNonSystemIdx === -1 ? stripped.length : firstNonSystemIdx;
  return [
    ...stripped.slice(0, insertAt),
    { role: "system", content: block },
    ...stripped.slice(insertAt),
  ];
}

// ─── Time anchor ────────────────────────────────────────────────────────
// Inject current time as a system message every turn so the model has a
// concrete temporal anchor instead of guessing from training-data drift.
// Session 926107f7 had the user correct the model's time 5+ times — first on
// DST (MST vs MDT for El Paso in June), then on absolute time ("it is 9:04am
// CDT, not yesterday afternoon").
export const TIME_ANCHOR_MARKER = "=== CURRENT TIME (refreshed each turn) ===";

const DAY_NAMES = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

function buildTimeAnchor(userLocalTz?: { label: string; offsetMinutes: number } | null): string {
  const now = new Date();
  const utcIso = now.toISOString();
  const dayUtc = DAY_NAMES[now.getUTCDay()];
  const lines = [
    TIME_ANCHOR_MARKER,
    `UTC: ${utcIso}`,
    `Day (UTC): ${dayUtc}`,
  ];
  if (userLocalTz) {
    const localMs = now.getTime() + userLocalTz.offsetMinutes * 60_000;
    const local = new Date(localMs);
    const yyyy = local.getUTCFullYear();
    const mm = String(local.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(local.getUTCDate()).padStart(2, "0");
    const hh = String(local.getUTCHours()).padStart(2, "0");
    const mi = String(local.getUTCMinutes()).padStart(2, "0");
    const dayLocal = DAY_NAMES[local.getUTCDay()];
    lines.push(`User local: ${yyyy}-${mm}-${dd} ${hh}:${mi} ${userLocalTz.label} (${dayLocal})`);
  }
  lines.push("");
  lines.push("All timestamps in your responses MUST be expressed in UTC unless the");
  lines.push("user explicitly asks for a different zone. When converting, show your");
  lines.push("work (e.g., '2026-06-18T14:24:37Z = 08:24:37 MDT'). Do not assume the");
  lines.push("current date from training data — use the time above.");
  return lines.join("\n");
}

export function injectTimeAnchor(messages: ChatMessage[], sessionId: string | null | undefined): ChatMessage[] {
  const stripped = messages.filter(
    (m) => !(m.role === "system" && typeof m.content === "string" && m.content.startsWith(TIME_ANCHOR_MARKER)),
  );
  const tz = sessionId ? conversationManager.getInferredTimezone(sessionId) : null;
  const block = buildTimeAnchor(tz);
  const firstNonSystemIdx = stripped.findIndex((m) => m.role !== "system");
  const insertAt = firstNonSystemIdx === -1 ? stripped.length : firstNonSystemIdx;
  return [
    ...stripped.slice(0, insertAt),
    { role: "system", content: block },
    ...stripped.slice(insertAt),
  ];
}

// ─── Timezone / location pin ────────────────────────────────────────────
// Extracts user-stated timezone or location and pins it separately so the
// model can't ignore it as one bullet among many directives.
export const USER_LOCATION_MARKER = "=== USER LOCATION / TIMEZONE (sticky) ===";

export function injectUserLocation(messages: ChatMessage[], sessionId: string | null | undefined): ChatMessage[] {
  if (!sessionId) return messages;
  const stripped = messages.filter(
    (m) => !(m.role === "system" && typeof m.content === "string" && m.content.startsWith(USER_LOCATION_MARKER)),
  );
  const facts = conversationManager.getLocationFacts(sessionId);
  if (facts.length === 0) return stripped;
  const block = [
    USER_LOCATION_MARKER,
    "What the user has told you about their location and timezone. Always honor",
    "the most recent statement when it conflicts with earlier ones.",
    "",
    ...facts.map((f) => `- [${f.timestamp.toISOString().slice(11, 19)} UTC] ${f.content.replace(/\s+/g, " ").trim()}`),
  ].join("\n");
  const firstNonSystemIdx = stripped.findIndex((m) => m.role !== "system");
  const insertAt = firstNonSystemIdx === -1 ? stripped.length : firstNonSystemIdx;
  return [
    ...stripped.slice(0, insertAt),
    { role: "system", content: block },
    ...stripped.slice(insertAt),
  ];
}

// ─── Evidence discipline (report mode) ──────────────────────────────────
// When the user asks for a report / write-up / summary, inject strong
// anti-hallucination guidance. Session 926107f7 showed the model fabricating
// claims like "the malicious IP did not authenticate to other Hunt mailboxes"
// when it had not actually searched for that. Anti-hallucination prompts only
// fire on report-style turns to avoid being noise during normal tool use.
export const EVIDENCE_DISCIPLINE_MARKER = "=== EVIDENCE DISCIPLINE (report mode active) ===";

const REPORT_INTENT_PATTERNS = [
  /\b(comprehensive\s+)?report\b/i,
  /\b(write|wrote)\s+up\b/i,
  /\bsummari[sz]e\b/i,
  /\b(final|incident)\s+summary\b/i,
  /\btimeline\s+(of|report)\b/i,
  /\bwalk\s*through\b/i,
];

function isReportIntent(text: string | undefined): boolean {
  if (!text) return false;
  return REPORT_INTENT_PATTERNS.some((p) => p.test(text));
}

export function injectEvidenceDiscipline(messages: ChatMessage[], sessionId: string | null | undefined): ChatMessage[] {
  const stripped = messages.filter(
    (m) => !(m.role === "system" && typeof m.content === "string" && m.content.startsWith(EVIDENCE_DISCIPLINE_MARKER)),
  );
  // Trigger on the most recent user message — if they're asking for a report
  // right now, the discipline applies to this turn's output.
  const lastUserText = (() => {
    if (!sessionId) return undefined;
    const session = conversationManager.getSession(sessionId);
    if (!session) return undefined;
    for (let i = session.messages.length - 1; i >= 0; i--) {
      if (session.messages[i].role === "user") return session.messages[i].content;
    }
    return undefined;
  })();
  if (!isReportIntent(lastUserText)) return stripped;

  const block = [
    EVIDENCE_DISCIPLINE_MARKER,
    "The user has asked for a report or summary. Apply STRICT evidence",
    "discipline to this turn's output:",
    "",
    "1. Every factual claim MUST cite a specific tool call in this session OR",
    "   a prior user-confirmed statement. Pin tc-xxx refs next to each claim.",
    "2. NEVER make negative assertions (e.g. 'the IP did not authenticate",
    "   elsewhere') unless you have explicitly queried for that scope AND the",
    "   query returned empty. Use 'not investigated' instead of 'did not happen'.",
    "3. Do not extrapolate from one tool result to a broader claim. If a single",
    "   query returned 3 events, report exactly 3 events, not 'all events'.",
    "4. Quote message IDs, IPs, timestamps, and bearer tokens VERBATIM from",
    "   tool results. Do not abbreviate or reformat.",
    "5. If you are not 100% certain about a claim, mark it explicitly as",
    "   '[UNVERIFIED]' and recommend the next query that would verify it.",
    "6. Distinguish 'I queried X and found Y' from 'X happened'.",
  ].join("\n");
  const firstNonSystemIdx = stripped.findIndex((m) => m.role !== "system");
  const insertAt = firstNonSystemIdx === -1 ? stripped.length : firstNonSystemIdx;
  return [
    ...stripped.slice(0, insertAt),
    { role: "system", content: block },
    ...stripped.slice(insertAt),
  ];
}

// ─── Established facts (user-confirmed claims) ──────────────────────────
// When the user explicitly confirms an assistant claim, that claim becomes a
// permanent anchor. Without this, the model contradicts its own prior
// findings (session 926107f7 #913: "'Per Hunt, this is the user's
// workstation.' This was per you in our chat. Is this not true?")
export const ESTABLISHED_FACTS_MARKER = "=== ESTABLISHED FACTS (confirmed by user) ===";

export function injectEstablishedFacts(messages: ChatMessage[], sessionId: string | null | undefined): ChatMessage[] {
  if (!sessionId) return messages;
  const stripped = messages.filter(
    (m) => !(m.role === "system" && typeof m.content === "string" && m.content.startsWith(ESTABLISHED_FACTS_MARKER)),
  );
  const facts = conversationManager.getEstablishedFacts(sessionId);
  if (facts.length === 0) return stripped;
  const block = [
    ESTABLISHED_FACTS_MARKER,
    "These are claims you made earlier that the user explicitly confirmed.",
    "Treat them as ground truth — do NOT contradict them in subsequent turns.",
    "",
    ...facts.map((f) => `- [${f.timestamp.toISOString().slice(0, 19)} UTC] ${f.content.replace(/\s+/g, " ").trim().slice(0, 280)}`),
  ].join("\n");
  const firstNonSystemIdx = stripped.findIndex((m) => m.role !== "system");
  const insertAt = firstNonSystemIdx === -1 ? stripped.length : firstNonSystemIdx;
  return [
    ...stripped.slice(0, insertAt),
    { role: "system", content: block },
    ...stripped.slice(insertAt),
  ];
}

function buildSessionRecovery(sessionId: string) {
  const session = conversationManager.getSession(sessionId);
  if (!session) return null;

  const messages = session.messages.map((message) => ({
    role: message.role,
    content: message.content,
    timestamp: message.timestamp.toISOString(),
    toolCalls: message.toolCalls,
    toolCallId: message.tool_call_id,
  }));
  const assistantMessages = messages
    .filter(
      (message) =>
        message.role === "assistant" && message.content.trim().length > 0,
    )
    .slice(-20);
  const toolResults = session.messages
    .filter((message) => message.role === "tool")
    .slice(-50)
    .map((message) => ({
      toolCallId: message.tool_call_id ?? null,
      timestamp: message.timestamp.toISOString(),
      result: parseStoredToolContent(message.content),
    }));
  const lastUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === "user");
  const runs = agentRunDatabase.listRuns({ sessionId, limit: 20 }).runs;
  const job = processingJobs.get(sessionId);

  return {
    success: true,
    session: {
      id: session.id,
      userId: session.userId,
      mode: session.mode,
      createdAt: session.createdAt.toISOString(),
      updatedAt: session.updatedAt.toISOString(),
      messageCount: session.messages.length,
      lastUserMessage,
    },
    processing: job?.status === "processing",
    job: job
      ? {
          status: job.status,
          startedAt: job.startedAt.toISOString(),
          lastActivityAt: job.lastActivityAt.toISOString(),
          completedAt: job.completedAt?.toISOString() ?? null,
          cancelled: job.cancelled,
          eventCount: job.events.length,
        }
      : null,
    latestRun: runs[0] ?? null,
    runs,
    assistantMessages,
    toolResults,
    messages,
  };
}

// Consume one chatStream iteration, emitting token/thinking/response_start events.
// Returns the accumulated content, thinking, and any tool calls when the stream ends.
async function streamChatIteration(
  sessionId: string,
  job: ProcessingJob,
  messages: ChatMessage[],
  tools: Tool[] | undefined,
  model: string | undefined,
): Promise<{ content: string; thinking: string; toolCalls?: ToolCall[] }> {
  let content = "";
  let thinking = "";
  let toolCalls: ToolCall[] | undefined;

  emitJobEvent(sessionId, "response_start", {});

  const gen = aiClient.chatStream({ messages, tools, temperature: 0.7, top_p: 0.95, model, signal: job.abortController.signal });
  for await (const event of gen) {
    assertJobActive(job);
    if (typeof event === "string") {
      if (event.startsWith("<<THINKING>>")) {
        const thinkContent = event.slice("<<THINKING>>".length).replace(/<<\/\/THINKING>>$/, "");
        if (thinkContent) {
          thinking += thinkContent;
          emitJobEvent(sessionId, "thinking", { thinking: thinkContent });
        }
      } else if (event) {
        content += event;
        emitJobEvent(sessionId, "token", { token: event });
      }
    } else if (event.type === "thinking") {
      thinking += event.content;
      emitJobEvent(sessionId, "thinking", { thinking: event.content });
    } else if (event.type === "tool_calls") {
      toolCalls = event.toolCalls;
    } else if (event.type === "usage") {
      const entry = sessionUsageMap.get(sessionId) ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0, messageCount: 0 };
      entry.promptTokens += event.usage.promptTokens;
      entry.completionTokens += event.usage.completionTokens;
      entry.totalTokens += event.usage.totalTokens;
      entry.messageCount += 1;
      sessionUsageMap.set(sessionId, entry);
      recordProviderUsage(aiClient.providerName, event.usage);
    }
  }

  return { content, thinking, toolCalls };
}

/**
 * Live shadow grounding (Idea 1 from the ClaimKit roadmap).
 *
 * Runs claimKitAdapter.ground() against the agent's actual final response and
 * the RAG evidence that was assembled for the same query, then back-fills
 * rag_hallucination_rate / rag_grounded on the live comparison_cases row.
 *
 * Background-only: never throws, never blocks the user-facing flow. The
 * sampling rate is enforced upstream when populating handle (see
 * context-packet.ts groundingHandle assignment).
 */
/** Total evidence size ceiling derived from env limits. */
const SHADOW_GROUND_TOTAL_CHARS =
  env.CLAIMKIT_LIVE_GROUNDING_MAX_EVIDENCE_DOCS *
  env.CLAIMKIT_LIVE_GROUNDING_MAX_CHARS_PER_DOC;
/** Don't shadow-ground responses below this length — too little signal. */
const SHADOW_GROUND_MIN_RESPONSE_CHARS = 40;

/**
 * Collect pre-extracted entity claims relevant to the agent's response.
 * Scans the response text for entity IDs (IR-82, owner/repo#123, etc.),
 * looks them up in entity-memory, and converts each current claim into a
 * natural-language sentence ClaimKit's grounding verifier can match
 * against directly — no LLM extraction needed.
 *
 * This is the consumer side of ClaimKit's groundFast() pre-extracted
 * claims API. By passing these structured claims, we save the ~30s of
 * LLM extraction cost that ground() would otherwise spend re-deriving
 * the same facts from the raw RAG docs.
 */
function collectPreExtractedClaimsForGrounding(
  responseText: string,
): Array<{ text: string; id: string; source: string; confidence: number }> {
  const ids = extractEntityIds(responseText);
  if (ids.length === 0) return [];

  const entities = entityMemory.getEntitiesByNormalizedNames(ids);
  const claims: Array<{ text: string; id: string; source: string; confidence: number }> = [];

  for (const entity of entities.slice(0, 12)) {
    const current = entityMemory.getCurrentClaims(entity.id);
    for (const c of current.slice(0, 8)) {
      // Render as a complete natural-language sentence so the token-overlap
      // verifier can match it against the response.
      const text = `${entity.name} has ${c.attribute} "${c.value}" as observed at ${c.updatedAt}.`;
      claims.push({
        text,
        id: `entity:${entity.id}:${c.attribute}`,
        source: c.source || "entity-memory",
        confidence: c.confidence,
      });
    }
    if (claims.length >= 30) break;
  }
  return claims;
}

export async function runShadowGrounding(
  handle: GroundingHandle,
  responseText: string,
  sessionId: string,
): Promise<void> {
  try {
    const trimmedResponse = responseText.trim();
    if (trimmedResponse.length < SHADOW_GROUND_MIN_RESPONSE_CHARS) return;
    if (!claimKitAdapter.isAvailable()) return;

    // Fast path: prefer pre-extracted entity claims when available. Skips
    // the ~30s ingest+extract LLM cycle inside ClaimKit's ground().
    const preExtracted = collectPreExtractedClaimsForGrounding(trimmedResponse);

    // Standard path evidence: bounded per-doc, doc count, and total to
    // keep ingest cost predictable even when RAG returned huge docs.
    const maxEvidenceDocs = env.CLAIMKIT_LIVE_GROUNDING_MAX_EVIDENCE_DOCS;
    const maxCharsPerDoc = env.CLAIMKIT_LIVE_GROUNDING_MAX_CHARS_PER_DOC;
    let remaining = SHADOW_GROUND_TOTAL_CHARS;
    const evidence: Array<{ title: string; content: string }> = [];
    for (const e of handle.ragEvidence.slice(0, maxEvidenceDocs)) {
      if (remaining <= 100) break;
      const cap = Math.min(maxCharsPerDoc, remaining);
      const content = e.content.length > cap
        ? e.content.substring(0, cap) + "\n...[truncated for grounding]"
        : e.content;
      evidence.push({ title: e.title, content });
      remaining -= content.length;
    }

    // Bail if neither path has any signal.
    if (preExtracted.length === 0 && evidence.length === 0) return;

    const start = Date.now();
    const result = await claimKitAdapter.ground({
      text: trimmedResponse,
      evidence,
      // ClaimKit fast path: when this is non-empty, ingest+extract is skipped
      // entirely and verification runs directly against these claims. See
      // ../../claimkit/src/core/ClaimKit.ts buildPacketFromPreExtractedClaims.
      preExtractedClaims: preExtracted.length > 0 ? preExtracted : undefined,
      // Token-overlap verifier is much cheaper than the LLM-classified one,
      // and the fast path's claims are already authoritative — full LLM
      // verification adds little. Set to false to enable LLM verification.
      skipLLMVerification: preExtracted.length > 0,
    });
    comparisonRunDatabase.updateCaseGrounding(
      handle.caseId,
      result.hallucinationRate,
      result.grounded,
    );
    console.log(
      `[ShadowGrounding] session=${sessionId} case=${handle.caseId} ` +
      `path=${preExtracted.length > 0 ? "fast" : "standard"} ` +
      `grounded=${result.grounded} halluc=${result.hallucinationRate.toFixed(2)} ` +
      `sentences=${result.sentenceResults.length} ` +
      `pre-extracted=${preExtracted.length} evidence=${evidence.length}docs ` +
      `took=${Date.now() - start}ms`,
    );
  } catch (err) {
    console.warn(
      `[ShadowGrounding] failed for case=${handle.caseId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

async function runChatJob(
  sessionId: string,
  messages: ChatMessage[],
  tools: Tool[] | undefined,
  mode: string,
  userId: string,
  model?: string,
  originalUserQueryOverride?: string,
  groundingHandle?: GroundingHandle,
) {
  console.log("[Chat/Job] runChatJob entered for", sessionId);
  const job = getOrCreateJob(sessionId);
  if (job.cancelled) {
    emitJobEvent(sessionId, "error", {
      error: "Run could not start",
      message: "Previous run was cancelled. Please try again.",
    });
    return;
  }
  job.status = "processing";
  job.events = [];
  job.cancelled = false;
  job.cancelReason = undefined;
  job.startedAt = new Date();
  job.lastActivityAt = new Date();
  job.completedAt = undefined;
  // A previous run on this job may have aborted the controller (or none was
  // ever created if the job was constructed by code that predates this
  // field). Either way, hand the new run a fresh signal.
  if (!job.abortController || job.abortController.signal.aborted) {
    job.abortController = new AbortController();
  }

  const originalUserQuery = originalUserQueryOverride ?? messages.find((m) => m.role === "user")?.content ?? "Unknown query";

  let runId: string | null = job.runId ?? null;
  if (!runId) {
    try {
      const runProvider = getRunProviderMetadata(model);
      runId = agentRunDatabase.startRun({ sessionId, userId, mode, ...runProvider }).id;
      job.runId = runId;
    } catch (e) { console.error("[AgentRuns]", e); }
  }

  const conversationCheckpoint = conversationManager.checkpointSession(sessionId);

  try {
    let stepOrder = 0;
    // loopCount = iterations that did REAL tool work (≥1 uncached call).
    // This is what the agent gets credit/blame for — the budget the
    // model is supposed to spend wisely.
    let loopCount = 0;
    // totalIterations = absolute iteration counter (including pure-
    // cache iterations). Safety net so a stuck model can't burn the
    // event loop forever even when it's not doing real work.
    let totalIterations = 0;
    const jobStartTime = Date.now();
    let expandedTools = [...(tools || [])];
    preExpandFromSession(sessionId, mode, expandedTools);
    expandedTools = capExpandedTools(expandedTools, tools || []);

    const getLoadedToolNames = () => expandedTools.map((t: Tool) => t.function.name);

    const zaiStats = zaiRateLimiter.stats;
    if (zaiStats.active > 0 || zaiStats.queued > 0) {
      console.warn(`[Chat/Job] ZAI contention at start of ${sessionId}: active=${zaiStats.active} queued=${zaiStats.queued} cooldown=${zaiStats.cooldownRemainingMs}ms burstThrottled=${zaiStats.burstThrottled}`);
    }

    assertJobActive(job);
    let modelStart = Date.now();
    try { if (runId) agentRunDatabase.addStep({ runId, stepType: "model_request", content: { user_message: originalUserQuery, zaiQueueDepth: zaiStats.queued, zaiActive: zaiStats.active }, stepOrder: stepOrder++ }); } catch (e) { console.error("[AgentRuns]", e); }

    messages = repairConversationState(messages);
    messages = repairOrphanedToolCalls(messages);
    messages = injectManifest(messages, sessionId);
    messages = injectUserDirectives(messages, sessionId);
    messages = injectEstablishedFacts(messages, sessionId);
    messages = injectEvidenceDiscipline(messages, sessionId);
    messages = injectUserLocation(messages, sessionId);
    messages = injectTimeAnchor(messages, sessionId);
    messages = ensureFirstNonSystemIsUser(messages);
    warnIfInvalidModelMessages(messages, "stream_initial");
    if (JOB_TIMEOUT_ENABLED && Date.now() - jobStartTime > JOB_TIMEOUT_MS) {
      console.warn(`[Chat/Job] Job timeout (${JOB_TIMEOUT_MS}ms) reached before first stream for ${sessionId}`);
      throw new JobTimeoutError(JOB_TIMEOUT_MS);
    }
    let { content, thinking: lastThinking, toolCalls } = await streamChatIteration(
      sessionId, job, messages, expandedTools.length > 0 ? expandedTools : tools, model,
    );

    assertJobActive(job);
    try { if (runId) agentRunDatabase.addStep({ runId, stepType: "model_response", content: { responsePreview: content.slice(0, 500) }, durationMs: Date.now() - modelStart, stepOrder: stepOrder++ }); } catch (e) { console.error("[AgentRuns]", e); }

    while (toolCalls && toolCalls.length > 0) {
      assertJobActive(job);
      // Drain any steering messages the user queued via POST
      // /chat/sessions/:id/steer. Injecting them as user-role messages
      // BEFORE the next model call lets the model pivot based on the
      // steer without the chat being cancelled and restarted.
      if (job.steeringQueue.length > 0) {
        for (const steer of job.steeringQueue) {
          messages.push({ role: "user", content: `[user steering] ${steer}` });
          // Persisted at POST /steer time, not here — otherwise a steer
          // queued but never drained (model finished without another
          // tool-call iteration) would vanish on refresh.
          emitJobEvent(sessionId, "steer_applied", { message: steer });
        }
        job.steeringQueue.length = 0;
      }
      // Always count the iteration toward the absolute safety ceiling
      // BEFORE doing any work — that's the runaway-prevention check.
      // The "useful work" loopCount is incremented AFTER dispatch only
      // when we see at least one uncached call (further down in the
      // loop body). Cache hits are basically free for the system, so
      // they shouldn't burn the budget the model is supposed to spend
      // on real exploration.
      totalIterations++;
      if (totalIterations > MAX_TOOL_LOOPS_HARD) {
        console.warn(`[Chat/Job] Hard iteration ceiling (${MAX_TOOL_LOOPS_HARD}) reached for ${sessionId}`);
        throw new ToolLoopLimitError(MAX_TOOL_LOOPS_HARD);
      }
      if (JOB_TIMEOUT_ENABLED && Date.now() - jobStartTime > JOB_TIMEOUT_MS) {
        console.warn(`[Chat/Job] Job timeout (${JOB_TIMEOUT_MS}ms) reached for ${sessionId}`);
        throw new JobTimeoutError(JOB_TIMEOUT_MS);
      }

      if (content.trim()) {
        try { if (runId) agentRunDatabase.addStep({ runId, stepType: "content", content: { content }, stepOrder: stepOrder++ }); } catch (e) { console.error("[AgentRuns]", e); }
      }

      conversationManager.addMessage(sessionId, {
        role: "assistant",
        content,
        toolCalls: toolCalls.map((tc) => {
          let parsedArgs: any = {};
          try { parsedArgs = JSON.parse(tc.function.arguments); } catch { parsedArgs = { raw: tc.function.arguments }; }
          return { id: tc.id, name: resolveToolName(tc.function.name), params: parsedArgs };
        }),
      });

      const parsedToolCalls = toolCalls.map((tc) => {
        let parsedArgs: any = {};
        try { parsedArgs = JSON.parse(tc.function.arguments); } catch { parsedArgs = { raw: tc.function.arguments }; }
        return { id: tc.id, name: tc.function.name, params: parsedArgs };
      });

      const allToolResults: Record<string, unknown> = {};
      // Per-tool-call nudges from recordToolResultEmpty. Appended to the
      // stringified tool result the model sees on the next iteration, so a
      // flailing search (e.g. 91 hawk_ir.search_logs in session 926107f7)
      // gets a clear "stop and pivot" signal instead of silently looping.
      const toolStreakNudges: Record<string, string> = {};
      const spawnCalls = parsedToolCalls.filter((tc) => tc.name === "agent.spawn");
      const regularCalls = parsedToolCalls.filter((tc) => tc.name !== "agent.spawn");
      // Track whether ANY tool call in this iteration hit network/IO.
      // Pure-cache iterations don't burn the "useful work" budget — the
      // agent already paid for that data earlier in the session.
      let anyUncachedThisIteration = false;

      for (const tc of regularCalls) {
        assertJobActive(job);
        const canonicalName = resolveToolName(tc.name);
        emitJobEvent(sessionId, "tool_start", { id: tc.id, name: canonicalName, params: tc.params });
        try { if (runId) agentRunDatabase.addStep({ runId, stepType: "tool_call", toolName: canonicalName, sanitizedParams: sanitizeValue(tc.params), stepOrder: stepOrder++ }); } catch (e) { console.error("[AgentRuns]", e); }
        const toolStart = Date.now();
        const dispatchParams = { ...tc.params, _mode: mode, _loadedTools: getLoadedToolNames(), _chatSessionId: sessionId };
        const { result, contextValue, cached } = await dispatchToolCallCached(
          sessionId, tc.name, dispatchParams, userId, false, { messages, mode }, tc.id,
        );
        if (!cached) anyUncachedThisIteration = true;
        assertJobActive(job);
        const toolDuration = Date.now() - toolStart;
        allToolResults[tc.id] = cached ? contextValue : compactToolResultForContext(contextValue);
        const streak = recordToolResultEmpty(sessionId, canonicalName, result);
        if (streak.nudge) {
          toolStreakNudges[tc.id] = streak.nudge;
          console.warn(`[Chat] empty-streak nudge for ${canonicalName} in session ${sessionId}: ${streak.nudge}`);
        }
        try { if (runId) agentRunDatabase.addStep({ runId, stepType: "tool_result", toolName: canonicalName, content: { preview: JSON.stringify(result).slice(0, 400) }, success: (result as any).success !== false, errorMessage: (result as any).error, durationMs: toolDuration, stepOrder: stepOrder++ }); } catch (e) { console.error("[AgentRuns]", e); }
        emitJobEvent(sessionId, "tool_result", { id: tc.id, result: cached ? contextValue : result });
        if (canonicalName.startsWith("todo.")) emitJobEvent(sessionId, "todo_changed", { action: canonicalName });

        if (canonicalName === "tools.discover" && (result as any).success) {
          const singleCategory = tc.params.category as string | undefined;
          const categoriesArray = tc.params.categories as string[] | string | undefined;
          const requested: string[] = categoriesArray
            ? Array.isArray(categoriesArray) ? categoriesArray : [categoriesArray]
            : singleCategory ? [singleCategory] : [];
          for (const category of requested) {
            recordDiscoveredCategory(sessionId, category);
            const categoryToolDefs = buildCategoryToolDefs(mode, category);
            const existingNames = new Set(expandedTools.map((t) => t.function.name));
            for (const td of categoryToolDefs) {
              if (!existingNames.has(td.function.name)) {
                expandedTools.push(td);
                existingNames.add(td.function.name);
              }
            }
            expandedTools = capExpandedTools(expandedTools, tools || []);
          }
        }

        conversationManager.addMessage(sessionId, {
          role: "tool",
          content: stringifyToolResultForMemory(canonicalName, contextValue),
          name: canonicalName,
          tool_call_id: tc.id,
        });
      }

      // agent.spawn is always real work (always spawns a subprocess).
      if (spawnCalls.length > 0) anyUncachedThisIteration = true;
      if (spawnCalls.length > 0) {
        for (const tc of spawnCalls) emitJobEvent(sessionId, "tool_start", { id: tc.id, name: tc.name, params: tc.params });
        const spawnResults = await Promise.all(spawnCalls.map(async (tc) => {
          assertJobActive(job);
          try { if (runId) agentRunDatabase.addStep({ runId, stepType: "tool_call", toolName: tc.name, sanitizedParams: sanitizeValue(tc.params), stepOrder: stepOrder++ }); } catch (e) { console.error("[AgentRuns]", e); }
          const spawnStart = Date.now();
          const dispatchParams = { ...tc.params, _mode: mode, _loadedTools: getLoadedToolNames(), _chatSessionId: sessionId };
          const result = await dispatchToolCall(tc.name, dispatchParams, userId, false, { messages, mode });
          assertJobActive(job);
          const spawnDuration = Date.now() - spawnStart;
          try { if (runId) agentRunDatabase.addStep({ runId, stepType: "tool_result", toolName: tc.name, content: { preview: JSON.stringify(result).slice(0, 400) }, success: result.success !== false, errorMessage: result.error, durationMs: spawnDuration, stepOrder: stepOrder++ }); } catch (e) { console.error("[AgentRuns]", e); }
          return { id: tc.id, result, name: tc.name };
        }));
        for (const { id, result, name } of spawnResults) {
          allToolResults[id] = result;
          emitJobEvent(sessionId, "tool_result", { id, result });
          conversationManager.addMessage(sessionId, { role: "tool", content: stringifyToolResultForMemory(name, result), name, tool_call_id: id });
        }
      }

      // Bill the iteration to the "useful work" loopCount only when at
      // least one call actually hit network/IO (or spawned a subprocess).
      // Pure-cache iterations are recorded in totalIterations (the hard
      // safety ceiling above) but don't consume the budget the model is
      // supposed to spend on exploration. Persist on every increment so
      // stalled/failed runs still record how deep the loop went.
      if (anyUncachedThisIteration) {
        loopCount++;
        try { if (runId) agentRunDatabase.updateToolLoopCount(runId, loopCount); } catch (e) { console.error("[AgentRuns]", e); }
        if (loopCount > MAX_TOOL_LOOPS) {
          console.warn(`[Chat/Job] Tool loop limit (${MAX_TOOL_LOOPS}) reached for ${sessionId}`);
          throw new ToolLoopLimitError(MAX_TOOL_LOOPS);
        }
      }

      messages = [
        ...messages,
        { role: "assistant", content, tool_calls: toolCalls },
        ...parsedToolCalls.map((tc) => {
          const base = stringifyToolResultForContext(allToolResults[tc.id]);
          const nudge = toolStreakNudges[tc.id];
          return {
            role: "tool" as const,
            content: nudge ? `${base}\n\n[GUARDRAIL] ${nudge}` : base,
            name: resolveToolName(tc.name),
            tool_call_id: tc.id,
          };
        }),
      ];
      messages = aiClient.pruneMessages(messages, expandedTools.length > 0 ? expandedTools : tools || undefined) as ChatMessage[];
      messages = repairConversationState(messages);
      messages = repairOrphanedToolCalls(messages);
      messages = injectManifest(messages, sessionId);
      messages = injectUserDirectives(messages, sessionId);
      messages = injectEstablishedFacts(messages, sessionId);
      messages = injectEvidenceDiscipline(messages, sessionId);
      messages = injectUserLocation(messages, sessionId);
      messages = injectTimeAnchor(messages, sessionId);
      messages = ensureFirstNonSystemIsUser(messages);

      warnIfInvalidModelMessages(messages, "stream_tool_loop");

      assertJobActive(job);
      modelStart = Date.now();
      try { if (runId) agentRunDatabase.addStep({ runId, stepType: "model_request", content: { user_message: originalUserQuery }, stepOrder: stepOrder++ }); } catch (e) { console.error("[AgentRuns]", e); }

      const next = await streamChatIteration(
        sessionId, job, messages, expandedTools.length > 0 ? expandedTools : undefined, model,
      );
      content = next.content;
      lastThinking = next.thinking;
      toolCalls = next.toolCalls;

      assertJobActive(job);
      try { if (runId) agentRunDatabase.addStep({ runId, stepType: "model_response", content: { responsePreview: content.slice(0, 500) }, durationMs: Date.now() - modelStart, stepOrder: stepOrder++ }); } catch (e) { console.error("[AgentRuns]", e); }
    }

    assertJobActive(job);
    conversationManager.addMessage(sessionId, { role: "assistant", content, ...(lastThinking ? { thinking: lastThinking } : {}) });
    if (content.trim()) {
      try { if (runId) agentRunDatabase.addStep({ runId, stepType: "content", content: { content }, stepOrder: stepOrder++ }); } catch (e) { console.error("[AgentRuns]", e); }
    }
    job.status = "completed";
    job.completedAt = new Date();
    try { if (runId) agentRunDatabase.completeRun(runId, { toolLoopCount: loopCount }); } catch (e) { console.error("[AgentRuns]", e); }

    emitJobEvent(sessionId, "done", {});

    // Fire-and-forget shadow grounding (Idea 1): ground the agent's actual
    // response against the same RAG evidence the model received, then update
    // the comparison_cases row. Sampled by CLAIMKIT_LIVE_GROUNDING_RATE.
    if (groundingHandle && content.trim()) {
      void runShadowGrounding(groundingHandle, content, sessionId);
    }
  } catch (error) {
    console.error(`[Chat/Job] Failed for session ${sessionId}:`, error);
    const cancelled = error instanceof JobCancelledError;
    if (!cancelled) {
      logChatError({
        category: "job_failed",
        message: error instanceof Error ? error.message : "Chat job failed",
        error,
        userId,
        sessionId,
        runId,
        context: { mode, requestedModel: model },
      });
      // Roll back any assistant/tool messages written during this failed run so
      // the next request doesn't inherit orphaned conversation state. Skip for
      // transient errors (rate limits, 5xx, network) — keeping the partial
      // assistant turn preserves the goal anchor so a follow-up turn ("keep
      // going") doesn't strand the user with no model-side context.
      if (!isRetryableTransientError(error)) {
        try {
          conversationManager.rollbackToCheckpoint(sessionId, conversationCheckpoint);
        } catch (e) { console.error("[Chat/Job] Rollback failed:", e); }
      } else {
        console.warn(
          `[Chat/Job] Transient error — keeping partial conversation state for session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // When cancelled (superseded by a new request), don't emit cleanup events.
    // The new request has already created a fresh job with its own subscribers;
    // emitting error/state events here would leak into the new stream.
    if (!cancelled) {
      const isTimeout = error instanceof JobTimeoutError;
      if (job.events[job.events.length - 1]?.event !== "error") {
        emitJobEvent(sessionId, "error", {
          error: isTimeout ? "Request timed out" : "Failed to process request",
          message: error instanceof Error ? error.message : "Unknown error",
          cancelled,
        });
      }

      job.status = "failed";
      job.completedAt = new Date();
      emitJobEvent(sessionId, "state", { processing: false, sessionId });
    }

    try {
      if (runId && !cancelled) {
        agentRunDatabase.failRun(runId, error instanceof Error ? error.message : "Unknown error");
      }
    } catch (e) { console.error("[AgentRuns]", e); }
  }
}

export async function chatRoutes(fastify: FastifyInstance) {
  /**
   * Main chat endpoint
   */
  fastify.post("/chat", async (request, reply) => {
    let runId: string | null = null;
    let sessionId: string | undefined;
    let conversationCheckpoint = 0;
    try {
      const body = chatRequestSchema.parse(request.body);
      const requestModel = resolveRequestModel(body.model);

      const runProvider = getRunProviderMetadata(requestModel);
      try { runId = agentRunDatabase.startRun({ sessionId: body.sessionId ?? null, userId: body.userId, mode: body.mode, ...runProvider }).id; } catch (e) { console.error("[AgentRuns]", e); }

      if (!aiClient.isConfigured()) {
        logChatError({
          category: "provider_not_configured",
          message: "AI provider not configured",
          userId: body.userId,
          sessionId: body.sessionId ?? null,
          runId,
          context: { mode: body.mode },
        });
        try { if (runId) agentRunDatabase.failRun(runId, "AI provider not configured"); } catch (e) { console.error("[AgentRuns]", e); }
        reply.code(503);
        const provider = providerSettings.getCurrent().provider;
        const keyHint =
          provider === "zai"
            ? "ZAI_API_KEY"
            : provider === "ollama"
              ? "OLLAMA_API_URL"
              : provider === "openai"
                ? "OPENAI_API_KEY"
                : "OPENCODE_API_KEY";
        return {
          error: `AI provider (${provider}) not configured`,
          message: `Please set the ${keyHint} environment variable`,
        };
      }

      sessionId = body.sessionId ?? undefined;
      let messages: ChatMessage[];

      const existingSession = sessionId
        ? conversationManager.getSession(sessionId)
        : null;

      if (sessionId && !existingSession) {
        console.error(`[Chat] Session ${sessionId} not found. Client sent a sessionId that does not exist in memory or on disk.`);
        logChatError({
          category: "session_not_found",
          message: `Session ${sessionId} no longer exists`,
          userId: body.userId,
          sessionId,
          runId,
          context: { mode: body.mode },
        });
        reply.code(404);
        return {
          error: "Session not found",
          message: `Session ${sessionId} no longer exists. It may have expired or been cleaned up.`,
        };
      }

      const systemPrompt = (body.systemPrompt && canOverrideSystemPrompt(body.userId))
        ? body.systemPrompt
        : getSystemPrompt(body.mode, body.message, undefined, sessionId ?? undefined);

      // Inject cross-session memories into system prompt when memory is enabled
      let memoryContext = "";
      if (body.includeMemory) {
        try {
          const memories = conversationManager.getRelevantMemories(body.userId, body.message, 3);
          if (memories.length > 0) {
            memoryContext = `## Relevant Past Context\n\n${memories.join("\n")}\n\n`;
          }
        } catch {
          // Memory injection is best-effort
        }
      }

      if (existingSession) {
        conversationManager.addMessage(sessionId!, {
          role: "user",
          content: body.message,
        });
      } else {
        sessionId = conversationManager.startSession(body.userId, body.mode, {
          title: `Chat on ${new Date().toLocaleDateString()}`,
          context: body.context,
        });

        conversationManager.addMessage(sessionId, {
          role: "user",
          content: body.message,
        });
      }

      let nonStreamGroundingHandle: GroundingHandle | undefined = undefined;
      if (body.includeMemory && shouldUseContextEngine()) {
        // Use getRawSessionMessages (no truncation) so rehydration can find cache refs
        // in large tool results before they're truncated.
        const rawSessionMessages = await conversationManager.getRawSessionMessages(
          sessionId!,
          body.includeMemory,
          "engine",
        );
        const sessionMessages = await rehydrateCachedToolResults(rawSessionMessages, sessionId!);
        const estimatedToolTokens = body.includeTools
          ? Math.min(aiClient.estimateTokens([], getToolsForRequest(body.mode, body.message) as any) || 12000, 12000)
          : 0;
        const packet = await assembleContext({
          mode: body.mode,
          query: body.message,
          sessionMessages,
          sessionId: sessionId!,
          includeMemory: body.includeMemory,
          toolInventory: "",
          providerMaxTokens: aiClient.getMaxContextTokens(),
          toolTokens: estimatedToolTokens,
          userId: body.userId,
        });
        messages = packet.messages;
        nonStreamGroundingHandle = packet.groundingHandle;
        // Inject cross-session memory into the system message
        if (memoryContext) {
          const first = messages[0];
          if (first && first.role === "system") {
            first.content = `${memoryContext}${first.content}`;
          } else {
            messages.unshift({ role: "system", content: memoryContext + systemPrompt });
          }
        }
        console.log(
          `[ContextEngine] Packet assembled: ${packet.diagnostics.finalMessageCount} messages, ${packet.totalTokens} tokens, compression=${packet.diagnostics.compressionRatio.toFixed(2)}, budget=${JSON.stringify(packet.diagnostics.budgetUtilization)}, timings=${JSON.stringify(packet.diagnostics.stageTimings)}`,
        );
      } else {
        // Use getRawSessionMessages (no truncation) so rehydration can find cache refs
        // in large tool results before they're truncated.
        const rawSessionMessages = await conversationManager.getRawSessionMessages(
          sessionId!,
          body.includeMemory,
        );
        const sessionMessages = await rehydrateCachedToolResults(rawSessionMessages, sessionId!);
        messages = [
          { role: "system", content: memoryContext ? `${memoryContext}${systemPrompt}` : systemPrompt },
          ...sessionMessages,
        ];
      }

      let tools: Tool[] | undefined = undefined;
      if (body.includeTools) {
        const modeTools = getToolsForRequest(body.mode, body.message);
        tools = modeTools.map((tool) => {
          const properties: Record<string, unknown> = {};
          for (const [key, param] of Object.entries(tool.params)) {
            const { required: _, ...rest } = param as any;
            properties[key] = rest;
          }
          return {
            type: "function" as const,
            function: {
              name: tool.name,
              description: tool.description,
              parameters: {
                type: "object",
                properties,
                required: Object.entries(tool.params)
                  .filter(([_, param]) => (param as any).required)
                  .map(([name]) => name),
              },
            },
          };
        });
      }

      // Preserve the original user query for logging (survives message pruning)
      const originalUserQuery = body.message;
      conversationCheckpoint = sessionId ? conversationManager.checkpointSession(sessionId) : 0;
      let stepOrder = 0;
      try { if (runId) agentRunDatabase.addStep({ runId, stepType: "model_request", content: { user_message: originalUserQuery }, stepOrder: stepOrder++ }); } catch (e) { console.error("[AgentRuns]", e); }
      messages = repairConversationState(messages);
      messages = repairOrphanedToolCalls(messages);
      messages = injectManifest(messages, sessionId);
      messages = injectUserDirectives(messages, sessionId);
      messages = injectEstablishedFacts(messages, sessionId);
      messages = injectEvidenceDiscipline(messages, sessionId);
      messages = injectUserLocation(messages, sessionId);
      messages = injectTimeAnchor(messages, sessionId);
      messages = ensureFirstNonSystemIsUser(messages);

      warnIfInvalidModelMessages(messages, "chat_initial");
      let response = await aiClient.chat({
        messages: messages,
        tools,
        temperature: 0.7,
        top_p: 0.95,
        model: requestModel,
      });
      try { if (runId) agentRunDatabase.addStep({ runId, stepType: "model_response", content: { model: response.model, usage: response.usage, responsePreview: typeof response.content === "string" ? response.content.slice(0, 500) : undefined }, stepOrder: stepOrder++ }); } catch (e) { console.error("[AgentRuns]", e); }

      let allToolCalls: Array<{ id: string; name: string; params: any }> = [];
      let allToolResults: Record<string, unknown> = {};
      let expandedTools = [...(tools || [])];
      if (sessionId) preExpandFromSession(sessionId, body.mode, expandedTools);
      expandedTools = capExpandedTools(expandedTools, tools || []);

      const getLoadedToolNames = () =>
        expandedTools.map((t: Tool) => t.function.name);

      let loopCount = 0;
      let totalIterations = 0;
      const jobStartTime = Date.now();

      while (response.toolCalls && response.toolCalls.length > 0) {
        // Hard ceiling first — pure-cache iterations still count here
        // so a runaway model can't loop forever on cached data.
        totalIterations++;
        if (totalIterations > MAX_TOOL_LOOPS_HARD) {
          console.warn(`[Chat] Hard iteration ceiling (${MAX_TOOL_LOOPS_HARD}) reached`);
          throw new ToolLoopLimitError(MAX_TOOL_LOOPS_HARD);
        }
        if (JOB_TIMEOUT_ENABLED && Date.now() - jobStartTime > JOB_TIMEOUT_MS) {
          console.warn(`[Chat] Job timeout (${JOB_TIMEOUT_MS}ms) reached`);
          throw new JobTimeoutError(JOB_TIMEOUT_MS);
        }
        // anyUncachedThisIteration is set inside the per-tool-call loop
        // below; loopCount is incremented AFTER dispatch only when at
        // least one tool actually hit network/IO. Cache hits are free.
        let anyUncachedThisIteration = false;

        if (response.thinking) {
          try { if (runId) agentRunDatabase.addStep({ runId, stepType: "thinking", content: { thinking: response.thinking }, stepOrder: stepOrder++ }); } catch (e) { console.error("[AgentRuns]", e); }
        }
        if (response.content && response.content.trim()) {
          try { if (runId) agentRunDatabase.addStep({ runId, stepType: "content", content: { content: response.content }, stepOrder: stepOrder++ }); } catch (e) { console.error("[AgentRuns]", e); }
        }

        if (sessionId) {
          conversationManager.addMessage(sessionId, {
            role: "assistant",
            content: response.content,
            toolCalls: response.toolCalls.map((tc) => {
              let parsedArgs: any = {};
              try {
                parsedArgs = JSON.parse(tc.function.arguments);
              } catch {
                parsedArgs = { raw: tc.function.arguments };
              }
              return {
                id: tc.id,
                name: resolveToolName(tc.function.name),
                params: parsedArgs,
              };
            }),
          });
        }

        const toolCalls = response.toolCalls.map((tc) => {
          let parsedArgs: any = {};
          try {
            parsedArgs = JSON.parse(tc.function.arguments);
          } catch {
            parsedArgs = { raw: tc.function.arguments };
          }
          return { id: tc.id, name: tc.function.name, params: parsedArgs };
        });

        allToolCalls = allToolCalls.concat(toolCalls);

        for (const tc of toolCalls) {
          const canonicalName = resolveToolName(tc.name);
          try { if (runId) agentRunDatabase.addStep({ runId, stepType: "tool_call", toolName: canonicalName, sanitizedParams: sanitizeValue(tc.params), stepOrder: stepOrder++ }); } catch (e) { console.error("[AgentRuns]", e); }
          const toolStart = Date.now();
          const dispatchParams = { ...tc.params, _mode: body.mode, _loadedTools: getLoadedToolNames(), _chatSessionId: sessionId };
          const { result, contextValue, cached } = await dispatchToolCallCached(
            sessionId,
            tc.name,
            dispatchParams,
            body.userId,
            false,
            { messages: messages || [], mode: body.mode },
            tc.id,
          );
          if (!cached) anyUncachedThisIteration = true;
          const toolDuration = Date.now() - toolStart;
          const contextResult = cached ? contextValue : compactToolResultForContext(contextValue);
          allToolResults[tc.id] = contextResult;
          if (sessionId) {
            const streak = recordToolResultEmpty(sessionId, canonicalName, result);
            if (streak.nudge) {
              // Wrap the result with the nudge so the model sees it on the
              // next iteration. Same approach as the streaming endpoint.
              const wrap = (typeof contextResult === "object" && contextResult)
                ? { ...(contextResult as object), _streak_nudge: streak.nudge }
                : { _value: contextResult, _streak_nudge: streak.nudge };
              allToolResults[tc.id] = wrap;
              console.warn(`[Chat] empty-streak nudge for ${canonicalName} in session ${sessionId}: ${streak.nudge}`);
            }
          }

          try { if (runId) agentRunDatabase.addStep({ runId, stepType: "tool_result", toolName: canonicalName, content: { preview: JSON.stringify(result).slice(0, 400) }, success: (result as any).success !== false, errorMessage: (result as any).error, durationMs: toolDuration, stepOrder: stepOrder++ }); } catch (e) { console.error("[AgentRuns]", e); }

          if (canonicalName === "tools.discover" && (result as any).success) {
            const singleCategory = tc.params.category as string | undefined;
            const categoriesArray = tc.params.categories as string[] | string | undefined;
            const requested: string[] = categoriesArray
              ? Array.isArray(categoriesArray) ? categoriesArray : [categoriesArray]
              : singleCategory ? [singleCategory] : [];
            for (const category of requested) {
              if (sessionId) recordDiscoveredCategory(sessionId, category);
              const categoryToolDefs = buildCategoryToolDefs(body.mode, category);
              const existingNames = new Set(expandedTools.map((t) => t.function.name));
              for (const td of categoryToolDefs) {
                if (!existingNames.has(td.function.name)) {
                  expandedTools.push(td);
                  existingNames.add(td.function.name);
                }
              }
              expandedTools = capExpandedTools(expandedTools, tools || []);
            }
          }

          if (sessionId) {
            conversationManager.addMessage(sessionId, {
              role: "tool",
              content: stringifyToolResultForMemory(canonicalName, contextValue),
              name: canonicalName,
              tool_call_id: tc.id,
            });
          }
        }

        // Bill to loopCount only when at least one tool actually did work.
        // Pure-cache iterations are tracked in totalIterations (hard
        // ceiling above) so they can't run forever, but they don't burn
        // the "useful work" budget.
        if (anyUncachedThisIteration) {
          loopCount++;
          try { if (runId) agentRunDatabase.updateToolLoopCount(runId, loopCount); } catch (e) { console.error("[AgentRuns]", e); }
          if (loopCount > MAX_TOOL_LOOPS) {
            console.warn(`[Chat] Tool loop limit (${MAX_TOOL_LOOPS}) reached, breaking`);
            throw new ToolLoopLimitError(MAX_TOOL_LOOPS);
          }
        }

        messages = [
          ...messages,
          {
            role: "assistant",
            content: response.content,
            tool_calls: response.toolCalls,
          },
          ...toolCalls.map((tc) => ({
            role: "tool" as const,
            content: stringifyToolResultForContext(allToolResults[tc.id]),
            name: resolveToolName(tc.name),
            tool_call_id: tc.id,
          })),
        ];

        const currentTools =
          expandedTools.length > 0 ? expandedTools : tools || undefined;
        messages = aiClient.pruneMessages(messages, currentTools) as ChatMessage[];
        messages = repairConversationState(messages);
        messages = repairOrphanedToolCalls(messages);
        messages = injectManifest(messages, sessionId);
        messages = injectUserDirectives(messages, sessionId);
        messages = injectEstablishedFacts(messages, sessionId);
        messages = injectEvidenceDiscipline(messages, sessionId);
        messages = injectUserLocation(messages, sessionId);
        messages = injectTimeAnchor(messages, sessionId);
        messages = ensureFirstNonSystemIsUser(messages);

        warnIfInvalidModelMessages(messages, "chat_tool_loop");

        // Use preserved original query (pruning may remove user messages)
        try { if (runId) agentRunDatabase.addStep({ runId, stepType: "model_request", content: { user_message: originalUserQuery }, stepOrder: stepOrder++ }); } catch (e) { console.error("[AgentRuns]", e); }
        response = await aiClient.chat({
          messages: messages,
          tools: expandedTools.length > 0 ? expandedTools : undefined,
          temperature: 0.7,
          top_p: 0.95,
          model: requestModel,
        });
        try { if (runId) agentRunDatabase.addStep({ runId, stepType: "model_response", content: { model: response.model, usage: response.usage, responsePreview: typeof response.content === "string" ? response.content.slice(0, 500) : undefined }, stepOrder: stepOrder++ }); } catch (e) { console.error("[AgentRuns]", e); }
      }

      if (sessionId) {
        conversationManager.addMessage(sessionId, {
          role: "assistant",
          content: response.content,
        });
      }

      if (response.thinking) {
        try { if (runId) agentRunDatabase.addStep({ runId, stepType: "thinking", content: { thinking: response.thinking }, stepOrder: stepOrder++ }); } catch (e) { console.error("[AgentRuns]", e); }
      }
      if (response.content && response.content.trim()) {
        try { if (runId) agentRunDatabase.addStep({ runId, stepType: "content", content: { content: response.content }, stepOrder: stepOrder++ }); } catch (e) { console.error("[AgentRuns]", e); }
      }

      try { if (runId) agentRunDatabase.completeRun(runId, { model: response.model, promptTokens: response.usage?.promptTokens, completionTokens: response.usage?.completionTokens, totalTokens: response.usage?.totalTokens, toolLoopCount: loopCount }); } catch (e) { console.error("[AgentRuns]", e); }

      // Fire-and-forget shadow grounding for the non-streaming /chat path.
      // Same purpose as the streaming hook: back-fill rag_hallucination_rate /
      // rag_grounded on the live comparison_cases row using the agent's
      // actual response and the RAG evidence the model received.
      if (nonStreamGroundingHandle && response.content?.trim() && sessionId) {
        void runShadowGrounding(nonStreamGroundingHandle, response.content, sessionId);
      }

      return {
        sessionId,
        content: response.content,
        thinking: response.thinking,
        toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
        toolResults:
          Object.keys(allToolResults).length > 0 ? allToolResults : undefined,
        usage: response.usage,
        model: response.model,
        done: response.done,
      };
    } catch (error) {
      fastify.log.error(error);
      logChatError({
        category: "request_failed",
        message: error instanceof Error ? error.message : "Failed to process chat request",
        error,
        runId,
      });
      try { if (runId) agentRunDatabase.failRun(runId, error instanceof Error ? error.message : "Unknown error"); } catch (e) { console.error("[AgentRuns]", e); }
      // Roll back any assistant/tool messages — but only if the error is not
      // a transient/retryable one. Keeping partial state on retryable failures
      // preserves goal context for the next turn.
      if (!isRetryableTransientError(error)) {
        try {
          if (sessionId) conversationManager.rollbackToCheckpoint(sessionId, conversationCheckpoint);
        } catch (e) { console.error("[Chat] Rollback failed:", e); }
      }
      return {
        error: "Failed to process chat request",
        message: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  /**
   * Stream chat endpoint
   */
  fastify.post("/chat/stream", async (request, reply): Promise<void> => {
    const body = chatRequestSchema.parse(request.body);
    const requestModel = resolveRequestModel(body.model);

    if (!aiClient.isConfigured()) {
      logChatError({
        category: "provider_not_configured",
        message: "AI provider not configured",
        userId: body.userId,
        sessionId: body.sessionId ?? null,
        context: { mode: body.mode, stream: true },
      });
      reply.code(503);
      const provider = providerSettings.getCurrent().provider;
      const keyHint =
        provider === "zai"
          ? "ZAI_API_KEY"
          : provider === "ollama"
            ? "OLLAMA_API_URL"
            : provider === "openai"
              ? "OPENAI_API_KEY"
              : "OPENCODE_API_KEY";
      return reply.send({
        error: `AI provider (${provider}) not configured`,
        message: `Please set the ${keyHint} environment variable`,
      });
    }

    reply.hijack();

    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no");
    reply.raw.flushHeaders();
    if (reply.raw.socket) {
      reply.raw.socket.setNoDelay(true);
    }

    const sendEvent = (event: string, data: unknown) => {
      try {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {}
    };

    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(": heartbeat\n\n");
      } catch {
        clearInterval(heartbeat);
      }
    }, 15000);

    const cleanupConnection = () => {
      clearInterval(heartbeat);
      try {
        reply.raw.end();
      } catch {}
    };

    try {
      let sessionId = body.sessionId;
      const activeJob = sessionId ? processingJobs.get(sessionId) : null;

      // Duplicate-message detection: if the client submits the same text as
      // the last user message within 60 seconds, treat it as a resend. This
      // prevents the "user typed the same question twice because they didn't
      // see a response" pattern (session 926107f7 msg #732/#733) from
      // cancelling an in-flight job or doubling work.
      if (
        sessionId &&
        !body.resend &&
        typeof body.message === "string" &&
        body.message.trim().length > 0
      ) {
        const existing = conversationManager.getSession(sessionId);
        if (existing) {
          const lastUser = [...existing.messages].reverse().find((m) => m.role === "user");
          if (lastUser && lastUser.content.trim() === body.message.trim()) {
            const ageMs = Date.now() - lastUser.timestamp.getTime();
            if (ageMs < 60_000) {
              console.warn(
                `[Chat/Stream] Duplicate user message within ${Math.round(ageMs / 1000)}s — treating as resend (session ${sessionId})`,
              );
              body.resend = true;
            }
          }
        }
      }

      if (activeJob?.status === "processing") {
        if (!body.resend) {
          // A brand-new message submission while a job is running: cancel the
          // old job and fall through to start a fresh one. Without this the
          // new message is never persisted and disappears on page refresh.
          console.warn(
            `[Chat/Stream] New message submitted while job running for ${sessionId} — cancelling old job`,
          );
          cancelProcessingJob(sessionId!, "Superseded by new message");
          // Remove the old job from the map immediately so getOrCreateJob
          // below produces a fresh object. The old runChatJob coroutine still
          // holds a reference to the cancelled object and will terminate on
          // its next assertJobActive call.
          processingJobs.delete(sessionId!);
        } else {
          // Resend / SSE reconnect: reattach to the in-flight job so the
          // client picks up buffered events and stays in sync.
          sendEvent("session", { sessionId });
          for (const evt of activeJob.events) {
            sendEvent(evt.event, evt.data);
          }

          const subscriber = (event: string, data: unknown) => {
            sendEvent(event, data);
            if (event === "done" || event === "error") {
              const cleanupDelay = event === "error" ? 1500 : 100;
              setTimeout(() => {
                cleanupConnection();
              }, cleanupDelay);
            }
          };
          activeJob.subscribers.add(subscriber);

          const socket = reply.raw.socket || request.raw.socket;
          if (socket) {
            socket.on("close", () => {
              activeJob.subscribers.delete(subscriber);
              cleanupConnection();
            });
          }
          return;
        }
      }

      const systemPrompt = (body.systemPrompt && canOverrideSystemPrompt(body.userId))
        ? body.systemPrompt
        : getSystemPrompt(body.mode, body.message, undefined, sessionId ?? undefined);

      const existingSession = sessionId
        ? conversationManager.getSession(sessionId)
        : null;

      if (sessionId && !existingSession) {
        console.error(`[Chat/Stream] Session ${sessionId} not found. Client sent a sessionId that does not exist in memory or on disk.`);
        logChatError({
          category: "session_not_found",
          message: `Session ${sessionId} no longer exists`,
          userId: body.userId,
          sessionId,
          context: { mode: body.mode, stream: true },
        });
        sendEvent("error", {
          error: "Session not found",
          message: `Session ${sessionId} no longer exists. It may have expired or been cleaned up.`,
        });
        cleanupConnection();
        return;
      }

      let messages: ChatMessage[];

      if (!body.resend) {
        if (existingSession) {
          conversationManager.addMessage(sessionId!, {
            role: "user",
            content: body.message,
          });
        } else {
          sessionId = conversationManager.startSession(body.userId, body.mode);
          conversationManager.addMessage(sessionId, {
            role: "user",
            content: body.message,
          });
        }
      } else if (!existingSession) {
        sessionId = conversationManager.startSession(body.userId, body.mode);
        conversationManager.addMessage(sessionId, {
          role: "user",
          content: body.message,
        });
      }

      sendEvent("session", { sessionId });

      const job = getOrCreateJob(sessionId!);
      job.cancelled = false;
      job.cancelReason = undefined;
      job.runId = undefined;
      // If we just reused a job whose controller was previously aborted (by a
      // superseded run), swap in a fresh controller. getOrCreateJob does this
      // when the slot is new, but resetting here covers the "reuse on resend"
      // path where the same job object was kept but a prior cancel fired.
      if (job.abortController.signal.aborted) {
        job.abortController = new AbortController();
      }
      const subscriber = (event: string, data: unknown) => {
        sendEvent(event, data);
        if (event === "done" || event === "error") {
          console.log(`[Chat/Stream] Subscriber received ${event}, scheduling cleanup`);
          const cleanupDelay = event === "error" ? 1500 : 100;
          setTimeout(() => {
            cleanupConnection();
          }, cleanupDelay);
        }
      };
      job.subscribers.add(subscriber);
      let earlyRunId: string | null = null;
      const runProvider = getRunProviderMetadata(requestModel);
      try { earlyRunId = agentRunDatabase.startRun({ sessionId, userId: body.userId, mode: body.mode, ...runProvider }).id; job.runId = earlyRunId; } catch (e) { console.error("[AgentRuns]", e); }

      // Carries the live shadow-grounding handle out of the context-assembly
      // block so it can be passed to runChatJob and fired after the agent
      // responds. Undefined when grounding wasn't sampled for this query.
      let groundingHandle: GroundingHandle | undefined = undefined;

      if (body.includeMemory && shouldUseContextEngine()) {
        sendEvent("processing", { message: "Assembling context..." });
        const contextStart = Date.now();
        try {
          try { if (earlyRunId) agentRunDatabase.addStep({ runId: earlyRunId, stepType: "note", content: { stage: "context_start", message: body.message }, stepOrder: -4 }); } catch (e) { console.error("[AgentRuns]", e); }
          // Use getRawSessionMessages (no truncation) so rehydration can find cache refs
          // in large tool results before they're truncated.
          const rawSessionMessages = await conversationManager.getRawSessionMessages(
            sessionId!,
            body.includeMemory,
            "engine",
          );
          const sessionMessages = await rehydrateCachedToolResults(rawSessionMessages, sessionId!);
          try { if (earlyRunId) agentRunDatabase.addStep({ runId: earlyRunId, stepType: "note", content: { stage: "context_session_messages", count: sessionMessages.length }, stepOrder: -3 }); } catch (e) { console.error("[AgentRuns]", e); }
          const estimatedToolTokens = body.includeTools
            ? Math.min(aiClient.estimateTokens([], getToolsForRequest(body.mode, body.message) as any) || 12000, 12000)
            : 0;
          try { if (earlyRunId) agentRunDatabase.addStep({ runId: earlyRunId, stepType: "note", content: { stage: "context_tool_budget", estimatedToolTokens }, stepOrder: -2 }); } catch (e) { console.error("[AgentRuns]", e); }
          const packet = await assembleContext({
            mode: body.mode,
            query: body.message,
            sessionMessages,
            sessionId: sessionId!,
            includeMemory: body.includeMemory,
            toolInventory: "",
            providerMaxTokens: aiClient.getMaxContextTokens(),
            toolTokens: estimatedToolTokens,
            userId: body.userId,
            onProgress: (message) => sendEvent("processing", { message }),
          });
          messages = packet.messages;
          groundingHandle = packet.groundingHandle;
          // Idea 3 + I: surface cross-source contradictions to the UI so the
          // user can resolve the conflict before relying on the agent's
          // answer. The agent already gets this in its system prompt; the
          // event gives the frontend a chance to render a banner.
          if (packet.contradictions && packet.contradictions.length > 0) {
            sendEvent("contradictions", { items: packet.contradictions });
          }
          console.log(
            `[ContextEngine] Packet assembled: ${packet.diagnostics.finalMessageCount} messages, ${packet.totalTokens} tokens, compression=${packet.diagnostics.compressionRatio.toFixed(2)}, budget=${JSON.stringify(packet.diagnostics.budgetUtilization)}, timings=${JSON.stringify(packet.diagnostics.stageTimings)}`,
          );
          try { if (earlyRunId) agentRunDatabase.addStep({ runId: earlyRunId, stepType: "note", content: { stage: "context_complete", finalMessageCount: packet.diagnostics.finalMessageCount, totalTokens: packet.totalTokens, compressionRatio: packet.diagnostics.compressionRatio, documentsRetrieved: packet.diagnostics.documentsRetrieved, documentsCompressed: packet.diagnostics.documentsCompressed, stageTimings: packet.diagnostics.stageTimings, claimkit: packet.diagnostics.claimkit }, durationMs: Date.now() - contextStart, stepOrder: -1 }); } catch (e) { console.error("[AgentRuns]", e); }
          sendEvent("processing", { message: "Generating response..." });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Context assembly failed";
          try { if (earlyRunId) agentRunDatabase.addStep({ runId: earlyRunId, stepType: "error", content: { stage: "context_failed" }, errorMessage: message, durationMs: Date.now() - contextStart, stepOrder: -1 }); } catch (e) { console.error("[AgentRuns]", e); }
          try { if (earlyRunId) agentRunDatabase.failRun(earlyRunId, message); } catch (e) { console.error("[AgentRuns]", e); }
          job.status = "failed";
          job.completedAt = new Date();
          logChatError({
            category: "context_assembly_failed",
            message,
            error,
            userId: body.userId,
            sessionId,
            runId: earlyRunId,
            context: { mode: body.mode, stream: true },
          });
          sendEvent("error", {
            error: "Context assembly failed",
            message,
          });
          cleanupConnection();
          return;
        }
      } else {
        // Use getRawSessionMessages (no truncation) so rehydration can find cache refs
        // in large tool results before they're truncated.
        const rawSessionMessages = await conversationManager.getRawSessionMessages(
          sessionId!,
          body.includeMemory,
        );
        const sessionMessages = await rehydrateCachedToolResults(rawSessionMessages, sessionId!);
        messages = [
          { role: "system", content: systemPrompt },
          ...sessionMessages,
        ];
      }

      let tools: Tool[] | undefined = undefined;
      if (body.includeTools) {
        const modeTools = getToolsForRequest(body.mode, body.message);
        tools = modeTools.map((tool) => {
          const properties: Record<string, unknown> = {};
          for (const [key, param] of Object.entries(tool.params)) {
            const { required: _, ...rest } = param as any;
            properties[key] = rest;
          }
          return {
            type: "function" as const,
            function: {
              name: tool.name,
              description: tool.description,
              parameters: {
                type: "object",
                properties,
                required: Object.entries(tool.params)
                  .filter(([_, param]) => (param as any).required)
                  .map(([name]) => name),
              },
            },
          };
        });
      }

      // After context assembly (especially ClaimKit seeding), ZAI may be rate-limited.
      // Wait for the cooldown to expire before starting the chat so the first streaming
      // attempt doesn't immediately hit 429.
      const preStartCooldown = zaiRateLimiter.stats.cooldownRemainingMs;
      if (preStartCooldown > 0) {
        const waitMs = Math.min(preStartCooldown + 500, 30_000);
        console.warn(`[Chat/Stream] ZAI cooldown active after context assembly (${preStartCooldown}ms) — waiting ${waitMs}ms before chat`);
        sendEvent("processing", { message: "API rate limit settling..." });
        await new Promise((r) => setTimeout(r, waitMs));
      }

      console.log("[Chat/Stream] Starting runChatJob for", sessionId);
      runChatJob(sessionId!, messages, tools, body.mode, body.userId, requestModel, body.message, groundingHandle)
        .then(() => console.log("[Chat/Stream] runChatJob completed for", sessionId))
        .catch((err) => {
          logChatError({
            category: "background_job_failed",
            message: err instanceof Error ? err.message : "Background chat job failed",
            error: err,
            userId: body.userId,
            sessionId,
            runId: earlyRunId,
            context: { mode: body.mode, stream: true },
          });
          console.error("[Chat/Stream] Background job error:", err);
        })
        .finally(() => {
          job.subscribers.delete(subscriber);
          setTimeout(() => {
            if (job.subscribers.size === 0) {
              processingJobs.delete(sessionId!);
            }
          }, 5000);
        });

      // Detect actual client disconnect via the underlying socket.
      // Do NOT use request.raw.on("close") — Fastify destroys the request
      // stream after body parsing, which fires long before the client leaves.
      const socket = reply.raw.socket || request.raw.socket;
      if (socket) {
        socket.on("close", () => {
          job.subscribers.delete(subscriber);
          cleanupConnection();
        });
        socket.on("error", () => {
          job.subscribers.delete(subscriber);
          cleanupConnection();
        });
      }

      // Keep the SSE connection alive until the client disconnects or the
      // job completes and cleanupConnection() ends the response.
      await new Promise<void>((resolve) => {
        if (socket) {
          socket.once("close", resolve);
        } else {
          setTimeout(() => resolve(), 300000);
        }
      });
    } catch (error) {
      fastify.log.error(error);
      logChatError({
        category: "stream_request_failed",
        message: error instanceof Error ? error.message : "Failed to process stream request",
        error,
        userId: body.userId,
        sessionId: body.sessionId ?? null,
        context: { mode: body.mode, stream: true },
      });
      sendEvent("error", {
        error: "Failed to process stream request",
        message: error instanceof Error ? error.message : "Unknown error",
      });
      cleanupConnection();
    }
  });

  fastify.post("/chat/sessions/:sessionId/cancel", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const session = conversationManager.getSession(sessionId);

    if (!session) {
      reply.code(404);
      return { error: "Session not found" };
    }

    const cancelled = cancelProcessingJob(sessionId);
    return {
      success: true,
      sessionId,
      cancelled,
      message: cancelled ? "Run cancelled" : "No active run for session",
    };
  });

  /**
   * Steer an already-running chat. Queues a user-message instruction
   * that's drained at the top of the next tool-loop iteration and
   * injected into the model's context, letting the user redirect a run
   * without cancelling and restarting it.
   *
   * Body: { message: string }
   * Returns: { queued: true, queueDepth: N } or 409 if no active run.
   */
  fastify.post("/chat/sessions/:sessionId/steer", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const body = request.body as { message?: unknown } | undefined;
    const text = typeof body?.message === "string" ? body.message.trim() : "";
    if (!text) {
      reply.code(400);
      return { error: "message (non-empty string) is required" };
    }
    if (text.length > 2000) {
      reply.code(400);
      return { error: "steering message capped at 2000 chars" };
    }
    const job = processingJobs.get(sessionId);
    if (!job || job.status !== "processing") {
      reply.code(409);
      return { error: "No active run to steer for this session" };
    }
    // Persist BEFORE the tool loop drains the queue, so the steer
    // survives a page refresh even when the model finishes its current
    // turn without another tool-call iteration (in which case the loop
    // exits and the in-memory queue is discarded). Stored as a plain
    // user-role message so it renders identically to anything else the
    // user typed; the model-facing copy in the tool-loop drain still
    // gets the "[user steering]" prefix so the model knows it's a
    // mid-stream injection, not a fresh turn.
    conversationManager.addMessage(sessionId, { role: "user", content: text });
    job.steeringQueue.push(text);
    emitJobEvent(sessionId, "steer_queued", { message: text });
    return {
      success: true,
      sessionId,
      queueDepth: job.steeringQueue.length,
      message: "Steer queued — will apply on next tool-loop iteration",
    };
  });

  /**
   * Upload files to a session. Body is JSON with base64-encoded contents
   * (no multipart dep). Files are written to
   * data/profiles/<active>/uploads/<sessionId>/<safeName> with traversal
   * protection. The returned `path` is the absolute on-disk path; the
   * caller embeds that into the next chat message so the model sees the
   * attachments via local.read_file.
   *
   * Body: { files: [{ name, mime?, contentBase64 }] }
   * 10MB per-file cap, 50 files per request.
   */
  fastify.post("/chat/sessions/:sessionId/files", async (request, reply) => {
    const fs = await import("fs");
    const path = await import("path");
    const { sessionId } = request.params as { sessionId: string };
    const body = request.body as
      | { files?: Array<{ name?: unknown; mime?: unknown; contentBase64?: unknown }> }
      | undefined;
    const files = Array.isArray(body?.files) ? body!.files : [];
    if (files.length === 0) {
      reply.code(400);
      return { error: "files[] is required" };
    }
    if (files.length > 50) {
      reply.code(400);
      return { error: "max 50 files per upload" };
    }
    const sessionSafe = /^[a-f0-9-]+$/i.test(sessionId) ? sessionId : "default";
    const baseDir = path.resolve(
      process.cwd(),
      "data",
      "profiles",
      "default",
      "uploads",
      sessionSafe,
    );
    fs.mkdirSync(baseDir, { recursive: true });

    const stored: Array<{ name: string; path: string; size: number; mime: string }> = [];
    for (const f of files) {
      const rawName = typeof f.name === "string" ? f.name : "";
      const mime = typeof f.mime === "string" ? f.mime : "application/octet-stream";
      const content = typeof f.contentBase64 === "string" ? f.contentBase64 : "";
      if (!rawName || !content) continue;
      // Strip directory traversal — keep only the basename, replace anything
      // not in [A-Za-z0-9._-] with underscore. Never trust the caller.
      const safeName = path.basename(rawName).replace(/[^A-Za-z0-9._-]+/g, "_");
      if (!safeName || safeName === "." || safeName === "..") continue;
      const buf = Buffer.from(content, "base64");
      if (buf.length > 10 * 1024 * 1024) {
        reply.code(413);
        return { error: `File ${safeName} exceeds 10MB cap` };
      }
      const target = path.join(baseDir, safeName);
      // Defense in depth — make sure the join stayed inside baseDir.
      if (!target.startsWith(baseDir + path.sep) && target !== baseDir) {
        reply.code(400);
        return { error: `Refusing to write outside upload sandbox` };
      }
      fs.writeFileSync(target, buf);
      stored.push({ name: safeName, path: target, size: buf.length, mime });
    }
    return { success: true, sessionId, files: stored };
  });

  /**
   * Download a file the model produced (or the user uploaded). Sandbox:
   * the resolved absolute path must live inside the workspace
   * (process.cwd()), the per-session uploads directory, or the reports
   * output directory. Anything else is rejected.
   *
   * Query: ?path=<absolute or workspace-relative>
   * Auth: same X-API-Key middleware as the rest of /chat.
   */
  fastify.get("/chat/files/download", async (request, reply) => {
    const fs = await import("fs");
    const path = await import("path");
    const { getReportsBaseDir } = await import("../reports/storage");
    const query = request.query as { path?: string; sessionId?: string };
    const raw = (query.path || "").trim();
    if (!raw) {
      reply.code(400);
      return { error: "path query parameter is required" };
    }
    const cwd = process.cwd();
    const uploadsRoot = path.resolve(cwd, "data", "profiles", "default", "uploads");
    const reportsRoot = path.resolve(cwd, getReportsBaseDir());
    // Accept either absolute or relative — but always resolve to absolute
    // and verify against the sandbox roots.
    const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(cwd, raw);
    const inWorkspace =
      abs === cwd || abs.startsWith(cwd + path.sep);
    const inUploads =
      abs === uploadsRoot || abs.startsWith(uploadsRoot + path.sep);
    const inReports =
      abs === reportsRoot || abs.startsWith(reportsRoot + path.sep);
    if (!inWorkspace && !inUploads && !inReports) {
      reply.code(400);
      return {
        error: "Path is outside the workspace + uploads + reports sandbox",
        sandbox: [cwd, uploadsRoot, reportsRoot],
      };
    }
    // Block obviously-sensitive paths even inside the workspace.
    const blocked = /(?:^|[\\/])\.env(?:$|[\\/])|(?:^|[\\/])\.git(?:$|[\\/])/i;
    const relativeToCwd = abs.startsWith(cwd) ? abs.slice(cwd.length) : abs;
    if (blocked.test(relativeToCwd)) {
      reply.code(403);
      return { error: "Refused to download a sensitive workspace path" };
    }
    if (!fs.existsSync(abs)) {
      reply.code(404);
      return { error: "File not found" };
    }
    const stat = fs.statSync(abs);
    if (!stat.isFile()) {
      reply.code(400);
      return { error: "Path is not a regular file" };
    }
    const baseName = path.basename(abs);
    const ext = path.extname(baseName).slice(1).toLowerCase();
    const mimeFor: Record<string, string> = {
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      pdf: "application/pdf",
      md: "text/markdown",
      html: "text/html",
      txt: "text/plain",
      csv: "text/csv",
      json: "application/json",
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      svg: "image/svg+xml",
    };
    const mime = mimeFor[ext] ?? "application/octet-stream";
    reply
      .header("Content-Type", mime)
      .header("Content-Length", stat.size)
      .header("Content-Disposition", `attachment; filename="${baseName}"`);
    return reply.send(fs.createReadStream(abs));
  });

  fastify.get("/chat/sessions/:sessionId/recovery", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const recovery = buildSessionRecovery(sessionId);

    if (!recovery) {
      reply.code(404);
      return { error: "Session not found" };
    }

    return recovery;
  });

  fastify.get("/chat/sessions/:sessionId/status", async (request) => {
    const { sessionId } = request.params as { sessionId: string };
    const job = processingJobs.get(sessionId);

    if (!job) {
      const session = conversationManager.getSession(sessionId);
      return {
        sessionId,
        processing: false,
        exists: session !== null,
      };
    }

    return {
      sessionId,
      processing: job.status === "processing",
      status: job.status,
      startedAt: job.startedAt,
      lastActivityAt: job.lastActivityAt,
      completedAt: job.completedAt,
      cancelled: job.cancelled,
      eventCount: job.events.length,
    };
  });

  fastify.get("/chat/sessions/:sessionId/stream", async (request, reply): Promise<void> => {
    const { sessionId } = request.params as { sessionId: string };
    const session = conversationManager.getSession(sessionId);

    if (!session) {
      reply.code(404);
      return reply.send({ error: "Session not found" });
    }

    reply.hijack();

    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no");
    reply.raw.flushHeaders();
    if (reply.raw.socket) {
      reply.raw.socket.setNoDelay(true);
    }

    const sendEvent = (event: string, data: unknown) => {
      try {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {}
    };

    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(": heartbeat\n\n");
      } catch {
        clearInterval(heartbeat);
      }
    }, 15000);

    const cleanupConnection = () => {
      clearInterval(heartbeat);
      try {
        reply.raw.end();
      } catch {}
    };

    const job = processingJobs.get(sessionId);
    if (job && job.status === "processing") {
      // Tell the client immediately that a job is active so it can show the
      // processing indicator before any replayed tool/token events arrive.
      sendEvent("state", { processing: true, sessionId });
      for (const evt of job.events) {
        sendEvent(evt.event, evt.data);
      }

      const subscriber = (event: string, data: unknown) => {
        sendEvent(event, data);
        if (event === "done" || event === "error") {
          setTimeout(() => {
            cleanupConnection();
          }, 100);
        }
      };
      job.subscribers.add(subscriber);

      const socket1 = reply.raw.socket || request.raw.socket;
      if (socket1) {
        socket1.on("close", () => {
          job.subscribers.delete(subscriber);
          cleanupConnection();
        });
      }
    } else {
      sendEvent("state", { processing: false, sessionId });

      const waitInterval = setInterval(() => {
        const currentJob = processingJobs.get(sessionId);
        if (currentJob && currentJob.status === "processing") {
          clearInterval(waitInterval);
          for (const evt of currentJob.events) {
            sendEvent(evt.event, evt.data);
          }
          const subscriber = (event: string, data: unknown) => {
            sendEvent(event, data);
            if (event === "done" || event === "error") {
              const cleanupDelay = event === "error" ? 1500 : 100;
              setTimeout(() => {
                cleanupConnection();
              }, cleanupDelay);
            }
          };
          currentJob.subscribers.add(subscriber);
          const socket2 = reply.raw.socket || request.raw.socket;
          if (socket2) {
            socket2.on("close", () => {
              currentJob.subscribers.delete(subscriber);
              cleanupConnection();
            });
          }
        }
      }, 500);

      const socket3 = reply.raw.socket || request.raw.socket;
      if (socket3) {
        socket3.on("close", () => {
          clearInterval(waitInterval);
          cleanupConnection();
        });
      }
    }
  });

  fastify.get("/chat/health", async (_request, _reply) => {
    const currentProvider = providerSettings.getCurrent();
    const provider = currentProvider.provider;
    const isConfigured = aiClient.isConfigured();
    const isValid = isConfigured ? await aiClient.validateConfig() : false;

    const [githubConfigured, gitlabConfigured, jiraConfigured, jitbitConfigured] = await Promise.all([
      githubClient.isConfigured(),
      gitlabClient.isConfigured(),
      jiraClient.isConfigured(),
      jitbitClient.isConfigured(),
    ]);

    const [githubValid, gitlabValid, jiraValid, jitbitValid] = await Promise.all([
      githubConfigured ? githubClient.validateConfig().catch(() => false) : false,
      gitlabConfigured ? gitlabClient.validateConfig().catch(() => false) : false,
      jiraConfigured ? jiraClient.validateConfig().catch(() => false) : false,
      jitbitConfigured ? jitbitClient.validateConfig().catch(() => false) : false,
    ]);

    const providerKeyMap: Record<string, { key: string; url: string }> = {
      opencode: { key: env.OPENCODE_API_KEY, url: env.OPENCODE_API_URL },
      zai: { key: env.ZAI_API_KEY, url: env.ZAI_API_URL },
      ollama: { key: env.OLLAMA_API_KEY || "local", url: env.OLLAMA_API_URL },
      openai: { key: env.OPENAI_API_KEY, url: env.OPENAI_API_URL },
    };

    const info = providerKeyMap[provider] || providerKeyMap.opencode;

    const ckAvailable = claimKitAdapter.isAvailable();
    const ckInitError = claimKitAdapter.getInitError();
    const embeddingAvailable = await embeddingService.isAvailable();

    return {
      provider: {
        active: provider,
        model: currentProvider.model,
        configured: isConfigured,
        valid: isValid,
        baseUrl: info.url,
      },
      integrations: {
        github: { configured: githubConfigured, valid: githubValid },
        gitlab: { configured: gitlabConfigured, valid: gitlabValid },
        jira: { configured: jiraConfigured, valid: jiraValid },
        jitbit: { configured: jitbitConfigured, valid: jitbitValid },
      },
      claimkit: {
        envEnabled: env.CLAIMKIT_ENABLED,
        envRaw: process.env.CLAIMKIT_ENABLED,
        initialized: ckAvailable,
        initError: ckInitError || null,
        contextMode: env.CONTEXT_MODE,
        embeddingAvailable,
      },
    };
  });

  fastify.get("/chat/usage", async (request, reply) => {
    const { sessionId } = request.query as { sessionId?: string };
    if (!sessionId) return reply.code(400).send({ error: "sessionId required" });
    const usage = sessionUsageMap.get(sessionId) ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0, messageCount: 0 };
    return usage;
  });

  fastify.get("/chat/balance", async (_request, _reply) => {
    const current = providerSettings.getCurrent();
    const provider = current.provider;
    const lifetime = providerLifetimeUsage.get(provider) ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    const result: Record<string, unknown> = {
      provider,
      model: current.model,
      lifetime,
    };

    if (provider === "zai") {
      const budget = env.ZAI_TOKEN_BUDGET;
      result.budget = budget > 0 ? budget : null;
      result.remaining = budget > 0 ? Math.max(0, budget - lifetime.totalTokens) : null;
      result.balanceApi = "unavailable";
      result.note = "Z.ai does not expose a public balance API. Configure ZAI_TOKEN_BUDGET to track remaining.";
    } else if (provider === "ollama") {
      result.budget = null;
      result.remaining = null;
      result.balanceApi = "local";
      // Probe Ollama for running models
      try {
        const ollamaUrl = (process.env.OLLAMA_API_URL || env.OLLAMA_API_URL).replace(/\/$/, "");
        const res = await fetch(`${ollamaUrl}/api/ps`);
        if (res.ok) result.ollamaRunning = await res.json();
      } catch {}
    } else if (provider === "openai") {
      result.budget = null;
      result.remaining = null;
      result.balanceApi = "unavailable";
      result.note = "OpenAI billing API requires dashboard access; not queryable from here.";
    } else {
      result.budget = null;
      result.remaining = null;
      result.balanceApi = "unavailable";
    }

    return result;
  });

  fastify.get("/chat/providers", async (_request, _reply) => {
    const current = providerSettings.getCurrent();
    const models = await providerSettings.getModels(current.provider);
    return {
      active: current.provider,
      model: current.model,
      hostId: current.hostId,
      providers: current.providers,
      models,
    };
  });

  fastify.get("/chat/providers/:provider/models", async (request, reply) => {
    const params = z.object({ provider: z.string() }).parse(request.params);
    const query = providerModelsQuerySchema.parse(request.query);
    const refresh = query.refresh === true || query.refresh === "true";
    if (!providerSettings.isProviderName(params.provider)) {
      return reply.status(400).send({ error: `Unsupported provider '${params.provider}'` });
    }

    const models = await providerSettings.getModels(params.provider as AIProviderName, refresh);
    return models;
  });

  fastify.post("/chat/provider", async (request, reply) => {
    try {
      const body = providerSelectionSchema.parse(request.body);
      const result = await providerSettings.setProvider(
        body.provider,
        body.model,
        body.hostId,
      );
      aiClient.refresh();
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(400).send({ error: message });
    }
  });

  fastify.post("/chat/provider/preflight", async (_request, reply) => {
    const current = providerSettings.getCurrent();
    const report = await runProviderPreflight(aiClient, current.provider, current.model);
    if (!report.success) {
      return reply.status(502).send(report);
    }
    return report;
  });

  /**
   * Create new conversation session
   */
  fastify.post("/chat/sessions", async (request, reply) => {
    try {
      const body = createSessionSchema.parse(request.body);

      const sessionId = conversationManager.startSession(
        body.userId,
        body.mode,
        {
          title: body.title,
          tags: body.tags,
          context: body.context,
        },
      );

      reply.code(201);
      return {
        success: true,
        sessionId,
        message: "Session created successfully",
      };
    } catch (error) {
      fastify.log.error(error);
      reply.code(500);
      return {
        error: "Failed to create session",
        message: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  /**
   * Get conversation session details
   */
  fastify.get("/chat/sessions/:sessionId", async (request, reply) => {
    try {
      const { sessionId } = request.params as { sessionId: string };

      const session = conversationManager.getSession(sessionId);

      if (!session) {
        reply.code(404);
        return {
          error: "Session not found",
        };
      }

      return {
        success: true,
        session: {
          id: session.id,
          userId: session.userId,
          mode: session.mode,
          messageCount: session.messages.length,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          metadata: session.metadata,
        },
      };
    } catch (error) {
      fastify.log.error(error);
      reply.code(500);
      return {
        error: "Failed to get session",
        message: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  /**
   * End conversation session
   */
  fastify.post("/chat/sessions/:sessionId/end", async (request, reply) => {
    try {
      const { sessionId } = request.params as { sessionId: string };

      await conversationManager.endSession(sessionId);

      return {
        success: true,
        message: "Session ended and saved to long-term memory",
      };
    } catch (error) {
      fastify.log.error(error);
      reply.code(500);
      return {
        error: "Failed to end session",
        message: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  fastify.get("/chat/sessions", async (request, reply) => {
    try {
      const { userId } = request.query as { userId?: string };
      const sessions = conversationManager.listSessionsForUser(
        userId || "web-user",
      );
      return { success: true, sessions };
    } catch (error) {
      fastify.log.error(error);
      reply.code(500);
      return {
        error: "Failed to list sessions",
        message: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  fastify.get("/chat/sessions/:sessionId/messages", async (request, reply) => {
    try {
      const { sessionId } = request.params as { sessionId: string };
      const messages =
        conversationManager.getSessionMessagesForDisplay(sessionId);
      return { success: true, sessionId, messages };
    } catch (error) {
      fastify.log.error(error);
      reply.code(500);
      return {
        error: "Failed to get messages",
        message: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  fastify.delete("/chat/sessions/:sessionId", async (request, reply) => {
    try {
      const { sessionId } = request.params as { sessionId: string };
      conversationManager.deleteSession(sessionId);
      return { success: true };
    } catch (error) {
      fastify.log.error(error);
      reply.code(500);
      return {
        error: "Failed to delete session",
        message: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  /**
   * /compact equivalent — collapses the session's message history into
   * a single LLM-generated summary so subsequent turns start from a
   * compact context anchor. Returns the summary + how many messages
   * were collapsed so the UI can show progress feedback.
   */
  fastify.post("/chat/sessions/:sessionId/compact", async (request, reply) => {
    try {
      const { sessionId } = request.params as { sessionId: string };
      const result = await conversationManager.compactSession(sessionId);
      return { success: true, ...result };
    } catch (error) {
      fastify.log.error(error);
      const message = error instanceof Error ? error.message : "Unknown error";
      const status = /not found/i.test(message) ? 404 : 500;
      reply.code(status);
      return { error: "Failed to compact session", message };
    }
  });

  /**
   * Search long-term memory
   */
  fastify.get("/chat/memory/search", async (request, reply) => {
    try {
      const { userId, query, limit } = request.query as {
        userId: string;
        query?: string;
        limit?: string;
      };

      if (!userId) {
        reply.code(400);
        return {
          error: "userId is required",
        };
      }

      const results = conversationManager.searchMemories(
        userId,
        query || "",
        limit ? parseInt(limit) : 10,
      );

      return {
        success: true,
        results,
        count: results.length,
      };
    } catch (error) {
      fastify.log.error(error);
      reply.code(500);
      return {
        error: "Failed to search memory",
        message: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  /**
   * Get relevant memories for context
   */
  fastify.post("/chat/memory/relevant", async (request, reply) => {
    try {
      const { userId, context, limit } = request.body as {
        userId: string;
        context: string;
        limit?: number;
      };

      if (!userId || !context) {
        reply.code(400);
        return {
          error: "userId and context are required",
        };
      }

      const relevant = conversationManager.getRelevantMemories(
        userId,
        context,
        limit || 3,
      );

      return {
        success: true,
        relevant,
      };
    } catch (error) {
      fastify.log.error(error);
      reply.code(500);
      return {
        error: "Failed to get relevant memories",
        message: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  /**
   * Get memory manager statistics
   */
  fastify.get("/chat/memory/stats", async (_request, reply) => {
    try {
      const stats = conversationManager.getStats();

      return {
        success: true,
        stats,
      };
    } catch (error) {
      fastify.log.error(error);
      reply.code(500);
      return {
        error: "Failed to get stats",
        message: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  fastify.get("/chat/tools", async (request) => {
    const { mode } = request.query as { mode?: string };
    const toolMode = mode || "productivity";
    const categories = getToolCategories(toolMode);

    const toolsByCategory: Record<
      string,
      Array<{ name: string; description: string; params: string[] }>
    > = {};

    for (const [category] of Object.entries(categories).sort(([a], [b]) => a.localeCompare(b))) {
      const categoryTools = getToolsByCategory(toolMode, category);
      toolsByCategory[category] = categoryTools.map((t) => ({
        name: t.name,
        description: t.description,
        params: Object.keys(t.params),
      }));
    }

    return { success: true, mode: toolMode, categories: toolsByCategory };
  });

  fastify.get("/chat/todos", async (request) => {
    const { sessionId } = request.query as { sessionId?: string };
    const lists = todoManager.getLists(sessionId);
    return {
      success: true,
      lists: lists.map((l) => ({
        id: l.id,
        title: l.title,
        itemCount: l.items.length,
        progress: todoManager.getProgress(l.id),
        items: l.items,
        createdAt: l.createdAt,
        updatedAt: l.updatedAt,
      })),
    };
  });

  fastify.get("/chat/knowledge/search", async (request) => {
    const { query, limit, source } = request.query as {
      query?: string;
      limit?: string;
      source?: string;
    };
    if (!query) return { success: true, results: [], count: 0 };

    const results = knowledgeStore.search(query, {
      limit: limit ? parseInt(limit) : 5,
      source: source as any,
    });

    return {
      success: true,
      results: results.map((r) => ({
        id: r.entry.id,
        title: r.entry.title,
        content: r.entry.content.substring(0, 500),
        source: r.entry.source,
        tags: r.entry.tags,
        score: r.score,
        matchType: r.matchType,
        createdAt: r.entry.createdAt,
      })),
      count: results.length,
    };
  });

  fastify.get("/chat/knowledge/recent", async (request) => {
    const { limit, source } = request.query as {
      limit?: string;
      source?: string;
    };
    const entries = knowledgeStore.getRecent({
      limit: limit ? parseInt(limit) : 10,
      source: source as any,
    });
    return {
      success: true,
      entries: entries.map((e) => ({
        id: e.id,
        title: e.title,
        source: e.source,
        tags: e.tags,
        createdAt: e.createdAt,
        accessCount: e.accessCount,
      })),
      count: entries.length,
    };
  });

  fastify.get("/chat/knowledge/stats", async () => {
    return { success: true, stats: knowledgeStore.getStats() };
  });

  fastify.get("/chat/graph/summary", async () => {
    return { success: true, summary: knowledgeGraph.getGraphSummary() };
  });

  fastify.get("/chat/graph/nodes", async (request) => {
    const { type, status, search, limit } = request.query as {
      type?: string;
      status?: string;
      search?: string;
      limit?: string;
    };

    const nodes = knowledgeGraph.queryNodes({
      type: type as any,
      status: status as any,
      search,
      limit: limit ? parseInt(limit) : 20,
    });

    return {
      success: true,
      count: nodes.length,
      nodes: nodes.map((n) => ({
        id: n.id,
        type: n.type,
        title: n.title,
        status: n.status,
        tags: n.tags,
        createdAt: n.createdAt,
      })),
    };
  });

  fastify.get("/chat/graph/nodes/:nodeId", async (request, reply) => {
    const { nodeId } = request.params as { nodeId: string };
    const node = knowledgeGraph.getNode(nodeId);
    if (!node) {
      reply.code(404);
      return { error: "Node not found" };
    }

    const edges = knowledgeGraph.getEdgesForNode(nodeId);
    return { success: true, node, edges };
  });

  fastify.get("/chat/codebase/stats", async () => {
    return { success: true, stats: codebaseIndexer.getStats() };
  });

  fastify.get("/chat/codebase/search", async (request) => {
    const { query, language, filePath, limit } = request.query as {
      query?: string;
      language?: string;
      filePath?: string;
      limit?: string;
    };

    if (!query) return { success: true, results: [], count: 0 };

    const results = await codebaseIndexer.searchWithEmbeddings(query, {
      limit: limit ? parseInt(limit) : 10,
      language,
      filePath,
    });

    return {
      success: true,
      results: results.map((r) => ({
        filePath: r.filePath,
        startLine: r.startLine,
        endLine: r.endLine,
        language: r.language,
        content: r.content.substring(0, 300),
        score: Math.round(r.score * 100) / 100,
        matchType: r.matchType,
      })),
      count: results.length,
    };
  });
}
