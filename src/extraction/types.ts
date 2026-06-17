export interface ExtractedWorkItem {
  type:
    | "task"
    | "decision"
    | "code_review"
    | "roadmap"
    | "customer_followup"
    | "detection"
    | "research"
    | "personal"
    | "support"
    | "release";
  title: string;
  description: string;
  priority: "low" | "medium" | "high" | "critical";
  source:
    | "chat"
    | "jira"
    | "github"
    | "gitlab"
    | "jitbit"
    | "calendar"
    | "manual"
    | "roadmap";
  tags?: string[];
  dueAt?: string;
}

export interface ExtractionInput {
  conversationText: string;
  context?: string;
  maxItems?: number;
}

export interface ExtractionOutput {
  items: ExtractedWorkItem[];
  confidence: number;
  reasoning: string;
}
