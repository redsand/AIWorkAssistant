import { describe, it, expect } from "vitest";
import { getToolByName, getToolCategories, getToolsByCategory } from "../tool-registry";

describe("tool-registry skill.manage schema", () => {
  const mode = "productivity";

  it("should find skill.manage tool by name", () => {
    const tool = getToolByName("skill.manage", mode);
    expect(tool).toBeDefined();
    expect(tool!.name).toBe("skill.manage");
  });

  it("should have the correct actionType", () => {
    const tool = getToolByName("skill.manage", mode);
    expect(tool!.actionType).toBe("skill.manage");
  });

  it("should have medium risk level", () => {
    const tool = getToolByName("skill.manage", mode);
    expect(tool!.riskLevel).toBe("medium");
  });

  it("should mark action as required", () => {
    const tool = getToolByName("skill.manage", mode);
    expect(tool!.params.action.required).toBe(true);
  });

  it("should enumerate valid actions in the action description", () => {
    const tool = getToolByName("skill.manage", mode);
    const desc = tool!.params.action.description;
    for (const action of ["create", "patch", "edit", "delete", "list", "search", "load"]) {
      expect(desc).toContain(action);
    }
  });

  it("should define skill_path as string type", () => {
    const tool = getToolByName("skill.manage", mode);
    expect(tool!.params.skill_path.type).toBe("string");
  });

  it("should define body as string type", () => {
    const tool = getToolByName("skill.manage", mode);
    expect(tool!.params.body.type).toBe("string");
  });

  it("should have only action as required at schema level (other fields validated per-action in handler)", () => {
    const tool = getToolByName("skill.manage", mode);
    const requiredParams = Object.entries(tool!.params)
      .filter(([, def]) => def.required)
      .map(([name]) => name)
      .sort();
    expect(requiredParams).toEqual(["action"].sort());
  });

  it("should define name, description, category, and body as string types for create", () => {
    const tool = getToolByName("skill.manage", mode);
    expect(tool!.params.name.type).toBe("string");
    expect(tool!.params.description.type).toBe("string");
    expect(tool!.params.category.type).toBe("string");
    expect(tool!.params.body.type).toBe("string");
  });

  it("should describe per-action requirements in field descriptions", () => {
    const tool = getToolByName("skill.manage", mode);
    expect(tool!.params.name.description).toContain("required for create");
    expect(tool!.params.description.description).toContain("required for create");
    expect(tool!.params.category.description).toContain("required for create");
    expect(tool!.params.body.description).toContain("required for create");
  });

  it("should be available in engineering mode", () => {
    const tool = getToolByName("skill.manage", "engineering");
    expect(tool).toBeDefined();
  });
});

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
