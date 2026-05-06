import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EntityMemory } from "../entity-memory";
import os from "os";
import path from "path";
import fs from "fs";

function tmpDb(): string {
  return path.join(os.tmpdir(), `entity-memory-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe("EntityMemory", () => {
  let mem: EntityMemory;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDb();
    mem = new EntityMemory(dbPath);
  });

  afterEach(() => {
    mem.close();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  // ── Upsert ──────────────────────────────────────────────────────────────

  it("creates a new entity", () => {
    const entity = mem.upsertEntity({ type: "company", name: "ACME Corp", source: "jitbit" });
    expect(entity.id).toBeTruthy();
    expect(entity.type).toBe("company");
    expect(entity.name).toBe("ACME Corp");
    expect(entity.normalizedName).toBe("acme corp");
  });

  it("upserts an existing entity without duplicating", () => {
    mem.upsertEntity({ type: "company", name: "ACME Corp", summary: "First" });
    const second = mem.upsertEntity({ type: "company", name: "ACME Corp", summary: "Updated" });
    const all = mem.findEntities({ type: "company" });
    expect(all).toHaveLength(1);
    expect(second.summary).toBe("Updated");
  });

  it("normalizes names for deduplication (case-insensitive)", () => {
    mem.upsertEntity({ type: "company", name: "ACME" });
    mem.upsertEntity({ type: "company", name: "acme" });
    mem.upsertEntity({ type: "company", name: "  ACME  " });
    expect(mem.findEntities({ type: "company" })).toHaveLength(1);
  });

  it("does not merge entities of different types", () => {
    mem.upsertEntity({ type: "company", name: "Hawk" });
    mem.upsertEntity({ type: "repo", name: "Hawk" });
    expect(mem.findEntities({})).toHaveLength(2);
  });

  // ── Get ──────────────────────────────────────────────────────────────────

  it("getEntity returns null for unknown id", () => {
    expect(mem.getEntity("non-existent")).toBeNull();
  });

  it("getEntityByName finds by type and name", () => {
    mem.upsertEntity({ type: "repo", name: "hawk-soar-cloud-v3" });
    const found = mem.getEntityByName("repo", "hawk-soar-cloud-v3");
    expect(found).not.toBeNull();
    expect(found!.type).toBe("repo");
  });

  // ── Facts ─────────────────────────────────────────────────────────────────

  it("adds a fact to an entity", () => {
    const entity = mem.upsertEntity({ type: "customer", name: "Globex" });
    const fact = mem.addFact(entity.id, "Primary contact is Alice Smith");
    expect(fact.entityId).toBe(entity.id);
    expect(fact.fact).toBe("Primary contact is Alice Smith");
  });

  it("deduplicates identical facts", () => {
    const entity = mem.upsertEntity({ type: "customer", name: "Globex" });
    mem.addFact(entity.id, "Uses enterprise tier");
    mem.addFact(entity.id, "Uses enterprise tier");
    expect(mem.getEntityFacts(entity.id)).toHaveLength(1);
  });

  it("stores multiple distinct facts", () => {
    const entity = mem.upsertEntity({ type: "customer", name: "Globex" });
    mem.addFact(entity.id, "Fact one");
    mem.addFact(entity.id, "Fact two");
    mem.addFact(entity.id, "Fact three");
    expect(mem.getEntityFacts(entity.id)).toHaveLength(3);
  });

  // ── Links ─────────────────────────────────────────────────────────────────

  it("links two entities", () => {
    const a = mem.upsertEntity({ type: "person", name: "Alice" });
    const b = mem.upsertEntity({ type: "company", name: "Globex" });
    const link = mem.linkEntities(a.id, b.id, "works_at");
    expect(link.fromEntityId).toBe(a.id);
    expect(link.toEntityId).toBe(b.id);
    expect(link.relation).toBe("works_at");
  });

  it("deduplicates links with same from/to/relation", () => {
    const a = mem.upsertEntity({ type: "person", name: "Alice" });
    const b = mem.upsertEntity({ type: "company", name: "Globex" });
    mem.linkEntities(a.id, b.id, "works_at");
    mem.linkEntities(a.id, b.id, "works_at");
    const context = mem.getEntityContext("person", "Alice");
    expect(context!.links).toHaveLength(1);
  });

  // ── Context ───────────────────────────────────────────────────────────────

  it("getEntityContext returns entity, facts, and links", () => {
    const customer = mem.upsertEntity({ type: "customer", name: "ACME" });
    const person = mem.upsertEntity({ type: "person", name: "Bob" });
    mem.addFact(customer.id, "On a 3-year enterprise contract");
    mem.addFact(customer.id, "Has 200 seats");
    mem.linkEntities(person.id, customer.id, "account_manager_for");

    const ctx = mem.getEntityContext("customer", "ACME");
    expect(ctx).not.toBeNull();
    expect(ctx!.facts).toHaveLength(2);
    expect(ctx!.links).toHaveLength(1);
    expect(ctx!.links[0].direction).toBe("inbound");
    expect(ctx!.links[0].entity.name).toBe("Bob");
  });

  it("getEntityContext returns null for unknown entity", () => {
    expect(mem.getEntityContext("customer", "Unknown Co")).toBeNull();
  });

  // ── Merge ─────────────────────────────────────────────────────────────────

  it("mergeEntities moves facts and deletes source", () => {
    const a = mem.upsertEntity({ type: "company", name: "Globex Inc" });
    const b = mem.upsertEntity({ type: "company", name: "Globex" });
    mem.addFact(a.id, "Fact from A");
    mem.mergeEntities(a.id, b.id);

    expect(mem.getEntity(a.id)).toBeNull();
    const factsOfB = mem.getEntityFacts(b.id);
    expect(factsOfB.some((f) => f.fact === "Fact from A")).toBe(true);
  });

  // ── Search ────────────────────────────────────────────────────────────────

  it("findEntities filters by type", () => {
    mem.upsertEntity({ type: "company", name: "Globex" });
    mem.upsertEntity({ type: "repo", name: "globex-api" });
    const companies = mem.findEntities({ type: "company" });
    expect(companies).toHaveLength(1);
    expect(companies[0].type).toBe("company");
  });

  it("findEntities searches by query text", () => {
    mem.upsertEntity({ type: "company", name: "ACME Corp" });
    mem.upsertEntity({ type: "company", name: "Globex" });
    const results = mem.findEntities({ query: "acme" });
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("ACME Corp");
  });

  it("listRecentEntities returns latest first", () => {
    mem.upsertEntity({ type: "company", name: "Alpha" });
    mem.upsertEntity({ type: "company", name: "Beta" });
    const recent = mem.listRecentEntities(10);
    expect(recent[0].name).toBe("Beta");
  });

  // ── Extractors ────────────────────────────────────────────────────────────

  it("extractFromText finds Jira keys", () => {
    const { entities } = mem.extractFromText("Working on PROJ-123 and HAWK-456 today.");
    const jiraEntities = entities.filter((e) => e.type === "jira_issue");
    expect(jiraEntities.map((e) => e.name)).toContain("PROJ-123");
    expect(jiraEntities.map((e) => e.name)).toContain("HAWK-456");
  });

  it("extractFromText finds GitHub PR URLs", () => {
    const { entities } = mem.extractFromText(
      "See https://github.com/myorg/my-repo/pull/42 for the fix.",
    );
    expect(entities.some((e) => e.type === "github_pr")).toBe(true);
    expect(entities.some((e) => e.type === "repo" && e.name === "my-repo")).toBe(true);
  });

  it("extractFromText finds GitLab MR URLs", () => {
    const { entities } = mem.extractFromText(
      "MR at https://gitlab.com/myorg/my-repo/-/merge_requests/99",
    );
    expect(entities.some((e) => e.type === "gitlab_mr")).toBe(true);
  });

  it("extractFromText finds preference statements", () => {
    const { entities, facts } = mem.extractFromText("I prefer TypeScript over JavaScript.");
    expect(entities.some((e) => e.type === "preference")).toBe(true);
    expect(facts.length).toBeGreaterThan(0);
  });

  it("extractAndStore persists extracted entities", () => {
    mem.extractAndStore("Reviewing PROJ-100 and PROJ-200.", "conversation");
    const jira = mem.findEntities({ type: "jira_issue" });
    expect(jira).toHaveLength(2);
  });

  it("extractCustomerEntity upserts a company", () => {
    const entity = mem.extractCustomerEntity("ACME Corp", { companyId: 42 });
    expect(entity.type).toBe("company");
    expect(entity.name).toBe("ACME Corp");
    expect(entity.sourceId).toBe("42");
  });
});
