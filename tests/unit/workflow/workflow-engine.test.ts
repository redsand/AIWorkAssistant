import { describe, it, expect, beforeEach } from "vitest";
import {
  WorkflowEngine,
  ApprovalRequiredError,
} from "../../../src/workflow/workflow-engine";
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

  describe("approvalRequired enforcement", () => {
    it("blocks execution of an approval-required action when not approved", async () => {
      await expect(
        engine.execute("escalate-hawk-ir-case", {
          caseId: "CASE-1",
          escalationReason: "active intrusion",
        }),
      ).rejects.toBeInstanceOf(ApprovalRequiredError);
    });

    it("blocks when approved is explicitly false", async () => {
      await expect(
        engine.execute(
          "escalate-hawk-ir-case",
          { caseId: "CASE-1", escalationReason: "active intrusion" },
          { approved: false },
        ),
      ).rejects.toBeInstanceOf(ApprovalRequiredError);
    });

    it("does not create an execution when approval is missing", async () => {
      await engine
        .execute("escalate-hawk-ir-case", {
          caseId: "CASE-1",
          escalationReason: "active intrusion",
        })
        .catch(() => undefined);
      // A blocked action must not leave a tracked execution behind.
      const anyExecution = (
        engine as unknown as { executions: Map<string, unknown> }
      ).executions;
      expect(anyExecution.size).toBe(0);
    });

    it("allows execution when approved is true", async () => {
      const execution = await engine.execute(
        "escalate-hawk-ir-case",
        { caseId: "CASE-1", escalationReason: "active intrusion" },
        { approved: true },
      );
      expect(execution.actionId).toBe("escalate-hawk-ir-case");
      expect(execution.status).toBe("running");
    });

    it("does not require approval for low-risk actions", async () => {
      const execution = await engine.execute("daily-standup-prep", {});
      expect(execution.status).toBe("running");
    });
  });

  describe("parameter type validation", () => {
    it("rejects a number parameter supplied as a string", async () => {
      await expect(
        engine.execute("triage-support-ticket", { ticketId: "not-a-number" }),
      ).rejects.toThrow(/expected number, got string/);
    });

    it("rejects a string parameter supplied as a number", async () => {
      await expect(
        engine.execute(
          "escalate-hawk-ir-case",
          { caseId: 123, escalationReason: "reason" },
          { approved: true },
        ),
      ).rejects.toThrow(/expected string, got number/);
    });

    it("rejects a boolean parameter supplied as a string", async () => {
      const local = new WorkflowEngine();
      (local as unknown as { actions: Map<string, unknown> }).actions.set(
        "flagged",
        {
          id: "flagged",
          name: "Flagged",
          description: "test",
          category: "maintenance",
          riskLevel: "low",
          params: [
            {
              name: "dryRun",
              description: "dry run flag",
              type: "boolean",
              required: true,
            },
          ],
          steps: [],
          tags: [],
          version: "1.0.0",
          approvalRequired: false,
        },
      );
      await expect(
        local.execute("flagged", { dryRun: "true" }),
      ).rejects.toThrow(/expected boolean, got string/);
      const ok = await local.execute("flagged", { dryRun: true });
      expect(ok.status).toBe("running");
    });

    it("accepts a correctly typed parameter", async () => {
      const execution = await engine.execute("triage-support-ticket", {
        ticketId: 42,
      });
      expect(execution.status).toBe("running");
    });
  });

  describe("execution status transitions", () => {
    it("transitions a running execution to completed", async () => {
      const execution = await engine.execute("daily-standup-prep", {});
      expect(execution.status).toBe("running");
      expect(execution.completedAt).toBeUndefined();

      const completed = engine.completeExecution(execution.id);
      expect(completed?.status).toBe("completed");
      expect(completed?.completedAt).toBeTruthy();
      expect(engine.getExecution(execution.id)?.status).toBe("completed");
    });

    it("transitions a running execution to failed", async () => {
      const execution = await engine.execute("triage-support-ticket", {
        ticketId: 7,
      });
      expect(execution.status).toBe("running");

      const failed = engine.failExecution(execution.id, "step failed");
      expect(failed?.status).toBe("failed");
      expect(failed?.completedAt).toBeTruthy();
      expect(failed?.stepResults.at(-1)?.error).toBe("step failed");
      expect(engine.getExecution(execution.id)?.status).toBe("failed");
    });

    it("returns undefined when transitioning an unknown execution", () => {
      expect(engine.completeExecution("missing")).toBeUndefined();
      expect(engine.failExecution("missing", "err")).toBeUndefined();
    });
  });

  describe("execution pruning", () => {
    it("caps retained executions at MAX_EXECUTIONS, evicting the oldest", async () => {
      // The cap is 1000; assert the store never exceeds it and the earliest
      // execution is evicted once the cap is reached.
      const first = await engine.execute("daily-standup-prep", {});
      const store = (
        engine as unknown as { executions: Map<string, unknown> }
      ).executions;
      const MAX = 1000;
      for (let i = store.size; i < MAX; i++) {
        await engine.execute("daily-standup-prep", {});
      }
      expect(store.size).toBe(MAX);
      // First entry is still present at exactly the cap.
      expect(engine.getExecution(first.id)).toBeDefined();
      // One more insert evicts the oldest (the first execution).
      await engine.execute("daily-standup-prep", {});
      expect(store.size).toBe(MAX);
      expect(engine.getExecution(first.id)).toBeUndefined();
    });
  });

  describe("identity binding", () => {
    it("records the actor that triggered and approved an action", async () => {
      const execution = await engine.execute(
        "escalate-hawk-ir-case",
        { caseId: "CASE-9", escalationReason: "lateral movement" },
        { approved: true, actor: "alice" },
      );
      expect(execution.triggeredBy).toBe("alice");
      expect(execution.approvedBy).toBe("alice");
    });

    it("does not set approvedBy for actions that do not require approval", async () => {
      const execution = await engine.execute(
        "daily-standup-prep",
        {},
        { actor: "bob" },
      );
      expect(execution.triggeredBy).toBe("bob");
      expect(execution.approvedBy).toBeUndefined();
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
