import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));
vi.mock("child_process", () => ({ spawn: mockSpawn }));

import { runAgentDirect } from "../agent-runner";

/**
 * Regression: claude/codex/opencode all emit NDJSON where agent text lives
 * inside a JSON string. A FIN the model puts on its own line survives JSON
 * encoding as a literal `\n` (backslash + n), not a real newline byte — so
 * checking the FIN regex against raw stdout never finds a whitespace/line
 * boundary around it. Detection must run against the formatter's decoded
 * output, which restores real newlines via JSON.parse.
 */
describe("runAgentDirect — FIN detection against decoded stream output", () => {
  function fakeChild() {
    const child: any = new EventEmitter();
    child.stdin = { write: vi.fn(), end: vi.fn() };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    return child;
  }

  it("detects FIN emitted on its own line inside a JSON-encoded assistant message", async () => {
    mockSpawn.mockReset();
    const child = fakeChild();
    mockSpawn.mockReturnValue(child);

    const resultPromise = runAgentDirect("prompt", {
      agent: "claude",
      workspace: process.cwd(),
    });

    // One NDJSON line: the model's text field contains a real "FIN" on its
    // own line, escaped to \n by JSON encoding — mirrors production output.
    const line = JSON.stringify({ type: "assistant", content: "All done here.\nFIN\n" }) + "\n";
    child.stdout.emit("data", Buffer.from(line));

    // Give the FIN handler's SIGTERM a moment, then close the process.
    await Promise.resolve();
    child.emit("close", 0, null);

    const result = await resultPromise;
    expect(result.finDetected).toBe(true);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("does not falsely detect FIN when the substring appears mid-word", async () => {
    mockSpawn.mockReset();
    const child = fakeChild();
    mockSpawn.mockReturnValue(child);

    const resultPromise = runAgentDirect("prompt", {
      agent: "claude",
      workspace: process.cwd(),
    });

    const line = JSON.stringify({ type: "assistant", content: "Refinement complete, see FINDINGS.md" }) + "\n";
    child.stdout.emit("data", Buffer.from(line));

    await Promise.resolve();
    child.emit("close", 0, null);

    const result = await resultPromise;
    expect(result.finDetected).toBe(false);
    expect(child.kill).not.toHaveBeenCalledWith("SIGTERM");
  });
});
