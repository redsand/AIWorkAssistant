// src/context-engine/__tests__/context-packet.integration.test.ts
//
// Integration coverage for the query-rewriting wiring inside
// assembleContextPacket (issue #230). The earlier unit tests exercised the
// rewriter helpers in isolation; these drive the real assembleContextPacket
// with every data source / external service mocked, and assert that:
//   1. the REWRITTEN query reaches retrieveAllStores (via knowledgeStore.search)
//      and claimKitAdapter.query — not the raw user text;
//   2. queryRewriteMetrics is emitted on the returned packet diagnostics;
//   3. QUERY_REWRITER_ENABLED=false passes the raw query through verbatim.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ClaimKitQueryResult } from "../adapters/claimkit-adapter";

const knowledgeSearch = vi.fn((..._args: unknown[]) => [] as unknown[]);
const codebaseSearch = vi.fn((..._args: unknown[]) => [] as unknown[]);
const graphQueryNodes = vi.fn((..._args: unknown[]) => [] as unknown[]);
const ckQuery = vi.fn((..._args: unknown[]): Promise<ClaimKitQueryResult> => Promise.resolve(CK_RESULT));
const ckIsAvailable = vi.fn(() => false);

vi.mock("../../agent/knowledge-store", () => ({
  knowledgeStore: { search: (...args: unknown[]) => knowledgeSearch(...(args as [])) },
}));
vi.mock("../../agent/codebase-indexer", () => ({
  codebaseIndexer: { search: (...args: unknown[]) => codebaseSearch(...(args as [])) },
}));
vi.mock("../../agent/knowledge-graph", () => ({
  knowledgeGraph: {
    queryNodes: (...args: unknown[]) => graphQueryNodes(...(args as [])),
    exportForContext: vi.fn(() => ""),
    retrieveCommunitySummaries: vi.fn(() => []),
  },
}));
vi.mock("../adapters/claimkit-adapter", () => ({
  claimKitAdapter: {
    isAvailable: (...args: unknown[]) => ckIsAvailable(...(args as [])),
    initialize: vi.fn(async () => false),
    getInitError: vi.fn(() => null),
    query: (...args: unknown[]) => ckQuery(...(args as [])),
    ground: vi.fn(),
  },
}));
vi.mock("../claimkit-ingestion", () => ({
  ingestScoredDocumentsForQuery: vi.fn(async () => undefined),
}));
vi.mock("../../comparison-runs/auto-capture", () => ({
  saveLiveComparison: vi.fn(() => null),
}));
vi.mock("../../agent/opencode-client", () => ({
  aiClient: { isConfigured: vi.fn(() => false), validateConfig: vi.fn(async () => false) },
}));
vi.mock("../../integrations/github/github-client", () => ({
  githubClient: { isConfigured: vi.fn(async () => false), validateConfig: vi.fn(async () => false) },
}));
vi.mock("../../integrations/gitlab/gitlab-client", () => ({
  gitlabClient: { isConfigured: vi.fn(async () => false), validateConfig: vi.fn(async () => false) },
}));
vi.mock("../../integrations/jira/jira-client", () => ({
  jiraClient: { isConfigured: vi.fn(async () => false), validateConfig: vi.fn(async () => false) },
}));
vi.mock("../../agent/prompts", () => ({
  getSystemPrompt: vi.fn(() => "SYSTEM PROMPT"),
}));
vi.mock("../../agent/provider-settings", () => ({
  providerSettings: { getCurrent: vi.fn(() => ({ provider: "test" })) },
}));
vi.mock("../../memory/agent-memory", () => ({
  agentMemory: { getMemorySnapshot: vi.fn(() => ""), getUserSnapshot: vi.fn(() => "") },
}));
vi.mock("../../memory/soul-manager", () => ({
  soulManager: { load: vi.fn(() => ""), getActivePersonality: vi.fn(() => null) },
}));
vi.mock("../../skills/skill-manager", () => ({
  skillManager: { getSummariesText: vi.fn(() => "") },
}));
vi.mock("../../agent/reflection-engine", () => ({
  reflectionEngine: { getRecentReflections: vi.fn(() => "") },
}));
vi.mock("../../memory/conversation-manager", () => ({
  conversationManager: { searchSessions: vi.fn(() => []) },
}));
vi.mock("../entity-claims-injector", () => ({
  buildEntityClaimsSection: vi.fn(() => ({
    content: "",
    entityCount: 0,
    claimCount: 0,
    contradictionCount: 0,
    contradictions: [],
    entitiesWithHistory: 0,
  })),
  extractEntityIds: vi.fn(() => []),
}));
vi.mock("../../memory/entity-memory", () => ({
  entityMemory: {
    getEntitiesByNormalizedNames: vi.fn(() => []),
    listRecentEntities: vi.fn(() => []),
  },
}));
vi.mock("../../memory/entity-markdown", () => ({
  entityMarkdown: { readRaw: vi.fn(() => "") },
}));
// Delegate to the REAL query-rewriter so the wiring tests exercise actual
// filler-stripping / abbreviation expansion. Registering it as a mock (spread
// into a fresh, configurable namespace) lets a single test spy on
// rewriteQuerySafe to simulate the internal-failure fallback path.
vi.mock("../query-rewriter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../query-rewriter")>();
  return { ...actual };
});

import { assembleContextPacket } from "../context-packet";
import * as queryRewriter from "../query-rewriter";
import { env } from "../../config/env";
import type { AssembleContextParams } from "../types";

const CK_RESULT: ClaimKitQueryResult = {
  answer: "Insufficient evidence to answer this question.",
  citations: [],
  confidence: 0.05,
  contradictions: [],
  missingEvidence: [],
  answerability: "not_answerable",
  metadata: { sourceIds: [], claimCount: 0, processingTimeMs: 1, retrievalScore: 0 },
};

function makeParams(query: string): AssembleContextParams {
  return {
    mode: "engineering",
    query,
    sessionMessages: [],
    sessionId: "s1",
    includeMemory: true,
    toolInventory: "",
    providerMaxTokens: 100_000,
    toolTokens: 0,
    userId: "u1",
  };
}

const FILLER_QUERY = "Can you tell me how CK handles contradictions";

describe("assembleContextPacket query-rewrite integration (issue #230)", () => {
  const saved: Partial<typeof env> = {};
  const keys = [
    "QUERY_REWRITER_ENABLED",
    "QUERY_REWRITE_VARIANT_COUNT",
    "CLAIMKIT_ENABLED",
    "CLAIMKIT_FIRST_ROUTING",
    "CLAIMKIT_AWAIT_SEED",
  ] as const;

  beforeEach(() => {
    vi.clearAllMocks();
    for (const k of keys) (saved as Record<string, unknown>)[k] = env[k];
    // Deterministic baseline: rewriter on, no parallel variant retrieval,
    // ClaimKit off unless a test opts in.
    (env as Record<string, unknown>).QUERY_REWRITER_ENABLED = true;
    (env as Record<string, unknown>).QUERY_REWRITE_VARIANT_COUNT = 0;
    (env as Record<string, unknown>).CLAIMKIT_ENABLED = false;
    (env as Record<string, unknown>).CLAIMKIT_FIRST_ROUTING = false;
    (env as Record<string, unknown>).CLAIMKIT_AWAIT_SEED = false;
    ckIsAvailable.mockReturnValue(false);
    ckQuery.mockResolvedValue(CK_RESULT);
  });

  afterEach(() => {
    for (const k of keys) (env as Record<string, unknown>)[k] = saved[k];
  });

  it("passes the rewritten (not raw) query to retrieveAllStores", async () => {
    await assembleContextPacket(makeParams(FILLER_QUERY));

    expect(knowledgeSearch).toHaveBeenCalled();
    const retrievalArg = knowledgeSearch.mock.calls[0][0] as string;
    // Filler stripped, abbreviation expanded.
    expect(retrievalArg).toContain("ClaimKit");
    expect(retrievalArg.toLowerCase()).not.toContain("can you tell me");
    expect(retrievalArg).not.toBe(FILLER_QUERY);
  });

  it("passes the rewritten query to claimKitAdapter.query when ClaimKit is enabled", async () => {
    (env as Record<string, unknown>).CLAIMKIT_ENABLED = true;
    ckIsAvailable.mockReturnValue(true);

    await assembleContextPacket(makeParams(FILLER_QUERY));

    expect(ckQuery).toHaveBeenCalled();
    const ckArg = ckQuery.mock.calls[0][0] as string;
    expect(ckArg).toContain("ClaimKit");
    expect(ckArg.toLowerCase()).not.toContain("can you tell me");
  });

  it("emits queryRewriteMetrics on the returned packet diagnostics", async () => {
    const packet = await assembleContextPacket(makeParams(FILLER_QUERY));

    const metrics = packet.diagnostics.queryRewriteMetrics;
    expect(metrics).toBeDefined();
    expect(metrics.enabled).toBe(true);
    // "CK" → "ClaimKit" is one abbreviation expansion.
    expect(metrics.abbreviationCount).toBeGreaterThanOrEqual(1);
    // Deterministic, non-timing assertion: the rewrite is synchronous so the
    // reported latency is always a finite, non-negative number. No upper bound —
    // wall-clock budgets are flaky on a loaded CI host.
    expect(Number.isFinite(metrics.latencyMs)).toBe(true);
    expect(metrics.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("passes the raw query through verbatim when QUERY_REWRITER_ENABLED=false", async () => {
    (env as Record<string, unknown>).QUERY_REWRITER_ENABLED = false;

    const packet = await assembleContextPacket(makeParams(FILLER_QUERY));

    expect(knowledgeSearch).toHaveBeenCalled();
    const retrievalArg = knowledgeSearch.mock.calls[0][0] as string;
    expect(retrievalArg).toBe(FILLER_QUERY);

    const metrics = packet.diagnostics.queryRewriteMetrics;
    expect(metrics.enabled).toBe(false);
    expect(metrics.variantCount).toBe(0);
    expect(metrics.entityRefCount).toBe(0);
    expect(metrics.abbreviationCount).toBe(0);
    // Disabled path uses the identity rewrite; assert a finite, non-negative
    // latency rather than an exact 0 so the check doesn't break if the identity
    // rewrite ever starts reporting a real (tiny) measured cost.
    expect(Number.isFinite(metrics.latencyMs)).toBe(true);
    expect(metrics.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("runs parallel variant retrieval and merges when QUERY_REWRITE_VARIANT_COUNT > 0", async () => {
    (env as Record<string, unknown>).QUERY_REWRITE_VARIANT_COUNT = 3;

    // Ambiguous query whose rewritten form ("authentication works") still yields
    // a synonym variant ("login auth credentials ...") — FILLER_QUERY rewrites to
    // a dense, synonym-free phrase and would generate zero variants.
    const ambiguousQuery = "Can you tell me how authentication works";
    const packet = await assembleContextPacket(makeParams(ambiguousQuery));

    const metrics = packet.diagnostics.queryRewriteMetrics;
    expect(metrics.variantCount).toBeGreaterThan(0);

    // Variant retrieval fans out: the primary rewritten query plus one
    // retrieveAllStores call per generated variant, so knowledgeStore.search
    // (the only knowledge retrieval on the non-ClaimKit path) runs more than
    // once. With variant count 0 (the baseline) it would run exactly once.
    expect(knowledgeSearch.mock.calls.length).toBeGreaterThan(1);

    // Every retrieval — primary and variant — must use a rewritten form; the raw
    // conversational filler must never reach an embedding lookup.
    for (const call of knowledgeSearch.mock.calls) {
      expect(String(call[0]).toLowerCase()).not.toContain("can you tell me");
    }
  });

  it("degrades to the raw query and still assembles a packet when the rewriter throws", async () => {
    // rewriteQuerySafe is contractually total: any internal failure must degrade
    // to the identity rewrite rather than propagate. Here the spy reproduces that
    // throw-and-recover so we can assert the *assembly* side of the contract —
    // assembleContextPacket must not crash, retrieval must fall back to the raw
    // query, and identity metrics must surface on the packet.
    const spy = vi
      .spyOn(queryRewriter, "rewriteQuerySafe")
      .mockImplementation((q: string) => {
        try {
          throw new Error("simulated rewrite failure");
        } catch {
          return queryRewriter.identityRewrite(q);
        }
      });

    try {
      const packet = await assembleContextPacket(makeParams(FILLER_QUERY));

      expect(spy).toHaveBeenCalled();
      expect(knowledgeSearch).toHaveBeenCalled();
      // Fallback retrieval embeds the raw query verbatim — no rewrite was applied.
      expect(knowledgeSearch.mock.calls[0][0]).toBe(FILLER_QUERY);

      const metrics = packet.diagnostics.queryRewriteMetrics;
      expect(metrics.variantCount).toBe(0);
      expect(metrics.entityRefCount).toBe(0);
      expect(metrics.abbreviationCount).toBe(0);
      expect(metrics.latencyMs).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});
