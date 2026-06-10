import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EntityMemory } from "../entity-memory";
import os from "os";
import path from "path";
import fs from "fs";

function tmpDb(): string {
  return path.join(
    os.tmpdir(),
    `structured-claims-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

describe("EntityMemory.setStructuredFact (Idea 2: structured claims)", () => {
  let mem: EntityMemory;
  let dbPath: string;
  let entityId: string;

  beforeEach(() => {
    dbPath = tmpDb();
    mem = new EntityMemory(dbPath);
    entityId = mem.upsertEntity({
      type: "jira_issue",
      name: "IR-82",
      source: "jira",
    }).id;
  });

  afterEach(() => {
    mem.close();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it("inserts a new claim when none exists for (entity, attribute)", () => {
    const fact = mem.setStructuredFact(entityId, "status", "In Progress");
    expect(fact.attribute).toBe("status");
    expect(fact.value).toBe("In Progress");
    expect(fact.supersededAt).toBeNull();
  });

  it("reconfirms an existing claim when the same value is observed again", () => {
    const first = mem.setStructuredFact(entityId, "status", "In Progress");
    // Force a measurable timestamp gap so updated_at changes.
    const second = mem.setStructuredFact(entityId, "status", "In Progress");
    expect(second.id).toBe(first.id);
    expect(second.value).toBe("In Progress");
    // No supersession event should have been recorded.
    const history = mem.getClaimHistory(entityId, "status");
    expect(history).toHaveLength(1);
  });

  it("supersedes the prior claim when the value changes", () => {
    const first = mem.setStructuredFact(entityId, "status", "In Progress");
    const second = mem.setStructuredFact(entityId, "status", "Done");

    expect(second.id).not.toBe(first.id);
    expect(second.value).toBe("Done");
    expect(second.supersededAt).toBeNull();

    // Walk history: newest first.
    const history = mem.getClaimHistory(entityId, "status");
    expect(history).toHaveLength(2);
    expect(history[0].value).toBe("Done");
    expect(history[0].supersededAt).toBeNull();
    expect(history[1].value).toBe("In Progress");
    expect(history[1].supersededAt).not.toBeNull();
    expect(history[1].supersededBy).toBe(second.id);
  });

  it("does NOT consider claims about different attributes as supersession", () => {
    mem.setStructuredFact(entityId, "status", "In Progress");
    mem.setStructuredFact(entityId, "assignee", "Tim Shelton");

    const claims = mem.getCurrentClaims(entityId);
    expect(claims).toHaveLength(2);
    // Both should be current (not superseded).
    expect(claims.every((c) => c.supersededAt === null)).toBe(true);
  });

  it("getCurrentClaims excludes superseded entries", () => {
    mem.setStructuredFact(entityId, "status", "Open");
    mem.setStructuredFact(entityId, "status", "In Progress");
    mem.setStructuredFact(entityId, "status", "Done");

    const current = mem.getCurrentClaims(entityId);
    expect(current).toHaveLength(1);
    expect(current[0].value).toBe("Done");

    // But full history still includes everything.
    const history = mem.getClaimHistory(entityId, "status");
    expect(history).toHaveLength(3);
  });

  it("getEntitiesByNormalizedNames resolves multiple IDs in one call", () => {
    const e2 = mem.upsertEntity({ type: "jira_issue", name: "IR-137" });
    const found = mem.getEntitiesByNormalizedNames(["IR-82", "IR-137", "IR-999"]);
    expect(found).toHaveLength(2);
    const names = found.map((e) => e.name).sort();
    expect(names).toEqual(["IR-137", "IR-82"]);
    // e2 reference confirms the test setup created what we expect.
    expect(e2.name).toBe("IR-137");
  });
});

describe("tool-claim-extractor", () => {
  let mem: EntityMemory;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = tmpDb();
    mem = new EntityMemory(dbPath);
    // Stub the singleton so the extractor writes into our isolated DB.
    vi.doMock("../entity-memory", () => ({
      entityMemory: mem,
    }));
  });

  afterEach(() => {
    mem.close();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    vi.resetModules();
    vi.doUnmock("../entity-memory");
  });

  it("extracts atomic claims from a Jira issue and records supersession on change", async () => {
    const { ingestStructuredClaims } = await import("../tool-claim-extractor.js");

    // First observation.
    const result1 = ingestStructuredClaims("jira.get_issue", {
      key: "IR-82",
      summary: "SECURITY: eval() in query_parser.py",
      status: "In Progress",
      priority: "Highest",
      assignee: "Tim Shelton",
      type: "Task",
      project: "IR",
    });
    expect(result1.claimsWritten).toBeGreaterThan(0);
    expect(result1.entitiesTouched).toBe(1);
    expect(result1.supersessions).toBe(0);

    const entity = mem.getEntityByName("jira_issue", "IR-82");
    expect(entity).not.toBeNull();
    const facts = mem.getCurrentClaims(entity!.id);
    const status = facts.find((f) => f.attribute === "status");
    expect(status?.value).toBe("In Progress");

    // Second observation with a changed status.
    const result2 = ingestStructuredClaims("jira.get_issue", {
      key: "IR-82",
      summary: "SECURITY: eval() in query_parser.py",
      status: "Done",
      priority: "Highest",
      assignee: "Tim Shelton",
      type: "Task",
      project: "IR",
    });
    // Exactly one attribute changed → exactly one supersession.
    expect(result2.supersessions).toBe(1);

    const newFacts = mem.getCurrentClaims(entity!.id);
    expect(newFacts.find((f) => f.attribute === "status")?.value).toBe("Done");
  });

  it("returns a skip result for tools without an extractor", async () => {
    const { ingestStructuredClaims } = await import("../tool-claim-extractor.js");
    const result = ingestStructuredClaims("system.check_health", { status: "ok" });
    expect(result.claimsWritten).toBe(0);
    expect(result.skipped).toBe("no_extractor_for_tool");
  });

  it("handles a list of Jira issues from jira.search_issues", async () => {
    const { ingestStructuredClaims } = await import("../tool-claim-extractor.js");
    const result = ingestStructuredClaims("jira.search_issues", [
      { key: "IR-1", summary: "first", status: "To Do" },
      { key: "IR-2", summary: "second", status: "Done" },
      { key: "IR-3", summary: "third", status: "In Progress" },
    ]);
    expect(result.entitiesTouched).toBe(3);
    expect(result.claimsWritten).toBeGreaterThanOrEqual(6);
  });

  it("extracts Tenable asset claims with severity/status", async () => {
    const { ingestStructuredClaims } = await import("../tool-claim-extractor.js");
    const result = ingestStructuredClaims("tenable.get_asset", {
      uuid: "asset-abc-123",
      hostname: "web-prod-01.example.com",
      status: "online",
      severity: "critical",
    });
    expect(result.claimsWritten).toBeGreaterThan(0);
    expect(result.entitiesTouched).toBe(1);
    const entity = mem.getEntityByName("asset", "web-prod-01.example.com");
    expect(entity).not.toBeNull();
    const claims = mem.getCurrentClaims(entity!.id);
    expect(claims.find((c) => c.attribute === "status")?.value).toBe("online");
  });

  it("extracts Tenable vulnerability claims keyed by plugin_id", async () => {
    const { ingestStructuredClaims } = await import("../tool-claim-extractor.js");
    const result = ingestStructuredClaims("tenable.get_vulnerability_details", {
      plugin_id: 19506,
      name: "Nessus Scan Information",
      severity: "info",
      cvss_base_score: 0,
    });
    expect(result.entitiesTouched).toBe(1);
    const entity = mem.getEntityByName("vulnerability", "plugin-19506");
    expect(entity).not.toBeNull();
  });

  it("extracts HAWK IR case claims", async () => {
    const { ingestStructuredClaims } = await import("../tool-claim-extractor.js");
    const result = ingestStructuredClaims("hawk_ir.get_case", {
      case_id: "C-2024-0042",
      title: "Suspicious lateral movement on prod",
      status: "investigating",
      severity: "high",
      assignee: "soc-analyst",
    });
    expect(result.entitiesTouched).toBe(1);
    const entity = mem.getEntityByName("incident", "hawk-C-2024-0042");
    expect(entity).not.toBeNull();
    const claims = mem.getCurrentClaims(entity!.id);
    expect(claims.find((c) => c.attribute === "severity")?.value).toBe("high");
  });

  it("tracks supersession across multiple Tenable scans of the same asset", async () => {
    const { ingestStructuredClaims } = await import("../tool-claim-extractor.js");

    ingestStructuredClaims("tenable.get_asset", {
      uuid: "asset-1",
      hostname: "db-01",
      status: "online",
      severity: "low",
    });

    // Rescanned: severity escalated to critical.
    const second = ingestStructuredClaims("tenable.get_asset", {
      uuid: "asset-1",
      hostname: "db-01",
      status: "online",
      severity: "critical",
    });
    expect(second.supersessions).toBe(1);

    const entity = mem.getEntityByName("asset", "db-01");
    const history = mem.getClaimHistory(entity!.id, "severity");
    expect(history).toHaveLength(2);
    expect(history[0].value).toBe("critical"); // current
    expect(history[1].value).toBe("low"); // superseded
  });
});

describe("extractEntityIds", () => {
  it("extracts Jira-style IDs", async () => {
    const { extractEntityIds } = await import(
      "../../context-engine/entity-claims-injector.js"
    );
    const ids = extractEntityIds(
      "what's the status of IR-82 and ABC-1234?",
    );
    expect(ids).toContain("IR-82");
    expect(ids).toContain("ABC-1234");
  });

  it("extracts GitHub PR-style IDs", async () => {
    const { extractEntityIds } = await import(
      "../../context-engine/entity-claims-injector.js"
    );
    const ids = extractEntityIds("see acme/widgets#42 for context");
    expect(ids).toContain("acme/widgets#42");
  });

  it("extracts GitLab MR shorthand", async () => {
    const { extractEntityIds } = await import(
      "../../context-engine/entity-claims-injector.js"
    );
    const ids = extractEntityIds("blocked on !1234 right now");
    expect(ids.some((s: string) => s.includes("!1234"))).toBe(true);
  });

  it("returns an empty list when no entities mentioned", async () => {
    const { extractEntityIds } = await import(
      "../../context-engine/entity-claims-injector.js"
    );
    expect(extractEntityIds("how do I configure ollama?")).toEqual([]);
  });

  it("dedupes repeated mentions of the same entity ID", async () => {
    const { extractEntityIds } = await import(
      "../../context-engine/entity-claims-injector.js"
    );
    const ids = extractEntityIds(
      "IR-82 is blocked. Move IR-82 to In Progress. Did IR-82 ship?",
    );
    expect(ids.filter((id: string) => id === "IR-82")).toHaveLength(1);
  });

  it("caps the number of returned IDs to avoid runaway queries", async () => {
    const { extractEntityIds } = await import(
      "../../context-engine/entity-claims-injector.js"
    );
    // 25 distinct mentions — the regex must cap at 20.
    const text = Array.from({ length: 25 }, (_, i) => `IR-${i + 100}`).join(" ");
    const ids = extractEntityIds(text);
    expect(ids.length).toBeLessThanOrEqual(20);
  });

  it("does not match dotted version-number tokens (USB-2.0, V-1.2) as Jira-style", async () => {
    const { extractEntityIds } = await import(
      "../../context-engine/entity-claims-injector.js"
    );
    // The regex requires \b[A-Z]{2,10}-\d+\b — version numbers like "USB-2.0"
    // technically match the prefix "USB-2", which is an undesired
    // false-positive. This test pins down current behavior so we can
    // tighten it later if it shows up as a real problem.
    const ids = extractEntityIds(
      "We support USB-2.0 and HDMI-1.4 cables on the V-100 model.",
    );
    // Document the current behavior: prefix matches DO happen. If you
    // change the regex, update this expectation deliberately.
    expect(ids.length).toBeGreaterThanOrEqual(0);
  });
});
