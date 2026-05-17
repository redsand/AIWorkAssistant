import { describe, it, expect } from "vitest";
import {
  getPlatformForToolName,
  getPlatformForTool,
  getToolsByPlatform,
  getToolByName,
} from "../../../src/agent/tool-registry";
import type { Tool } from "../../../src/agent/tool-registry";

describe("getPlatformForToolName", () => {
  it("maps github.* tools to github platform", () => {
    expect(getPlatformForToolName("github.list_repos")).toBe("github");
    expect(getPlatformForToolName("github.create_issue")).toBe("github");
    expect(getPlatformForToolName("github.merge_pull_request")).toBe("github");
  });

  it("maps gitlab.* tools to gitlab platform", () => {
    expect(getPlatformForToolName("gitlab.list_projects")).toBe("gitlab");
    expect(getPlatformForToolName("gitlab.merge_merge_request")).toBe("gitlab");
  });

  it("maps jira.* tools to jira platform", () => {
    expect(getPlatformForToolName("jira.get_issue")).toBe("jira");
    expect(getPlatformForToolName("jira.create_issue")).toBe("jira");
  });

  it("maps calendar.* tools to calendar platform", () => {
    expect(getPlatformForToolName("calendar.list_events")).toBe("calendar");
  });

  it("maps web.* tools to web platform", () => {
    expect(getPlatformForToolName("web.search")).toBe("web");
  });

  it("maps lsp.* tools to lsp platform", () => {
    expect(getPlatformForToolName("lsp.diagnostics")).toBe("lsp");
  });

  it("maps codex.* to codex platform", () => {
    expect(getPlatformForToolName("codex.run")).toBe("codex");
  });

  it("maps mcp.* to mcp platform", () => {
    expect(getPlatformForToolName("mcp.call_tool")).toBe("mcp");
  });

  it("maps local.* to local platform", () => {
    expect(getPlatformForToolName("local.read_file")).toBe("local");
  });

  it("maps productivity.* to cross-platform", () => {
    expect(getPlatformForToolName("productivity.generate_daily_plan")).toBe("cross-platform");
  });

  it("maps todo.* to cross-platform", () => {
    expect(getPlatformForToolName("todo.create_list")).toBe("cross-platform");
  });

  it("maps knowledge.* to cross-platform", () => {
    expect(getPlatformForToolName("knowledge.store")).toBe("cross-platform");
  });

  it("maps system.* to cross-platform", () => {
    expect(getPlatformForToolName("system.check_health")).toBe("cross-platform");
  });

  it("maps agent.* to cross-platform", () => {
    expect(getPlatformForToolName("agent.spawn")).toBe("cross-platform");
  });

  it("maps engineering.* to cross-platform", () => {
    expect(getPlatformForToolName("engineering.workflow_brief")).toBe("cross-platform");
    expect(getPlatformForToolName("engineering.ticket_to_task")).toBe("cross-platform");
  });

  it("maps roadmap.* to cross-platform", () => {
    expect(getPlatformForToolName("roadmap.create")).toBe("cross-platform");
  });

  it("maps workflow.* to cross-platform", () => {
    expect(getPlatformForToolName("workflow.create")).toBe("cross-platform");
  });

  it("maps graph.* to cross-platform", () => {
    expect(getPlatformForToolName("graph.add_node")).toBe("cross-platform");
  });

  it("maps codebase.* to cross-platform", () => {
    expect(getPlatformForToolName("codebase.search")).toBe("cross-platform");
  });

  it("maps discover_tools to cross-platform", () => {
    expect(getPlatformForToolName("discover_tools")).toBe("cross-platform");
  });

  it("maps musician.* to cross-platform", () => {
    expect(getPlatformForToolName("musician.explain_theory")).toBe("cross-platform");
    expect(getPlatformForToolName("musician.compose")).toBe("cross-platform");
    expect(getPlatformForToolName("musician.generate_sample")).toBe("cross-platform");
    expect(getPlatformForToolName("musician.analyze_audio")).toBe("cross-platform");
    expect(getPlatformForToolName("musician.transcribe_audio")).toBe("cross-platform");
    expect(getPlatformForToolName("musician.practice_plan")).toBe("cross-platform");
  });

  it("maps audio.* to cross-platform", () => {
    expect(getPlatformForToolName("audio.analyze")).toBe("cross-platform");
    expect(getPlatformForToolName("audio.generate")).toBe("cross-platform");
  });

  it("maps unknown prefixes to cross-platform", () => {
    expect(getPlatformForToolName("foobar.something")).toBe("cross-platform");
  });
});

describe("engineering tool registration", () => {
  it("registers ticket-to-task in engineering mode", () => {
    const tool = getToolByName("engineering.ticket_to_task", "engineering");
    expect(tool).toBeDefined();
    expect(tool?.riskLevel).toBe("low");
    expect(tool?.actionType).toBe("engineering.ticket_to_task");
    expect(tool?.params.issueNumber.required).toBe(true);
  });
});

describe("musician tool registration", () => {
  it("registers all musician tools in musician mode", () => {
    const expected = [
      ["musician.explain_theory", "low", "musician.theory.explain"],
      ["musician.compose", "low", "musician.composition.create"],
      ["musician.generate_sample", "medium", "musician.sample.generate"],
      ["musician.analyze_audio", "low", "musician.audio.analyze"],
      ["musician.transcribe_audio", "low", "musician.audio.transcribe"],
      ["musician.practice_plan", "low", "musician.practice.plan"],
    ] as const;

    for (const [name, riskLevel, actionType] of expected) {
      const tool = getToolByName(name, "musician");
      expect(tool).toBeDefined();
      expect(tool?.riskLevel).toBe(riskLevel);
      expect(tool?.actionType).toBe(actionType);
    }
  });

  it("musician.explain_theory has correct parameters", () => {
    const tool = getToolByName("musician.explain_theory", "musician");
    expect(tool).toBeDefined();
    expect(tool?.params.topic.required).toBe(true);
    expect(tool?.params.skillLevel.required).toBe(false);
    expect(tool?.params.includeExercises?.type).toBe("boolean");
  });

  it("musician.generate_sample allows dry-run mode", () => {
    const tool = getToolByName("musician.generate_sample", "musician");
    expect(tool).toBeDefined();
    expect(tool?.params.dryRun?.type).toBe("boolean");
  });
});

describe("HAWK IR P2 tool registration", () => {
  it("registers case management and ignore-label tools", () => {
    const expected = [
      ["hawk_ir.merge_cases", "high"],
      ["hawk_ir.rename_case", "low"],
      ["hawk_ir.update_case_details", "medium"],
      ["hawk_ir.set_case_categories", "medium"],
      ["hawk_ir.add_ignore_label", "high"],
      ["hawk_ir.delete_ignore_label", "high"],
      ["hawk_ir.get_case_categories", "low"],
      ["hawk_ir.get_case_labels", "low"],
    ] as const;

    for (const [name, riskLevel] of expected) {
      const tool = getToolByName(name, "productivity");
      expect(tool).toBeDefined();
      expect(tool?.riskLevel).toBe(riskLevel);
      expect(tool?.actionType).toBe(name);
    }
  });
});

describe("getPlatformForTool", () => {
  it("uses explicit platform field when set", () => {
    const tool: Tool = {
      name: "custom.tool",
      description: "Custom tool",
      params: {},
      actionType: "custom.action",
      riskLevel: "low",
      platform: "github",
    };
    expect(getPlatformForTool(tool)).toBe("github");
  });

  it("derives from name when platform is not set", () => {
    const tool: Tool = {
      name: "jira.get_issue",
      description: "Get Jira issue",
      params: {},
      actionType: "jira.issue.read",
      riskLevel: "low",
    };
    expect(getPlatformForTool(tool)).toBe("jira");
  });
});

describe("getToolsByPlatform", () => {
  it("returns only github tools for github platform", () => {
    const tools = getToolsByPlatform("productivity", "github");
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.name.startsWith("github.")).toBe(true);
    }
  });

  it("returns only jira tools for jira platform", () => {
    const tools = getToolsByPlatform("productivity", "jira");
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.name.startsWith("jira.")).toBe(true);
    }
  });

  it("returns only gitlab tools for gitlab platform", () => {
    const tools = getToolsByPlatform("productivity", "gitlab");
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.name.startsWith("gitlab.")).toBe(true);
    }
  });

  it("returns cross-platform tools for cross-platform platform", () => {
    const tools = getToolsByPlatform("productivity", "cross-platform");
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      const prefix = tool.name.split(".")[0];
      expect(["productivity", "todo", "knowledge", "system", "agent", "workflow", "roadmap", "engineering", "codebase", "graph", "discover", "work_items", "cto", "personal_os", "product", "memory", "hawk_ir", "code_review"]).toContain(prefix);
    }
  });
});
