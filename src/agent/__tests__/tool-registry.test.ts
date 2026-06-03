import { describe, it, expect } from "vitest";
import { getToolByName, getToolCategories, getToolsByCategory } from "../tool-registry";

describe("tool-registry memory.manage schema", () => {
  const mode = "productivity";

  it("should find memory.manage tool by name", () => {
    const tool = getToolByName("memory.manage", mode);
    expect(tool).toBeDefined();
    expect(tool!.name).toBe("memory.manage");
  });

  it("should have the correct actionType", () => {
    const tool = getToolByName("memory.manage", mode);
    expect(tool!.actionType).toBe("memory.manage");
  });

  it("should have medium risk level", () => {
    const tool = getToolByName("memory.manage", mode);
    expect(tool!.riskLevel).toBe("medium");
  });

  it("should mark action as required", () => {
    const tool = getToolByName("memory.manage", mode);
    expect(tool!.params.action.required).toBe(true);
  });

  it("should define action as string type", () => {
    const tool = getToolByName("memory.manage", mode);
    expect(tool!.params.action.type).toBe("string");
  });

  it("should enumerate valid actions in the action description", () => {
    const tool = getToolByName("memory.manage", mode);
    const desc = tool!.params.action.description;
    for (const action of ["add", "replace", "remove", "consolidate", "status"]) {
      expect(desc).toContain(action);
    }
  });

  it("should define key parameter as string type", () => {
    const tool = getToolByName("memory.manage", mode);
    expect(tool!.params.key.type).toBe("string");
  });

  it("should define value parameter as string type", () => {
    const tool = getToolByName("memory.manage", mode);
    expect(tool!.params.value.type).toBe("string");
  });

  it("should define target parameter as string type", () => {
    const tool = getToolByName("memory.manage", mode);
    expect(tool!.params.target.type).toBe("string");
  });

  it("should describe target options (memory/user)", () => {
    const tool = getToolByName("memory.manage", mode);
    const desc = tool!.params.target.description.toLowerCase();
    expect(desc).toContain("memory");
    expect(desc).toContain("user");
  });

  it("should define source_keys as string type (comma-separated)", () => {
    const tool = getToolByName("memory.manage", mode);
    expect(tool!.params.source_keys.type).toBe("string");
    expect(tool!.params.source_keys.description).toContain("Comma");
  });

  it("should define merged_key as string type", () => {
    const tool = getToolByName("memory.manage", mode);
    expect(tool!.params.merged_key.type).toBe("string");
  });

  it("should define merged_value as string type", () => {
    const tool = getToolByName("memory.manage", mode);
    expect(tool!.params.merged_value.type).toBe("string");
  });

  it("should have action as the only required parameter", () => {
    const tool = getToolByName("memory.manage", mode);
    const requiredParams = Object.entries(tool!.params)
      .filter(([, def]) => def.required)
      .map(([name]) => name);
    expect(requiredParams).toEqual(["action"]);
  });

  it("should have all expected parameters", () => {
    const tool = getToolByName("memory.manage", mode);
    const paramNames = Object.keys(tool!.params);
    expect(paramNames).toContain("action");
    expect(paramNames).toContain("key");
    expect(paramNames).toContain("value");
    expect(paramNames).toContain("target");
    expect(paramNames).toContain("source_keys");
    expect(paramNames).toContain("merged_key");
    expect(paramNames).toContain("merged_value");
  });

  it("should be available in productivity mode", () => {
    const tool = getToolByName("memory.manage", mode);
    expect(tool).toBeDefined();
  });

  it("should be available in engineering mode", () => {
    const tool = getToolByName("memory.manage", "engineering");
    expect(tool).toBeDefined();
  });

  it("should include memory tools in tool categories", () => {
    const categories = getToolCategories(mode);
    const categoryNames = Object.keys(categories);
    // memory.manage should appear in some category
    const allTools = categoryNames.flatMap((cat) => getToolsByCategory(mode, cat));
    const memoryManage = allTools.find((t) => t.name === "memory.manage");
    expect(memoryManage).toBeDefined();
  });
});
