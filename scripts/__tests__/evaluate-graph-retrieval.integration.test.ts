// scripts/__tests__/evaluate-graph-retrieval.integration.test.ts
//
// Covers the impure / async surface of the harness: the ClaimKit-backed
// verification and grounding checks, end-to-end evaluation, and queries-file
// validation. The knowledge graph/store and ClaimKit adapter are mocked so the
// suite runs without a database or live providers.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

vi.mock("../../src/agent/knowledge-graph", () => ({
  knowledgeGraph: {
    queryNodes: vi.fn(() => []),
    getNeighbors: vi.fn(() => ({ nodes: [], edges: [] })),
  },
}));

vi.mock("../../src/agent/knowledge-store", () => ({
  knowledgeStore: {
    search: vi.fn(() => []),
  },
}));

vi.mock("../../src/context-engine/adapters/claimkit-adapter", () => ({
  claimKitAdapter: {
    isAvailable: vi.fn(() => false),
    initialize: vi.fn(async () => false),
    query: vi.fn(),
    ground: vi.fn(),
  },
}));

import {
  checkClaimKitVerified,
  checkRagHallucinated,
  evaluateGraphRetrieval,
  generateReport,
  loadQueries,
  retrieveGraphEntities,
  RAG_BASELINE_HALLUCINATION_RATE,
  type GraphEvalResult,
} from "../evaluate-graph-retrieval";
import { knowledgeGraph } from "../../src/agent/knowledge-graph";
import { knowledgeStore } from "../../src/agent/knowledge-store";
import { claimKitAdapter } from "../../src/context-engine/adapters/claimkit-adapter";

const graph = vi.mocked(knowledgeGraph);
const store = vi.mocked(knowledgeStore);
const ck = vi.mocked(claimKitAdapter);

function makeHit(content: string, title = "doc") {
  return {
    entry: { id: "1", source: "manual", title, content, tags: [] },
    score: 1,
    matchType: "keyword",
  } as unknown as ReturnType<typeof knowledgeStore.search>[number];
}

beforeEach(() => {
  vi.clearAllMocks();
  ck.isAvailable.mockReturnValue(false);
  ck.initialize.mockResolvedValue(false);
  store.search.mockReturnValue([]);
  graph.queryNodes.mockReturnValue([]);
  graph.getNeighbors.mockReturnValue({ nodes: [], edges: [] } as never);
});

describe("checkClaimKitVerified", () => {
  it("returns false when ClaimKit is unavailable", async () => {
    ck.isAvailable.mockReturnValue(false);
    ck.initialize.mockResolvedValue(false);
    await expect(checkClaimKitVerified("what depends on IR-82?")).resolves.toBe(false);
    expect(ck.query).not.toHaveBeenCalled();
  });

  it("returns true when answerable with at least one citation", async () => {
    ck.isAvailable.mockReturnValue(true);
    ck.query.mockResolvedValue({
      answer: "A depends on B.",
      answerability: "answerable",
      citations: [{ claimId: "c1", sourceId: "s1", text: "evidence" }],
    } as never);
    await expect(checkClaimKitVerified("does A depend on B?")).resolves.toBe(true);
  });

  it("returns false when answerable but without citations", async () => {
    ck.isAvailable.mockReturnValue(true);
    ck.query.mockResolvedValue({
      answer: "Unclear.",
      answerability: "answerable",
      citations: [],
    } as never);
    await expect(checkClaimKitVerified("does A depend on B?")).resolves.toBe(false);
  });

  it("returns false when not answerable", async () => {
    ck.isAvailable.mockReturnValue(true);
    ck.query.mockResolvedValue({
      answer: "",
      answerability: "not_answerable",
      citations: [{ claimId: "c1", sourceId: "s1", text: "x" }],
    } as never);
    await expect(checkClaimKitVerified("does A depend on B?")).resolves.toBe(false);
  });

  it("returns false (and does not throw) when the query throws", async () => {
    ck.isAvailable.mockReturnValue(true);
    ck.query.mockRejectedValue(new Error("boom"));
    await expect(checkClaimKitVerified("does A depend on B?")).resolves.toBe(false);
  });
});

describe("checkRagHallucinated", () => {
  it("returns true when there are no retrieved documents", async () => {
    store.search.mockReturnValue([]);
    await expect(checkRagHallucinated("anything")).resolves.toBe(true);
    expect(ck.query).not.toHaveBeenCalled();
  });

  it("returns null (not measured) when ClaimKit is unavailable", async () => {
    store.search.mockReturnValue([makeHit("some content")]);
    ck.isAvailable.mockReturnValue(false);
    ck.initialize.mockResolvedValue(false);
    await expect(checkRagHallucinated("anything")).resolves.toBeNull();
  });

  it("grounds a generated answer (not the documents) against the documents", async () => {
    store.search.mockReturnValue([makeHit("retrieved doc content")]);
    ck.isAvailable.mockReturnValue(true);
    ck.query.mockResolvedValue({ answer: "generated answer" } as never);
    ck.ground.mockResolvedValue({ grounded: true } as never);

    await expect(checkRagHallucinated("q")).resolves.toBe(false);

    // The text being grounded must be the generated answer, and the evidence
    // must be the retrieved documents — proving the check is not circular.
    const groundArg = ck.ground.mock.calls[0][0];
    expect(groundArg.text).toBe("generated answer");
    expect(groundArg.evidence).toEqual([
      { title: "doc", content: "retrieved doc content" },
    ]);
  });

  it("returns true when the generated answer is ungrounded", async () => {
    store.search.mockReturnValue([makeHit("doc")]);
    ck.isAvailable.mockReturnValue(true);
    ck.query.mockResolvedValue({ answer: "hallucinated" } as never);
    ck.ground.mockResolvedValue({ grounded: false } as never);
    await expect(checkRagHallucinated("q")).resolves.toBe(true);
  });

  it("returns null when no answer could be generated", async () => {
    store.search.mockReturnValue([makeHit("doc")]);
    ck.isAvailable.mockReturnValue(true);
    ck.query.mockResolvedValue({ answer: "   " } as never);
    await expect(checkRagHallucinated("q")).resolves.toBeNull();
    expect(ck.ground).not.toHaveBeenCalled();
  });

  it("returns null (and does not throw) when grounding throws", async () => {
    store.search.mockReturnValue([makeHit("doc")]);
    ck.isAvailable.mockReturnValue(true);
    ck.query.mockResolvedValue({ answer: "answer" } as never);
    ck.ground.mockRejectedValue(new Error("boom"));
    await expect(checkRagHallucinated("q")).resolves.toBeNull();
  });
});

describe("loadQueries", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-eval-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeQueries(contents: string): string {
    const p = path.join(dir, "queries.json");
    fs.writeFileSync(p, contents);
    return p;
  }

  it("throws an actionable error when the file is missing", () => {
    const missing = path.join(dir, "does-not-exist.json");
    expect(() => loadQueries(missing)).toThrow(/Could not read queries file/);
  });

  it("throws when the file is not valid JSON", () => {
    const p = writeQueries("{ not valid json");
    expect(() => loadQueries(p)).toThrow(/not valid JSON/);
  });

  it("throws when the top-level value is not an array", () => {
    const p = writeQueries(JSON.stringify({ query: "x" }));
    expect(() => loadQueries(p)).toThrow(/must contain a JSON array/);
  });

  it("throws when an entry is missing the query string", () => {
    const p = writeQueries(JSON.stringify([{ groundTruth: ["a"], type: "structural" }]));
    expect(() => loadQueries(p)).toThrow(/non-empty "query" string/);
  });

  it("throws when groundTruth is not a string array", () => {
    const p = writeQueries(
      JSON.stringify([{ query: "q", groundTruth: [1, 2], type: "structural" }]),
    );
    expect(() => loadQueries(p)).toThrow(/"groundTruth" array of strings/);
  });

  it("throws when type is missing", () => {
    const p = writeQueries(JSON.stringify([{ query: "q", groundTruth: ["a"] }]));
    expect(() => loadQueries(p)).toThrow(/non-empty "type" string/);
  });

  it("parses a well-formed queries file", () => {
    const p = writeQueries(
      JSON.stringify([{ query: "what depends on IR-82?", groundTruth: ["IR-83"], type: "structural" }]),
    );
    expect(loadQueries(p)).toEqual([
      { query: "what depends on IR-82?", groundTruth: ["IR-83"], type: "structural" },
    ]);
  });
});

describe("retrieveGraphEntities (against known graph data)", () => {
  it("returns matched nodes plus their 1-hop neighbors by id and title", () => {
    graph.queryNodes.mockReturnValue([
      { id: "IR-82", title: "Incident 82" },
    ] as never);
    graph.getNeighbors.mockReturnValue({
      nodes: [
        { id: "IR-83", title: "Incident 83" },
        { id: "IR-84", title: "Incident 84" },
      ],
      edges: [],
    } as never);

    const { entities, error } = retrieveGraphEntities("what depends on IR-82?");

    expect(error).toBe(false);
    // matched node (id + title) and both neighbors (id + title) are surfaced.
    expect(new Set(entities)).toEqual(
      new Set(["IR-82", "Incident 82", "IR-83", "Incident 83", "IR-84", "Incident 84"]),
    );
    // neighbors are expanded from the matched node id.
    expect(graph.getNeighbors).toHaveBeenCalledWith("IR-82", 1);
  });

  it("returns no entities when nothing matches", () => {
    graph.queryNodes.mockReturnValue([] as never);
    const { entities, error } = retrieveGraphEntities("unmatched query");
    expect(entities).toEqual([]);
    expect(error).toBe(false);
    expect(graph.getNeighbors).not.toHaveBeenCalled();
  });

  it("flags error: true (without throwing) when the graph query throws", () => {
    graph.queryNodes.mockImplementation(() => {
      throw new Error("store offline");
    });
    const { entities, error } = retrieveGraphEntities("what depends on IR-82?");
    expect(error).toBe(true);
    expect(entities).toEqual([]);
  });
});

describe("evaluateGraphRetrieval (end-to-end)", () => {
  let dir: string;
  let queriesPath: string;
  let reportPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-eval-e2e-"));
    queriesPath = path.join(dir, "queries.json");
    reportPath = path.join(dir, "report.md");
    fs.writeFileSync(
      queriesPath,
      JSON.stringify([
        { query: "what depends on IR-82?", groundTruth: ["IR-83"], type: "structural" },
      ]),
    );
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("produces results and writes a report", async () => {
    graph.queryNodes.mockReturnValue([
      { id: "IR-83", title: "IR-83" },
    ] as never);
    graph.getNeighbors.mockReturnValue({ nodes: [], edges: [] } as never);

    const results = await evaluateGraphRetrieval(queriesPath, reportPath);

    expect(results).toHaveLength(1);
    expect(results[0].graphRetrieved).toBe(true);
    expect(results[0].graphAccuracy).toBe(1);
    expect(fs.existsSync(reportPath)).toBe(true);
    expect(fs.readFileSync(reportPath, "utf-8")).toContain("# Graph Retrieval Evaluation Report");
  });

  it("records null hallucination when ClaimKit is unavailable and does not claim improvement", async () => {
    graph.queryNodes.mockReturnValue([{ id: "IR-83", title: "IR-83" }] as never);
    store.search.mockReturnValue([makeHit("doc")]);
    ck.isAvailable.mockReturnValue(false);
    ck.initialize.mockResolvedValue(false);

    const results = await evaluateGraphRetrieval(queriesPath, reportPath);

    expect(results[0].ragHallucinated).toBeNull();
    const report = fs.readFileSync(reportPath, "utf-8");
    expect(report).toContain("not measured");
    expect(report).not.toMatch(/\(improvement\)/);
  });

  it("records a graph error (not zero-retrieval) when the graph query throws", async () => {
    graph.queryNodes.mockImplementation(() => {
      throw new Error("store offline");
    });

    const results = await evaluateGraphRetrieval(queriesPath, reportPath);

    expect(results[0].graphError).toBe(true);
    expect(results[0].graphRetrieved).toBe(false);
    const report = fs.readFileSync(reportPath, "utf-8");
    expect(report).toContain("Graph query errors: 1/1");
    expect(report).toMatch(/Graph retrieval threw/);
  });

  it("propagates a validation error for a malformed queries file", async () => {
    fs.writeFileSync(queriesPath, "not json");
    await expect(evaluateGraphRetrieval(queriesPath, reportPath)).rejects.toThrow(
      /not valid JSON/,
    );
  });
});

describe("generateReport hallucination accounting", () => {
  function makeResult(overrides?: Partial<GraphEvalResult>): GraphEvalResult {
    return {
      query: "q",
      type: "structural",
      graphRetrieved: true,
      graphAccuracy: 1,
      claimkitVerified: true,
      ragHallucinated: false,
      graphError: false,
      latencyMs: 1,
      ...overrides,
    };
  }

  it("reports 'not measured' and no improvement when all queries are null", () => {
    const report = generateReport([
      makeResult({ ragHallucinated: null }),
      makeResult({ ragHallucinated: null }),
    ]);
    expect(report).toContain("not measured");
    expect(report).not.toMatch(/\(improvement\)/);
  });

  it("computes the rate only over measured queries", () => {
    // 1 hallucinated out of 2 measured (third is null/excluded) -> 50%.
    const report = generateReport([
      makeResult({ ragHallucinated: true }),
      makeResult({ ragHallucinated: false }),
      makeResult({ ragHallucinated: null }),
    ]);
    expect(report).toContain("Measured RAG hallucination: 50.0% (2/3 queries measured)");
  });

  it("shows an improvement delta when measured rate beats the baseline", () => {
    const report = generateReport([makeResult({ ragHallucinated: false })]);
    expect(report).toContain(`RAG baseline (published): ${(RAG_BASELINE_HALLUCINATION_RATE * 100).toFixed(1)}%`);
    expect(report).toMatch(/improvement/);
  });
});
