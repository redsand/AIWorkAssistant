import { describe, it, expect } from "vitest";
import { DEFAULT_POLICIES } from "../../src/config/policy";
import { guardrailsRegistry, RiskLevel, ActionCategory } from "../../src/guardrails/action-registry";
import { getToolByName } from "../../src/agent/tool-registry";
import { dispatchToolCall } from "../../src/agent/tool-dispatcher";

describe("hawk_ir.create_case integration", () => {
  it("registers a policy rule requiring approval at medium risk", () => {
    const rule = DEFAULT_POLICIES.find((p) => p.pattern === "hawk_ir.create_case");
    expect(rule).toBeDefined();
    expect(rule?.riskLevel).toBe("medium");
    expect(rule?.defaultResult).toBe("approval_required");
  });

  it("registers an action-registry entry with correct risk level and rate limits", () => {
    const action = guardrailsRegistry.getAction("hawk_ir.create_case");
    expect(action).toBeDefined();
    expect(action?.riskLevel).toBe(RiskLevel.MEDIUM);
    expect(action?.category).toBe(ActionCategory.SECURITY_CHANGE);
    expect(action?.operation).toBe("hawk_ir.case.create");
    expect(action?.requiresApproval).toBe(true);
    expect(action?.requiresMFA).toBe(false);
    expect(action?.rateLimits).toEqual({ maxPerHour: 20, maxPerDay: 50 });
    expect(action?.allowedRoles).toEqual(["admin", "soc", "analyst"]);
  });

  it("exposes the tool in the productivity registry with required params", () => {
    const tool = getToolByName("hawk_ir.create_case", "productivity");
    expect(tool).toBeDefined();
    expect(tool?.riskLevel).toBe("medium");
    expect(tool?.actionType).toBe("hawk_ir.create_case");
    expect(tool?.params.name?.required).toBe(true);
    expect(tool?.params.events?.required).toBe(true);
  });

  it("returns a dry-run preview without performing an external write", async () => {
    const result = await dispatchToolCall(
      "hawk_ir.create_case",
      {
        name: "Entra Identity Protection Risk State Set",
        events: [{ alert_name: "Risky sign-in" }, { alert_name: "Atypical travel" }],
        risk_level: "High",
        tags: ["entra"],
        mitre: ["T1078"],
        dryRun: true,
      },
      "user",
      true,
    );

    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(true);
    const data = result.data as any;
    expect(data.wouldExecute).toBe(true);
    expect(data.toolName).toBe("hawk_ir.create_case");
    expect(data.summary).toContain("2 event(s)");
    expect(data.targetSystem).toBe("hawk_ir");
    expect(data.riskLevel).toBe("medium");
  });
});
