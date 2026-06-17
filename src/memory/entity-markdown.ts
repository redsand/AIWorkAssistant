import fs from "fs";
import path from "path";
import os from "os";

/**
 * ENTITY.md per-person relationship files (Hermes-style relationship memory).
 *
 * `EntityMemory` (entity-memory.ts) is the structured SQLite source of truth.
 * This module is a human-readable, human-editable markdown *projection* of a
 * single entity, stored at `data/memories/entities/{entityId}.md`. It mirrors
 * the file-based pattern used by MEMORY.md / USER.md in agent-memory.ts.
 *
 * The markdown gives the agent fast "relationship memory" — e.g. that your boss
 * prefers Slack over email, that a client is in EST. Because the file is
 * editable, the `preferences` and `notes` sections are treated as
 * human-authored and are preserved across automated syncs from SQLite.
 */

export interface EntityMarkdownData {
  /** Who they are, role, company. */
  identity: string;
  /** Communication style, timezone, working hours. */
  preferences: string;
  /** Summary of past interactions. */
  interactionHistory: string;
  /** Decisions made with/about this entity. */
  keyDecisions: string;
  /** Free-form notes. */
  notes: string;
}

/** Snake-case section identifiers accepted by the memory.update_entity_md tool. */
export const ENTITY_SECTIONS = [
  "identity",
  "preferences",
  "interaction_history",
  "key_decisions",
  "notes",
] as const;

export type EntitySection = (typeof ENTITY_SECTIONS)[number];

/** Ordered (snake section → markdown heading → data field) mapping. */
const SECTION_MAP: ReadonlyArray<{
  section: EntitySection;
  heading: string;
  field: keyof EntityMarkdownData;
}> = [
  { section: "identity", heading: "Identity", field: "identity" },
  { section: "preferences", heading: "Preferences", field: "preferences" },
  { section: "interaction_history", heading: "Interaction History", field: "interactionHistory" },
  { section: "key_decisions", heading: "Key Decisions", field: "keyDecisions" },
  { section: "notes", heading: "Notes", field: "notes" },
];

const MAX_SECTION_CHARS = 4000;

function emptyData(): EntityMarkdownData {
  return {
    identity: "",
    preferences: "",
    interactionHistory: "",
    keyDecisions: "",
    notes: "",
  };
}

/** Strip control characters and normalize newlines to keep persisted markdown safe. */
function sanitize(input: string): string {
  return input
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/\r\n?/g, "\n")
    .trim();
}

export class EntityMarkdown {
  private basePath: string;

  constructor(basePath?: string) {
    this.basePath = basePath ?? EntityMarkdown.resolveBasePath();
    if (!fs.existsSync(this.basePath)) {
      fs.mkdirSync(this.basePath, { recursive: true });
    }
  }

  private static resolveBasePath(): string {
    if (process.env.ENTITY_MARKDOWN_PATH) {
      return process.env.ENTITY_MARKDOWN_PATH;
    }
    if (process.env.VITEST) {
      return path.join(
        os.tmpdir(),
        "ai-assist-tim-vitest-entity-markdown",
        `${process.env.VITEST_WORKER_ID || "worker"}-${process.pid}`,
      );
    }
    return path.join(process.cwd(), "data", "memories", "entities");
  }

  /** Map an arbitrary entity id (may contain '/', '#', '!') to a safe filename. */
  private safeFileName(entityId: string): string {
    const safe = entityId.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
    return (safe || "entity") + ".md";
  }

  getEntityMdPath(entityId: string): string {
    return path.join(this.basePath, this.safeFileName(entityId));
  }

  exists(entityId: string): boolean {
    return fs.existsSync(this.getEntityMdPath(entityId));
  }

  /** Render an ENTITY.md document. `name` falls back to the entity id for the header. */
  generateMarkdown(entityId: string, data: EntityMarkdownData, name?: string): string {
    const header = `# ENTITY: ${(name && name.trim()) || entityId}`;
    const parts: string[] = [header];
    for (const { heading, field } of SECTION_MAP) {
      parts.push("", `## ${heading}`, (data[field] ?? "").trim());
    }
    return parts.join("\n").trimEnd() + "\n";
  }

  writeEntityMd(entityId: string, data: EntityMarkdownData, name?: string): void {
    const sanitized: EntityMarkdownData = {
      identity: sanitize(data.identity ?? "").slice(0, MAX_SECTION_CHARS),
      preferences: sanitize(data.preferences ?? "").slice(0, MAX_SECTION_CHARS),
      interactionHistory: sanitize(data.interactionHistory ?? "").slice(0, MAX_SECTION_CHARS),
      keyDecisions: sanitize(data.keyDecisions ?? "").slice(0, MAX_SECTION_CHARS),
      notes: sanitize(data.notes ?? "").slice(0, MAX_SECTION_CHARS),
    };
    const content = this.generateMarkdown(entityId, sanitized, name);
    const filePath = this.getEntityMdPath(entityId);
    const tmpPath = filePath + ".tmp";
    fs.writeFileSync(tmpPath, content, "utf-8");
    fs.renameSync(tmpPath, filePath);
  }

  readEntityMd(entityId: string): EntityMarkdownData | null {
    const filePath = this.getEntityMdPath(entityId);
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, "utf-8");
    return this.parse(content);
  }

  /** Read the raw markdown content (header + sections), or null if missing. */
  readRaw(entityId: string): string | null {
    const filePath = this.getEntityMdPath(entityId);
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, "utf-8");
  }

  /** Parse the `# ENTITY: {name}` header back out, or null if absent. */
  readName(entityId: string): string | null {
    const raw = this.readRaw(entityId);
    if (!raw) return null;
    const m = raw.match(/^#\s*ENTITY:\s*(.+)$/m);
    return m ? m[1].trim() : null;
  }

  /** Update a single section, preserving the rest of the file (and the header name). */
  updateSection(entityId: string, section: string, content: string, name?: string): void {
    const target = SECTION_MAP.find((s) => s.section === section);
    if (!target) {
      throw new Error(
        `Unknown section '${section}'. Valid: ${ENTITY_SECTIONS.join(", ")}`,
      );
    }
    const existing = this.readEntityMd(entityId) ?? emptyData();
    existing[target.field] = content;
    const headerName = name ?? this.readName(entityId) ?? undefined;
    this.writeEntityMd(entityId, existing, headerName);
  }

  private parse(content: string): EntityMarkdownData {
    const data = emptyData();
    const lines = content.split("\n");
    let currentField: keyof EntityMarkdownData | null = null;
    let buffer: string[] = [];

    const flush = () => {
      if (currentField !== null) {
        data[currentField] = buffer.join("\n").trim();
      }
      buffer = [];
    };

    for (const line of lines) {
      const headingMatch = line.match(/^##\s+(.+?)\s*$/);
      if (headingMatch) {
        flush();
        const heading = headingMatch[1].trim().toLowerCase();
        const found = SECTION_MAP.find((s) => s.heading.toLowerCase() === heading);
        currentField = found ? found.field : null;
        continue;
      }
      if (line.startsWith("# ")) {
        // Document title (# ENTITY: ...) — not a section body.
        continue;
      }
      if (currentField !== null) {
        buffer.push(line);
      }
    }
    flush();
    return data;
  }
}

export const entityMarkdown = new EntityMarkdown();
