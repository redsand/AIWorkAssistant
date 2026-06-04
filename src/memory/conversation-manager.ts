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

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  timestamp: Date;
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

export class ConversationManager {
  private sessions: Map<string, ConversationSession> = new Map();
  private memoryBasePath: string;
  private db: Database.Database | null = null;

  // Configuration thresholds — compact early to keep context lean
  private readonly MAX_MESSAGES_BEFORE_COMPACT = 40;
  private readonly MIN_RECENT_MESSAGES = 10;
  private readonly MAX_CONTEXT_TOOL_CHARS = 12_000;
  private readonly MAX_CONTEXT_MESSAGE_CHARS = 8_000;
  private readonly SESSION_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours

  constructor() {
    this.memoryBasePath = this.resolveMemoryBasePath();
    this.initializeStorage();
    this.startCleanupTask();
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

    return path.join(process.cwd(), "data", "memories");
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
      this.db.pragma("journal_mode = WAL");
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
        context: (metadata?.context as Record<string, unknown>) || {},
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
   * Add a message to a session
   */
  addMessage(sessionId: string, message: Omit<Message, "timestamp">): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const content = message.content;

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
          const summary = this.ensureActiveSessionSummary(
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
        const summary = this.ensureActiveSessionSummary(session, oldMessages);
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

  private toContextChatMessage(msg: Message): ChatMessage {
    const chatMsg: ChatMessage = {
      role: msg.role,
      content: this.truncateContextContent(msg),
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
    return {
      role: "system",
      content: `Previous conversation summary:\n${summary.summary}\n\nKey topics discussed: ${summary.keyTopics.join(", ")}`,
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

    console.log(
      `[MemoryManager] Ended session ${sessionId}, saved to long-term memory`,
    );
  }

  deleteSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.removeActiveSession(sessionId);
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

    const summaryPrompt = `You are summarizing a conversation between a user and an AI assistant. Your summary will replace the older messages in the conversation history, so the AI can continue seamlessly WITHOUT re-calling tools or re-asking questions.

PRESERVE ALL OF THE FOLLOWING — this is critical to prevent the AI from wasting tokens on redundant actions:

1. **Tool results with actual data**: For every tool call, include the tool name, its parameters, and the KEY DATA from the result (IDs, names, statuses, counts, specific items found). Do NOT just say "OK" or "completed" — include the actual data.

2. **Decisions made**: Any conclusions the assistant reached, recommendations given, or choices the user confirmed.

3. **User's goals**: What the user explicitly asked for and whether it was completed or still pending.

4. **Pending actions**: Anything the assistant said it would do but hasn't done yet.

5. **Facts established**: Specific Jira keys, roadmap IDs, ticket statuses, dates, or other concrete data referenced.

FORMAT: Use bullet points grouped by category. Be concise but never omit concrete data (IDs, keys, names, statuses).

Here is the conversation to summarize:

---
${conversationText}
---`;

    try {
      const summarizationTimeout = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("LLM summarization timed out")),
          30_000,
        ),
      );
      const response = await Promise.race([
        aiClient.chat({
          messages: [
            {
              role: "system",
              content:
                "You are a precise conversation summarizer. You preserve all concrete data (IDs, keys, names, statuses) from tool results so the AI does not re-call tools.",
            },
            { role: "user", content: summaryPrompt },
          ],
          temperature: 0.3,
        }),
        summarizationTimeout,
      ]);

      if (response.content && response.content.trim().length > 50) {
        return `[LLM Summary — ${messages.length} earlier messages]\n\n${response.content.trim()}`;
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
            return `USER: ${m.content.substring(0, 500)}`;
          case "assistant": {
            const parts: string[] = [];
            if (m.toolCalls?.length) {
              for (const tc of m.toolCalls) {
                const params = toolCallMap.get(tc.id)?.params || "";
                parts.push(`[Called tool: ${tc.name}(${params})]`);
              }
            }
            if (m.content?.trim()) {
              parts.push(m.content.substring(0, 400));
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
              resultText = JSON.stringify(parsed, null, 0).substring(0, 600);
            } catch {
              resultText = m.content.substring(0, 300);
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

  private ensureActiveSessionSummary(
    session: ConversationSession,
    summarizedMessages: Message[],
  ): MemorySummary {
    const existing = this.loadSessionSummary(session.id);
    if (existing && existing.messageCount >= summarizedMessages.length) {
      return existing;
    }

    const summary = this.buildDeterministicSessionSummary(
      session,
      summarizedMessages,
    );
    this.saveSessionSummary(summary);
    return summary;
  }

  private buildDeterministicSessionSummary(
    session: ConversationSession,
    messages: Message[],
  ): MemorySummary {
    const timeRange = {
      start: messages[0]?.timestamp || session.createdAt,
      end: messages[messages.length - 1]?.timestamp || session.updatedAt,
    };

    return {
      id: uuidv4(),
      userId: session.userId,
      sessionId: session.id,
      title:
        session.metadata.title || `Session ${new Date().toLocaleDateString()}`,
      summary: this.buildCompactSummaryFallback(messages),
      keyTopics: this.extractTopics(messages),
      startDate: timeRange.start,
      endDate: timeRange.end,
      messageCount: messages.length,
      createdAt: new Date(),
      metadata: {
        mode: session.mode,
        tags: session.metadata.tags,
        active: true,
      },
    };
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
  }> {
    const session =
      this.sessions.get(sessionId) || this.loadActiveSession(sessionId);
    if (!session) {
      return [];
    }

    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, session);
    }

    // Only show user and assistant messages in the UI — skip system and tool
    return session.messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .filter(
        (m) =>
          !(m.role === "assistant" && (!m.content || m.content.trim() === "")),
      )
      .map((m) => ({
        role: m.role,
        content: m.content,
        timestamp: m.timestamp.toISOString(),
      }));
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
