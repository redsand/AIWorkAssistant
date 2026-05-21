import { describe, it, expect } from "vitest";
import { PRODUCTIVITY_SYSTEM_PROMPT } from "../../../src/agent/prompts";

describe("DEPENDENCY_ANALYSIS_RULES", () => {
  it("is included in PRODUCTIVITY_SYSTEM_PROMPT", () => {
    expect(PRODUCTIVITY_SYSTEM_PROMPT).toContain("DEPENDENCY ANALYSIS RULES");
  });

  it("requires analysis when creating multiple tickets", () => {
    expect(PRODUCTIVITY_SYSTEM_PROMPT).toContain(
      "MANDATORY WHEN CREATING MULTIPLE TICKETS",
    );
  });

  it("defines batch analysis workflow", () => {
    expect(PRODUCTIVITY_SYSTEM_PROMPT).toContain("BATCH ANALYSIS WORKFLOW");
  });

  it("covers shared files as a dependency signal", () => {
    expect(PRODUCTIVITY_SYSTEM_PROMPT).toContain("Shared files");
  });

  it("covers shared concepts as a dependency signal", () => {
    expect(PRODUCTIVITY_SYSTEM_PROMPT).toContain("Shared concepts");
  });

  it("covers sequential logic as a dependency signal", () => {
    expect(PRODUCTIVITY_SYSTEM_PROMPT).toContain("Sequential logic");
  });

  it("defines dependency chain labels", () => {
    expect(PRODUCTIVITY_SYSTEM_PROMPT).toContain("DEPENDENCY CHAIN LABELS");
    expect(PRODUCTIVITY_SYSTEM_PROMPT).toContain("dependency-chain:NAME");
    expect(PRODUCTIVITY_SYSTEM_PROMPT).toContain("blocks:ISSUE-KEY");
    expect(PRODUCTIVITY_SYSTEM_PROMPT).toContain("depends-on:ISSUE-KEY");
    expect(PRODUCTIVITY_SYSTEM_PROMPT).toContain("standalone");
    expect(PRODUCTIVITY_SYSTEM_PROMPT).toContain("ready-for-agent");
  });

  it("defines execution order rules", () => {
    expect(PRODUCTIVITY_SYSTEM_PROMPT).toContain("EXECUTION ORDER RULES");
    expect(PRODUCTIVITY_SYSTEM_PROMPT).toContain("Foundational first");
    expect(PRODUCTIVITY_SYSTEM_PROMPT).toContain("Security first");
    expect(PRODUCTIVITY_SYSTEM_PROMPT).toContain(
      "Bug fixes before enhancements",
    );
    expect(PRODUCTIVITY_SYSTEM_PROMPT).toContain("Standalone anytime");
    expect(PRODUCTIVITY_SYSTEM_PROMPT).toContain("Respect the chain");
  });

  it("defines dependency comment format", () => {
    expect(PRODUCTIVITY_SYSTEM_PROMPT).toContain("DEPENDENCY COMMENT FORMAT");
    expect(PRODUCTIVITY_SYSTEM_PROMPT).toContain("Dependency Analysis");
    expect(PRODUCTIVITY_SYSTEM_PROMPT).toContain("Recommendation:");
  });

  it("cross-references AGENTS.md as canonical source", () => {
    expect(PRODUCTIVITY_SYSTEM_PROMPT).toContain("AGENTS.md");
    expect(PRODUCTIVITY_SYSTEM_PROMPT).toContain(
      "Dependency Analysis & Prioritization",
    );
  });

  it("is positioned after EFFICIENCY RULES in the prompt", () => {
    const effIdx = PRODUCTIVITY_SYSTEM_PROMPT.indexOf("EFFICIENCY RULES");
    const depIdx = PRODUCTIVITY_SYSTEM_PROMPT.indexOf(
      "DEPENDENCY ANALYSIS RULES",
    );
    const coreIdx = PRODUCTIVITY_SYSTEM_PROMPT.indexOf("CORE PRINCIPLES");
    expect(effIdx).toBeGreaterThan(-1);
    expect(depIdx).toBeGreaterThan(effIdx);
    expect(depIdx).toBeLessThan(coreIdx);
  });
});

describe("TICKET_CREATION_RULES cross-reference", () => {
  it("references the dependency analysis workflow at the end of ticket creation rules", () => {
    expect(PRODUCTIVITY_SYSTEM_PROMPT).toContain(
      "DEPENDENCY ANALYSIS workflow",
    );
  });
});
