import { describe, expect, it } from "vitest";
import { guardrailsRegistry, RiskLevel } from "../../../src/guardrails/action-registry";

describe("HAWK IR P2 guardrails", () => {
  it("configures P2 write tools per the approval matrix", () => {
    const expectations = [
      ["hawk_ir.merge_cases", RiskLevel.HIGH, true, false, true, false],
      ["hawk_ir.rename_case", RiskLevel.LOW, true, false, false, false],
      ["hawk_ir.update_case_details", RiskLevel.MEDIUM, true, false, false, false],
      ["hawk_ir.set_case_categories", RiskLevel.MEDIUM, true, false, false, false],
      ["hawk_ir.add_ignore_label", RiskLevel.HIGH, true, false, true, false],
      ["hawk_ir.delete_ignore_label", RiskLevel.HIGH, true, false, true, false],
    ] as const;

    for (const [id, riskLevel, approval, mfa, justification, dryRun] of expectations) {
      const action = guardrailsRegistry.getAction(id);
      expect(action).toBeDefined();
      expect(action?.riskLevel).toBe(riskLevel);
      expect(action?.requiresApproval).toBe(approval);
      expect(action?.requiresMFA).toBe(mfa);
      expect(action?.requiresJustification).toBe(justification);
      expect(action?.requiresDryRun).toBe(dryRun);
    }
  });
});
