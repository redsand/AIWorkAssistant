import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Subclass exposes the protected helper for test coverage. The helper lives
// on AIProvider in src/agent/providers/types.ts; we instantiate a minimal
// concrete subclass that doesn't actually call any upstream.
import { AIProvider } from "../types";
import type { ChatRequest, ChatResponse, ProviderCapabilities } from "../types";

class TestProvider extends AIProvider {
  readonly name = "test-provider";
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    toolChoice: "auto",
    parallelToolCalls: false,
    requiresAuth: false,
    synthesizesToolCallIds: false,
  };
  isConfigured() { return true; }
  async validateConfig() { return true; }
  protected async chatImpl(_request: ChatRequest): Promise<ChatResponse> {
    return { content: "", model: "test", done: true };
  }
  protected async *chatStreamImpl() {
    return;
  }
  // Re-expose the protected helper for tests.
  public _installGuard(signal?: AbortSignal) {
    return this.installFirstChunkAbort(signal);
  }
}

const PROVIDER_CONFIG = {
  apiKey: "k",
  baseUrl: "http://localhost",
  model: "m",
  temperature: 0,
  topP: 1,
  maxRetries: 0,
  timeout: 5_000,
};

describe("installFirstChunkAbort", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.AI_FIRST_CHUNK_TIMEOUT_MS;
  });

  afterEach(() => {
    process.env.AI_FIRST_CHUNK_TIMEOUT_MS = originalEnv;
    vi.useRealTimers();
  });

  it("aborts if no chunk arrives before the configured idle timeout", async () => {
    process.env.AI_FIRST_CHUNK_TIMEOUT_MS = "50";
    const p = new TestProvider(PROVIDER_CONFIG);
    const g = p._installGuard();

    expect(g.signal.aborted).toBe(false);
    await new Promise((r) => setTimeout(r, 90));
    expect(g.signal.aborted).toBe(true);
    expect(g.abortReason()).toMatch(/idle timeout/);
    g.dispose();
  });

  it("does NOT abort if onChunk() is called before the timeout", async () => {
    process.env.AI_FIRST_CHUNK_TIMEOUT_MS = "60";
    const p = new TestProvider(PROVIDER_CONFIG);
    const g = p._installGuard();

    await new Promise((r) => setTimeout(r, 20));
    g.onChunk();

    await new Promise((r) => setTimeout(r, 80));
    expect(g.signal.aborted).toBe(false);
    expect(g.abortReason()).toBeUndefined();
    g.dispose();
  });

  it("forwards an already-aborted external signal", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const p = new TestProvider(PROVIDER_CONFIG);
    const g = p._installGuard(ctrl.signal);
    expect(g.signal.aborted).toBe(true);
    expect(g.abortReason()).toMatch(/External cancellation/);
    g.dispose();
  });

  it("forwards a later external abort", async () => {
    process.env.AI_FIRST_CHUNK_TIMEOUT_MS = "10000"; // long, so idle won't fire
    const ctrl = new AbortController();
    const p = new TestProvider(PROVIDER_CONFIG);
    const g = p._installGuard(ctrl.signal);

    expect(g.signal.aborted).toBe(false);
    ctrl.abort();
    expect(g.signal.aborted).toBe(true);
    expect(g.abortReason()).toMatch(/External cancellation/);
    g.dispose();
  });

  it("dispose() is idempotent and prevents the watchdog from firing later", async () => {
    process.env.AI_FIRST_CHUNK_TIMEOUT_MS = "40";
    const p = new TestProvider(PROVIDER_CONFIG);
    const g = p._installGuard();

    g.dispose();
    g.dispose(); // second call no-ops
    await new Promise((r) => setTimeout(r, 80));
    expect(g.signal.aborted).toBe(false);
  });

  it("disables the idle watchdog when AI_FIRST_CHUNK_TIMEOUT_MS=0", async () => {
    process.env.AI_FIRST_CHUNK_TIMEOUT_MS = "0";
    const p = new TestProvider(PROVIDER_CONFIG);
    const g = p._installGuard();
    await new Promise((r) => setTimeout(r, 60));
    expect(g.signal.aborted).toBe(false);
    g.dispose();
  });

  it("preserves the external-cancellation reason even after the watchdog also fires", async () => {
    process.env.AI_FIRST_CHUNK_TIMEOUT_MS = "30";
    const ctrl = new AbortController();
    const p = new TestProvider(PROVIDER_CONFIG);
    const g = p._installGuard(ctrl.signal);

    ctrl.abort();
    // First reason recorded wins (external came in first).
    expect(g.abortReason()).toMatch(/External cancellation/);
    await new Promise((r) => setTimeout(r, 60));
    // Watchdog timer fires too but we keep the original reason.
    expect(g.abortReason()).toMatch(/External cancellation/);
    g.dispose();
  });
});
