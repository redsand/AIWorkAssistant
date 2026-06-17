// tests/integration/skill-hub-tool.test.ts
//
// Verifies the skill.hub tool is wired end-to-end: registered in the tool
// registry with the expected schema/risk level, and present in the dispatcher's
// handler map so a model-issued skill.hub call can be routed.
import { describe, it, expect } from "vitest";
import { getToolByName } from "../../src/agent/tool-registry";
import { getAvailableTools } from "../../src/agent/tool-dispatcher";

describe("skill.hub tool wiring", () => {
  it("is registered in the tool registry with a high risk level", () => {
    const tool = getToolByName("skill.hub", "engineering");
    expect(tool).toBeDefined();
    expect(tool?.actionType).toBe("skill.hub");
    // Publishing pushes to a shared public repo, so the tool must be high risk.
    expect(tool?.riskLevel).toBe("high");
  });

  it("documents the action parameter as required", () => {
    const tool = getToolByName("skill.hub", "engineering");
    expect(tool?.params?.action?.required).toBe(true);
    expect(tool?.params?.action?.description).toMatch(
      /search.*install.*promote.*publish.*list.*remove/,
    );
  });

  it("is reachable through the dispatcher handler map", () => {
    expect(getAvailableTools()).toContain("skill.hub");
  });
});
