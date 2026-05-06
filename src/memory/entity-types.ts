export const ENTITY_TYPES = [
  "person",
  "customer",
  "company",
  "project",
  "repo",
  "jira_issue",
  "gitlab_mr",
  "github_pr",
  "roadmap",
  "work_item",
  "decision",
  "preference",
  "system",
  "vendor",
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

export interface MemoryEntity {
  id: string;
  type: EntityType;
  name: string;
  normalizedName: string;
  summary: string;
  confidence: number;
  source: string;
  sourceId: string | null;
  sourceUrl: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  metadata: Record<string, unknown>;
}

export interface EntityFact {
  id: string;
  entityId: string;
  fact: string;
  source: string;
  sourceId: string | null;
  confidence: number;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
}

export interface EntityLink {
  id: string;
  fromEntityId: string;
  toEntityId: string;
  relation: string;
  confidence: number;
  source: string;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface EntityContext {
  entity: MemoryEntity;
  facts: EntityFact[];
  links: Array<{
    relation: string;
    direction: "outbound" | "inbound";
    entity: MemoryEntity;
    confidence: number;
  }>;
}

export interface UpsertEntityInput {
  type: EntityType;
  name: string;
  summary?: string;
  confidence?: number;
  source?: string;
  sourceId?: string;
  sourceUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface FindEntitiesQuery {
  query?: string;
  type?: EntityType;
  source?: string;
  minConfidence?: number;
  limit?: number;
}

export interface ExtractedEntities {
  entities: UpsertEntityInput[];
  facts: Array<{ entityName: string; entityType: EntityType; fact: string; source: string }>;
}
