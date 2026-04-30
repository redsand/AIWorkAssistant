/**
 * Conversation Memory Manager
 * Handles conversation history, auto-compaction, and long-term memory storage
 */

import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
  timestamp: Date;
  toolCalls?: Array<{
    id: string;
    name: string;
    params: Record<string, unknown>;
  }>;
}

export interface ConversationSession {
  id: string;
  userId: string;
  mode: 'productivity' | 'engineering';
  messages: Message[];
  createdAt: Date;
  updatedAt: Date;
  metadata: {
    title?: string;
    tags?: string[];
    context?: Record<string, unknown>;
  };
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

  // Configuration thresholds
  private readonly MAX_MESSAGES_BEFORE_COMPACT = 50;
  private readonly MAX_TOKENS_BEFORE_COMPACT = 8000; // Approximate
  private readonly MIN_RECENT_MESSAGES = 10;
  private readonly SESSION_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours

  constructor() {
    this.memoryBasePath = path.join(process.cwd(), 'data', 'memories');
    this.initializeStorage();
    this.startCleanupTask();
  }

  private initializeStorage() {
    const dirs = [
      path.join(this.memoryBasePath, 'users'),
      path.join(this.memoryBasePath, 'sessions'),
      path.join(this.memoryBasePath, 'summaries'),
      path.join(this.memoryBasePath, 'active'),
    ];

    dirs.forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });

    console.log('[MemoryManager] Storage initialized');
  }

  /**
   * Start or continue a conversation session
   */
  startSession(userId: string, mode: 'productivity' | 'engineering', metadata?: Record<string, unknown>): string {
    const sessionId = uuidv4();

    const session: ConversationSession = {
      id: sessionId,
      userId,
      mode,
      messages: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      metadata: {
        title: metadata?.title as string || `Session ${new Date().toLocaleDateString()}`,
        tags: metadata?.tags as string[] || [],
        context: metadata?.context as Record<string, unknown> || {},
      },
    };

    this.sessions.set(sessionId, session);
    this.saveActiveSession(session);

    console.log(`[MemoryManager] Started session ${sessionId} for user ${userId}`);
    return sessionId;
  }

  /**
   * Add a message to a session
   */
  addMessage(sessionId: string, message: Omit<Message, 'timestamp'>): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const messageWithTimestamp: Message = {
      ...message,
      timestamp: new Date(),
    };

    session.messages.push(messageWithTimestamp);
    session.updatedAt = new Date();

    // Check if we need to compact
    if (this.shouldCompact(session)) {
      this.compactSession(sessionId);
    }

    this.saveActiveSession(session);
  }

  /**
   * Get conversation history for a session
   */
  getSession(sessionId: string): ConversationSession | null {
    return this.sessions.get(sessionId) || null;
  }

  /**
   * Get messages in OpenCode API format
   */
  getSessionMessages(sessionId: string, includeSummaries = true): Array<{ role: string; content: string }> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return [];
    }

    const messages: Array<{ role: string; content: string }> = [];

    // Add system prompt
    messages.push({
      role: 'system',
      content: this.getSystemPrompt(session.mode, session.metadata),
    });

    // Add summary if available
    if (includeSummaries) {
      const summary = this.loadSessionSummary(sessionId);
      if (summary) {
        messages.push({
          role: 'system',
          content: `Previous conversation summary:\n${summary.summary}\n\nKey topics discussed: ${summary.keyTopics.join(', ')}`,
        });
      }
    }

    // Add recent messages
    session.messages.forEach(msg => {
      messages.push({
        role: msg.role,
        content: msg.content,
      });
    });

    return messages;
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

    // Remove from active sessions
    this.sessions.delete(sessionId);
    this.removeActiveSession(sessionId);

    console.log(`[MemoryManager] Ended session ${sessionId}, saved to long-term memory`);
  }

  /**
   * Search long-term memory
   */
  searchMemories(userId: string, query: string, limit = 10): MemorySummary[] {
    const summaryPath = path.join(this.memoryBasePath, 'summaries', userId);

    if (!fs.existsSync(summaryPath)) {
      return [];
    }

    const files = fs.readdirSync(summaryPath)
      .filter(f => f.endsWith('.md'))
      .sort((a, b) => {
        const statA = fs.statSync(path.join(summaryPath, a));
        const statB = fs.statSync(path.join(summaryPath, b));
        return statB.mtime.getTime() - statA.mtime.getTime(); // Most recent first
      })
      .slice(0, limit * 2); // Get more than needed for filtering

    const results: MemorySummary[] = [];

    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(summaryPath, file), 'utf-8');
        const summary = this.parseMarkdownSummary(content);

        // Simple text search
        const searchText = `${summary.title} ${summary.summary} ${summary.keyTopics.join(' ')}`.toLowerCase();
        if (searchText.includes(query.toLowerCase())) {
          results.push(summary);
        }

        if (results.length >= limit) {
          break;
        }
      } catch (error) {
        console.error(`[MemoryManager] Error reading memory file ${file}:`, error);
      }
    }

    return results;
  }

  /**
   * Get relevant memories for context
   */
  getRelevantMemories(userId: string, currentContext: string, limit = 3): string[] {
    const recentMemories = this.searchMemories(userId, '', 20);

    // Score memories by relevance to current context
    const scoredMemories = recentMemories.map(memory => ({
      memory,
      score: this.calculateRelevance(memory, currentContext),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(item => item.memory);

    return scoredMemories.map(m => `- ${m.title}: ${m.summary.substring(0, 200)}...`);
  }

  /**
   * Check if session needs compaction
   */
  private shouldCompact(session: ConversationSession): boolean {
    const messageCount = session.messages.length;
    const estimatedTokens = this.estimateTokens(session.messages);

    return messageCount > this.MAX_MESSAGES_BEFORE_COMPACT ||
           estimatedTokens > this.MAX_TOKENS_BEFORE_COMPACT;
  }

  /**
   * Compact session by summarizing old messages
   */
  private async compactSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.messages.length <= this.MIN_RECENT_MESSAGES) {
      return;
    }

    console.log(`[MemoryManager] Compacting session ${sessionId}`);

    // Split messages into old and recent
    const splitPoint = session.messages.length - this.MIN_RECENT_MESSAGES;
    const oldMessages = session.messages.slice(0, splitPoint);
    const recentMessages = session.messages.slice(splitPoint);

    // Generate summary of old messages
    const summary = await this.generateMessagesSummary(oldMessages);

    // Save summary
    const summaryPath = path.join(this.memoryBasePath, 'sessions', `${sessionId}.summary.md`);
    const summaryContent = this.formatSessionSummary(oldMessages, summary);
    fs.writeFileSync(summaryPath, summaryContent, 'utf-8');

    // Replace old messages with summary
    session.messages = [
      {
        role: 'system',
        content: `[Previous conversation summary]\n${summary}`,
        timestamp: new Date(),
      },
      ...recentMessages,
    ];

    session.updatedAt = new Date();
  }

  /**
   * Generate summary of messages
   */
  private async generateMessagesSummary(messages: Message[]): Promise<string> {
    // Simple summarization logic - can be enhanced with AI
    const userMessages = messages.filter(m => m.role === 'user').length;
    const assistantMessages = messages.filter(m => m.role === 'assistant').length;

    const topics = this.extractTopics(messages);
    const timeRange = this.getTimeRange(messages);

    return `Conversation spanned ${timeRange}. ` +
           `Discussed ${userMessages} user messages and ${assistantMessages} assistant responses. ` +
           `Key topics: ${topics.join(', ')}.`;
  }

  /**
   * Generate session summary for long-term storage
   */
  private async generateSessionSummary(session: ConversationSession): Promise<MemorySummary> {
    const summary = await this.generateMessagesSummary(session.messages);
    const topics = this.extractTopics(session.messages);
    const timeRange = {
      start: session.messages[0]?.timestamp || session.createdAt,
      end: session.messages[session.messages.length - 1]?.timestamp || session.updatedAt,
    };

    return {
      id: uuidv4(),
      userId: session.userId,
      sessionId: session.id,
      title: session.metadata.title || `Session ${new Date().toLocaleDateString()}`,
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
  private async saveLongTermSummary(session: ConversationSession, summary: MemorySummary): Promise<void> {
    const userDir = path.join(this.memoryBasePath, 'summaries', session.userId);
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
    }

    const filename = `${session.id}_${Date.now()}.md`;
    const filepath = path.join(userDir, filename);

    const content = this.formatLongTermSummary(summary);
    fs.writeFileSync(filepath, content, 'utf-8');

    console.log(`[MemoryManager] Saved long-term summary to ${filepath}`);
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
**Tags:** ${(summary.metadata.tags as string[] || []).join(', ')}

## Summary

${summary.summary}

## Key Topics

${summary.keyTopics.map(topic => `- ${topic}`).join('\n')}

## Metadata

- **Created:** ${summary.createdAt.toISOString()}
- **User ID:** ${summary.userId}
- **Session ID:** ${summary.sessionId}

---
*Generated by OpenClaw Agent Memory Manager*
`;
  }

  /**
   * Format session summary for temporary storage
   */
  private formatSessionSummary(messages: Message[], summary: string): string {
    const topics = this.extractTopics(messages);
    const timeRange = this.getTimeRange(messages);

    return `# Conversation Summary

**Time Range:** ${timeRange}
**Messages:** ${messages.length}
**Key Topics:** ${topics.join(', ')}

## Summary

${summary}

## Message Details

${messages.map(m => `
### ${m.role} - ${m.timestamp.toLocaleTimeString()}

${m.content}

${m.toolCalls ? `**Tool Calls:** ${m.toolCalls.map(tc => tc.name).join(', ')}` : ''}
`).join('\n')}

---
*Compacted by OpenClaw Agent Memory Manager*
`;
  }

  /**
   * Parse markdown summary back into object
   */
  private parseMarkdownSummary(content: string): MemorySummary {
    // Simple parsing - can be enhanced with proper markdown parser
    const lines = content.split('\n');
    const summary: Partial<MemorySummary> = {};

    let currentSection = '';
    let summaryText = '';

    lines.forEach(line => {
      if (line.startsWith('**Session ID:**')) {
        summary.sessionId = line.split('**Session ID:**')[1].trim();
      } else if (line.startsWith('**Date:**')) {
        // Parse date range
      } else if (line.startsWith('# ')) {
        summary.title = line.replace('# ', '').trim();
      } else if (line.startsWith('## Summary')) {
        currentSection = 'summary';
      } else if (line.startsWith('## Key Topics')) {
        currentSection = 'topics';
      } else if (currentSection === 'summary' && line.trim() && !line.startsWith('##')) {
        summaryText += line + '\n';
      }
    });

    summary.summary = summaryText.trim();
    summary.keyTopics = [];
    summary.id = uuidv4();
    summary.createdAt = new Date();
    summary.userId = 'unknown';
    summary.sessionId = summary.sessionId || 'unknown';
    summary.title = summary.title || 'Untitled Session';
    summary.summary = summary.summary || '';
    summary.keyTopics = summary.keyTopics || [];
    summary.startDate = new Date();
    summary.endDate = new Date();
    summary.messageCount = 0;
    summary.metadata = {};

    return summary as MemorySummary;
  }

  /**
   * Extract key topics from messages
   */
  private extractTopics(messages: Message[]): string[] {
    // Simple keyword extraction - can be enhanced with NLP
    const allText = messages.map(m => m.content).join(' ').toLowerCase();

    // Common tech and business topics
    const topicPatterns = [
      'security', 'network', 'development', 'testing', 'deployment',
      'api', 'database', 'frontend', 'backend', 'infrastructure',
      'jira', 'gitlab', 'roadmap', 'project', 'planning',
      'incident', 'response', 'monitoring', 'performance',
      'automation', 'script', 'integration', 'configuration'
    ];

    return topicPatterns.filter(topic => allText.includes(topic));
  }

  /**
   * Get time range of messages
   */
  private getTimeRange(messages: Message[]): string {
    if (messages.length === 0) return 'No messages';

    const start = messages[0].timestamp;
    const end = messages[messages.length - 1].timestamp;

    const duration = end.getTime() - start.getTime();
    const minutes = Math.floor(duration / (1000 * 60));

    if (minutes < 60) {
      return `${minutes} minutes`;
    } else if (minutes < 1440) {
      return `${Math.floor(minutes / 60)} hours`;
    } else {
      return `${Math.floor(minutes / 1440)} days`;
    }
  }

  /**
   * Estimate token count for messages
   */
  private estimateTokens(messages: Message[]): number {
    // Rough estimate: ~4 characters per token
    const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
    return Math.floor(totalChars / 4);
  }

  /**
   * Calculate relevance score for memory
   */
  private calculateRelevance(memory: MemorySummary, context: string): number {
    const memoryText = `${memory.title} ${memory.summary} ${memory.keyTopics.join(' ')}`.toLowerCase();
    const contextLower = context.toLowerCase();

    let score = 0;

    // Exact phrase matches
    const contextWords = contextLower.split(/\s+/);
    contextWords.forEach(word => {
      if (word.length > 3 && memoryText.includes(word)) {
        score += 1;
      }
    });

    // Topic matches
    memory.keyTopics.forEach(topic => {
      if (contextLower.includes(topic.toLowerCase())) {
        score += 2;
      }
    });

    // Recency bias (more recent = slightly higher score)
    const daysOld = (Date.now() - memory.createdAt.getTime()) / (1000 * 60 * 60 * 24);
    score += Math.max(0, 10 - daysOld) * 0.1;

    return score;
  }

  /**
   * Get system prompt for mode
   */
  private getSystemPrompt(mode: 'productivity' | 'engineering', metadata: Record<string, unknown>): string {
    const basePrompt = mode === 'productivity'
      ? 'You are a helpful productivity assistant focused on planning, organization, and efficiency.'
      : 'You are an engineering assistant focused on technical design, implementation, and best practices.';

    const contextInfo = Object.entries(metadata.context || {})
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n');

    return `${basePrompt}\n\n${contextInfo}`;
  }

  /**
   * Save active session to disk
   */
  private saveActiveSession(session: ConversationSession): void {
    const filepath = path.join(this.memoryBasePath, 'active', `${session.id}.json`);
    const data = {
      ...session,
      createdAt: session.createdAt.toISOString(),
      updatedAt: session.updatedAt.toISOString(),
      messages: session.messages.map(m => ({
        ...m,
        timestamp: m.timestamp.toISOString(),
      })),
    };

    fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf-8');
  }

  /**
   * Load active session from disk
   */
  private loadActiveSession(sessionId: string): ConversationSession | null {
    const filepath = path.join(this.memoryBasePath, 'active', `${sessionId}.json`);

    if (!fs.existsSync(filepath)) {
      return null;
    }

    try {
      const data = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
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
      console.error(`[MemoryManager] Error loading session ${sessionId}:`, error);
      return null;
    }
  }

  /**
   * Remove active session file
   */
  private removeActiveSession(sessionId: string): void {
    const filepath = path.join(this.memoryBasePath, 'active', `${sessionId}.json`);
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
    }
  }

  /**
   * Load session summary
   */
  private loadSessionSummary(sessionId: string): MemorySummary | null {
    const filepath = path.join(this.memoryBasePath, 'sessions', `${sessionId}.summary.md`);

    if (!fs.existsSync(filepath)) {
      return null;
    }

    try {
      const content = fs.readFileSync(filepath, 'utf-8');
      return this.parseMarkdownSummary(content);
    } catch (error) {
      console.error(`[MemoryManager] Error loading summary for ${sessionId}:`, error);
      return null;
    }
  }

  /**
   * Start cleanup task for old sessions
   */
  private startCleanupTask(): void {
    // Run cleanup every hour
    setInterval(() => {
      this.cleanupOldSessions();
    }, 60 * 60 * 1000);

    // Initial cleanup
    this.cleanupOldSessions();
  }

  /**
   * Clean up old inactive sessions
   */
  private cleanupOldSessions(): void {
    const now = Date.now();
    const activeDir = path.join(this.memoryBasePath, 'active');

    if (!fs.existsSync(activeDir)) {
      return;
    }

    const files = fs.readdirSync(activeDir);

    files.forEach(file => {
      if (file.endsWith('.json')) {
        const filepath = path.join(activeDir, file);
        const stats = fs.statSync(filepath);

        if (now - stats.mtime.getTime() > this.SESSION_TIMEOUT_MS) {
          const sessionId = file.replace('.json', '');

          // End the session and move to long-term storage
          this.endSession(sessionId).catch(error => {
            console.error(`[MemoryManager] Error ending session ${sessionId}:`, error);
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
    const activeDir = path.join(this.memoryBasePath, 'active');
    const summariesDir = path.join(this.memoryBasePath, 'summaries');
    const usersDir = path.join(this.memoryBasePath, 'users');

    let activeSessions = 0;
    let totalSummaries = 0;
    let usersCount = 0;

    if (fs.existsSync(activeDir)) {
      activeSessions = fs.readdirSync(activeDir).filter(f => f.endsWith('.json')).length;
    }

    if (fs.existsSync(summariesDir)) {
      const countRecursive = (dir: string): number => {
        let count = 0;
        const files = fs.readdirSync(dir);
        files.forEach(file => {
          const filepath = path.join(dir, file);
          const stat = fs.statSync(filepath);
          if (stat.isDirectory()) {
            count += countRecursive(filepath);
          } else if (file.endsWith('.md')) {
            count++;
          }
        });
        return count;
      };

      totalSummaries = countRecursive(summariesDir);
      usersCount = fs.existsSync(usersDir) ? fs.readdirSync(usersDir).length : 0;
    }

    return {
      activeSessions,
      totalSummaries,
      usersCount,
    };
  }
}

// Singleton instance
export const conversationManager = new ConversationManager();
