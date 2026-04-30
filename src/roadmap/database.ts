/**
 * Roadmap Database Manager
 * Handles all database operations for roadmap management
 */

import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';

const DB_PATH = path.join(process.cwd(), 'data', 'roadmap.db');

export interface Roadmap {
  id: string;
  name: string;
  type: 'client' | 'internal';
  status: 'draft' | 'active' | 'completed' | 'archived';
  startDate: string;
  endDate: string | null;
  jiraProjectKey: string | null;
  jiraProjectId: string | null;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  metadata: string | null; // JSON string for additional data
}

export interface Milestone {
  id: string;
  roadmapId: string;
  name: string;
  description: string | null;
  targetDate: string;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
  order: number;
  jiraEpicKey: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RoadmapItem {
  id: string;
  milestoneId: string;
  title: string;
  description: string | null;
  type: 'feature' | 'task' | 'bug' | 'technical_debt' | 'research';
  status: 'todo' | 'in_progress' | 'done' | 'blocked';
  priority: 'low' | 'medium' | 'high' | 'critical';
  estimatedHours: number | null;
  actualHours: number | null;
  assignee: string | null;
  jiraKey: string | null;
  order: number;
  createdAt: string;
  updatedAt: string;
}

export interface RoadmapTemplate {
  id: string;
  name: string;
  description: string;
  type: 'client' | 'internal';
  category: 'onboarding' | 'project_delivery' | 'maintenance' | 'internal_improvement';
  milestones: string; // JSON array of template milestones
  items: string; // JSON array of template items
  createdAt: string;
  updatedAt: string;
}

class RoadmapDatabase {
  private db: Database.Database;

  constructor() {
    this.db = new Database(DB_PATH);
    this.initializeSchema();
  }

  private initializeSchema() {
    // Enable foreign keys
    this.db.pragma('foreign_keys = ON');

    // Roadmaps table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS roadmaps (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('client', 'internal')),
        status TEXT NOT NULL CHECK(status IN ('draft', 'active', 'completed', 'archived')),
        start_date TEXT NOT NULL,
        end_date TEXT,
        jira_project_key TEXT,
        jira_project_id TEXT,
        description TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        metadata TEXT
      );
    `);

    // Milestones table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS milestones (
        id TEXT PRIMARY KEY,
        roadmap_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        target_date TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'in_progress', 'completed', 'blocked')),
        order_index INTEGER NOT NULL,
        jira_epic_key TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (roadmap_id) REFERENCES roadmaps(id) ON DELETE CASCADE
      );
    `);

    // Roadmap items table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS roadmap_items (
        id TEXT PRIMARY KEY,
        milestone_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        type TEXT NOT NULL CHECK(type IN ('feature', 'task', 'bug', 'technical_debt', 'research')),
        status TEXT NOT NULL CHECK(status IN ('todo', 'in_progress', 'done', 'blocked')),
        priority TEXT NOT NULL CHECK(priority IN ('low', 'medium', 'high', 'critical')),
        estimated_hours REAL,
        actual_hours REAL,
        assignee TEXT,
        jira_key TEXT,
        order_index INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (milestone_id) REFERENCES milestones(id) ON DELETE CASCADE
      );
    `);

    // Templates table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS roadmap_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('client', 'internal')),
        category TEXT NOT NULL CHECK(category IN ('onboarding', 'project_delivery', 'maintenance', 'internal_improvement')),
        milestones TEXT NOT NULL,
        items TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    // Create indexes for performance
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_roadmaps_type ON roadmaps(type);
      CREATE INDEX IF NOT EXISTS idx_roadmaps_status ON roadmaps(status);
      CREATE INDEX IF NOT EXISTS idx_milestones_roadmap_id ON milestones(roadmap_id);
      CREATE INDEX IF NOT EXISTS idx_roadmap_items_milestone_id ON roadmap_items(milestone_id);
      CREATE INDEX IF NOT EXISTS idx_roadmap_items_status ON roadmap_items(status);
      CREATE INDEX IF NOT EXISTS idx_roadmap_items_priority ON roadmap_items(priority);
    `);

    console.log('[RoadmapDB] Database schema initialized');
  }

  // Roadmap CRUD operations
  createRoadmap(roadmap: Omit<Roadmap, 'id' | 'createdAt' | 'updatedAt'>): Roadmap {
    const id = uuidv4();
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO roadmaps (
        id, name, type, status, start_date, end_date,
        jira_project_key, jira_project_id, description,
        created_at, updated_at, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      roadmap.name,
      roadmap.type,
      roadmap.status,
      roadmap.startDate,
      roadmap.endDate,
      roadmap.jiraProjectKey,
      roadmap.jiraProjectId,
      roadmap.description,
      now,
      now,
      roadmap.metadata
    );

    return {
      id,
      ...roadmap,
      createdAt: now,
      updatedAt: now,
    };
  }

  getRoadmap(id: string): Roadmap | null {
    const stmt = this.db.prepare('SELECT * FROM roadmaps WHERE id = ?');
    const row = stmt.get(id) as any;

    if (!row) return null;

    return this.mapRoadmapRow(row);
  }

  listRoadmaps(filters?: { type?: 'client' | 'internal'; status?: string }): Roadmap[] {
    let query = 'SELECT * FROM roadmaps WHERE 1=1';
    const params: any[] = [];

    if (filters?.type) {
      query += ' AND type = ?';
      params.push(filters.type);
    }

    if (filters?.status) {
      query += ' AND status = ?';
      params.push(filters.status);
    }

    query += ' ORDER BY created_at DESC';

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as any[];

    return rows.map(row => this.mapRoadmapRow(row));
  }

  updateRoadmap(id: string, updates: Partial<Omit<Roadmap, 'id' | 'createdAt' | 'updatedAt'>>): Roadmap | null {
    const current = this.getRoadmap(id);
    if (!current) return null;

    const fields: string[] = [];
    const params: any[] = [];

    Object.entries(updates).forEach(([key, value]) => {
      if (value !== undefined) {
        const dbKey = this.camelToSnake(key);
        fields.push(`${dbKey} = ?`);
        params.push(value);
      }
    });

    if (fields.length === 0) return current;

    fields.push('updated_at = ?');
    params.push(new Date().toISOString());
    params.push(id);

    const stmt = this.db.prepare(`UPDATE roadmaps SET ${fields.join(', ')} WHERE id = ?`);
    stmt.run(...params);

    return this.getRoadmap(id);
  }

  deleteRoadmap(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM roadmaps WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  // Milestone CRUD operations
  createMilestone(milestone: Omit<Milestone, 'id' | 'createdAt' | 'updatedAt'>): Milestone {
    const id = uuidv4();
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO milestones (
        id, roadmap_id, name, description, target_date, status,
        order_index, jira_epic_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      milestone.roadmapId,
      milestone.name,
      milestone.description,
      milestone.targetDate,
      milestone.status,
      milestone.order,
      milestone.jiraEpicKey,
      now,
      now
    );

    return {
      id,
      ...milestone,
      createdAt: now,
      updatedAt: now,
    };
  }

  getMilestones(roadmapId: string): Milestone[] {
    const stmt = this.db.prepare(`
      SELECT * FROM milestones
      WHERE roadmap_id = ?
      ORDER BY order_index ASC
    `);

    const rows = stmt.all(roadmapId) as any[];
    return rows.map(row => this.mapMilestoneRow(row));
  }

  updateMilestone(id: string, updates: Partial<Omit<Milestone, 'id' | 'createdAt' | 'updatedAt'>>): Milestone | null {
    const current = this.getMilestone(id);
    if (!current) return null;

    const fields: string[] = [];
    const params: any[] = [];

    Object.entries(updates).forEach(([key, value]) => {
      if (value !== undefined) {
        const dbKey = this.camelToSnake(key);
        fields.push(`${dbKey} = ?`);
        params.push(value);
      }
    });

    if (fields.length === 0) return current;

    fields.push('updated_at = ?');
    params.push(new Date().toISOString());
    params.push(id);

    const stmt = this.db.prepare(`UPDATE milestones SET ${fields.join(', ')} WHERE id = ?`);
    stmt.run(...params);

    return this.getMilestone(id);
  }

  deleteMilestone(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM milestones WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  private getMilestone(id: string): Milestone | null {
    const stmt = this.db.prepare('SELECT * FROM milestones WHERE id = ?');
    const row = stmt.get(id) as any;
    if (!row) return null;
    return this.mapMilestoneRow(row);
  }

  // Roadmap item CRUD operations
  createItem(item: Omit<RoadmapItem, 'id' | 'createdAt' | 'updatedAt'>): RoadmapItem {
    const id = uuidv4();
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO roadmap_items (
        id, milestone_id, title, description, type, status,
        priority, estimated_hours, actual_hours, assignee,
        jira_key, order_index, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      item.milestoneId,
      item.title,
      item.description,
      item.type,
      item.status,
      item.priority,
      item.estimatedHours,
      item.actualHours,
      item.assignee,
      item.jiraKey,
      item.order,
      now,
      now
    );

    return {
      id,
      ...item,
      createdAt: now,
      updatedAt: now,
    };
  }

  getItems(milestoneId: string): RoadmapItem[] {
    const stmt = this.db.prepare(`
      SELECT * FROM roadmap_items
      WHERE milestone_id = ?
      ORDER BY order_index ASC
    `);

    const rows = stmt.all(milestoneId) as any[];
    return rows.map(row => this.mapItemRow(row));
  }

  updateItem(id: string, updates: Partial<Omit<RoadmapItem, 'id' | 'createdAt' | 'updatedAt'>>): RoadmapItem | null {
    const current = this.getItem(id);
    if (!current) return null;

    const fields: string[] = [];
    const params: any[] = [];

    Object.entries(updates).forEach(([key, value]) => {
      if (value !== undefined) {
        const dbKey = this.camelToSnake(key);
        fields.push(`${dbKey} = ?`);
        params.push(value);
      }
    });

    if (fields.length === 0) return current;

    fields.push('updated_at = ?');
    params.push(new Date().toISOString());
    params.push(id);

    const stmt = this.db.prepare(`UPDATE roadmap_items SET ${fields.join(', ')} WHERE id = ?`);
    stmt.run(...params);

    return this.getItem(id);
  }

  deleteItem(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM roadmap_items WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  private getItem(id: string): RoadmapItem | null {
    const stmt = this.db.prepare('SELECT * FROM roadmap_items WHERE id = ?');
    const row = stmt.get(id) as any;
    if (!row) return null;
    return this.mapItemRow(row);
  }

  // Template operations
  createTemplate(template: Omit<RoadmapTemplate, 'id' | 'createdAt' | 'updatedAt'>): RoadmapTemplate {
    const id = uuidv4();
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO roadmap_templates (
        id, name, description, type, category, milestones, items, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      template.name,
      template.description,
      template.type,
      template.category,
      template.milestones,
      template.items,
      now,
      now
    );

    return {
      id,
      ...template,
      createdAt: now,
      updatedAt: now,
    };
  }

  getTemplate(id: string): RoadmapTemplate | null {
    const stmt = this.db.prepare('SELECT * FROM roadmap_templates WHERE id = ?');
    const row = stmt.get(id) as any;
    if (!row) return null;
    return this.mapTemplateRow(row);
  }

  listTemplates(filters?: { type?: 'client' | 'internal'; category?: string }): RoadmapTemplate[] {
    let query = 'SELECT * FROM roadmap_templates WHERE 1=1';
    const params: any[] = [];

    if (filters?.type) {
      query += ' AND type = ?';
      params.push(filters.type);
    }

    if (filters?.category) {
      query += ' AND category = ?';
      params.push(filters.category);
    }

    query += ' ORDER BY created_at DESC';

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as any[];

    return rows.map(row => this.mapTemplateRow(row));
  }

  deleteTemplate(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM roadmap_templates WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  // Helper functions
  private mapRoadmapRow(row: any): Roadmap {
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      status: row.status,
      startDate: row.start_date,
      endDate: row.end_date,
      jiraProjectKey: row.jira_project_key,
      jiraProjectId: row.jira_project_id,
      description: row.description,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      metadata: row.metadata,
    };
  }

  private mapMilestoneRow(row: any): Milestone {
    return {
      id: row.id,
      roadmapId: row.roadmap_id,
      name: row.name,
      description: row.description,
      targetDate: row.target_date,
      status: row.status,
      order: row.order_index,
      jiraEpicKey: row.jira_epic_key,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapItemRow(row: any): RoadmapItem {
    return {
      id: row.id,
      milestoneId: row.milestone_id,
      title: row.title,
      description: row.description,
      type: row.type,
      status: row.status,
      priority: row.priority,
      estimatedHours: row.estimated_hours,
      actualHours: row.actual_hours,
      assignee: row.assignee,
      jiraKey: row.jira_key,
      order: row.order_index,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapTemplateRow(row: any): RoadmapTemplate {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      type: row.type,
      category: row.category,
      milestones: row.milestones,
      items: row.items,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private camelToSnake(str: string): string {
    return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
  }

  close() {
    this.db.close();
  }
}

export const roadmapDatabase = new RoadmapDatabase();
