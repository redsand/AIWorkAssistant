import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { AgentMemory } from "../../../src/memory/agent-memory";

describe("AgentMemory", () => {
  it("stores entries and exposes prompt snapshots", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agent-memory-"));
    const memory = new AgentMemory(dir);

    try {
      expect(memory.add("memory", "root_origin", "tool result history must stay paired")).toEqual({ success: true });
      expect(memory.add("user", "prefers_visibility", "errors should be queryable")).toEqual({ success: true });

      expect(memory.getMemorySnapshot()).toContain("§ root_origin");
      expect(memory.getMemorySnapshot()).toContain("tool result history must stay paired");
      expect(memory.getUserSnapshot()).toContain("§ prefers_visibility");
      expect(memory.getUserSnapshot()).toContain("errors should be queryable");
      expect(memory.getUsage("memory").used).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists markdown entries between instances", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agent-memory-"));

    try {
      const first = new AgentMemory(dir);
      expect(first.add("memory", "provider_payload", "strip internal message metadata")).toEqual({ success: true });

      const second = new AgentMemory(dir);
      expect(second.getEntries("memory")).toMatchObject([
        { key: "provider_payload", value: "strip internal message metadata" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
