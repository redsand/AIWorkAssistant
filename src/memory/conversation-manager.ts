/**
 * Conversation Memory Manager
 * Handles conversation history, auto-compaction, and long-term memory storage
 */

import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import type { ChatMessage } from "../agent/opencode-client";
import { aiClient } from "../agent/opencode-client";
import { resolvePath } from "../config/env";
import { toolCallCache } from "./tool-cache";
import { applyWalHygiene } from "../util/sqlite-hygiene";

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  timestamp: Date;
  thinking?: string;
  name?: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    params: Record<string, unknown>;
  }>;
  tool_call_id?: string;
}

export interface ConversationSession {
  id: string;
  userId: string;
  mode: "productivity" | "engineering";
  messages: Message[];
  createdAt: Date;
  updatedAt: Date;
  metadata: {
    title?: string;
    tags?: string[];
    context?: Record<string, unknown>;
  };
}

export interface SessionSearchResult {
  sessionId: string;
  title: string;
  summary: string;
  keyTopics: string[];
  relevanceScore: number;
  createdAt: string;
}

export interface MemorySummary {
  id: string;
  userId: string;
  sessionId: string;
  title: string;
  summary: string;
  keyTopics: string[];
  startDate: Date;
  endDate: Date;
  messageCount: number;
  createdAt: Date;
  metadata: Record<string, unknown>;
}

/**
 * Collapse near-duplicate strings so a directive pin doesn't contain four
 * copies of "use payload field if direct match fails". Compares normalized
 * forms (lowercased, whitespace-collapsed) with a Jaccard-on-word-shingles
 * similarity score above 0.55, which catches paraphrases like
 *   "use payload field if direct match fails"
 *   "if the field is not found default to payload"
 *   "you are using fields that do not exist; default to payload"
 * The most recent instance wins (assumed to be the most refined form).
 */
function dedupeNearDuplicates<T extends { timestamp: Date; content: string }>(
  items: T[],
  threshold = 0.55,
): T[] {
  const norm = (s: string) =>
    s.toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const shingles = (s: string): Set<string> => {
    const words = norm(s).split(" ").filter((w) => w.length >= 3);
    const set = new Set<string>();
    for (let i = 0; i < words.length - 1; i++) set.add(`${words[i]} ${words[i + 1]}`);
    if (set.size === 0) for (const w of words) set.add(w);
    return set;
  };
  const jaccard = (a: Set<string>, b: Set<string>): number => {
    if (a.size === 0 || b.size === 0) return 0;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    return inter / (a.size + b.size - inter);
  };
  // Walk newest-first; for each candidate, drop any older one that overlaps.
  const reversed = [...items].reverse();
  const kept: { item: T; shingles: Set<string> }[] = [];
  for (const item of reversed) {
    const sh = shingles(item.content);
    let dup = false;
    for (const k of kept) {
      if (jaccard(sh, k.shingles) >= threshold) { dup = true; break; }
    }
    if (!dup) kept.push({ item, shingles: sh });
  }
  return kept.map((k) => k.item).reverse();
}

export class ConversationManager {
  private sessions: Map<string, ConversationSession> = new Map();
  private memoryBasePath: string;
  private db: Database.Database | null = null;

  // Configuration thresholds — compact early to keep context lean
  private readonly MAX_MESSAGES_BEFORE_COMPACT = 40;
  // Keep more recent messages outside the summary so short-term context is never lost.
  private readonly MIN_RECENT_MESSAGES = 30;
  // Re-summarize when this many new messages have accumulated since the last summary.
  private readonly RESUMMARY_THRESHOLD = 15;
  // Increased from 12k/8k to prevent tool results from being truncated,
  // which then causes repairConversationState to inject "[Result unavailable]" placeholders.
  // Ollama (kimi-k2.6:cloud) has ~120k token limit (~300k chars).
  private readonly MAX_CONTEXT_TOOL_CHARS = 50_000;
  private readonly MAX_CONTEXT_MESSAGE_CHARS = 30_000;
  // How long an active session survives without activity before it's evicted
  // from active/ and won't rehydrate on server start. Default 7 days so a
  // user investigation that pauses overnight (or over a weekend) doesn't
  // silently disappear. Set via SESSION_TIMEOUT_HOURS for production tuning;
  // 0 disables eviction entirely (keep everything forever — rely on manual
  // delete for cleanup).
  private readonly SESSION_TIMEOUT_MS = (() => {
    const raw = process.env.SESSION_TIMEOUT_HOURS;
    if (raw === undefined || raw === "") return 7 * 24 * 60 * 60 * 1000;
    const hours = Number(raw);
    if (!Number.isFinite(hours) || hours < 0) return 7 * 24 * 60 * 60 * 1000;
    if (hours === 0) return Number.POSITIVE_INFINITY;
    return hours * 60 * 60 * 1000;
  })();

  constructor() {
    // Force the profile manager to run BEFORE we mkdir the memory subdirs.
    // ProfileManager.getActive() is what triggers the legacy-data migration
    // for the default profile. If initializeStorage() runs first it pre-
    // creates data/profiles/default/memories/{active,sessions,...}, which used
    // to make the migration's "destination already populated" guard skip
    // forever (losing the user's chats from the pre-isolation layout).
    // Migration is now marker-gated, but ordering still matters so the
    // copied files land BEFORE we open sessions.db in initFTS5.
    this.ensureProfileScaffold();
    this.memoryBasePath = this.resolveMemoryBasePath();
    this.initializeStorage();
    this.startCleanupTask();
  }

  /**
   * Trigger profile-manager initialization so it can scaffold the active
   * profile directory and run any legacy-data migration BEFORE we touch the
   * memory path. Skipped in tests and when an explicit memory path is set —
   * in those modes the memory dir is not inside the profile structure, so
   * touching the real profile root would be a side effect leaking into
   * unrelated tests/installations.
   */
  private ensureProfileScaffold(): void {
    if (process.env.CONVERSATION_MEMORY_PATH) return;
    if (process.env.VITEST) return;
    try {
      // Lazy require avoids a top-level import cycle: profile-manager imports
      // ../config/env which is also touched by this module's imports.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getConfigProfileManager } = require("../config/profile-manager");
      getConfigProfileManager().getActive();
    } catch (err) {
      console.warn(
        "[MemoryManager] Profile pre-init failed (continuing — migration may be deferred):",
        err instanceof Error ? err.message : err,
      );
    }
  }

  private resolveMemoryBasePath(): string {
    if (process.env.CONVERSATION_MEMORY_PATH) {
      return process.env.CONVERSATION_MEMORY_PATH;
    }

    if (process.env.VITEST && path.basename(process.cwd()) === "ai-assist-tim") {
      return path.join(
        os.tmpdir(),
        "ai-assist-tim-vitest-memories",
        `${process.env.VITEST_WORKER_ID || "worker"}-${process.pid}`,
      );
    }

    // Preserve the historical `memories/` base (sessions/summaries/etc. are
    // created as subdirectories below it). Using "memories" — not "sessions" —
    // keeps the layout consistent with AgentMemory and SoulManager and avoids
    // silently renaming the storage directory under profile isolation.
    return resolvePath("memories");
  }

  private initializeStorage() {
    const dirs = [
      path.join(this.memoryBasePath, "users"),
      path.join(this.memoryBasePath, "sessions"),
      path.join(this.memoryBasePath, "summaries"),
      path.join(this.memoryBasePath, "active"),
    ];

    dirs.forEach((dir) => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });

    this.initFTS5();
    this.rehydrateSessions();

    console.log("[MemoryManager] Storage initialized");
  }

  private initFTS5() {
    try {
      const dbPath = path.join(this.memoryBasePath, "sessions.db");
      this.db = new Database(dbPath);
      applyWalHygiene(this.db, { label: "conversation-sessions" });
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
          sessionId,
          userId,
          title,
          summary,
          keyTopics,
          content
        );
      `);
    } catch (err) {
      console.warn("[MemoryManager] FTS5 unavailable, search will use text fallback:", err);
      this.db = null;
    }
  }

  private rehydrateSessions() {
    const activeDir = path.join(this.memoryBasePath, "active");
    if (!fs.existsSync(activeDir)) return;

    const files = fs.readdirSync(activeDir).filter((f) => f.endsWith(".json"));
    let count = 0;

    for (const file of files) {
      const sessionId = file.replace(".json", "");
      const session = this.loadActiveSession(sessionId);
      if (session) {
        const age = Date.now() - session.updatedAt.getTime();
        if (age < this.SESSION_TIMEOUT_MS) {
          this.sessions.set(sessionId, session);
          count++;
        } else {
          this.removeActiveSession(sessionId);
        }
      }
    }

    if (count > 0) {
      console.log(`[MemoryManager] Rehydrated ${count} session(s) from disk`);
    }
  }

  /**
   * Start or continue a conversation session
   */
  startSession(
    userId: string,
    mode: "productivity" | "engineering",
    metadata?: Record<string, unknown>,
  ): string {
    const profileId = (metadata?.profileId as string) || "default";
    const sessionId = uuidv4();

    const session: ConversationSession = {
      id: sessionId,
      userId,
      mode,
      messages: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      metadata: {
        title:
          (metadata?.title as string) ||
          `Session ${new Date().toLocaleDateString()}`,
        tags: (metadata?.tags as string[]) || [],
        context: {
          ...(metadata?.context as Record<string, unknown>) || {},
          profileId,
        },
      },
    };

    this.sessions.set(sessionId, session);
    this.saveActiveSession(session);

    console.log(
      `[MemoryManager] Started session ${sessionId} for user ${userId}`,
    );
    return sessionId;
  }

  /**
   * Returns the current message count for a session — use as a rollback handle
   * before starting a run so a crash can undo partial conversation state.
   */
  checkpointSession(sessionId: string): number {
    const session = this.sessions.get(sessionId);
    return session ? session.messages.length : 0;
  }

  /**
   * Truncates the session's message list back to the checkpoint count.
   * Call on run failure to remove assistant/tool messages added by a crashed run,
   * preventing orphaned state from poisoning the next request.
   */
  rollbackToCheckpoint(sessionId: string, checkpoint: number): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.messages.length <= checkpoint) return;
    const removed = session.messages.length - checkpoint;
    session.messages.splice(checkpoint);
    session.updatedAt = new Date();
    this.saveActiveSession(session);
    console.warn(`[MemoryManager] Rolled back session ${sessionId} by ${removed} message(s) to checkpoint (${checkpoint} messages)`);
  }

  /**
   * Add a message to a session
   */
  addMessage(sessionId: string, message: Omit<Message, "timestamp">): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // Strip stray <think>...</think> blocks from assistant content. Reasoning
    // models (Qwen, kimi, DeepSeek-R1) sometimes leak the closing </think>
    // tag (or the full paired block) into their visible content because their
    // reasoning channel is also emitted inside the same content stream.
    // Observed in session 926107f7 msg #47: "...Let me compile the final
    // summary.</think>## HAWK IR Findings..." — the </think> leaked through
    // the provider's reasoning-content extraction and the user saw it
    // verbatim. Stripping at the conversation boundary catches every path
    // without per-provider duplication.
    let content = message.content;
    if (message.role === "assistant" && typeof content === "string" && content.includes("</think>")) {
      content = content
        .replace(/<think>[\s\S]*?<\/think>/gi, "") // paired block
        .replace(/<\/think>/gi, "")                 // stray closing tag
        .replace(/^<think>/i, "")                   // stray opening tag at start
        .replace(/^\s+/, "");                       // tidy leading whitespace
    }

    const messageWithTimestamp: Message = {
      ...message,
      content,
      timestamp: new Date(),
    };

    session.messages.push(messageWithTimestamp);
    session.updatedAt = new Date();

    if (
      message.role === "user" &&
      (!session.metadata.title ||
        session.metadata.title.startsWith("Session") ||
        session.metadata.title.startsWith("Chat on"))
    ) {
      const fallback = message.content
        .substring(0, 60)
        .replace(/\n/g, " ")
        .trim();
      session.metadata.title =
        fallback.length < message.content.replace(/\n/g, " ").trim().length
          ? fallback + "..."
          : fallback;

      this.generateTitleLLM(sessionId, message.content).catch(() => {});
    }

    this.saveActiveSession(session);
  }

  /**
   * Manually compact a session: replaces the message history with a
   * single LLM-generated summary so subsequent turns start from a
   * compact context anchor. Equivalent to what the auto-compactor does
   * at MAX_MESSAGES_BEFORE_COMPACT, but triggered explicitly by the
   * user (slash command `/compact` from the chat UI).
   *
   * Returns the new summary + count of messages replaced. Throws if the
   * session doesn't exist. Safe to call on a session with no messages
   * (returns originalCount=0, summary="").
   */
  async compactSession(
    sessionId: string,
  ): Promise<{ summary: string; originalCount: number }> {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    const originalCount = session.messages.length;
    if (originalCount === 0) {
      return { summary: "", originalCount: 0 };
    }
    const summary = await this.buildCompactSummaryLLM(session.messages);
    session.messages = [
      {
        role: "system",
        content: `[Compacted session summary — ${originalCount} prior messages]\n\n${summary}`,
        timestamp: new Date(),
      },
    ];
    session.updatedAt = new Date();
    this.saveActiveSession(session);
    return { summary, originalCount };
  }

  /**
   * Get conversation history for a session
   */
  getSession(sessionId: string): ConversationSession | null {
    const cached = this.sessions.get(sessionId);
    if (cached) return cached;

    const loaded = this.loadActiveSession(sessionId);
    if (loaded) {
      this.sessions.set(sessionId, loaded);
      return loaded;
    }

    return null;
  }

  /**
   * Return non-trivial user messages from a session, chronologically, so
   * callers can pin them as a persistent system-prompt addendum that
   * survives both the conversation-manager truncation (last-30-messages)
   * and the provider's aggressive prune (system + last 6 + most-recent user).
   *
   * Without pinning, directives like "use payload field if direct match fails"
   * or "the time is wrong, 14:10:45 UTC = 08:10:45 AM Central" silently age
   * out of context after ~30 turns and the user has to repeat themselves
   * (observed in session 926107f7: user repeated the payload-field directive
   * 4+ times across 400+ messages because each correction was pruned away).
   *
   * Trivial messages are filtered (continue / yes / k / short acks) so the
   * pin contains only actual instructions, not throat-clearing.
   */
  getUserDirectives(
    sessionId: string,
    opts: { charBudget?: number } = {},
  ): Array<{ timestamp: Date; content: string }> {
    const session = this.getSession(sessionId);
    if (!session) return [];
    const budget = opts.charBudget ?? 12_000;

    const trivialPattern =
      /^(continue|keep going|go on|proceed|next|more|yes|y|yeah|yep|ok|okay|k|sure|fine|right|correct|good|great|nice|thanks|thx|ty|np|done|cool|alright|👍|done\.|👀|see above)[.!?\s]*$/i;

    const filtered = session.messages
      .filter((m) => m.role === "user")
      .map((m) => ({ timestamp: m.timestamp, content: m.content.trim() }))
      .filter((m) => m.content.length > 20 && !trivialPattern.test(m.content));

    // De-duplicate near-identical directives so the pin doesn't contain four
    // copies of "use payload field if direct match fails". The most recent
    // instance wins (collapses to its timestamp); earlier ones are dropped.
    const deduped = dedupeNearDuplicates(filtered);

    // Apply char budget: oldest evicted first so the most recent directives
    // (which usually supersede earlier ones) are always retained.
    let total = 0;
    const kept: Array<{ timestamp: Date; content: string }> = [];
    for (let i = deduped.length - 1; i >= 0; i--) {
      const entry = deduped[i];
      const cost = entry.content.length + 40; // +40 for timestamp/bullet overhead
      if (total + cost > budget && kept.length > 0) break;
      kept.unshift(entry);
      total += cost;
    }
    return kept;
  }

  /**
   * Persist healed tool-message content back to the session so the heal
   * survives subsequent reads. rehydrateCachedToolResults rewrites truncated
   * tool messages in-memory; without this method those rewrites had to be
   * re-computed on every load, which depended on the live cache surviving.
   *
   * Updates by tool_call_id. Silently ignores entries with no match so
   * stale heal maps don't error out.
   */
  healToolMessages(
    sessionId: string,
    healed: Map<string, string>,
  ): number {
    if (healed.size === 0) return 0;
    const session = this.getSession(sessionId);
    if (!session) return 0;
    let healedCount = 0;
    for (const msg of session.messages) {
      if (msg.role !== "tool") continue;
      const id = msg.tool_call_id;
      if (!id) continue;
      const newContent = healed.get(id);
      if (newContent === undefined || newContent === msg.content) continue;
      msg.content = newContent;
      healedCount++;
    }
    if (healedCount > 0) {
      session.updatedAt = new Date();
      this.saveActiveSession(session);
      console.log(`[MemoryManager] Healed ${healedCount} tool message(s) in session ${sessionId}`);
    }
    return healedCount;
  }

  /**
   * Detect user-stated timezone or location and return as a sticky list.
   * Heuristic — only matches user messages that explicitly mention a timezone
   * abbreviation, a UTC offset, or a city/state. Pinned separately from
   * directives because timezone confusion was the #1 hallucination source in
   * session 926107f7 (model used MST when El Paso in June is MDT).
   */
  getLocationFacts(sessionId: string): Array<{ timestamp: Date; content: string }> {
    const session = this.getSession(sessionId);
    if (!session) return [];

    const tzPattern = /\b(UTC|GMT|EST|EDT|CST|CDT|MST|MDT|PST|PDT|AKST|AKDT|HST|AST|ADT|NST|NDT|UTC[+-]\d{1,2}(:\d{2})?|GMT[+-]\d{1,2}(:\d{2})?)\b/;
    // Common US cities/states that imply a timezone or signal location
    // changes. Add freely — false positives are cheap (one extra pin entry).
    const locationPattern = /\b(El Paso|New York|Los Angeles|Chicago|Dallas|Denver|Boston|Seattle|Portland|Miami|Atlanta|Houston|Phoenix|Honolulu|Anchorage|San Francisco|Texas|California|Colorado|Florida|Eastern|Central|Mountain|Pacific|Alaska|Hawaii|UK|Britain|London|Paris|Berlin|Tokyo|Sydney|Mumbai|Delhi|Singapore|Toronto|Vancouver)\b/i;
    const timeStatementPattern = /\bit['']?s\s+\d{1,2}[:.]?\d{0,2}\s*(am|pm)?\b/i;

    return session.messages
      .filter((m) => m.role === "user")
      .map((m) => ({ timestamp: m.timestamp, content: m.content.trim() }))
      .filter((m) =>
        tzPattern.test(m.content) ||
        locationPattern.test(m.content) ||
        timeStatementPattern.test(m.content)
      )
      // Keep the last 6 — usually enough to capture corrections without
      // bloating the pin with every passing time mention.
      .slice(-6);
  }

  /**
   * Best-effort timezone inference from user-stated facts. Returns the most
   * recently stated timezone (with UTC offset for current month) so the time
   * anchor can show the user's local time alongside UTC.
   *
   * Coverage is intentionally narrow — only abbreviations the user has typed.
   * Anything else returns null and the time anchor only shows UTC.
   */
  getInferredTimezone(sessionId: string): { label: string; offsetMinutes: number } | null {
    const session = this.getSession(sessionId);
    if (!session) return null;
    const isUSDST = (() => {
      const m = new Date().getUTCMonth();
      return m >= 2 && m <= 10; // March through November, approximately
    })();
    // Order matters — DST variants take precedence when DST is active.
    const tzMap: Array<{ label: string; offsetMinutes: number; dst?: boolean; std?: boolean }> = [
      { label: "CDT", offsetMinutes: -5 * 60, dst: true },
      { label: "CST", offsetMinutes: -6 * 60, std: true },
      { label: "EDT", offsetMinutes: -4 * 60, dst: true },
      { label: "EST", offsetMinutes: -5 * 60, std: true },
      { label: "MDT", offsetMinutes: -6 * 60, dst: true },
      { label: "MST", offsetMinutes: -7 * 60, std: true },
      { label: "PDT", offsetMinutes: -7 * 60, dst: true },
      { label: "PST", offsetMinutes: -8 * 60, std: true },
    ];

    // Walk user messages newest-first so the latest correction wins.
    const users = session.messages.filter((m) => m.role === "user");
    for (let i = users.length - 1; i >= 0; i--) {
      const c = users[i].content;
      // Exact abbreviation match first (e.g. "9:04am CDT", "Central Time").
      for (const tz of tzMap) {
        if (new RegExp(`\\b${tz.label}\\b`).test(c)) {
          // Only use std vs dst if it matches current DST state — otherwise
          // try the variant.
          if ((tz.dst && isUSDST) || (tz.std && !isUSDST)) return { label: tz.label, offsetMinutes: tz.offsetMinutes };
        }
      }
      // City/state fallbacks
      if (/\b(El Paso|Albuquerque|Denver|Colorado|New Mexico|Mountain)\b/i.test(c)) {
        return isUSDST
          ? { label: "MDT", offsetMinutes: -6 * 60 }
          : { label: "MST", offsetMinutes: -7 * 60 };
      }
      if (/\b(Chicago|Dallas|Houston|Texas|Central(?:\s+Time)?)\b/i.test(c)) {
        return isUSDST
          ? { label: "CDT", offsetMinutes: -5 * 60 }
          : { label: "CST", offsetMinutes: -6 * 60 };
      }
      if (/\b(New York|Boston|Atlanta|Miami|Eastern(?:\s+Time)?)\b/i.test(c)) {
        return isUSDST
          ? { label: "EDT", offsetMinutes: -4 * 60 }
          : { label: "EST", offsetMinutes: -5 * 60 };
      }
      if (/\b(Los Angeles|San Francisco|Seattle|Portland|California|Pacific(?:\s+Time)?)\b/i.test(c)) {
        return isUSDST
          ? { label: "PDT", offsetMinutes: -7 * 60 }
          : { label: "PST", offsetMinutes: -8 * 60 };
      }
    }
    return null;
  }

  /**
   * Extract claims the user has explicitly confirmed. Heuristic — looks for
   * user messages that start with a confirmation token ("yes", "correct",
   * "confirmed", "right") and pairs them with the immediately-preceding
   * assistant content. Without this, the model contradicts its own findings
   * (session 926107f7 #913: "'Per Hunt, this is the user's workstation.'
   * This was per you in our chat. Is this not true?")
   */
  getEstablishedFacts(
    sessionId: string,
    opts: { maxFacts?: number; maxCharsPerFact?: number } = {},
  ): Array<{ timestamp: Date; content: string }> {
    const session = this.getSession(sessionId);
    if (!session) return [];
    const maxFacts = opts.maxFacts ?? 20;
    const maxCharsPerFact = opts.maxCharsPerFact ?? 280;

    const confirmPattern =
      /^(yes|yep|yeah|correct|that['']?s correct|right|that['']?s right|confirmed|exactly|precisely|true|that['']?s true|good|perfect|exactly right|i confirm)[.!?,\s]/i;

    const facts: Array<{ timestamp: Date; content: string }> = [];
    const msgs = session.messages;
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m.role !== "user") continue;
      if (!confirmPattern.test(m.content.trim())) continue;

      // Find the immediately preceding assistant message with non-empty content.
      let j = i - 1;
      while (j >= 0 && (msgs[j].role !== "assistant" || !msgs[j].content.trim())) j--;
      if (j < 0) continue;
      const assistantText = msgs[j].content.trim();

      // Take the LAST meaningful sentence (or first sentence as fallback).
      // Often the headline finding is at the start of the response; but
      // sometimes it's at the end — take the longest of the first 3 sentences.
      const sentences = assistantText
        .split(/(?<=[.!?])\s+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 20);
      const candidate = sentences
        .slice(0, 3)
        .sort((a, b) => b.length - a.length)[0];
      if (!candidate) continue;

      facts.push({
        timestamp: m.timestamp,
        content: candidate.length > maxCharsPerFact
          ? candidate.slice(0, maxCharsPerFact) + "…"
          : candidate,
      });
    }
    // Keep the most recent N facts so the pin stays compact.
    return facts.slice(-maxFacts);
  }

  /**
   * Get messages in OpenCode API format — compacts on-the-fly for the AI context
   * without mutating the stored session (which preserves full display history).
   */
  async getSessionMessages(
    sessionId: string,
    includeSummaries = true,
    contextMode: "rag" | "engine" = "rag",
  ): Promise<ChatMessage[]> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return [];
    }

    // In engine mode, the context engine handles system prompt, history
    // selection, and knowledge injection. It still needs bounded session input:
    // raw long-running sessions can contain huge tool-result JSON that drowns
    // the current request before ranking even starts.
    if (contextMode === "engine") {
      const messages: ChatMessage[] = [];

      const allMessages = session.messages;
      if (allMessages.length > this.MAX_MESSAGES_BEFORE_COMPACT) {
        const oldMessages = allMessages.slice(0, -this.MIN_RECENT_MESSAGES);
        const recentMessages = allMessages.slice(-this.MIN_RECENT_MESSAGES);
        if (includeSummaries) {
          const summary = await this.ensureActiveSessionSummary(
            session,
            oldMessages,
          );
          messages.push(this.toSummaryChatMessage(summary));
        }

        for (const msg of recentMessages) {
          messages.push(this.toContextChatMessage(msg));
        }
      } else {
        if (includeSummaries) {
          const summary = this.loadSessionSummary(sessionId);
          if (summary) {
            messages.push(this.toSummaryChatMessage(summary));
          }
        }

        for (const msg of allMessages) {
          messages.push(this.toContextChatMessage(msg));
        }
      }

      return messages;
    }

    const messages: ChatMessage[] = [];

    // Add system prompt
    messages.push({
      role: "system",
      content: this.getSystemPrompt(session.mode, session.metadata),
    });

    const allMessages = session.messages;
    const recentCount = this.MIN_RECENT_MESSAGES;
    if (allMessages.length > this.MAX_MESSAGES_BEFORE_COMPACT) {
      const oldMessages = allMessages.slice(0, -recentCount);
      const recentMessages = allMessages.slice(-recentCount);

      if (includeSummaries) {
        const summary = await this.ensureActiveSessionSummary(session, oldMessages);
        messages.push(this.toSummaryChatMessage(summary));
      }

      for (const msg of recentMessages) {
        messages.push(this.toContextChatMessage(msg));
      }
    } else {
      if (includeSummaries) {
        const summary = this.loadSessionSummary(sessionId);
        if (summary) {
          messages.push(this.toSummaryChatMessage(summary));
        }
      }

      for (const msg of allMessages) {
        messages.push(this.toContextChatMessage(msg));
      }
    }

    return messages;
  }

  /**
   * Get session messages WITHOUT truncation AND WITHOUT summary — for cache rehydration.
   * Rehydration must happen BEFORE truncation so cache refs in large tool
   * results aren't lost to the truncation suffix.
   *
   * CRITICAL: We exclude the session summary here because it contains
   * "earlier messages compressed" language that triggers the model's
   * "context window full" hallucination, even though the actual tool
   * results are being rehydrated and are fully available.
   */
  async getRawSessionMessages(
    sessionId: string,
    _includeSummaries = false, // Kept for API compat; summary injection was disabled
    contextMode: "rag" | "engine" = "rag",
  ): Promise<ChatMessage[]> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return [];
    }

    // Same logic as getSessionMessages but with truncate=false and NO summaries
    if (contextMode === "engine") {
      const messages: ChatMessage[] = [];

      const allMessages = session.messages;
      if (allMessages.length > this.MAX_MESSAGES_BEFORE_COMPACT) {
        const recentMessages = allMessages.slice(-this.MIN_RECENT_MESSAGES);
        // Skip summary — it confuses the model into thinking context is full
        // when actually tool results are rehydrated from cache

        for (const msg of recentMessages) {
          messages.push(this.toContextChatMessage(msg, false));
        }
      } else {
        // Skip summary — it confuses the model

        for (const msg of allMessages) {
          messages.push(this.toContextChatMessage(msg, false));
        }
      }

      return messages;
    }

    const messages: ChatMessage[] = [];

    // Add system prompt
    messages.push({
      role: "system",
      content: this.getSystemPrompt(session.mode, session.metadata),
    });

    const allMessages = session.messages;
    const recentCount = this.MIN_RECENT_MESSAGES;
    if (allMessages.length > this.MAX_MESSAGES_BEFORE_COMPACT) {
      const recentMessages = allMessages.slice(-recentCount);

      // Skip summary — it confuses the model into thinking context is full

      for (const msg of recentMessages) {
        messages.push(this.toContextChatMessage(msg, false));
      }
    } else {
      // Skip summary

      for (const msg of allMessages) {
        messages.push(this.toContextChatMessage(msg, false));
      }
    }

    return messages;
  }

  private toContextChatMessage(msg: Message, truncate = true): ChatMessage {
    const chatMsg: ChatMessage = {
      role: msg.role,
      content: truncate ? this.truncateContextContent(msg) : msg.content,
    };
    if (msg.toolCalls) {
      chatMsg.tool_calls = msg.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: {
          name: tc.name,
          arguments:
            typeof tc.params === "string"
              ? tc.params
              : JSON.stringify(tc.params),
        },
      }));
    }
    if (msg.tool_call_id) {
      chatMsg.tool_call_id = msg.tool_call_id;
    }
    return chatMsg;
  }

  private truncateContextContent(msg: Message): string {
    const limit =
      msg.role === "tool"
        ? this.MAX_CONTEXT_TOOL_CHARS
        : this.MAX_CONTEXT_MESSAGE_CHARS;
    if (msg.content.length <= limit) return msg.content;
    return `${msg.content.substring(0, limit)}\n...[truncated for context: ${msg.content.length - limit} chars omitted]`;
  }

  private toSummaryChatMessage(summary: MemorySummary): ChatMessage {
    const topics = summary.keyTopics.length > 0
      ? `\n\nTopics covered: ${summary.keyTopics.join(", ")}`
      : "";
    return {
      role: "system",
      content:
        `CONVERSATION HISTORY (earlier messages compressed — treat this as authoritative):\n\n` +
        `${summary.summary}${topics}\n\n` +
        `IMPORTANT: Do NOT re-call any tool whose result is already recorded above. ` +
        `If a cached ref (tc-xxx) is listed, use tools.fetch_cached to retrieve that data instead of repeating the original call.`,
    };
  }

  /**
   * End a session and move to long-term storage
   */
  async endSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    // Generate summary
    const summary = await this.generateSessionSummary(session);

    // Save summary to long-term storage
    await this.saveLongTermSummary(session, summary);

    // Index into FTS5 for cross-session search
    this.indexSessionFTS(session, summary);

    // Remove from active sessions
    this.sessions.delete(sessionId);
    this.removeActiveSession(sessionId);
    toolCallCache.clear(sessionId);

    console.log(
      `[MemoryManager] Ended session ${sessionId}, saved to long-term memory`,
    );
  }

  deleteSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.removeActiveSession(sessionId);
    toolCallCache.clear(sessionId);
    console.log(`[MemoryManager] Deleted session ${sessionId}`);
  }

  /**
   * Index a completed session into FTS5 for cross-session search
   */
  private indexSessionFTS(
    session: ConversationSession,
    summary: MemorySummary,
  ): void {
    if (!this.db) return;

    try {
      const content = session.messages
        .map((m) => m.content)
        .join(" ")
        .substring(0, 5000);

      this.db.prepare(`
        INSERT INTO sessions_fts (sessionId, userId, title, summary, keyTopics, content)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        session.id,
        session.userId,
        session.metadata.title || "",
        summary.summary,
        summary.keyTopics.join(", "),
        content,
      );
    } catch (err) {
      console.warn("[MemoryManager] Failed to index session in FTS5:", err);
    }
  }

  /**
   * Search across all sessions using FTS5 with BM25 ranking.
   * Falls back to text search if FTS5 is unavailable.
   */
  searchSessions(query: string, limit = 5): SessionSearchResult[] {
    if (!query.trim()) return [];

    if (this.db) {
      const ftsQuery = this.buildFtsQuery(query);
      try {
        if (ftsQuery) {
          const rows = this.db.prepare(`
            SELECT
              sessionId,
              title,
              summary,
              keyTopics,
              bm25(sessions_fts) as score
            FROM sessions_fts
            WHERE sessions_fts MATCH ?
            ORDER BY score
            LIMIT ?
          `).all(ftsQuery, limit) as Array<{
            sessionId: string;
            title: string;
            summary: string;
            keyTopics: string;
            score: number;
          }>;

          if (rows.length > 0) {
            return rows.map((row) => ({
              sessionId: row.sessionId,
              title: row.title,
              summary: row.summary.substring(0, 500),
              keyTopics: row.keyTopics
                ? row.keyTopics.split(", ").filter(Boolean)
                : [],
              relevanceScore: -row.score,
              createdAt: "",
            }));
          }
        }
      } catch (err) {
        console.warn("[MemoryManager] FTS5 search failed, using fallback:", err);
      }
    }

    return this.searchSessionsFallback(query, limit);
  }

  private buildFtsQuery(query: string): string {
    const terms = query
      .match(/[\p{L}\p{N}_-]+/gu)
      ?.map((term) => term.trim())
      .filter((term) => term.length >= 2)
      .slice(0, 12) ?? [];

    return terms
      .map((term) => `"${term.replace(/"/g, "\"\"")}"`)
      .join(" OR ");
  }

  private searchSessionsFallback(
    query: string,
    limit: number,
  ): SessionSearchResult[] {
    const results: SessionSearchResult[] = [];
    const summariesDir = path.join(this.memoryBasePath, "summaries");

    if (!fs.existsSync(summariesDir)) return results;

    const queryLower = query.toLowerCase();

    const scanDir = (dir: string) => {
      if (results.length >= limit) return;
      const entries = fs.readdirSync(dir);
      for (const entry of entries) {
        if (results.length >= limit) break;
        const full = path.join(dir, entry);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          scanDir(full);
          continue;
        }
        if (!entry.endsWith(".md")) continue;
        try {
          const content = fs.readFileSync(full, "utf-8");
          const textLower = content.toLowerCase();
          if (!textLower.includes(queryLower)) continue;
          const parsed = this.parseMarkdownSummary(content);
          let score = 0;
          const words = queryLower.split(/\s+/);
          for (const w of words) {
            if (w.length > 2 && textLower.includes(w)) score += 1;
          }
          results.push({
            sessionId: parsed.sessionId,
            title: parsed.title,
            summary: parsed.summary.substring(0, 500),
            keyTopics: parsed.keyTopics,
            relevanceScore: score,
            createdAt: parsed.createdAt?.toISOString() ?? "",
          });
        } catch {}
      }
    };

    scanDir(summariesDir);
    results.sort((a, b) => b.relevanceScore - a.relevanceScore);
    return results;
  }

  /**
   * Search long-term memory
   */
  searchMemories(userId: string, query: string, limit = 10): MemorySummary[] {
    const summaryPath = path.join(this.memoryBasePath, "summaries", userId);

    if (!fs.existsSync(summaryPath)) {
      return [];
    }

    const files = fs
      .readdirSync(summaryPath)
      .filter((f) => f.endsWith(".md"))
      .sort((a, b) => {
        const statA = fs.statSync(path.join(summaryPath, a));
        const statB = fs.statSync(path.join(summaryPath, b));
        return statB.mtime.getTime() - statA.mtime.getTime(); // Most recent first
      })
      .slice(0, limit * 2); // Get more than needed for filtering

    const results: MemorySummary[] = [];

    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(summaryPath, file), "utf-8");
        const summary = this.parseMarkdownSummary(content);

        // Simple text search
        const searchText =
          `${summary.title} ${summary.summary} ${summary.keyTopics.join(" ")}`.toLowerCase();
        if (searchText.includes(query.toLowerCase())) {
          results.push(summary);
        }

        if (results.length >= limit) {
          break;
        }
      } catch (error) {
        console.error(
          `[MemoryManager] Error reading memory file ${file}:`,
          error,
        );
      }
    }

    return results;
  }

  /**
   * Get relevant memories for context
   */
  getRelevantMemories(
    userId: string,
    currentContext: string,
    limit = 3,
  ): string[] {
    const recentMemories = this.searchMemories(userId, "", 20);

    // Score memories by relevance to current context
    const scoredMemories = recentMemories
      .map((memory) => ({
        memory,
        score: this.calculateRelevance(memory, currentContext),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((item) => item.memory);

    return scoredMemories.map(
      (m) => `- ${m.title}: ${m.summary.substring(0, 200)}...`,
    );
  }

  /**
   * Save a standalone memory entry for a user (not tied to a session).
   * Used by agents like aicoder and reviewer to record their work outcomes.
   */
  saveMemory(
    userId: string,
    title: string,
    summary: string,
    keyTopics: string[] = [],
  ): void {
    const userDir = path.join(this.memoryBasePath, "summaries", userId);
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
    }

    const filename = `agent_${Date.now()}.md`;
    const filepath = path.join(userDir, filename);

    const now = new Date();
    const content = `# ${title}

**Session ID:** agent-memory-${Date.now()}
**Date:** ${now.toLocaleDateString()} - ${now.toLocaleDateString()}
**Messages:** 1
**Mode:** agent
**Tags:** ${keyTopics.join(", ")}

## Summary

${summary}

## Key Topics

${keyTopics.map((topic) => `- ${topic}`).join("\n")}

## Metadata

- **Created:** ${now.toISOString()}
- **User ID:** ${userId}
- **Session ID:** agent-memory-${Date.now()}

---
*Generated by AI Assistant Memory Manager*
`;

    fs.writeFileSync(filepath, content, "utf-8");
    console.log(`[MemoryManager] Saved memory for ${userId}: ${filepath}`);
  }

  /**
   * Build a structured summary preserving key facts, decisions, and actions
   */
  private async generateTitleLLM(
    sessionId: string,
    firstMessage: string,
  ): Promise<void> {
    try {
      const response = await aiClient.chat({
        messages: [
          {
            role: "system",
            content:
              "Generate a very short title (max 6 words) for a chat conversation that starts with this user message. Reply with ONLY the title text, no quotes, no punctuation, no explanation.",
          },
          { role: "user", content: firstMessage.substring(0, 500) },
        ],
        temperature: 0.3,
      });

      const title = response.content?.trim();
      if (title && title.length > 0 && title.length <= 80) {
        const session = this.sessions.get(sessionId);
        if (session) {
          session.metadata.title = title;
          this.saveActiveSession(session);
        }
      }
    } catch {}
  }

  private async buildCompactSummaryLLM(messages: Message[]): Promise<string> {
    const conversationText = this.serializeMessagesForSummary(messages);

    const summaryPrompt = `You are summarizing a conversation between a user and an AI assistant. Your summary REPLACES the older messages in the context window — the AI will only see this summary plus the most recent messages. The summary must be complete enough that the AI never needs to re-call a tool or re-ask a question whose answer was already obtained.

CRITICAL — preserve ALL of the following with full fidelity:

1. **Every tool call and its result**: For each tool invoked, record the tool name, key parameters, and the ACTUAL DATA returned — IDs, names, counts, statuses, dates, error messages. Never say "returned data" without saying what the data was. If a cached ref is available (e.g. [cached ref: tc-abc123]), include it so the AI can retrieve the full result later.

2. **What the user asked for**: Exact request(s), including any specific date ranges, customer names, filters, or formats requested.

3. **What has been completed**: Specific outcomes — reports generated, data fetched, items found. Include concrete numbers (e.g. "37 HAWK IR incidents found for May 1–Jun 4").

4. **What is still in progress or pending**: Any task the user requested that is not yet done.

5. **Decisions, conclusions, and recommendations**: Any choices confirmed, paths taken, or advice given.

6. **Concrete identifiers**: Jira/ticket keys, case IDs, host names, CVE IDs, usernames, session IDs, dates — anything the AI would need to continue the work without starting over.

FORMAT: Bullet points grouped by category. Each tool result gets its own bullet. Never compress actual data into vague phrases.

Conversation to summarize (${messages.length} messages):

---
${conversationText}
---`;

    try {
      const response = await aiClient.chat({
        messages: [
          {
            role: "system",
            content:
              "You are a lossless conversation archivist. Your summaries preserve every fact, ID, count, and decision so an AI agent can continue work seamlessly. You never omit concrete data.",
          },
          { role: "user", content: summaryPrompt },
        ],
        temperature: 0.1,
      });

      if (response.content && response.content.trim().length > 50) {
        return `[Context Summary — ${messages.length} earlier messages compressed]\n\n${response.content.trim()}`;
      }
    } catch (error) {
      console.error(
        "[MemoryManager] LLM summarization failed, using fallback:",
        error,
      );
    }

    return this.buildCompactSummaryFallback(messages);
  }

  private serializeMessagesForSummary(messages: Message[]): string {
    const toolCallMap = new Map<string, { name: string; params: string }>();
    for (const msg of messages) {
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          const paramsStr =
            typeof tc.params === "object"
              ? Object.entries(tc.params)
                  .filter(([, v]) => v !== undefined && v !== null)
                  .map(([k, v]) => `${k}=${String(v).substring(0, 80)}`)
                  .join(", ")
              : String(tc.params).substring(0, 120);
          toolCallMap.set(tc.id, { name: tc.name, params: paramsStr });
        }
      }
    }

    return messages
      .filter((m) => m.role !== "system")
      .map((m) => {
        switch (m.role) {
          case "user":
            // Include full user message — user intents must never be truncated away
            return `USER: ${m.content.substring(0, 1500)}`;
          case "assistant": {
            const parts: string[] = [];
            if (m.toolCalls?.length) {
              for (const tc of m.toolCalls) {
                const params = toolCallMap.get(tc.id)?.params || "";
                parts.push(`[Called tool: ${tc.name}(${params})]`);
              }
            }
            if (m.content?.trim()) {
              parts.push(m.content.substring(0, 800));
            }
            return `ASSISTANT: ${parts.join(" ")}`;
          }
          case "tool": {
            const callInfo = m.tool_call_id
              ? toolCallMap.get(m.tool_call_id)
              : null;
            const label = callInfo
              ? `TOOL RESULT (${callInfo.name}): `
              : "TOOL RESULT: ";
            let resultText: string;
            try {
              const parsed = JSON.parse(m.content);
              // If this result has a cache ref, include it so the AI can re-fetch if needed
              const ref = parsed._cached_ref as string | undefined;
              const refNote = ref ? ` [cached ref: ${ref}]` : "";
              // For large results, keep the summary fields rather than raw JSON
              if (parsed.data && typeof parsed.data === "object") {
                const data = parsed.data as Record<string, unknown>;
                const summary = data.summary ?? data.title ?? data.name ?? data.id;
                if (summary) {
                  resultText = `${JSON.stringify({ ...parsed, data: `[${typeof data}]` }, null, 0).substring(0, 1200)}${refNote}`;
                } else {
                  resultText = JSON.stringify(parsed, null, 0).substring(0, 1200) + refNote;
                }
              } else {
                resultText = JSON.stringify(parsed, null, 0).substring(0, 1200) + refNote;
              }
            } catch {
              resultText = m.content.substring(0, 600);
            }
            return `${label}${resultText}`;
          }
          default:
            return "";
        }
      })
      .filter((line) => line.length > 0)
      .join("\n\n");
  }

  private buildCompactSummaryFallback(messages: Message[]): string {
    const userMessages = messages.filter((m) => m.role === "user");
    const toolMessages = messages.filter((m) => m.role === "tool");
    const topics = this.extractTopics(messages);

    const toolCallMap = new Map<string, { name: string; params: string }>();
    for (const msg of messages) {
      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          const paramsStr =
            typeof tc.params === "object"
              ? Object.entries(tc.params)
                  .filter(([, v]) => v !== undefined && v !== null)
                  .map(([k, v]) => `${k}=${String(v).substring(0, 60)}`)
                  .join(", ")
              : "";
          toolCallMap.set(tc.id, { name: tc.name, params: paramsStr });
        }
      }
    }

    const lines = [
      `[Fallback summary — ${messages.length} messages compressed]`,
      `Topics: ${topics.join(", ")}`,
    ];

    const userIntents = userMessages
      .slice(-6)
      .map((m) => m.content.substring(0, 120).replace(/\n/g, " "))
      .filter((c) => c.trim().length > 0);

    if (userIntents.length > 0) {
      lines.push(`User requests:`);
      userIntents.forEach((intent, i) => {
        lines.push(`  ${i + 1}. ${intent}`);
      });
    }

    const toolResults: string[] = [];
    for (const msg of toolMessages) {
      const callId = msg.tool_call_id;
      const callInfo = callId ? toolCallMap.get(callId) : null;
      const toolName = callInfo?.name || "unknown";
      const params = callInfo?.params || "";

      let resultSummary: string;
      try {
        const parsed = JSON.parse(msg.content);
        if (parsed.error)
          resultSummary = `ERROR: ${parsed.error}`.substring(0, 150);
        else if (Array.isArray(parsed.data))
          resultSummary = `[${parsed.data.length} items]`;
        else if (typeof parsed.data === "object" && parsed.data) {
          const keys = Object.keys(parsed.data).slice(0, 4);
          resultSummary = keys
            .map((k) => `${k}=${String(parsed.data[k]).substring(0, 50)}`)
            .join(", ");
        } else resultSummary = String(parsed.data || "OK").substring(0, 100);
      } catch {
        resultSummary = msg.content.substring(0, 100).replace(/\n/g, " ");
      }

      toolResults.push(
        `${toolName}${params ? `(${params})` : ""} → ${resultSummary}`,
      );
    }

    if (toolResults.length > 0) {
      lines.push(`Tool results (DO NOT re-call):`);
      toolResults.slice(-12).forEach((r) => {
        lines.push(`  - ${r}`);
      });
    }

    lines.push(`(Do NOT repeat tools that already returned data above.)`);
    return lines.join("\n");
  }

  private async ensureActiveSessionSummary(
    session: ConversationSession,
    summarizedMessages: Message[],
  ): Promise<MemorySummary> {
    const existing = this.loadSessionSummary(session.id);
    // Reuse summary if still fresh — re-summarize once RESUMMARY_THRESHOLD new
    // messages have accumulated since the last summary was written.
    if (existing && (summarizedMessages.length - existing.messageCount) < this.RESUMMARY_THRESHOLD) {
      return existing;
    }

    const timeRange = {
      start: summarizedMessages[0]?.timestamp || session.createdAt,
      end: summarizedMessages[summarizedMessages.length - 1]?.timestamp || session.updatedAt,
    };

    // Use the LLM-backed summarizer — same quality as session-end summaries.
    const summaryText = await this.buildCompactSummaryLLM(summarizedMessages);

    const summary: MemorySummary = {
      id: uuidv4(),
      userId: session.userId,
      sessionId: session.id,
      title: session.metadata.title || `Session ${new Date().toLocaleDateString()}`,
      summary: summaryText,
      keyTopics: this.extractTopics(summarizedMessages),
      startDate: timeRange.start,
      endDate: timeRange.end,
      messageCount: summarizedMessages.length,
      createdAt: new Date(),
      metadata: {
        mode: session.mode,
        tags: session.metadata.tags,
        active: true,
      },
    };
    this.saveSessionSummary(summary);
    return summary;
  }

  /**
   * Generate session summary for long-term storage
   */
  private async generateSessionSummary(
    session: ConversationSession,
  ): Promise<MemorySummary> {
    const summary = await this.buildCompactSummaryLLM(session.messages);
    const topics = this.extractTopics(session.messages);
    const timeRange = {
      start: session.messages[0]?.timestamp || session.createdAt,
      end:
        session.messages[session.messages.length - 1]?.timestamp ||
        session.updatedAt,
    };

    return {
      id: uuidv4(),
      userId: session.userId,
      sessionId: session.id,
      title:
        session.metadata.title || `Session ${new Date().toLocaleDateString()}`,
      summary,
      keyTopics: topics,
      startDate: timeRange.start,
      endDate: timeRange.end,
      messageCount: session.messages.length,
      createdAt: new Date(),
      metadata: {
        mode: session.mode,
        tags: session.metadata.tags,
      },
    };
  }

  /**
   * Save summary to long-term storage
   */
  private async saveLongTermSummary(
    session: ConversationSession,
    summary: MemorySummary,
  ): Promise<void> {
    const userDir = path.join(this.memoryBasePath, "summaries", session.userId);
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
    }

    const filename = `${session.id}_${Date.now()}.md`;
    const filepath = path.join(userDir, filename);

    const content = this.formatLongTermSummary(summary);
    fs.writeFileSync(filepath, content, "utf-8");

    console.log(`[MemoryManager] Saved long-term summary to ${filepath}`);
  }

  private saveSessionSummary(summary: MemorySummary): void {
    const filepath = this.sessionSummaryPath(summary.sessionId);
    const content = this.formatLongTermSummary(summary);
    fs.writeFileSync(filepath, content, "utf-8");
  }

  /**
   * Format long-term summary as markdown
   */
  private formatLongTermSummary(summary: MemorySummary): string {
    return `# ${summary.title}

**Session ID:** ${summary.sessionId}
**Date:** ${summary.startDate.toLocaleDateString()} - ${summary.endDate.toLocaleDateString()}
**Messages:** ${summary.messageCount}
**Mode:** ${summary.metadata.mode}
**Tags:** ${((summary.metadata.tags as string[]) || []).join(", ")}

## Summary

${summary.summary}

## Key Topics

${summary.keyTopics.map((topic) => `- ${topic}`).join("\n")}

## Metadata

- **Created:** ${summary.createdAt.toISOString()}
- **User ID:** ${summary.userId}
- **Session ID:** ${summary.sessionId}

---
*Generated by AI Assistant Memory Manager*
`;
  }

  /** @internal Kept for future use */
  /**
   * Parse markdown summary back into object
   */
  private parseMarkdownSummary(content: string): MemorySummary {
    const lines = content.split("\n");
    const summary: Partial<MemorySummary> = {};

    let currentSection = "";
    let summaryText = "";
    const keyTopics: string[] = [];

    lines.forEach((line) => {
      if (line.startsWith("**Session ID:**")) {
        summary.sessionId = line.split("**Session ID:**")[1].trim();
      } else if (line.startsWith("**Messages:**")) {
        summary.messageCount =
          Number(line.split("**Messages:**")[1].trim()) || 0;
      } else if (line.startsWith("- **Created:**")) {
        const value = line.split("- **Created:**")[1].trim();
        const createdAt = new Date(value);
        if (!Number.isNaN(createdAt.getTime())) {
          summary.createdAt = createdAt;
        }
      } else if (line.startsWith("- **User ID:**")) {
        summary.userId = line.split("- **User ID:**")[1].trim();
      } else if (line.startsWith("# ")) {
        summary.title = line.replace("# ", "").trim();
      } else if (line.startsWith("## Summary")) {
        currentSection = "summary";
      } else if (line.startsWith("## Key Topics")) {
        currentSection = "topics";
      } else if (line.startsWith("## Metadata")) {
        currentSection = "metadata";
      } else if (
        currentSection === "summary" &&
        line.trim() &&
        !line.startsWith("##")
      ) {
        summaryText += line + "\n";
      } else if (currentSection === "topics" && line.startsWith("- ")) {
        keyTopics.push(line.slice(2).trim());
      }
    });

    summary.summary = summaryText.trim();
    summary.id = uuidv4();
    summary.createdAt = summary.createdAt || new Date();
    summary.userId = summary.userId || "unknown";
    summary.sessionId = summary.sessionId || "unknown";
    summary.title = summary.title || "Untitled Session";
    summary.summary = summary.summary || "";
    summary.keyTopics = keyTopics;
    summary.startDate = new Date();
    summary.endDate = new Date();
    summary.messageCount = summary.messageCount || 0;
    summary.metadata = {};

    return summary as MemorySummary;
  }

  /**
   * Extract key topics from messages
   */
  private extractTopics(messages: Message[]): string[] {
    // Simple keyword extraction - can be enhanced with NLP
    const allText = messages
      .map((m) => m.content)
      .join(" ")
      .toLowerCase();

    // Common tech and business topics
    const topicPatterns = [
      "security",
      "network",
      "development",
      "testing",
      "deployment",
      "api",
      "database",
      "frontend",
      "backend",
      "infrastructure",
      "jira",
      "gitlab",
      "roadmap",
      "project",
      "planning",
      "incident",
      "response",
      "monitoring",
      "performance",
      "automation",
      "script",
      "integration",
      "configuration",
    ];

    return topicPatterns.filter((topic) => allText.includes(topic));
  }

  /**
   * Get time range of messages
   */
  private calculateRelevance(memory: MemorySummary, context: string): number {
    const memoryText =
      `${memory.title} ${memory.summary} ${memory.keyTopics.join(" ")}`.toLowerCase();
    const contextLower = context.toLowerCase();

    let score = 0;

    // Exact phrase matches
    const contextWords = contextLower.split(/\s+/);
    contextWords.forEach((word) => {
      if (word.length > 3 && memoryText.includes(word)) {
        score += 1;
      }
    });

    // Topic matches
    memory.keyTopics.forEach((topic) => {
      if (contextLower.includes(topic.toLowerCase())) {
        score += 2;
      }
    });

    // Recency bias (more recent = slightly higher score)
    const daysOld =
      (Date.now() - memory.createdAt.getTime()) / (1000 * 60 * 60 * 24);
    score += Math.max(0, 10 - daysOld) * 0.1;

    return score;
  }

  /**
   * Get system prompt for mode
   */
  private getSystemPrompt(
    mode: "productivity" | "engineering",
    metadata: Record<string, unknown>,
  ): string {
    const basePrompt =
      mode === "productivity"
        ? "You are a helpful productivity assistant focused on planning, organization, and efficiency."
        : "You are an engineering assistant focused on technical design, implementation, and best practices.";

    const contextInfo = Object.entries(metadata.context || {})
      .map(([key, value]) => `${key}: ${value}`)
      .join("\n");

    return `${basePrompt}\n\n${contextInfo}`;
  }

  /**
   * Save active session to disk
   */
  private saveActiveSession(session: ConversationSession): void {
    const filepath = path.join(
      this.memoryBasePath,
      "active",
      `${session.id}.json`,
    );
    const data = {
      ...session,
      createdAt: session.createdAt.toISOString(),
      updatedAt: session.updatedAt.toISOString(),
      messages: session.messages.map((m) => ({
        ...m,
        timestamp: m.timestamp.toISOString(),
      })),
    };

    try {
      const tmpPath = filepath + ".tmp";
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
      fs.renameSync(tmpPath, filepath);
    } catch (err) {
      console.error(
        `[MemoryManager] Failed to persist session ${session.id}:`,
        err,
      );
    }
  }

  /**
   * Load active session from disk
   */
  private loadActiveSession(sessionId: string): ConversationSession | null {
    const filepath = path.join(
      this.memoryBasePath,
      "active",
      `${sessionId}.json`,
    );

    if (!fs.existsSync(filepath)) {
      return null;
    }

    try {
      const data = JSON.parse(fs.readFileSync(filepath, "utf-8"));
      return {
        ...data,
        createdAt: new Date(data.createdAt),
        updatedAt: new Date(data.updatedAt),
        messages: data.messages.map((m: any) => ({
          ...m,
          timestamp: new Date(m.timestamp),
        })),
      };
    } catch (error) {
      console.error(
        `[MemoryManager] Error loading session ${sessionId}:`,
        error,
      );
      return null;
    }
  }

  /**
   * Remove active session file
   */
  private removeActiveSession(sessionId: string): void {
    const filepath = path.join(
      this.memoryBasePath,
      "active",
      `${sessionId}.json`,
    );
    this.unlinkIfPresent(filepath);

    const summaryPath = this.sessionSummaryPath(sessionId);
    this.unlinkIfPresent(summaryPath);
  }

  private unlinkIfPresent(filepath: string): void {
    try {
      fs.unlinkSync(filepath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "EPERM") {
        throw error;
      }
    }
  }

  /**
   * Load session summary
   */
  private loadSessionSummary(sessionId: string): MemorySummary | null {
    const filepath = this.sessionSummaryPath(sessionId);

    if (!fs.existsSync(filepath)) {
      return null;
    }

    try {
      const content = fs.readFileSync(filepath, "utf-8");
      return this.parseMarkdownSummary(content);
    } catch (error) {
      console.error(
        `[MemoryManager] Error loading summary for ${sessionId}:`,
        error,
      );
      return null;
    }
  }

  private sessionSummaryPath(sessionId: string): string {
    return path.join(this.memoryBasePath, "sessions", `${sessionId}.summary.md`);
  }

  /**
   * Start cleanup task for old sessions
   */
  private startCleanupTask(): void {
    const cleanupTimer = setInterval(
      () => {
        this.cleanupOldSessions();
      },
      60 * 60 * 1000,
    );
    cleanupTimer.unref();

    this.cleanupOldSessions();
  }

  /**
   * Clean up old inactive sessions
   */
  private cleanupOldSessions(): void {
    const now = Date.now();
    const activeDir = path.join(this.memoryBasePath, "active");

    if (!fs.existsSync(activeDir)) {
      return;
    }

    const files = fs.readdirSync(activeDir);

    files.forEach((file) => {
      if (file.endsWith(".json")) {
        const filepath = path.join(activeDir, file);
        const stats = fs.statSync(filepath);

        if (now - stats.mtime.getTime() > this.SESSION_TIMEOUT_MS) {
          const sessionId = file.replace(".json", "");

          // End the session and move to long-term storage
          this.endSession(sessionId).catch((error) => {
            console.error(
              `[MemoryManager] Error ending session ${sessionId}:`,
              error,
            );
          });
        }
      }
    });
  }

  /**
   * Get statistics
   */
  getStats(): {
    activeSessions: number;
    totalSummaries: number;
    usersCount: number;
  } {
    const activeDir = path.join(this.memoryBasePath, "active");
    const summariesDir = path.join(this.memoryBasePath, "summaries");
    const usersDir = path.join(this.memoryBasePath, "users");

    let activeSessions = 0;
    let totalSummaries = 0;
    let usersCount = 0;

    if (fs.existsSync(activeDir)) {
      activeSessions = fs
        .readdirSync(activeDir)
        .filter((f) => f.endsWith(".json")).length;
    }

    if (fs.existsSync(summariesDir)) {
      const countRecursive = (dir: string): number => {
        let count = 0;
        const files = fs.readdirSync(dir);
        files.forEach((file) => {
          const filepath = path.join(dir, file);
          const stat = fs.statSync(filepath);
          if (stat.isDirectory()) {
            count += countRecursive(filepath);
          } else if (file.endsWith(".md")) {
            count++;
          }
        });
        return count;
      };

      totalSummaries = countRecursive(summariesDir);
      usersCount = fs.existsSync(usersDir)
        ? fs.readdirSync(usersDir).length
        : 0;
    }

    return {
      activeSessions,
      totalSummaries,
      usersCount,
    };
  }

  listSessionsForUser(userId: string): Array<{
    id: string;
    mode: string;
    messageCount: number;
    createdAt: Date;
    updatedAt: Date;
    title: string;
    preview: string;
  }> {
    const activeDir = path.join(this.memoryBasePath, "active");
    const sessions: Array<{
      id: string;
      mode: string;
      messageCount: number;
      createdAt: Date;
      updatedAt: Date;
      title: string;
      preview: string;
    }> = [];

    if (!fs.existsSync(activeDir)) return sessions;

    const files = fs.readdirSync(activeDir).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      try {
        const data = JSON.parse(
          fs.readFileSync(path.join(activeDir, file), "utf-8"),
        );
        if (data.userId !== userId) continue;

        const lastUserMsg = [...(data.messages || [])]
          .reverse()
          .find((m: any) => m.role === "user");
        sessions.push({
          id: data.id,
          mode: data.mode,
          messageCount: data.messages?.length || 0,
          createdAt: new Date(data.createdAt),
          updatedAt: new Date(data.updatedAt),
          title: data.metadata?.title || "Untitled",
          preview: lastUserMsg?.content?.substring(0, 100) || "",
        });
      } catch {
        // skip corrupted files
      }
    }

    sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    return sessions;
  }

  getSessionMessagesForDisplay(sessionId: string): Array<{
    role: string;
    content: string;
    timestamp: string;
    thinking?: string;
  }> {
    const session =
      this.sessions.get(sessionId) || this.loadActiveSession(sessionId);
    if (!session) {
      return [];
    }

    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, session);
    }

    // Show user and assistant messages. For assistant messages with no text
    // content but with tool calls, synthesize a placeholder so the user can
    // see the agent was working (otherwise the whole turn appears blank).
    const display = session.messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => {
        if (m.role === "assistant" && (!m.content || m.content.trim() === "")) {
          if (m.toolCalls && m.toolCalls.length > 0) {
            const names = m.toolCalls.map((t) => `\`${t.name}\``).join(", ");
            return {
              role: m.role,
              content: `🔧 *Called ${names}*`,
              timestamp: m.timestamp.toISOString(),
              ...(m.thinking ? { thinking: m.thinking } : {}),
            };
          }
          return null;
        }
        return {
          role: m.role,
          content: m.content,
          timestamp: m.timestamp.toISOString(),
          ...(m.thinking ? { thinking: m.thinking } : {}),
        };
      })
      .filter((m): m is NonNullable<typeof m> => m !== null);

    const runStatusMessage = this.buildRunStatusMessage(
      sessionId,
      display.length > 0
        ? new Date(display[display.length - 1].timestamp)
        : null,
    );
    if (runStatusMessage) display.push(runStatusMessage);

    return display;
  }

  /**
   * If the most recent agent run for this session failed (or has been
   * silently stuck in 'running' past a reasonable threshold), surface that
   * as a synthesized assistant bubble so users can see *why* there's no
   * reply. Without this, a rate-limit failure or server restart mid-turn
   * looks identical to "the model said nothing".
   */
  private buildRunStatusMessage(
    sessionId: string,
    lastDisplayTimestamp: Date | null,
  ): {
    role: "assistant";
    content: string;
    timestamp: string;
  } | null {
    try {
      // Lazy require avoids a circular dependency with agent-runs/database,
      // which can transitively pull in conversation-manager via tool-dispatcher.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { agentRunDatabase } = require("../agent-runs/database");
      const { runs } = agentRunDatabase.listRuns({ sessionId, limit: 1 });
      if (!runs || runs.length === 0) return null;

      const latest = runs[0];
      const startedMs = latest.startedAt
        ? new Date(latest.startedAt).getTime()
        : 0;
      const lastVisibleMs = lastDisplayTimestamp
        ? lastDisplayTimestamp.getTime()
        : 0;
      // Only surface if the run started after the last visible message, so
      // we don't double-report once a successful turn followed up.
      if (lastVisibleMs && startedMs && startedMs < lastVisibleMs - 1000) {
        return null;
      }

      if (latest.status === "failed" && latest.errorMessage) {
        const ts = latest.completedAt || latest.startedAt || new Date().toISOString();
        return {
          role: "assistant",
          content: `⚠️ *Run failed:* ${latest.errorMessage}`,
          timestamp: new Date(ts).toISOString(),
        };
      }

      if (latest.status === "running") {
        const lastActivityMs = latest.lastActivityAt
          ? new Date(latest.lastActivityAt).getTime()
          : startedMs;
        const ageMs = Date.now() - lastActivityMs;
        // 5 minutes idle = effectively dead. The reaper marks these failed
        // on next server start, but until then they're invisible.
        if (ageMs > 5 * 60 * 1000) {
          return {
            role: "assistant",
            content:
              "⏳ *Run interrupted before completion* — server restart or timeout while the agent was running tools. No final reply was generated.",
            timestamp: new Date(lastActivityMs).toISOString(),
          };
        }
      }
      return null;
    } catch (err) {
      console.warn(
        "[MemoryManager] Failed to enrich run status into messages:",
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  /** Close the SQLite database connection. Call during test cleanup. */
  close(): void {
    if (this.db) {
      try {
        this.db.pragma("wal_checkpoint(TRUNCATE)");
        this.db.close();
      } catch {}
      this.db = null;
    }
  }
}

// Singleton instance
export const conversationManager = new ConversationManager();
