import { describe, it, expect } from "vitest";
import {
  initConvergenceState,
  recordRoundFindings,
  checkConvergence,
  hashFinding,
  formatConvergenceReport,
  DEFAULT_CONVERGENCE_CONFIG,
  type ConvergenceConfig,
  type ConvergenceState,
} from "../../../src/autonomous-loop/convergence";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const strictConfig: ConvergenceConfig = {
  maxRounds: 5,
  maxIdenticalFindings: 2,
  maxEmptyPRs: 2,
  maxNoProgressRounds: 3,
};

const finding1 = { file: "src/auth.ts", severity: "high", category: "security", message: "Auth bypass" };
const finding2 = { file: "src/api.ts", severity: "medium", category: "performance", message: "N+1 query" };
const finding3 = { file: "src/utils.ts", severity: "low", category: "style", message: "Unused import" };

// ── hashFinding ────────────────────────────────────────────────────────────────

describe("hashFinding", () => {
  it("produces a stable hash from file + severity + category", () => {
    const hash1 = hashFinding(finding1);
    const hash2 = hashFinding(finding1);
    expect(hash1).toBe(hash2);
  });

  it("normalizes severity and category to lowercase", () => {
    const a = hashFinding({ file: "x.ts", severity: "HIGH", category: "Security" });
    const b = hashFinding({ file: "x.ts", severity: "high", category: "security" });
    expect(a).toBe(b);
  });

  it("produces different hashes for different files", () => {
    expect(hashFinding(finding1)).not.toBe(hashFinding(finding2));
  });

  it("handles missing fields with defaults", () => {
    const h = hashFinding({});
    expect(h).toBe("::unknown::unknown"); // empty file, default severity, default category
  });

  it("handles undefined fields gracefully", () => {
    const h = hashFinding({ severity: "critical" });
    expect(h).toContain("critical");
  });
});

// ── initConvergenceState ──────────────────────────────────────────────────────

describe("initConvergenceState", () => {
  it("starts with round 0 and empty tracking", () => {
    const state = initConvergenceState();
    expect(state.roundNumber).toBe(0);
    expect(state.previousFindings).toEqual([]);
    expect(state.emptyPRCount).toBe(0);
    expect(state.findingsResolved).toBe(0);
    expect(state.findingsNew).toBe(0);
    expect(state.noProgressCount).toBe(0);
    expect(state.identicalCount.size).toBe(0);
    expect(state.lastRoundFindings.size).toBe(0);
  });
});

// ── recordRoundFindings ────────────────────────────────────────────────────────

describe("recordRoundFindings", () => {
  it("increments round number", () => {
    const state = initConvergenceState();
    const next = recordRoundFindings(state, [finding1], true);
    expect(next.roundNumber).toBe(1);
    const next2 = recordRoundFindings(next, [finding1], true);
    expect(next2.roundNumber).toBe(2);
  });

  it("resets emptyPRCount when PR has changes", () => {
    const state = initConvergenceState();
    const next = recordRoundFindings(state, [], false); // empty PR
    expect(next.emptyPRCount).toBe(1);
    const next2 = recordRoundFindings(next, [finding1], true); // has changes
    expect(next2.emptyPRCount).toBe(0);
  });

  it("increments emptyPRCount when PR has no changes", () => {
    const state = initConvergenceState();
    const next = recordRoundFindings(state, [], false);
    expect(next.emptyPRCount).toBe(1);
    const next2 = recordRoundFindings(next, [], false);
    expect(next2.emptyPRCount).toBe(2);
  });

  it("tracks identical finding counts across rounds", () => {
    const state = initConvergenceState();
    const next = recordRoundFindings(state, [finding1], true);
    expect(next.identicalCount.get(hashFinding(finding1))).toBe(1);
    const next2 = recordRoundFindings(next, [finding1], true);
    expect(next2.identicalCount.get(hashFinding(finding1))).toBe(2);
  });

  it("detects resolved findings (present in previous round but not current)", () => {
    let state = initConvergenceState();
    // Round 1: finding1 present
    state = recordRoundFindings(state, [finding1], true);
    expect(state.findingsNew).toBe(1);
    expect(state.findingsResolved).toBe(0);

    // Round 2: finding1 resolved (not present), finding2 new
    state = recordRoundFindings(state, [finding2], true);
    expect(state.findingsResolved).toBe(1);
    expect(state.findingsNew).toBe(1);
  });

  it("detects no-progress rounds (no findings resolved)", () => {
    let state = initConvergenceState();
    // Round 1: finding1 (no previous round, so noProgressCount = 1)
    state = recordRoundFindings(state, [finding1], true);
    expect(state.noProgressCount).toBe(1);
    // Round 2: same finding (not resolved, noProgressCount = 2)
    state = recordRoundFindings(state, [finding1], true);
    expect(state.findingsResolved).toBe(0);
    expect(state.noProgressCount).toBe(2);
  });

  it("resets noProgressCount when findings are resolved", () => {
    let state = initConvergenceState();
    state = recordRoundFindings(state, [finding1], true); // noProgressCount = 1
    state = recordRoundFindings(state, [finding1], true); // noProgressCount = 2
    expect(state.noProgressCount).toBe(2);
    state = recordRoundFindings(state, [finding2], true); // finding1 resolved, noProgressCount = 0
    expect(state.noProgressCount).toBe(0);
  });

  it("accumulates previous findings across rounds", () => {
    let state = initConvergenceState();
    state = recordRoundFindings(state, [finding1], true);
    state = recordRoundFindings(state, [finding2], true);
    // Both finding1 and finding2 should be in history
    expect(state.previousFindings).toContain(hashFinding(finding1));
    expect(state.previousFindings).toContain(hashFinding(finding2));
  });
});

// ── checkConvergence ──────────────────────────────────────────────────────────

describe("checkConvergence", () => {
  describe("max_rounds", () => {
    it("stops when roundNumber exceeds maxRounds", () => {
      const state = { ...initConvergenceState(), roundNumber: 6 };
      const result = checkConvergence(state, strictConfig);
      expect(result.shouldStop).toBe(true);
      expect(result.reason).toBe("max_rounds");
      expect(result.recommendation).toBe("escalate_human");
    });

    it("continues when roundNumber equals maxRounds", () => {
      const state = { ...initConvergenceState(), roundNumber: 5 };
      const result = checkConvergence(state, strictConfig);
      // Not exceeded yet (5 is not > 5)
      expect(result.shouldStop).toBe(false);
    });
  });

  describe("identical_findings", () => {
    it("stops when a finding appears more than maxIdenticalFindings times", () => {
      const state = {
        ...initConvergenceState(),
        roundNumber: 3,
        identicalCount: new Map([[hashFinding(finding1), 3]]),
      };
      const result = checkConvergence(state, strictConfig);
      expect(result.shouldStop).toBe(true);
      expect(result.reason).toBe("identical_findings");
      expect(result.recommendation).toBe("escalate_human");
    });

    it("continues when findings are within threshold", () => {
      const state = {
        ...initConvergenceState(),
        roundNumber: 2,
        identicalCount: new Map([[hashFinding(finding1), 2]]),
      };
      const result = checkConvergence(state, strictConfig);
      // 2 is not > 2 (maxIdenticalFindings)
      expect(result.shouldStop).toBe(false);
    });
  });

  describe("empty_prs", () => {
    it("stops when emptyPRCount exceeds maxEmptyPRs", () => {
      const state = { ...initConvergenceState(), roundNumber: 2, emptyPRCount: 3 };
      const result = checkConvergence(state, strictConfig);
      expect(result.shouldStop).toBe(true);
      expect(result.reason).toBe("empty_prs");
      expect(result.recommendation).toBe("requeue_different_prompt");
    });

    it("continues when emptyPRCount is within threshold", () => {
      const state = { ...initConvergenceState(), roundNumber: 1, emptyPRCount: 2 };
      const result = checkConvergence(state, strictConfig);
      // 2 is not > 2
      expect(result.shouldStop).toBe(false);
    });
  });

  describe("no_progress", () => {
    it("stops when noProgressCount reaches maxNoProgressRounds", () => {
      const state = { ...initConvergenceState(), roundNumber: 3, noProgressCount: 3 };
      const result = checkConvergence(state, strictConfig);
      expect(result.shouldStop).toBe(true);
      expect(result.reason).toBe("no_progress");
      expect(result.recommendation).toBe("escalate_human");
    });

    it("continues when noProgressCount is below threshold", () => {
      const state = { ...initConvergenceState(), roundNumber: 2, noProgressCount: 2 };
      const result = checkConvergence(state, strictConfig);
      // 2 is not >= 3
      expect(result.shouldStop).toBe(false);
    });
  });

  describe("converged (all findings resolved)", () => {
    it("returns continue with converged reason when findings are resolved", () => {
      let state = initConvergenceState();
      // Round 1: add finding
      state = recordRoundFindings(state, [finding1], true);
      // Round 2: finding1 is resolved (not present), so lastRoundFindings is empty
      state = recordRoundFindings(state, [], true);
      const result = checkConvergence(state, strictConfig);
      expect(result.shouldStop).toBe(false);
      expect(result.reason).toBe("converged");
      expect(result.recommendation).toBe("mark_done");
    });
  });

  describe("continue (normal progress)", () => {
    it("returns continue when progress is being made", () => {
      let state = initConvergenceState();
      state = recordRoundFindings(state, [finding1, finding2], true);
      const result = checkConvergence(state, strictConfig);
      expect(result.shouldStop).toBe(false);
      expect(result.reason).toBe("converged");
      expect(result.recommendation).toBe("continue");
    });
  });

  describe("evaluation order", () => {
    it("maxRounds takes priority over identical findings", () => {
      const state = {
        ...initConvergenceState(),
        roundNumber: 10, // exceeds maxRounds
        identicalCount: new Map([[hashFinding(finding1), 5]]),
        emptyPRCount: 5,
        noProgressCount: 5,
      };
      const result = checkConvergence(state, strictConfig);
      expect(result.reason).toBe("max_rounds");
    });

    it("identical findings takes priority over empty PRs", () => {
      const state = {
        ...initConvergenceState(),
        roundNumber: 2,
        identicalCount: new Map([[hashFinding(finding1), 3]]),
        emptyPRCount: 5,
      };
      const result = checkConvergence(state, strictConfig);
      expect(result.reason).toBe("identical_findings");
    });

    it("empty PRs takes priority over no progress", () => {
      const state = {
        ...initConvergenceState(),
        roundNumber: 2,
        noProgressCount: 5,
        emptyPRCount: 5,
      };
      const result = checkConvergence(state, strictConfig);
      expect(result.reason).toBe("empty_prs");
    });
  });
});

// ── formatConvergenceReport ───────────────────────────────────────────────────

describe("formatConvergenceReport", () => {
  it("formats a human-readable report", () => {
    const state = {
      ...initConvergenceState(),
      roundNumber: 3,
      findingsResolved: 2,
      findingsNew: 1,
      emptyPRCount: 0,
      noProgressCount: 0,
    };
    const result = {
      shouldStop: true,
      reason: "max_rounds" as const,
      message: "Exceeded max rework rounds (5).",
      recommendation: "escalate_human" as const,
    };
    const report = formatConvergenceReport(result, state, strictConfig);
    expect(report).toContain("Convergence Report");
    expect(report).toContain("3"); // roundNumber
    expect(report).toContain("max_rounds");
    expect(report).toContain("escalate_human");
  });
});

// ── Default config ─────────────────────────────────────────────────────────────

describe("DEFAULT_CONVERGENCE_CONFIG", () => {
  it("has sensible defaults", () => {
    expect(DEFAULT_CONVERGENCE_CONFIG.maxRounds).toBe(5);
    expect(DEFAULT_CONVERGENCE_CONFIG.maxIdenticalFindings).toBe(2);
    expect(DEFAULT_CONVERGENCE_CONFIG.maxEmptyPRs).toBe(2);
    expect(DEFAULT_CONVERGENCE_CONFIG.maxNoProgressRounds).toBe(3);
  });
});

// ── End-to-end scenario tests ─────────────────────────────────────────────────

describe("convergence end-to-end scenarios", () => {
  it("IR-66 scenario: 4 rounds of empty PRs should stop at round 3", () => {
    const config: ConvergenceConfig = { maxRounds: 5, maxIdenticalFindings: 2, maxEmptyPRs: 2, maxNoProgressRounds: 3 };
    let state = initConvergenceState();

    // Round 1: agent produces nothing
    state = recordRoundFindings(state, [], false);
    let result = checkConvergence(state, config);
    expect(result.shouldStop).toBe(false); // 1 empty PR, not > 2

    // Round 2: agent produces nothing again
    state = recordRoundFindings(state, [], false);
    result = checkConvergence(state, config);
    expect(result.shouldStop).toBe(false); // 2 empty PRs, not > 2

    // Round 3: agent produces nothing again
    state = recordRoundFindings(state, [], false);
    result = checkConvergence(state, config);
    expect(result.shouldStop).toBe(true); // 3 empty PRs > 2
    expect(result.reason).toBe("empty_prs");
  });

  it("IR-99 scenario: identical findings repeated 7+ times should stop at round 3", () => {
    const config: ConvergenceConfig = { maxRounds: 5, maxIdenticalFindings: 2, maxEmptyPRs: 2, maxNoProgressRounds: 3 };
    let state = initConvergenceState();

    // Round 1: reviewer posts "Security-related files detected"
    const securityFinding = { file: "src/auth.ts", severity: "high", category: "security" };
    state = recordRoundFindings(state, [securityFinding], true);
    let result = checkConvergence(state, config);
    expect(result.shouldStop).toBe(false); // count = 1, not > 2

    // Round 2: same finding comes back
    state = recordRoundFindings(state, [securityFinding], true);
    result = checkConvergence(state, config);
    expect(result.shouldStop).toBe(false); // count = 2, not > 2

    // Round 3: same finding again
    state = recordRoundFindings(state, [securityFinding], true);
    result = checkConvergence(state, config);
    expect(result.shouldStop).toBe(true); // count = 3 > 2
    expect(result.reason).toBe("identical_findings");
  });

  it("IR-94 scenario: 6 rounds with no progress should stop at round 4 (3 no-progress rounds)", () => {
    const config: ConvergenceConfig = { maxRounds: 10, maxIdenticalFindings: 5, maxEmptyPRs: 3, maxNoProgressRounds: 3 };
    let state = initConvergenceState();

    // Rounds 1-4: same unfixed findings, agent doesn't resolve them
    for (let i = 0; i < 4; i++) {
      state = recordRoundFindings(state, [{ file: "src/api.ts", severity: "high", category: "security" }], true);
    }
    const result = checkConvergence(state, config);
    // Round 4: noProgressCount should be 3 (rounds 2, 3, 4 had no resolved findings)
    expect(result.shouldStop).toBe(true);
    expect(result.reason).toBe("no_progress");
  });

  it("convergence: all findings resolved → mark_done", () => {
    const config = strictConfig;
    let state = initConvergenceState();

    // Round 1: two findings
    state = recordRoundFindings(state, [finding1, finding2], true);
    let result = checkConvergence(state, config);
    expect(result.shouldStop).toBe(false);

    // Round 2: both findings resolved (empty round)
    state = recordRoundFindings(state, [], true);
    result = checkConvergence(state, config);
    expect(result.shouldStop).toBe(false);
    expect(result.reason).toBe("converged");
    expect(result.recommendation).toBe("mark_done");
  });

  it("mixed findings: some resolved, some new → continue", () => {
    const config = strictConfig;
    let state = initConvergenceState();

    // Round 1: finding1
    state = recordRoundFindings(state, [finding1], true);

    // Round 2: finding1 resolved, finding3 is new
    state = recordRoundFindings(state, [finding3], true);
    const result = checkConvergence(state, config);
    expect(result.shouldStop).toBe(false);
    expect(state.findingsResolved).toBe(1);
    expect(state.findingsNew).toBe(1);
  });
});