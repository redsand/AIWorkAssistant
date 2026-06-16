import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { GroundingHandle } from "../../context-engine/types.js";
import type { GroundInput, GroundResult } from "../../context-engine/adapters/claimkit-adapter.js";

const makeEvidence = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    title: `Doc ${i + 1}`,
    content: "word ".repeat(2000),
  }));

describe("runShadowGrounding caps", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = {
      ...originalEnv,
      CLAIMKIT_LIVE_GROUNDING_RATE: "0.1",
      CLAIMKIT_LIVE_GROUNDING_MAX_EVIDENCE_DOCS: "6",
      CLAIMKIT_LIVE_GROUNDING_MAX_CHARS_PER_DOC: "1500",
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("passes at most maxEvidenceDocs and truncates each doc to maxCharsPerDoc", async () => {
    const ground = vi.fn(async (_input: GroundInput): Promise<GroundResult> => ({
      grounded: true,
      hallucinationRate: 0,
      supportedAssertionCount: 1,
      unsupportedAssertionCount: 0,
      unsupportedPhrases: [],
      sentenceResults: [{ text: "x", supported: true }],
    }));
    const isAvailable = vi.fn(() => true);

    vi.doMock("../../context-engine/adapters/claimkit-adapter.js", () => ({
      claimKitAdapter: { isAvailable, ground },
    }));
    vi.doMock("../../comparison-runs/database.js", () => ({
      comparisonRunDatabase: { updateCaseGrounding: vi.fn() },
    }));

    const { runShadowGrounding } = await import("../chat.js");
    const handle: GroundingHandle = { caseId: "case-1", ragEvidence: makeEvidence(20) };

    await runShadowGrounding(handle, "This is the agent response with enough text to ground.", "session-1");

    expect(ground).toHaveBeenCalledTimes(1);
    const evidence = ground.mock.calls[0]![0].evidence;
    expect(evidence.length).toBeLessThanOrEqual(6);
    for (const e of evidence) {
      expect(e.content.length).toBeLessThanOrEqual(1500 + "\n...[truncated for grounding]".length);
    }
  });
});
