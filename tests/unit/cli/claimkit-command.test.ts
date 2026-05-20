import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/context-engine/adapters/claimkit-adapter", () => ({
  claimKitAdapter: {
    initialize: vi.fn(),
    query: vi.fn(),
    getInitError: vi.fn(),
  },
}));

vi.mock("../../../src/context-engine/claimkit-ingestion", () => ({
  ingestKnowledgeStore: vi.fn(),
  ingestCodebaseStore: vi.fn(),
  ingestGraphStore: vi.fn(),
}));

vi.mock("../../../src/eval/comparison/claimkit-comparison", () => ({
  runClaimKitComparison: vi.fn(),
}));

import { registerClaimKitCommand } from "../../../src/cli/commands/claimkit";
import { claimKitAdapter } from "../../../src/context-engine/adapters/claimkit-adapter";
import {
  ingestKnowledgeStore,
  ingestCodebaseStore,
  ingestGraphStore,
} from "../../../src/context-engine/claimkit-ingestion";
import { runClaimKitComparison } from "../../../src/eval/comparison/claimkit-comparison";
import { Command } from "commander";

function buildProgram() {
  const program = new Command();
  program.exitOverride();
  registerClaimKitCommand(program);
  return program;
}

function makeIngestionStats(overrides: Record<string, unknown> = {}) {
  return { total: 10, ingested: 8, skipped: 1, errors: 1, sourceIds: [], durationMs: 150, ...overrides };
}

function makeCkQueryResult(overrides: Record<string, unknown> = {}) {
  return {
    answer: "The answer",
    citations: [],
    confidence: 0.85,
    contradictions: [],
    missingEvidence: [],
    answerability: "answerable" as const,
    metadata: { sourceIds: ["s1"], claimCount: 5, processingTimeMs: 100, retrievalScore: 0.9 },
    ...overrides,
  };
}

function makeComparisonResult(overrides: Record<string, unknown> = {}) {
  return {
    totalCases: 2,
    cases: [],
    aggregate: {
      wins: { claimkit: 1, rag: 1, tie: 0 },
      claimkit: { mean: { confidence: 0.8, answerabilityRate: 0.9, avgClaims: 5, avgTimeMs: 120 } },
      rag: { mean: { avgTokens: 1000, avgSections: 2, avgTimeMs: 80 } },
    },
    ...overrides,
  };
}

describe("registerClaimKitCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("command registration", () => {
    it("registers a claimkit command on the program", () => {
      const program = buildProgram();
      const names = program.commands.map((c) => c.name());
      expect(names).toContain("claimkit");
    });

    it("registers status, ingest, query, compare subcommands", () => {
      const program = buildProgram();
      const ck = program.commands.find((c) => c.name() === "claimkit")!;
      const subNames = ck.commands.map((c) => c.name());
      expect(subNames).toContain("status");
      expect(subNames).toContain("ingest");
      expect(subNames).toContain("query");
      expect(subNames).toContain("compare");
    });
  });

  describe("status command", () => {
    it("logs available when ClaimKit initializes successfully", async () => {
      vi.mocked(claimKitAdapter.initialize).mockResolvedValue(true);
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const program = buildProgram();
      await program.parseAsync(["node", "cli", "claimkit", "status"]);

      expect(claimKitAdapter.initialize).toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("available"));
      consoleSpy.mockRestore();
    });

    it("logs not available when ClaimKit fails to initialize", async () => {
      vi.mocked(claimKitAdapter.initialize).mockResolvedValue(false);
      vi.mocked(claimKitAdapter.getInitError).mockReturnValue("CLAIMKIT_ENABLED=false");
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const program = buildProgram();
      await program.parseAsync(["node", "cli", "claimkit", "status"]);

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("not available"));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("CLAIMKIT_ENABLED=false"));
      consoleSpy.mockRestore();
    });
  });

  describe("ingest command", () => {
    it("ingests all stores when no flags are passed", async () => {
      vi.mocked(ingestKnowledgeStore).mockResolvedValue(makeIngestionStats());
      vi.mocked(ingestCodebaseStore).mockResolvedValue(makeIngestionStats());
      vi.mocked(ingestGraphStore).mockResolvedValue(makeIngestionStats());
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const program = buildProgram();
      await program.parseAsync(["node", "cli", "claimkit", "ingest"]);

      expect(ingestKnowledgeStore).toHaveBeenCalled();
      expect(ingestCodebaseStore).toHaveBeenCalled();
      expect(ingestGraphStore).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it("ingests knowledge store only when --knowledge flag is passed", async () => {
      vi.mocked(ingestKnowledgeStore).mockResolvedValue(makeIngestionStats());
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const program = buildProgram();
      await program.parseAsync(["node", "cli", "claimkit", "ingest", "--knowledge"]);

      expect(ingestKnowledgeStore).toHaveBeenCalled();
      expect(ingestCodebaseStore).not.toHaveBeenCalled();
      expect(ingestGraphStore).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it("ingests codebase store only when --codebase flag is passed", async () => {
      vi.mocked(ingestCodebaseStore).mockResolvedValue(makeIngestionStats());
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const program = buildProgram();
      await program.parseAsync(["node", "cli", "claimkit", "ingest", "--codebase"]);

      expect(ingestCodebaseStore).toHaveBeenCalled();
      expect(ingestKnowledgeStore).not.toHaveBeenCalled();
      expect(ingestGraphStore).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it("ingests graph store only when --graph flag is passed", async () => {
      vi.mocked(ingestGraphStore).mockResolvedValue(makeIngestionStats());
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const program = buildProgram();
      await program.parseAsync(["node", "cli", "claimkit", "ingest", "--graph"]);

      expect(ingestGraphStore).toHaveBeenCalled();
      expect(ingestKnowledgeStore).not.toHaveBeenCalled();
      expect(ingestCodebaseStore).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it("logs ingestion stats for each store", async () => {
      vi.mocked(ingestKnowledgeStore).mockResolvedValue(makeIngestionStats({ ingested: 7, total: 10, errors: 2, durationMs: 300 }));
      vi.mocked(ingestCodebaseStore).mockResolvedValue(makeIngestionStats({ ingested: 5, total: 5, errors: 0, durationMs: 200 }));
      vi.mocked(ingestGraphStore).mockResolvedValue(makeIngestionStats({ ingested: 3, total: 4, errors: 1, durationMs: 100 }));
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const program = buildProgram();
      await program.parseAsync(["node", "cli", "claimkit", "ingest"]);

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Knowledge"));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Codebase"));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Graph"));
      consoleSpy.mockRestore();
    });
  });

  describe("query command", () => {
    it("queries ClaimKit and prints the result", async () => {
      vi.mocked(claimKitAdapter.initialize).mockResolvedValue(true);
      vi.mocked(claimKitAdapter.query).mockResolvedValue(makeCkQueryResult() as never);
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const program = buildProgram();
      await program.parseAsync(["node", "cli", "claimkit", "query", "what is X?"]);

      expect(claimKitAdapter.query).toHaveBeenCalledWith("what is X?");
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("answerable"));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("85.0%"));
      consoleSpy.mockRestore();
    });

    it("exits with error when ClaimKit is not available", async () => {
      vi.mocked(claimKitAdapter.initialize).mockResolvedValue(false);
      const consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);

      const program = buildProgram();
      await program.parseAsync(["node", "cli", "claimkit", "query", "what is X?"]);

      expect(consoleErrSpy).toHaveBeenCalledWith(expect.stringContaining("not available"));
      expect(exitSpy).toHaveBeenCalledWith(1);
      consoleErrSpy.mockRestore();
      exitSpy.mockRestore();
    });

    it("prints citations when present", async () => {
      const result = makeCkQueryResult({
        citations: [
          { claimId: "c1", sourceId: "s1", text: "A".repeat(150) },
        ],
      });
      vi.mocked(claimKitAdapter.initialize).mockResolvedValue(true);
      vi.mocked(claimKitAdapter.query).mockResolvedValue(result as never);
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const program = buildProgram();
      await program.parseAsync(["node", "cli", "claimkit", "query", "test?"]);

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Citations"));
      consoleSpy.mockRestore();
    });

    it("warns about contradictions when present", async () => {
      const result = makeCkQueryResult({
        contradictions: [{ claimA: "a", claimB: "b", reason: "conflict" }],
      });
      vi.mocked(claimKitAdapter.initialize).mockResolvedValue(true);
      vi.mocked(claimKitAdapter.query).mockResolvedValue(result as never);
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const program = buildProgram();
      await program.parseAsync(["node", "cli", "claimkit", "query", "test?"]);

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Contradictions"));
      consoleSpy.mockRestore();
    });
  });

  describe("compare command", () => {
    it("runs comparison and prints results", async () => {
      vi.mocked(runClaimKitComparison).mockResolvedValue(makeComparisonResult() as never);
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const program = buildProgram();
      await program.parseAsync(["node", "cli", "claimkit", "compare", "query one", "query two"]);

      expect(runClaimKitComparison).toHaveBeenCalledWith(
        expect.objectContaining({ queries: ["query one", "query two"] }),
      );
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("2 queries"));
      consoleSpy.mockRestore();
    });

    it("prints ClaimKit and RAG win counts", async () => {
      vi.mocked(runClaimKitComparison).mockResolvedValue(makeComparisonResult() as never);
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const program = buildProgram();
      await program.parseAsync(["node", "cli", "claimkit", "compare", "q1"]);

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("ClaimKit wins"));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("RAG wins"));
      consoleSpy.mockRestore();
    });
  });
});
