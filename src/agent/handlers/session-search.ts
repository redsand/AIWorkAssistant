import type { ConversationManager } from "../../memory/conversation-manager";

export interface SessionSearchHandlerResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

export function createSessionSearchHandler(manager: ConversationManager) {
  return async function handleSessionSearch(
    params: Record<string, unknown>,
  ): Promise<SessionSearchHandlerResult> {
    const query = typeof params.query === "string" ? params.query.trim() : "";
    if (!query) {
      return { success: false, error: "query is required" };
    }

    const limit = typeof params.limit === "number" ? params.limit : 5;
    const results = manager.searchSessions(query, limit);

    const formatted = results.map((r) => ({
      sessionId: r.sessionId,
      title: r.title,
      summary: r.summary.substring(0, 300),
      keyTopics: r.keyTopics,
      relevanceScore: Math.round(r.relevanceScore * 100) / 100,
    }));

    return {
      success: true,
      data: {
        query,
        totalResults: results.length,
        results: formatted,
      },
    };
  };
}
