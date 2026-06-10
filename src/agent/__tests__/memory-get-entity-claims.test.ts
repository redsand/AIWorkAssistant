import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createMemoryGetEntityClaimsHandler,
  type EntityClaimsStore,
} from "../handlers/memory-get-entity-claims";
import type { EntityFact, MemoryEntity } from "../../memory/entity-types";

function makeEntity(overrides: Partial<MemoryEntity> = {}): MemoryEntity {
  return {
    id: "ent-1",
    type: "jira_issue",
    name: "IR-82",
    normalizedName: "ir-82",
    summary: "SECURITY: eval() in query_parser.py",
    confidence: 0.95,
    source: "jira",
    sourceId: null,
    sourceUrl: "https://jira.example/IR-82",
    firstSeenAt: "2026-06-10T10:00:00Z",
    lastSeenAt: "2026-06-10T12:00:00Z",
    metadata: {},
    ...overrides,
  };
}

function makeFact(overrides: Partial<EntityFact> = {}): EntityFact {
  return {
    id: "fact-1",
    entityId: "ent-1",
    fact: "status: In Progress",
    source: "tool:jira.get_issue",
    sourceId: null,
    confidence: 1.0,
    createdAt: "2026-06-10T11:00:00Z",
    updatedAt: "2026-06-10T12:00:00Z",
    metadata: {},
    attribute: "status",
    value: "In Progress",
    supersededAt: null,
    supersededBy: null,
    ...overrides,
  };
}

function createMockStore(overrides?: Partial<EntityClaimsStore>): EntityClaimsStore {
  return {
    getEntityByName: vi.fn().mockReturnValue(null),
    getCurrentClaims: vi.fn().mockReturnValue([]),
    getClaimHistory: vi.fn().mockReturnValue([]),
    ...overrides,
  };
}

describe("memory.get_entity_claims handler", () => {
  let store: ReturnType<typeof createMockStore>;
  let handler: ReturnType<typeof createMemoryGetEntityClaimsHandler>;

  beforeEach(() => {
    store = createMockStore();
    handler = createMemoryGetEntityClaimsHandler(store);
  });

  // ── Input validation ──────────────────────────────────────────────────

  it("rejects missing type", async () => {
    const result = await handler({ name: "IR-82" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("type and name are required");
  });

  it("rejects missing name", async () => {
    const result = await handler({ type: "jira_issue" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("type and name are required");
  });

  it("rejects empty string params", async () => {
    const result = await handler({ type: "", name: "" });
    expect(result.success).toBe(false);
  });

  // ── Unknown entity ────────────────────────────────────────────────────

  it("returns found:false with a helpful message when the entity isn't known", async () => {
    const result = await handler({ type: "jira_issue", name: "IR-999" });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      found: false,
      message: expect.stringContaining("IR-999"),
    });
    expect(store.getEntityByName).toHaveBeenCalledWith("jira_issue", "IR-999");
    // No claims lookup should have fired when the entity is missing.
    expect(store.getCurrentClaims).not.toHaveBeenCalled();
  });

  // ── Known entity with no claims ───────────────────────────────────────

  it("returns found:true with empty claims array when entity is known but has no structured claims", async () => {
    store = createMockStore({
      getEntityByName: vi.fn().mockReturnValue(makeEntity()),
      getCurrentClaims: vi.fn().mockReturnValue([]),
    });
    handler = createMemoryGetEntityClaimsHandler(store);

    const result = await handler({ type: "jira_issue", name: "IR-82" });
    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.found).toBe(true);
    expect(data.claims).toEqual([]);
    expect(data.note).toContain("no structured claims");
  });

  // ── Known entity with claims ──────────────────────────────────────────

  it("returns current claims with attribute, value, source, observedAt, confidence", async () => {
    store = createMockStore({
      getEntityByName: vi.fn().mockReturnValue(makeEntity()),
      getCurrentClaims: vi.fn().mockReturnValue([
        makeFact({ attribute: "status", value: "In Progress" }),
        makeFact({
          id: "fact-2",
          attribute: "assignee",
          value: "Tim Shelton",
          fact: "assignee: Tim Shelton",
        }),
      ]),
    });
    handler = createMemoryGetEntityClaimsHandler(store);

    const result = await handler({ type: "jira_issue", name: "IR-82" });
    const data = result.data as any;
    expect(data.found).toBe(true);
    expect(data.claimCount).toBe(2);
    expect(data.claims).toHaveLength(2);
    expect(data.claims[0]).toMatchObject({
      attribute: "status",
      value: "In Progress",
      source: "tool:jira.get_issue",
    });
    expect(data.claims[0]).toHaveProperty("observedAt");
    expect(data.claims[0]).toHaveProperty("confidence");
    expect(data.entity).toMatchObject({
      type: "jira_issue",
      name: "IR-82",
      sourceUrl: "https://jira.example/IR-82",
    });
  });

  it("does NOT include history field when includeHistory is omitted", async () => {
    store = createMockStore({
      getEntityByName: vi.fn().mockReturnValue(makeEntity()),
      getCurrentClaims: vi.fn().mockReturnValue([makeFact()]),
    });
    handler = createMemoryGetEntityClaimsHandler(store);

    const result = await handler({ type: "jira_issue", name: "IR-82" });
    const data = result.data as any;
    expect(data.claims[0]).not.toHaveProperty("history");
    expect(store.getClaimHistory).not.toHaveBeenCalled();
  });

  it("includes supersession history when includeHistory is true", async () => {
    const history = [
      makeFact({
        id: "fact-current",
        value: "Done",
        createdAt: "2026-06-10T12:00:00Z",
        supersededAt: null,
      }),
      makeFact({
        id: "fact-prior",
        value: "In Progress",
        createdAt: "2026-06-10T10:00:00Z",
        supersededAt: "2026-06-10T12:00:00Z",
        supersededBy: "fact-current",
      }),
    ];
    store = createMockStore({
      getEntityByName: vi.fn().mockReturnValue(makeEntity()),
      getCurrentClaims: vi.fn().mockReturnValue([history[0]]),
      getClaimHistory: vi.fn().mockReturnValue(history),
    });
    handler = createMemoryGetEntityClaimsHandler(store);

    const result = await handler({
      type: "jira_issue",
      name: "IR-82",
      includeHistory: true,
    });
    const data = result.data as any;
    expect(data.claims[0].history).toHaveLength(2);
    expect(data.claims[0].history[0]).toMatchObject({
      value: "Done",
      supersededAt: null,
    });
    expect(data.claims[0].history[1]).toMatchObject({
      value: "In Progress",
      supersededAt: "2026-06-10T12:00:00Z",
      supersededBy: "fact-current",
    });
    expect(store.getClaimHistory).toHaveBeenCalledWith("ent-1", "status");
  });

  it("only requests history for the requested attribute, not all attributes", async () => {
    store = createMockStore({
      getEntityByName: vi.fn().mockReturnValue(makeEntity()),
      getCurrentClaims: vi.fn().mockReturnValue([
        makeFact({ attribute: "status", value: "Done" }),
        makeFact({ attribute: "assignee", value: "Tim Shelton" }),
      ]),
      getClaimHistory: vi.fn().mockReturnValue([]),
    });
    handler = createMemoryGetEntityClaimsHandler(store);

    await handler({
      type: "jira_issue",
      name: "IR-82",
      includeHistory: true,
    });
    // history is fetched once per current attribute
    expect(store.getClaimHistory).toHaveBeenCalledTimes(2);
    expect(store.getClaimHistory).toHaveBeenCalledWith("ent-1", "status");
    expect(store.getClaimHistory).toHaveBeenCalledWith("ent-1", "assignee");
  });

  // ── Error path ────────────────────────────────────────────────────────

  it("returns success:false when the store throws", async () => {
    store = createMockStore({
      getEntityByName: vi.fn().mockImplementation(() => {
        throw new Error("DB locked");
      }),
    });
    handler = createMemoryGetEntityClaimsHandler(store);

    const result = await handler({ type: "jira_issue", name: "IR-82" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("DB locked");
  });
});
