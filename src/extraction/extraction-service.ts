import type {
  ExtractionInput,
  ExtractionOutput,
  ExtractedWorkItem,
} from "./types";
import { workItemDatabase } from "../work-items/database";

export class ExtractionService {
  async extractWorkItems(input: ExtractionInput): Promise<ExtractionOutput> {
    const maxItems = input.maxItems ?? 10;

    const items: ExtractedWorkItem[] = [];

    const actionPatterns = [
      /(?:need to|should|must|have to|going to|will|please)\s+(.+)/gi,
      /(?:create|add|fix|update|implement|review|check|investigate|follow\s*up)\s+(.+)/gi,
      /(?:TODO|ACTION|DECISION|FOLLOW-UP)[:\s]+(.+)/gi,
    ];

    const lines = input.conversationText.split("\n");
    for (const line of lines) {
      for (const pattern of actionPatterns) {
        pattern.lastIndex = 0;
        const match = pattern.exec(line);
        if (match && items.length < maxItems) {
          items.push({
            type: "task",
            title: match[1].trim().substring(0, 100),
            description: line.trim(),
            priority: "medium",
            source: "chat",
          });
        }
      }
    }

    const seen = new Set<string>();
    const deduped = items.filter((item) => {
      const key = item.title.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return {
      items: deduped,
      confidence: deduped.length > 0 ? 0.7 : 0.2,
      reasoning:
        deduped.length > 0
          ? `Extracted ${deduped.length} work items from conversation`
          : "No clear action items found in conversation",
    };
  }

  async createExtractedItems(items: ExtractedWorkItem[]): Promise<string[]> {
    const createdIds: string[] = [];

    for (const item of items) {
      const created = workItemDatabase.createWorkItem({
        type: item.type,
        title: item.title,
        description: item.description,
        priority: item.priority,
        source: item.source,
        status: "proposed",
        tags: item.tags,
        dueAt: item.dueAt,
      });
      createdIds.push(created.id);
    }

    return createdIds;
  }
}

export const extractionService = new ExtractionService();
