import { describe, it, expect, beforeEach } from "vitest";
import { WorkflowEngine } from "../../../src/workflow/workflow-engine";
import { builtinActions } from "../../../src/workflow/builtin-actions";

describe("WorkflowEngine", () => {
  let engine: WorkflowEngine;

  beforeEach(() => {
    engine = new WorkflowEngine();
  });

  describe("listActions", () => {
    it("returns all built-in actions", () => {
      const { actions } = engine.listActions();
      expect(actions).toHaveLength(builtinActions.length);
      const ids = actions.map((a) => a.id).sort();
      expect(ids).toEqual(builtinActions.map((a) => a.id).sort());
    });

    it("exposes description, risk level and required-parameter metadata", () => {
      const { actions } = engine.listActions();
      for (const action of actions) {
        expect(action.description.length).toBeGreaterThan(0);
        expect(["low", "medium", "high"]).toContain(action.riskLevel);
        expect(typeof action.approvalRequired).toBe("boolean");
        expect(Array.isArray(action.tags)).toBe(true);
      }
    });
  });

  describe("getAction", () => {
    it("returns an action by id", () => {
      const action = engine.getAction("daily-standup-prep");
      expect(action).toBeDefined();
      expect(action?.id).toBe("daily-standup-prep");
      expect(action?.params.find((p) => p.name === "date")).toBeDefined();
    });

    it("returns undefined for an unknown id", () => {
      expect(engine.getAction("does-not-exist")).toBeUndefined();
    });
  });

  describe("execute", () => {
    it("throws for an unknown action id", async () => {
      await expect(engine.execute("nope", {})).rejects.toThrow(
        /Workflow action not found/,
      );
    });

    it("throws when a required parameter is missing and has no default", async () => {
      await expect(engine.execute("triage-support-ticket", {})).rejects.toThrow(
        /Missing required parameter: ticketId/,
      );
    });

    it("fills required parameters from defaults instead of throwing", async () => {
      const execution = await engine.execute("daily-standup-prep", {});
      expect(execution.params.date).toBe("today");
    });

    it("creates an execution with running status and tracked params", async () => {
      const execution = await engine.execute("triage-support-ticket", {
        ticketId: 42,
      });
      expect(execution.id).toBeTruthy();
      expect(execution.actionId).toBe("triage-support-ticket");
      expect(execution.status).toBe("running");
      expect(execution.startedAt).toBeTruthy();
      expect(execution.stepResults).toEqual([]);
      expect(execution.params.ticketId).toBe(42);
    });

    it("validates allowed values and throws on an invalid value", async () => {
      const local = new WorkflowEngine();
      // Inject an action with an allowedValues constraint via the public map seed.
      (local as unknown as { actions: Map<string, unknown> }).actions.set(
        "constrained",
        {
          id: "constrained",
          name: "Constrained",
          description: "test",
          category: "maintenance",
          riskLevel: "low",
          params: [
            {
              name: "mode",
              description: "mode",
              type: "string",
              required: true,
              allowedValues: ["a", "b"],
            },
          ],
          steps: [],
          tags: [],
          version: "1.0.0",
          approvalRequired: false,
        },
      );

      await expect(local.execute("constrained", { mode: "z" })).rejects.toThrow(
        /Invalid value for mode/,
      );
      const ok = await local.execute("constrained", { mode: "a" });
      expect(ok.status).toBe("running");
    });
  });

  describe("getExecution", () => {
    it("retrieves a previously created execution", async () => {
      const execution = await engine.execute("daily-standup-prep", {});
      expect(engine.getExecution(execution.id)?.id).toBe(execution.id);
    });

    it("returns undefined for an unknown execution id", () => {
      expect(engine.getExecution("missing")).toBeUndefined();
    });
  });

  describe("immutability", () => {
    it("freezes built-in actions so they cannot be modified at runtime", () => {
      const action = engine.getAction("escalate-hawk-ir-case")!;
      expect(Object.isFrozen(action)).toBe(true);
      expect(() => {
        (action as unknown as { riskLevel: string }).riskLevel = "low";
      }).toThrow();
      expect(action.riskLevel).toBe("medium");
    });

    it("freezes nested params and steps", () => {
      const action = engine.getAction("daily-standup-prep")!;
      expect(Object.isFrozen(action.params)).toBe(true);
      expect(Object.isFrozen(action.steps)).toBe(true);
      expect(Object.isFrozen(action.params[0])).toBe(true);
    });
  });
});
