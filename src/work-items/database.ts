import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import fs from "fs";
import { applyWalHygiene } from "../util/sqlite-hygiene";
import type {
  WorkItem,
  WorkItemCreateParams,
  WorkItemUpdateParams,
  WorkItemListFilters,
  WorkItemListResult,
  WorkItemStats,
  WorkItemNote,
} from "./types";

const DATA_DIR = path.join(process.cwd(), "data");
const DEFAULT_DB_PATH = path.join(DATA_DIR, "work-items.db");

class WorkItemDatabase {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const dbFile = dbPath ?? DEFAULT_DB_PATH;
    const dir = path.dirname(dbFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbFile);
    applyWalHygiene(this.db, { label: "work-items" });
    this.initSchema();
  }

  private initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS work_items (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'proposed',
        priority TEXT NOT NULL DEFAULT 'medium',
        owner TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'manual',
        source_url TEXT,
        source_external_id TEXT,
        due_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        archived INTEGER NOT NULL DEFAULT 0,
        tags_json TEXT,
        linked_resources_json TEXT,
        notes_json TEXT,
        metadata_json TEXT
      );
    `);

    // Run migrations before creating indexes so the archived column exists
    this.runMigrations();

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_work_items_status ON work_items(status);
      CREATE INDEX IF NOT EXISTS idx_work_items_type ON work_items(type);
      CREATE INDEX IF NOT EXISTS idx_work_items_priority ON work_items(priority);
      CREATE INDEX IF NOT EXISTS idx_work_items_source ON work_items(source);
      CREATE INDEX IF NOT EXISTS idx_work_items_owner ON work_items(owner);
      CREATE INDEX IF NOT EXISTS idx_work_items_due_at ON work_items(due_at);
      CREATE INDEX IF NOT EXISTS idx_work_items_created_at ON work_items(created_at);
      CREATE INDEX IF NOT EXISTS idx_work_items_archived ON work_items(archived);
    `);
  }

  private runMigrations() {
    // Migration: add archived column if it doesn't exist (for existing databases)
    const hasArchivedColumn = this.db
      .prepare(
        "SELECT COUNT(*) as cnt FROM pragma_table_info('work_items') WHERE name = 'archived'",
      )
      .get() as { cnt: number };

    if (hasArchivedColumn.cnt === 0) {
      this.db.exec("ALTER TABLE work_items ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
    }

    // Migration: set archived=1 for existing items with status 'archived' or 'done'
    const unarchivedDoneCount = (
      this.db
        .prepare(
          "SELECT COUNT(*) as cnt FROM work_items WHERE archived = 0 AND (status = 'archived' OR status = 'done')",
        )
        .get() as { cnt: number }
    ).cnt;

    if (unarchivedDoneCount > 0) {
      this.db.exec(
        "UPDATE work_items SET archived = 1 WHERE archived = 0 AND (status = 'archived' OR status = 'done')",
      );
    }
  }

  createWorkItem(params: WorkItemCreateParams): WorkItem {
    const id = uuidv4();
    const now = new Date().toISOString();
    const status = params.status ?? "proposed";
    const isTerminal = status === "done" || status === "archived";
    const item: WorkItem = {
      id,
      type: params.type,
      title: params.title,
      description: params.description ?? "",
      status,
      priority: params.priority ?? "medium",
      owner: params.owner ?? "",
      source: params.source ?? "manual",
      sourceUrl: params.sourceUrl ?? null,
      sourceExternalId: params.sourceExternalId ?? null,
      dueAt: params.dueAt ?? null,
      createdAt: now,
      updatedAt: now,
      completedAt: status === "done" ? now : null,
      archived: isTerminal,
      tagsJson: params.tags ? JSON.stringify(params.tags) : null,
      linkedResourcesJson: params.linkedResources
        ? JSON.stringify(params.linkedResources)
        : null,
      notesJson: null,
      metadataJson: params.metadata ? JSON.stringify(params.metadata) : null,
    };

    this.db
      .prepare(
        `INSERT INTO work_items (id, type, title, description, status, priority, owner, source, source_url, source_external_id, due_at, created_at, updated_at, completed_at, archived, tags_json, linked_resources_json, notes_json, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        item.id,
        item.type,
        item.title,
        item.description,
        item.status,
        item.priority,
        item.owner,
        item.source,
        item.sourceUrl,
        item.sourceExternalId,
        item.dueAt,
        item.createdAt,
        item.updatedAt,
        item.completedAt,
        item.archived ? 1 : 0,
        item.tagsJson,
        item.linkedResourcesJson,
        item.notesJson,
        item.metadataJson,
      );

    return item;
  }

  updateWorkItem(id: string, patch: WorkItemUpdateParams): WorkItem | null {
    const existing = this.getWorkItem(id);
    if (!existing) return null;

    const now = new Date().toISOString();
    const updates: string[] = [];
    const values: unknown[] = [];

    if (patch.status !== undefined) {
      updates.push("status = ?");
      values.push(patch.status);
      // Auto-archive when status is set to done, un-archive when set to anything else
      if (patch.status === "done") {
        updates.push("archived = 1");
        if (!existing.completedAt) {
          updates.push("completed_at = ?");
          values.push(now);
        }
      } else if (existing.archived) {
        updates.push("archived = 0");
      }
    }

    const fieldMap: Record<string, unknown> = {
      type: patch.type,
      title: patch.title,
      description: patch.description,
      priority: patch.priority,
      owner: patch.owner,
      source: patch.source,
      source_url: patch.sourceUrl,
      source_external_id: patch.sourceExternalId,
      due_at: patch.dueAt,
      tags_json: patch.tags ? JSON.stringify(patch.tags) : undefined,
      linked_resources_json: patch.linkedResources
        ? JSON.stringify(patch.linkedResources)
        : undefined,
      metadata_json: patch.metadata ? JSON.stringify(patch.metadata) : undefined,
    };

    for (const [col, val] of Object.entries(fieldMap)) {
      if (val !== undefined) {
        updates.push(`${col} = ?`);
        values.push(val);
      }
    }

    if (updates.length === 0) return existing;

    updates.push("updated_at = ?");
    values.push(now);
    values.push(id);

    this.db
      .prepare(`UPDATE work_items SET ${updates.join(", ")} WHERE id = ?`)
      .run(...values);
    return this.getWorkItem(id);
  }

  getWorkItem(id: string): WorkItem | null {
    const row = this.db
      .prepare("SELECT * FROM work_items WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  listWorkItems(filters?: WorkItemListFilters): WorkItemListResult {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters?.status) {
      conditions.push("status = ?");
      params.push(filters.status);
    }
    if (filters?.type) {
      conditions.push("type = ?");
      params.push(filters.type);
    }
    if (filters?.priority) {
      conditions.push("priority = ?");
      params.push(filters.priority);
    }
    if (filters?.source) {
      conditions.push("source = ?");
      params.push(filters.source);
    }
    if (filters?.owner) {
      conditions.push("owner = ?");
      params.push(filters.owner);
    }
    if (filters?.search) {
      conditions.push("(title LIKE ? OR description LIKE ?)");
      params.push(`%${filters.search}%`, `%${filters.search}%`);
    }
    if (!filters?.includeArchived && filters?.status !== "done" && filters?.status !== "archived") {
      conditions.push("archived = 0");
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = filters?.limit ?? 50;
    const offset = filters?.offset ?? 0;

    const countRow = this.db
      .prepare(`SELECT COUNT(*) as total FROM work_items ${whereClause}`)
      .get(...params) as { total: number };

    const rows = this.db
      .prepare(
        `SELECT * FROM work_items ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as Record<string, unknown>[];

    return {
      items: rows.map((r) => this.mapRow(r)),
      total: countRow.total,
    };
  }

  addNote(id: string, author: string, content: string): WorkItem | null {
    const item = this.getWorkItem(id);
    if (!item) return null;

    const notes: WorkItemNote[] = item.notesJson
      ? JSON.parse(item.notesJson)
      : [];
    notes.push({
      id: uuidv4(),
      author,
      content,
      createdAt: new Date().toISOString(),
    });

    this.db
      .prepare(
        "UPDATE work_items SET notes_json = ?, updated_at = ? WHERE id = ?",
      )
      .run(JSON.stringify(notes), new Date().toISOString(), id);
    return this.getWorkItem(id);
  }

  addLinkedResource(
    id: string,
    resource: { type: string; url: string; label: string },
  ): WorkItem | null {
    const item = this.getWorkItem(id);
    if (!item) return null;

    const resources = item.linkedResourcesJson
      ? JSON.parse(item.linkedResourcesJson)
      : [];
    resources.push(resource);

    this.db
      .prepare(
        "UPDATE work_items SET linked_resources_json = ?, updated_at = ? WHERE id = ?",
      )
      .run(JSON.stringify(resources), new Date().toISOString(), id);
    return this.getWorkItem(id);
  }

  completeWorkItem(id: string): WorkItem | null {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE work_items SET status = 'done', archived = 1, completed_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(now, now, id);
    return this.getWorkItem(id);
  }

  archiveWorkItem(id: string): WorkItem | null {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE work_items SET archived = 1, updated_at = ? WHERE id = ?",
      )
      .run(now, id);
    return this.getWorkItem(id);
  }

  findByTicketSource(source: string, externalId: string): WorkItem | null {
    const row = this.db
      .prepare(
        "SELECT * FROM work_items WHERE source = ? AND source_external_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(source, externalId) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  getStats(): WorkItemStats {
    const totalRow = this.db
      .prepare("SELECT COUNT(*) as count FROM work_items WHERE archived = 0")
      .get() as { count: number };

    const overdueRow = this.db
      .prepare(
        "SELECT COUNT(*) as count FROM work_items WHERE due_at < ? AND archived = 0 AND status != 'done'",
      )
      .get(new Date().toISOString()) as { count: number };

    const byStatus = Object.fromEntries(
      (
        this.db
          .prepare(
            "SELECT status, COUNT(*) as count FROM work_items WHERE archived = 0 GROUP BY status",
          )
          .all() as { status: string; count: number }[]
      ).map((r) => [r.status, r.count]),
    );
    const byType = Object.fromEntries(
      (
        this.db
          .prepare(
            "SELECT type, COUNT(*) as count FROM work_items WHERE archived = 0 GROUP BY type",
          )
          .all() as { type: string; count: number }[]
      ).map((r) => [r.type, r.count]),
    );
    const byPriority = Object.fromEntries(
      (
        this.db
          .prepare(
            "SELECT priority, COUNT(*) as count FROM work_items WHERE archived = 0 GROUP BY priority",
          )
          .all() as { priority: string; count: number }[]
      ).map((r) => [r.priority, r.count]),
    );

    return {
      totalItems: totalRow.count,
      byStatus,
      byType,
      byPriority,
      overdue: overdueRow.count,
    };
  }

  private mapRow(row: Record<string, unknown>): WorkItem {
    return {
      id: row.id as string,
      type: row.type as WorkItem["type"],
      title: row.title as string,
      description: row.description as string,
      status: row.status as WorkItem["status"],
      priority: row.priority as WorkItem["priority"],
      owner: row.owner as string,
      source: row.source as WorkItem["source"],
      sourceUrl: row.source_url as string | null,
      sourceExternalId: row.source_external_id as string | null,
      dueAt: row.due_at as string | null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      completedAt: row.completed_at as string | null,
      archived: row.archived === 1 || row.archived === true,
      tagsJson: row.tags_json as string | null,
      linkedResourcesJson: row.linked_resources_json as string | null,
      notesJson: row.notes_json as string | null,
      metadataJson: row.metadata_json as string | null,
    };
  }

  close(): void {
    this.db.close();
  }
}

export { WorkItemDatabase };
export const workItemDatabase = new WorkItemDatabase();
