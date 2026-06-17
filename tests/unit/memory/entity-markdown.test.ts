import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EntityMarkdown } from "../../../src/memory/entity-markdown";
import { EntityMemory } from "../../../src/memory/entity-memory";

describe("EntityMarkdown", () => {
  let dir: string;
  let md: EntityMarkdown;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "entity-md-"));
    md = new EntityMarkdown(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const sampleData = () => ({
    identity: "Jane Doe, VP Eng at ACME",
    preferences: "Prefers Slack over email. Timezone: EST.",
    interactionHistory: "- Kicked off project Falcon\n- Reviewed Q2 roadmap",
    keyDecisions: "- Approved migration to v3",
    notes: "Out on PTO next week.",
  });

  it("generates markdown with the ENTITY header and all sections", () => {
    const out = md.generateMarkdown("ent-1", sampleData(), "Jane Doe");
    expect(out).toContain("# ENTITY: Jane Doe");
    expect(out).toContain("## Identity");
    expect(out).toContain("Jane Doe, VP Eng at ACME");
    expect(out).toContain("## Preferences");
    expect(out).toContain("## Interaction History");
    expect(out).toContain("## Key Decisions");
    expect(out).toContain("## Notes");
  });

  it("falls back to the entity id in the header when no name is provided", () => {
    const out = md.generateMarkdown("ent-99", sampleData());
    expect(out).toContain("# ENTITY: ent-99");
  });

  it("writes and reads back the same data (round trip)", () => {
    md.writeEntityMd("ent-1", sampleData(), "Jane Doe");
    const read = md.readEntityMd("ent-1");
    expect(read).not.toBeNull();
    expect(read).toEqual(sampleData());
    expect(md.readName("ent-1")).toBe("Jane Doe");
  });

  it("stores files under data/memories/entities/{entityId}.md convention", () => {
    md.writeEntityMd("ent-1", sampleData(), "Jane Doe");
    expect(existsSync(path.join(dir, "ent-1.md"))).toBe(true);
  });

  it("returns null when reading a non-existent entity", () => {
    expect(md.readEntityMd("nope")).toBeNull();
    expect(md.readRaw("nope")).toBeNull();
    expect(md.readName("nope")).toBeNull();
    expect(md.exists("nope")).toBe(false);
  });

  it("sanitizes entity ids with slashes/hashes into safe filenames", () => {
    md.writeEntityMd("acme/widgets#42", sampleData(), "acme/widgets#42");
    expect(md.exists("acme/widgets#42")).toBe(true);
    const read = md.readEntityMd("acme/widgets#42");
    expect(read?.identity).toBe(sampleData().identity);
    // No raw slash or hash in the file name.
    const filePath = md.getEntityMdPath("acme/widgets#42");
    expect(path.basename(filePath)).not.toContain("/");
    expect(path.basename(filePath)).not.toContain("#");
  });

  it("updates a single section, preserving the others and the header name", () => {
    md.writeEntityMd("ent-1", sampleData(), "Jane Doe");
    md.updateSection("ent-1", "preferences", "Now prefers email; timezone PST.");
    const read = md.readEntityMd("ent-1")!;
    expect(read.preferences).toBe("Now prefers email; timezone PST.");
    // Other sections untouched.
    expect(read.identity).toBe(sampleData().identity);
    expect(read.keyDecisions).toBe(sampleData().keyDecisions);
    // Header name preserved.
    expect(md.readName("ent-1")).toBe("Jane Doe");
  });

  it("maps snake_case section names to the right field", () => {
    md.updateSection("ent-2", "interaction_history", "- First call");
    md.updateSection("ent-2", "key_decisions", "- Signed contract");
    const read = md.readEntityMd("ent-2")!;
    expect(read.interactionHistory).toBe("- First call");
    expect(read.keyDecisions).toBe("- Signed contract");
  });

  it("rejects unknown section names", () => {
    expect(() => md.updateSection("ent-1", "bogus", "x")).toThrow(/Unknown section/);
  });

  it("strips control characters from persisted content", () => {
    md.writeEntityMd(
      "ent-3",
      { ...sampleData(), notes: "line1\x00\x07line2" },
      "ctrl",
    );
    const raw = readFileSync(md.getEntityMdPath("ent-3"), "utf-8");
    expect(raw).not.toContain("\x00");
    expect(raw).not.toContain("\x07");
  });
});

describe("EntityMemory.syncToMarkdown", () => {
  let dbDir: string;
  let mdDir: string;
  let memory: EntityMemory;
  let md: EntityMarkdown;

  beforeEach(() => {
    dbDir = mkdtempSync(path.join(tmpdir(), "entity-db-"));
    mdDir = mkdtempSync(path.join(tmpdir(), "entity-sync-md-"));
    md = new EntityMarkdown(mdDir);
    memory = new EntityMemory(path.join(dbDir, "test.db"), md);
  });

  afterEach(() => {
    memory.close();
    rmSync(dbDir, { recursive: true, force: true });
    rmSync(mdDir, { recursive: true, force: true });
  });

  it("projects an upserted entity into an ENTITY.md file", () => {
    const entity = memory.upsertEntity({
      type: "person",
      name: "Boss Person",
      summary: "Engineering manager",
    });
    const read = md.readEntityMd(entity.id);
    expect(read).not.toBeNull();
    expect(read!.identity).toContain("Boss Person (person)");
    expect(read!.identity).toContain("Engineering manager");
    expect(md.readName(entity.id)).toBe("Boss Person");
  });

  it("includes free-text facts in interaction history", () => {
    const entity = memory.upsertEntity({ type: "person", name: "Teammate" });
    memory.addFact(entity.id, "Working on the auth rewrite");
    const read = md.readEntityMd(entity.id)!;
    expect(read.interactionHistory).toContain("Working on the auth rewrite");
  });

  it("includes current structured claims in key decisions", () => {
    const entity = memory.upsertEntity({ type: "jira_issue", name: "IR-82" });
    memory.setStructuredFact(entity.id, "status", "In Progress");
    const read = md.readEntityMd(entity.id)!;
    expect(read.keyDecisions).toContain("status: In Progress");
  });

  it("preserves human-authored preferences and notes across syncs", () => {
    const entity = memory.upsertEntity({ type: "person", name: "Client" });
    md.updateSection(entity.id, "preferences", "Prefers phone calls.", "Client");
    // Trigger another sync via a fact.
    memory.addFact(entity.id, "Asked about pricing");
    const read = md.readEntityMd(entity.id)!;
    expect(read.preferences).toBe("Prefers phone calls.");
    expect(read.interactionHistory).toContain("Asked about pricing");
  });
});
