import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import fs from "fs";
import type {
  MemoryEntity,
  EntityFact,
  EntityLink,
  EntityContext,
  UpsertEntityInput,
  FindEntitiesQuery,
  ExtractedEntities,
  EntityType,
} from "./entity-types";

const DATA_DIR = path.join(process.cwd(), "data");
const DEFAULT_DB_PATH = path.join(DATA_DIR, "entity-memory.db");

class EntityMemory {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const dbFile = dbPath ?? DEFAULT_DB_PATH;
    const dir = path.dirname(dbFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(dbFile);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.initSchema();
  }

  private initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_entities (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        confidence REAL NOT NULL DEFAULT 1.0,
        source TEXT NOT NULL DEFAULT 'manual',
        source_id TEXT,
        source_url TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        metadata_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_entities_type ON memory_entities(type);
      CREATE INDEX IF NOT EXISTS idx_entities_normalized_name ON memory_entities(normalized_name);
      CREATE INDEX IF NOT EXISTS idx_entities_source ON memory_entities(source);
      CREATE INDEX IF NOT EXISTS idx_entities_last_seen ON memory_entities(last_seen_at);

      CREATE TABLE IF NOT EXISTS memory_entity_facts (
        id TEXT PRIMARY KEY,
        entity_id TEXT NOT NULL REFERENCES memory_entities(id) ON DELETE CASCADE,
        fact TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'manual',
        source_id TEXT,
        confidence REAL NOT NULL DEFAULT 1.0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        metadata_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_facts_entity_id ON memory_entity_facts(entity_id);

      CREATE TABLE IF NOT EXISTS memory_entity_links (
        id TEXT PRIMARY KEY,
        from_entity_id TEXT NOT NULL REFERENCES memory_entities(id) ON DELETE CASCADE,
        to_entity_id TEXT NOT NULL REFERENCES memory_entities(id) ON DELETE CASCADE,
        relation TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 1.0,
        source TEXT NOT NULL DEFAULT 'manual',
        created_at TEXT NOT NULL,
        metadata_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_links_from ON memory_entity_links(from_entity_id);
      CREATE INDEX IF NOT EXISTS idx_links_to ON memory_entity_links(to_entity_id);
    `);
  }

  // ── Core entity operations ────────────────────────────────────────────────

  upsertEntity(input: UpsertEntityInput): MemoryEntity {
    const normalized = this.normalize(input.name);
    const now = new Date().toISOString();

    const existing = this.db
      .prepare("SELECT * FROM memory_entities WHERE type = ? AND normalized_name = ?")
      .get(input.type, normalized) as Record<string, unknown> | undefined;

    if (existing) {
      this.db.prepare(`
        UPDATE memory_entities
        SET summary = CASE WHEN ? != '' THEN ? ELSE summary END,
            confidence = MAX(confidence, ?),
            source_id = COALESCE(?, source_id),
            source_url = COALESCE(?, source_url),
            last_seen_at = ?,
            metadata_json = COALESCE(?, metadata_json)
        WHERE id = ?
      `).run(
        input.summary ?? "", input.summary ?? "",
        input.confidence ?? 1.0,
        input.sourceId ?? null,
        input.sourceUrl ?? null,
        now,
        input.metadata ? JSON.stringify(input.metadata) : null,
        existing.id as string,
      );
      return this.getEntity(existing.id as string)!;
    }

    const id = uuidv4();
    this.db.prepare(`
      INSERT INTO memory_entities
        (id, type, name, normalized_name, summary, confidence, source, source_id, source_url, first_seen_at, last_seen_at, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.type,
      input.name,
      normalized,
      input.summary ?? "",
      input.confidence ?? 1.0,
      input.source ?? "manual",
      input.sourceId ?? null,
      input.sourceUrl ?? null,
      now,
      now,
      input.metadata ? JSON.stringify(input.metadata) : null,
    );
    return this.getEntity(id)!;
  }

  getEntity(id: string): MemoryEntity | null {
    const row = this.db
      .prepare("SELECT * FROM memory_entities WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapEntity(row) : null;
  }

  getEntityByName(type: EntityType, name: string): MemoryEntity | null {
    const row = this.db
      .prepare("SELECT * FROM memory_entities WHERE type = ? AND normalized_name = ?")
      .get(type, this.normalize(name)) as Record<string, unknown> | undefined;
    return row ? this.mapEntity(row) : null;
  }

  findEntities(query: FindEntitiesQuery): MemoryEntity[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (query.type) {
      conditions.push("type = ?");
      params.push(query.type);
    }
    if (query.source) {
      conditions.push("source = ?");
      params.push(query.source);
    }
    if (query.minConfidence !== undefined) {
      conditions.push("confidence >= ?");
      params.push(query.minConfidence);
    }
    if (query.query) {
      conditions.push("(normalized_name LIKE ? OR summary LIKE ? OR name LIKE ?)");
      const q = `%${query.query.toLowerCase()}%`;
      params.push(q, q, q);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = query.limit ?? 20;

    const rows = this.db
      .prepare(`SELECT * FROM memory_entities ${where} ORDER BY last_seen_at DESC LIMIT ?`)
      .all(...params, limit) as Record<string, unknown>[];

    return rows.map((r) => this.mapEntity(r));
  }

  listRecentEntities(limit = 20): MemoryEntity[] {
    const rows = this.db
      .prepare("SELECT * FROM memory_entities ORDER BY last_seen_at DESC LIMIT ?")
      .all(limit) as Record<string, unknown>[];
    return rows.map((r) => this.mapEntity(r));
  }

  // ── Facts ─────────────────────────────────────────────────────────────────

  addFact(
    entityId: string,
    fact: string,
    options: { source?: string; sourceId?: string; confidence?: number; metadata?: Record<string, unknown> } = {},
  ): EntityFact {
    const now = new Date().toISOString();
    const normalizedFact = fact.trim();

    // Deduplicate: exact same fact text for same entity
    const existing = this.db
      .prepare("SELECT * FROM memory_entity_facts WHERE entity_id = ? AND fact = ?")
      .get(entityId, normalizedFact) as Record<string, unknown> | undefined;

    if (existing) {
      this.db.prepare("UPDATE memory_entity_facts SET updated_at = ?, confidence = MAX(confidence, ?) WHERE id = ?")
        .run(now, options.confidence ?? 1.0, existing.id);
      return this.mapFact(this.db.prepare("SELECT * FROM memory_entity_facts WHERE id = ?").get(existing.id) as Record<string, unknown>);
    }

    const id = uuidv4();
    this.db.prepare(`
      INSERT INTO memory_entity_facts (id, entity_id, fact, source, source_id, confidence, created_at, updated_at, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, entityId, normalizedFact,
      options.source ?? "manual",
      options.sourceId ?? null,
      options.confidence ?? 1.0,
      now, now,
      options.metadata ? JSON.stringify(options.metadata) : null,
    );

    // Bump entity last_seen
    this.db.prepare("UPDATE memory_entities SET last_seen_at = ? WHERE id = ?").run(now, entityId);

    return this.mapFact(this.db.prepare("SELECT * FROM memory_entity_facts WHERE id = ?").get(id) as Record<string, unknown>);
  }

  getEntityFacts(entityId: string): EntityFact[] {
    const rows = this.db
      .prepare("SELECT * FROM memory_entity_facts WHERE entity_id = ? ORDER BY created_at DESC")
      .all(entityId) as Record<string, unknown>[];
    return rows.map((r) => this.mapFact(r));
  }

  // ── Links ─────────────────────────────────────────────────────────────────

  linkEntities(
    fromId: string,
    toId: string,
    relation: string,
    options: { source?: string; confidence?: number; metadata?: Record<string, unknown> } = {},
  ): EntityLink {
    const now = new Date().toISOString();

    const existing = this.db
      .prepare("SELECT * FROM memory_entity_links WHERE from_entity_id = ? AND to_entity_id = ? AND relation = ?")
      .get(fromId, toId, relation) as Record<string, unknown> | undefined;

    if (existing) {
      this.db.prepare("UPDATE memory_entity_links SET confidence = MAX(confidence, ?) WHERE id = ?")
        .run(options.confidence ?? 1.0, existing.id);
      return this.mapLink(this.db.prepare("SELECT * FROM memory_entity_links WHERE id = ?").get(existing.id) as Record<string, unknown>);
    }

    const id = uuidv4();
    this.db.prepare(`
      INSERT INTO memory_entity_links (id, from_entity_id, to_entity_id, relation, confidence, source, created_at, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, fromId, toId, relation,
      options.confidence ?? 1.0,
      options.source ?? "manual",
      now,
      options.metadata ? JSON.stringify(options.metadata) : null,
    );
    return this.mapLink(this.db.prepare("SELECT * FROM memory_entity_links WHERE id = ?").get(id) as Record<string, unknown>);
  }

  // ── Rich context ──────────────────────────────────────────────────────────

  getEntityContext(type: EntityType, name: string): EntityContext | null {
    const entity = this.getEntityByName(type, name);
    if (!entity) return null;

    const facts = this.getEntityFacts(entity.id);

    const outboundRows = this.db
      .prepare(`
        SELECT l.relation, l.confidence, e.*
        FROM memory_entity_links l
        JOIN memory_entities e ON e.id = l.to_entity_id
        WHERE l.from_entity_id = ?
      `)
      .all(entity.id) as Record<string, unknown>[];

    const inboundRows = this.db
      .prepare(`
        SELECT l.relation, l.confidence, e.*
        FROM memory_entity_links l
        JOIN memory_entities e ON e.id = l.from_entity_id
        WHERE l.to_entity_id = ?
      `)
      .all(entity.id) as Record<string, unknown>[];

    const links = [
      ...outboundRows.map((r) => ({
        relation: r.relation as string,
        direction: "outbound" as const,
        entity: this.mapEntity(r),
        confidence: r.confidence as number,
      })),
      ...inboundRows.map((r) => ({
        relation: r.relation as string,
        direction: "inbound" as const,
        entity: this.mapEntity(r),
        confidence: r.confidence as number,
      })),
    ];

    return { entity, facts, links };
  }

  // ── Merge ─────────────────────────────────────────────────────────────────

  mergeEntities(sourceId: string, targetId: string): MemoryEntity | null {
    const source = this.getEntity(sourceId);
    const target = this.getEntity(targetId);
    if (!source || !target) return null;

    const merge = this.db.transaction(() => {
      // Move facts to target
      this.db.prepare("UPDATE memory_entity_facts SET entity_id = ? WHERE entity_id = ?")
        .run(targetId, sourceId);
      // Move links
      this.db.prepare("UPDATE memory_entity_links SET from_entity_id = ? WHERE from_entity_id = ?")
        .run(targetId, sourceId);
      this.db.prepare("UPDATE memory_entity_links SET to_entity_id = ? WHERE to_entity_id = ?")
        .run(targetId, sourceId);
      // Merge summary if target has none
      if (!target.summary && source.summary) {
        this.db.prepare("UPDATE memory_entities SET summary = ? WHERE id = ?")
          .run(source.summary, targetId);
      }
      // Update confidence to max
      this.db.prepare("UPDATE memory_entities SET confidence = MAX(confidence, ?) WHERE id = ?")
        .run(source.confidence, targetId);
      // Delete source
      this.db.prepare("DELETE FROM memory_entities WHERE id = ?").run(sourceId);
    });

    merge();
    return this.getEntity(targetId);
  }

  // ── Heuristic extractors ──────────────────────────────────────────────────

  extractFromText(text: string, source = "conversation"): ExtractedEntities {
    const entities: ExtractedEntities["entities"] = [];
    const facts: ExtractedEntities["facts"] = [];

    // Jira issue keys: PROJ-123
    const jiraKeys = text.match(/\b([A-Z][A-Z0-9]+-\d+)\b/g) ?? [];
    for (const key of [...new Set(jiraKeys)]) {
      entities.push({ type: "jira_issue", name: key, source, confidence: 0.9 });
    }

    // GitHub PRs: github.com/org/repo/pull/123 or #123 near "PR"
    const ghPrUrls = text.match(/github\.com\/[^/\s]+\/([^/\s]+)\/pull\/(\d+)/g) ?? [];
    for (const url of [...new Set(ghPrUrls)]) {
      const m = url.match(/github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/);
      if (m) {
        entities.push({ type: "github_pr", name: `${m[1]}#${m[2]}`, source, sourceUrl: `https://${url}`, confidence: 0.95 });
        entities.push({ type: "repo", name: m[1], source, sourceUrl: `https://github.com/${url.split("/")[1]}/${m[1]}`, confidence: 0.9 });
      }
    }

    // GitLab MRs: gitlab.com/org/repo/-/merge_requests/123
    const glMrUrls = text.match(/gitlab\.com\/[^/\s]+\/([^/\s]+)\/-\/merge_requests\/(\d+)/g) ?? [];
    for (const url of [...new Set(glMrUrls)]) {
      const m = url.match(/gitlab\.com\/[^/]+\/([^/]+)\/-\/merge_requests\/(\d+)/);
      if (m) {
        entities.push({ type: "gitlab_mr", name: `${m[1]}!${m[2]}`, source, sourceUrl: `https://${url}`, confidence: 0.95 });
        entities.push({ type: "repo", name: m[1], source, confidence: 0.9 });
      }
    }

    // Bare repo names from GitHub/GitLab URLs
    const repoUrls = text.match(/(?:github|gitlab)\.com\/[^/\s]+\/([^/\s#?]+)/g) ?? [];
    for (const url of [...new Set(repoUrls)]) {
      const m = url.match(/(?:github|gitlab)\.com\/[^/]+\/([^/\s#?]+)/);
      if (m) {
        entities.push({ type: "repo", name: m[1].replace(/\.git$/, ""), source, confidence: 0.85 });
      }
    }

    // Preferences: "I prefer X", "always X", "never X", "do not X", "don't X"
    const prefPatterns = [
      /I (?:prefer|want|like|always|never) ([^.!?\n]{5,80})/gi,
      /(?:Do not|Don't|Never|Always) ([^.!?\n]{5,80})/gi,
      /(?:please|remember(?: to)?|make sure(?: to)?) ([^.!?\n]{5,80})/gi,
    ];
    for (const pattern of prefPatterns) {
      const matches = [...text.matchAll(pattern)];
      for (const m of matches) {
        const prefText = m[0].trim();
        entities.push({ type: "preference", name: "user_preference", source, confidence: 0.8 });
        facts.push({ entityName: "user_preference", entityType: "preference", fact: prefText, source });
      }
    }

    return { entities, facts };
  }

  /** Extract customer/company entity from a Jitbit-derived customer name. */
  extractCustomerEntity(name: string, options: { companyId?: string | number; url?: string } = {}): MemoryEntity {
    return this.upsertEntity({
      type: "company",
      name,
      source: "jitbit",
      sourceId: options.companyId ? String(options.companyId) : undefined,
      sourceUrl: options.url,
      confidence: 0.95,
    });
  }

  /** Extract and store entities from free text, returning the upserted entities. */
  extractAndStore(text: string, source = "conversation"): MemoryEntity[] {
    const { entities, facts } = this.extractFromText(text, source);
    const stored: MemoryEntity[] = [];

    for (const input of entities) {
      const entity = this.upsertEntity(input);
      if (!stored.find((e) => e.id === entity.id)) stored.push(entity);
    }

    for (const f of facts) {
      const entity = stored.find(
        (e) => this.normalize(e.name) === this.normalize(f.entityName) && e.type === f.entityType,
      ) ?? this.getEntityByName(f.entityType, f.entityName);
      if (entity) {
        this.addFact(entity.id, f.fact, { source: f.source, confidence: 0.8 });
      }
    }

    return stored;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private normalize(name: string): string {
    return name.toLowerCase().trim().replace(/\s+/g, " ");
  }

  private mapEntity(row: Record<string, unknown>): MemoryEntity {
    return {
      id: row.id as string,
      type: row.type as EntityType,
      name: row.name as string,
      normalizedName: row.normalized_name as string,
      summary: row.summary as string,
      confidence: row.confidence as number,
      source: row.source as string,
      sourceId: row.source_id as string | null,
      sourceUrl: row.source_url as string | null,
      firstSeenAt: row.first_seen_at as string,
      lastSeenAt: row.last_seen_at as string,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json as string) : {},
    };
  }

  private mapFact(row: Record<string, unknown>): EntityFact {
    return {
      id: row.id as string,
      entityId: row.entity_id as string,
      fact: row.fact as string,
      source: row.source as string,
      sourceId: row.source_id as string | null,
      confidence: row.confidence as number,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json as string) : {},
    };
  }

  private mapLink(row: Record<string, unknown>): EntityLink {
    return {
      id: row.id as string,
      fromEntityId: row.from_entity_id as string,
      toEntityId: row.to_entity_id as string,
      relation: row.relation as string,
      confidence: row.confidence as number,
      source: row.source as string,
      createdAt: row.created_at as string,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json as string) : {},
    };
  }

  close(): void {
    this.db.close();
  }
}

export { EntityMemory };
export const entityMemory = new EntityMemory();
