// Verifies knowledge-store splits oversized entries into heading-aware
// sub-chunks that reference the parent via parent_id (issue #228).
import { describe, it, expect, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Mock ClaimKit ingestion so we can assert exactly which entries get pushed to
// the claim store (parents only — sub-chunks must be excluded). The factory
// returns a vi.fn() resolving immediately; store() fires it and ignores the
// promise, so a no-op resolve is sufficient.
vi.mock("../../context-engine/claimkit-ingestion", () => ({
  ingestSingleKnowledgeEntry: vi.fn(async () => {}),
}));

import { knowledgeStore, KnowledgeStore } from "../knowledge-store";
import { env } from "../../config/env";
import { estimateTokens } from "../../context-engine/budget";
import { ingestSingleKnowledgeEntry } from "../../context-engine/claimkit-ingestion";

const createdIds: string[] = [];

afterEach(() => {
  for (const id of createdIds.splice(0)) {
    // Remove the parent and any sub-chunks it spawned.
    for (const e of knowledgeStore.getAllEntries()) {
      if (e.id === id || e.parentId === id) knowledgeStore.deleteEntry(e.id);
    }
  }
});

// Builds markdown content guaranteed to exceed 2x the configured chunk size.
// Sized by estimated tokens — the same unit store() uses for its split
// threshold — so the entry reliably triggers chunking regardless of
// CHARS_PER_TOKEN (a char-based target silently under-shoots if that constant
// changes).
function bigMarkdown(): string {
  const para = "This is filler content for a documentation section. ".repeat(20);
  const targetTokens = env.RAG_CHUNK_SIZE * 3; // comfortably above the 2x split threshold
  const sections: string[] = [];
  const assemble = () => `# Document Title\n${sections.join("\n")}`;
  let i = 0;
  while (estimateTokens(assemble()) < targetTokens) {
    sections.push(`## Section ${i}\n${para}\n`);
    i++;
  }
  return assemble();
}

// Builds markdown with an explicit number of headed sections so test cases can
// control how many sub-chunks an entry produces (more sections → more chunks).
function markdownWithSections(count: number): string {
  const para = "This is filler content for a documentation section. ".repeat(20);
  const sections: string[] = [];
  for (let i = 0; i < count; i++) {
    sections.push(`## Section ${i}\n${para}\n`);
  }
  return `# Document Title\n${sections.join("\n")}`;
}

describe("knowledgeStore.store — oversized entry chunking", () => {
  it("splits a large entry into parent-referencing sub-chunks", () => {
    const id = knowledgeStore.store({
      source: "web_page",
      title: "Large Doc",
      content: bigMarkdown(),
      tags: ["docs"],
      createdAt: new Date(),
    });
    createdIds.push(id);

    const children = knowledgeStore
      .getAllEntries()
      .filter((e) => e.parentId === id);

    expect(children.length).toBeGreaterThan(1);
    // Sub-chunks inherit the parent title with a part suffix.
    expect(children.every((c) => c.title.startsWith("Large Doc (part "))).toBe(true);
    // At least one sub-chunk carries a heading breadcrumb context header.
    expect(children.some((c) => c.content.includes("Section"))).toBe(true);
  });

  it("ingests only the parent into ClaimKit, never the sub-chunks", () => {
    const mockIngest = vi.mocked(ingestSingleKnowledgeEntry);
    mockIngest.mockClear();

    const id = knowledgeStore.store({
      source: "web_page",
      title: "Ingest Doc",
      content: bigMarkdown(),
      tags: ["docs"],
      createdAt: new Date(),
    });
    createdIds.push(id);

    // Sanity: this entry was large enough to produce sub-chunks.
    const children = knowledgeStore
      .getAllEntries()
      .filter((e) => e.parentId === id);
    expect(children.length).toBeGreaterThan(1);

    // ClaimKit ingestion is called exactly once — for the parent — and with
    // none of the `${id}-cN` sub-chunk ids.
    expect(mockIngest).toHaveBeenCalledTimes(1);
    expect(mockIngest.mock.calls[0][0].id).toBe(id);
    const ingestedIds = mockIngest.mock.calls.map((c) => c[0].id);
    expect(ingestedIds.some((iid) => iid.startsWith(`${id}-c`))).toBe(false);
  });

  it("does not return both a parent entry and its sub-chunks for one query", () => {
    const id = knowledgeStore.store({
      source: "web_page",
      title: "Dedup Doc",
      content: bigMarkdown(),
      tags: ["docs"],
      createdAt: new Date(),
    });
    createdIds.push(id);

    // "filler"/"documentation"/"section" appear in the parent's full content
    // and in every sub-chunk, so without dedup both would match this query.
    const results = knowledgeStore.search("filler documentation section", {
      limit: 50,
    });

    const roots = results.map((r) => r.entry.parentId ?? r.entry.id);
    // Each logical document (root id) surfaces at most once.
    expect(new Set(roots).size).toBe(roots.length);

    // Specifically, the parent and its own children never co-occur.
    const hasParent = results.some((r) => r.entry.id === id);
    const hasChild = results.some((r) => r.entry.parentId === id);
    expect(hasParent && hasChild).toBe(false);
  });

  it("does not split a small entry", () => {
    const id = knowledgeStore.store({
      source: "manual",
      title: "Tiny Note",
      content: "Just a short note with no need for chunking.",
      tags: [],
      createdAt: new Date(),
    });
    createdIds.push(id);

    const children = knowledgeStore
      .getAllEntries()
      .filter((e) => e.parentId === id);
    expect(children.length).toBe(0);
  });

  it("removes stale sub-chunks when re-storing an entry with fewer chunks", () => {
    const stableId = "kn-test-restore-fewer";
    knowledgeStore.store({
      id: stableId,
      source: "web_page",
      title: "Versioned Doc",
      content: markdownWithSections(12),
      tags: ["docs"],
      createdAt: new Date(),
    });
    createdIds.push(stableId);

    const firstChildren = knowledgeStore
      .getAllEntries()
      .filter((e) => e.parentId === stableId);
    expect(firstChildren.length).toBeGreaterThan(1);

    // Re-store the same id with smaller content that yields fewer chunks.
    knowledgeStore.store({
      id: stableId,
      source: "web_page",
      title: "Versioned Doc",
      content: markdownWithSections(4),
      tags: ["docs"],
      createdAt: new Date(),
    });

    const secondChildren = knowledgeStore
      .getAllEntries()
      .filter((e) => e.parentId === stableId);

    // The new (smaller) version has strictly fewer sub-chunks...
    expect(secondChildren.length).toBeGreaterThan(0);
    expect(secondChildren.length).toBeLessThan(firstChildren.length);

    // ...and none of the extra children from the first version are orphaned.
    const liveIds = new Set(
      knowledgeStore.getAllEntries().map((e) => e.id),
    );
    const survivingIndex = secondChildren.length;
    for (const child of firstChildren) {
      if (!secondChildren.some((c) => c.id === child.id)) {
        expect(liveIds.has(child.id)).toBe(false);
      }
    }
    // Sub-chunk ids are dense (`<parent>-c0..cN`); none above the new count remain.
    expect(liveIds.has(`${stableId}-c${survivingIndex}`)).toBe(false);
  });

  it("removes all sub-chunks when a re-store drops below the split threshold", () => {
    const stableId = "kn-test-restore-shrink";
    knowledgeStore.store({
      id: stableId,
      source: "web_page",
      title: "Shrinking Doc",
      content: markdownWithSections(12),
      tags: [],
      createdAt: new Date(),
    });
    createdIds.push(stableId);

    expect(
      knowledgeStore.getAllEntries().filter((e) => e.parentId === stableId)
        .length,
    ).toBeGreaterThan(1);

    // Re-store the same id with content too small to need chunking at all.
    knowledgeStore.store({
      id: stableId,
      source: "web_page",
      title: "Shrinking Doc",
      content: "Now just a tiny note that needs no chunking.",
      tags: [],
      createdAt: new Date(),
    });

    expect(
      knowledgeStore.getAllEntries().filter((e) => e.parentId === stableId)
        .length,
    ).toBe(0);
  });
});

describe("KnowledgeStore — parent_id schema migration", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("adds the parent_id column to a pre-existing database that lacks it", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-mig-"));
    const dbPath = path.join(tmpDir, "knowledge.db");

    // Seed an "old" database: the knowledge table predates the parent_id column.
    const seed = new Database(dbPath);
    seed.exec(`
      CREATE TABLE knowledge (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        url TEXT,
        file_path TEXT,
        tags TEXT DEFAULT '[]',
        session_id TEXT,
        keywords TEXT DEFAULT '[]',
        created_at TEXT NOT NULL,
        accessed_at TEXT NOT NULL,
        access_count INTEGER DEFAULT 0
      );
    `);
    seed
      .prepare(
        `INSERT INTO knowledge (id, source, title, content, created_at, accessed_at)
         VALUES ('legacy-1', 'manual', 'Legacy', 'old content', '2020-01-01', '2020-01-01')`,
      )
      .run();
    seed.close();

    // Constructing the store against the legacy DB must migrate it in place.
    const store = new KnowledgeStore(dbPath);

    const check = new Database(dbPath);
    const cols = check.prepare(`PRAGMA table_info(knowledge)`).all() as {
      name: string;
    }[];
    check.close();
    expect(cols.some((c) => c.name === "parent_id")).toBe(true);

    // The pre-existing row survives the migration and is still retrievable.
    const legacy = store.getAllEntries().find((e) => e.id === "legacy-1");
    expect(legacy).toBeDefined();
    expect(legacy?.parentId).toBeUndefined();

    // And the migrated DB supports storing new chunked entries end to end.
    store.store({
      id: "migrated-parent",
      source: "web_page",
      title: "Post-migration Doc",
      content: markdownWithSections(8),
      tags: [],
      createdAt: new Date(),
    });
    const children = store
      .getAllEntries()
      .filter((e) => e.parentId === "migrated-parent");
    expect(children.length).toBeGreaterThan(1);

    store.close();
  });
});
