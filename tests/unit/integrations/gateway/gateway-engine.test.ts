import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { GatewayEngine } from "../../../../src/integrations/gateway/gateway-engine";
import type { PlatformAdapter, DeliveryResult, IncomingMessage } from "../../../../src/integrations/gateway/platform-adapter";

function waitForFile(filepath: string, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (fs.existsSync(filepath)) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`Timeout waiting for ${filepath}`));
      setTimeout(check, 10);
    };
    check();
  });
}

function createMockAdapter(overrides?: Partial<PlatformAdapter>): PlatformAdapter {
  const sendMock = vi.fn<() => Promise<DeliveryResult>>().mockResolvedValue({
    success: true,
    messageId: "msg-123",
    platform: "mock",
    timestamp: new Date().toISOString(),
    suppressed: false,
  });

  const startMock = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const stopMock = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

  return {
    platform: "mock",
    send: sendMock,
    receive: async function* () {},
    start: startMock,
    stop: stopMock,
    isConnected: () => true,
    ...overrides,
  } as PlatformAdapter & { send: typeof sendMock; start: typeof startMock; stop: typeof stopMock };
}

describe("GatewayEngine", () => {
  let tmpDir: string;
  let engine: GatewayEngine;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-test-"));
    engine = new GatewayEngine(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("adapter management", () => {
    it("registers and retrieves adapters", () => {
      const adapter = createMockAdapter();
      engine.registerAdapter(adapter);
      expect(engine.getAdapter("mock")).toBe(adapter);
      expect(engine.getRegisteredPlatforms()).toEqual(["mock"]);
    });

    it("returns undefined for unknown adapter", () => {
      expect(engine.getAdapter("nonexistent")).toBeUndefined();
    });

    it("lists multiple registered platforms", () => {
      engine.registerAdapter(createMockAdapter({ platform: "telegram" }));
      engine.registerAdapter(createMockAdapter({ platform: "discord" }));
      engine.registerAdapter(createMockAdapter({ platform: "slack" }));
      expect(engine.getRegisteredPlatforms()).toEqual(["telegram", "discord", "slack"]);
    });

    it("overwrites adapter when re-registering same platform", () => {
      const first = createMockAdapter({ platform: "telegram" });
      const second = createMockAdapter({ platform: "telegram" });
      engine.registerAdapter(first);
      engine.registerAdapter(second);
      expect(engine.getAdapter("telegram")).toBe(second);
      expect(engine.getRegisteredPlatforms()).toEqual(["telegram"]);
    });
  });

  describe("start/stop lifecycle", () => {
    it("starts all registered adapters", async () => {
      const adapter = createMockAdapter();
      engine.registerAdapter(adapter);
      await engine.start();
      expect(adapter.start).toHaveBeenCalled();
      expect(engine.isRunning()).toBe(true);
    });

    it("stops all registered adapters", async () => {
      const adapter = createMockAdapter();
      engine.registerAdapter(adapter);
      await engine.start();
      await engine.stop();
      expect(adapter.stop).toHaveBeenCalled();
      expect(engine.isRunning()).toBe(false);
    });

    it("does not double-start", async () => {
      const adapter = createMockAdapter();
      engine.registerAdapter(adapter);
      await engine.start();
      await engine.start();
      expect(adapter.start).toHaveBeenCalledTimes(1);
    });

    it("continues if one adapter fails to start", async () => {
      const goodAdapter = createMockAdapter({ platform: "good" });
      const badAdapter = createMockAdapter({
        platform: "bad",
        start: vi.fn().mockRejectedValue(new Error("fail")),
      });
      engine.registerAdapter(goodAdapter);
      engine.registerAdapter(badAdapter as unknown as PlatformAdapter);
      await engine.start();
      expect(engine.isRunning()).toBe(true);
    });

    it("does not double-stop", async () => {
      const adapter = createMockAdapter();
      engine.registerAdapter(adapter);
      await engine.start();
      await engine.stop();
      await engine.stop();
      expect(adapter.stop).toHaveBeenCalledTimes(1);
    });
  });

  describe("send", () => {
    it("routes message to the correct adapter", async () => {
      const adapter = createMockAdapter({ platform: "telegram" });
      engine.registerAdapter(adapter);
      await engine.start();

      const result = await engine.send("telegram", "user1", "Hello");
      expect(result.success).toBe(true);
      expect(adapter.send).toHaveBeenCalledWith("user1", "Hello", undefined);
    });

    it("passes delivery options to adapter", async () => {
      const adapter = createMockAdapter({ platform: "telegram" });
      engine.registerAdapter(adapter);
      const opts = { parseMode: "markdown" as const, silent: false, replyToMessageId: "42" };
      await engine.send("telegram", "user1", "Hello", opts);
      expect(adapter.send).toHaveBeenCalledWith("user1", "Hello", opts);
    });

    it("suppresses messages containing [SILENT]", async () => {
      const adapter = createMockAdapter({ platform: "telegram" });
      engine.registerAdapter(adapter);

      const result = await engine.send("telegram", "user1", "Secret [SILENT] data");
      expect(result.suppressed).toBe(true);
      expect(result.success).toBe(true);
      expect(adapter.send).not.toHaveBeenCalled();
    });

    it("suppresses when silent option is true", async () => {
      const adapter = createMockAdapter({ platform: "telegram" });
      engine.registerAdapter(adapter);

      const result = await engine.send("telegram", "user1", "Hello", { silent: true });
      expect(result.suppressed).toBe(true);
      expect(adapter.send).not.toHaveBeenCalled();
    });

    it("[SILENT] takes precedence even with message text", async () => {
      const adapter = createMockAdapter({ platform: "telegram" });
      engine.registerAdapter(adapter);

      const result = await engine.send("telegram", "user1", "status update [SILENT]");
      expect(result.suppressed).toBe(true);
      expect(result.platform).toBe("telegram");
    });

    it("returns failure for unknown platform", async () => {
      const result = await engine.send("unknown", "user1", "Hello");
      expect(result.success).toBe(false);
    });

    it("returns failure when adapter throws", async () => {
      const adapter = createMockAdapter({
        platform: "telegram",
        send: vi.fn().mockRejectedValue(new Error("network error")),
      });
      engine.registerAdapter(adapter as unknown as PlatformAdapter);

      const result = await engine.send("telegram", "user1", "Hello");
      expect(result.success).toBe(false);
    });

    it("returns adapter failure when adapter reports unsuccessful result", async () => {
      const adapter = createMockAdapter({
        platform: "telegram",
        send: vi.fn().mockResolvedValue({
          success: false,
          platform: "telegram",
          timestamp: new Date().toISOString(),
          suppressed: false,
        }),
      });
      engine.registerAdapter(adapter as unknown as PlatformAdapter);

      const result = await engine.send("telegram", "user1", "Hello");
      expect(result.success).toBe(false);
    });
  });

  describe("broadcast", () => {
    it("sends to all registered platforms", async () => {
      const telegram = createMockAdapter({ platform: "telegram" });
      const discord = createMockAdapter({ platform: "discord" });
      engine.registerAdapter(telegram);
      engine.registerAdapter(discord);

      const results = await engine.broadcast("Hello!", "user1");
      expect(results).toHaveLength(2);
      expect(telegram.send).toHaveBeenCalledWith("user1", "Hello!", undefined);
      expect(discord.send).toHaveBeenCalledWith("user1", "Hello!", undefined);
    });

    it("sends to specified platforms only", async () => {
      const telegram = createMockAdapter({ platform: "telegram" });
      const discord = createMockAdapter({ platform: "discord" });
      engine.registerAdapter(telegram);
      engine.registerAdapter(discord);

      const results = await engine.broadcast("Hello!", "user1", ["telegram"]);
      expect(results).toHaveLength(1);
    });

    it("handles mixed success and failure in broadcast", async () => {
      const good = createMockAdapter({ platform: "telegram" });
      const bad = createMockAdapter({
        platform: "discord",
        send: vi.fn().mockRejectedValue(new Error("boom")),
      });
      engine.registerAdapter(good);
      engine.registerAdapter(bad as unknown as PlatformAdapter);

      const results = await engine.broadcast("Hello!", "user1");
      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(false);
    });

    it("broadcast respects [SILENT] suppression", async () => {
      const telegram = createMockAdapter({ platform: "telegram" });
      const discord = createMockAdapter({ platform: "discord" });
      engine.registerAdapter(telegram);
      engine.registerAdapter(discord);

      const results = await engine.broadcast("[SILENT] quiet", "user1");
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.suppressed)).toBe(true);
      expect(telegram.send).not.toHaveBeenCalled();
      expect(discord.send).not.toHaveBeenCalled();
    });
  });

  describe("session mapping", () => {
    it("maps and retrieves sessions", () => {
      engine.mapSession("user1", "telegram", "session-abc");
      expect(engine.getSession("user1", "telegram")).toBe("session-abc");
    });

    it("returns undefined for unmapped session", () => {
      expect(engine.getSession("unknown", "telegram")).toBeUndefined();
    });

    it("persists sessions to disk", async () => {
      engine.mapSession("user1", "telegram", "session-abc");
      const filepath = path.join(tmpDir, "sessions.json");
      await waitForFile(filepath);
      const data = JSON.parse(fs.readFileSync(filepath, "utf-8"));
      expect(data).toHaveLength(1);
      expect(data[0].sessionId).toBe("session-abc");
    });

    it("loads sessions from disk on start", async () => {
      engine.mapSession("user1", "telegram", "session-abc");
      const filepath = path.join(tmpDir, "sessions.json");
      await waitForFile(filepath);

      const engine2 = new GatewayEngine(tmpDir);
      await engine2.start();
      expect(engine2.getSession("user1", "telegram")).toBe("session-abc");
    });

    it("finds cross-platform session", () => {
      engine.mapSession("user1", "telegram", "session-abc");
      const found = engine.findSessionCrossPlatform("user1");
      expect(found?.sessionId).toBe("session-abc");
      expect(found?.platform).toBe("telegram");
    });

    it("returns undefined for cross-platform lookup with no sessions", () => {
      expect(engine.findSessionCrossPlatform("nobody")).toBeUndefined();
    });

    it("overwrites session on re-map", () => {
      engine.mapSession("user1", "telegram", "session-old");
      engine.mapSession("user1", "telegram", "session-new");
      expect(engine.getSession("user1", "telegram")).toBe("session-new");
    });

    it("handles corrupt sessions file gracefully", async () => {
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.writeFileSync(path.join(tmpDir, "sessions.json"), "not valid json{");
      const engine2 = new GatewayEngine(tmpDir);
      await engine2.start();
      expect(engine2.getSession("user1", "telegram")).toBeUndefined();
    });
  });

  describe("delivery logging", () => {
    it("appends entries to delivery-log.jsonl", async () => {
      const adapter = createMockAdapter({ platform: "telegram" });
      engine.registerAdapter(adapter);
      await engine.start();

      await engine.send("telegram", "user1", "Hello");

      const logPath = path.join(tmpDir, "delivery-log.jsonl");
      expect(fs.existsSync(logPath)).toBe(true);
      const lines = fs.readFileSync(logPath, "utf-8").trim().split("\n");
      expect(lines).toHaveLength(1);
      const entry = JSON.parse(lines[0]);
      expect(entry.platform).toBe("telegram");
      expect(entry.userId).toBe("user1");
      expect(entry.suppressed).toBe(false);
    });

    it("logs suppressed deliveries", async () => {
      await engine.send("telegram", "user1", "[SILENT] msg");

      const logPath = path.join(tmpDir, "delivery-log.jsonl");
      const lines = fs.readFileSync(logPath, "utf-8").trim().split("\n");
      const entry = JSON.parse(lines[0]);
      expect(entry.suppressed).toBe(true);
    });

    it("logs error for unknown platform", async () => {
      await engine.send("unknown", "user1", "Hello");

      const logPath = path.join(tmpDir, "delivery-log.jsonl");
      const lines = fs.readFileSync(logPath, "utf-8").trim().split("\n");
      const entry = JSON.parse(lines[0]);
      expect(entry.error).toContain("No adapter registered");
    });

    it("logs error when adapter throws", async () => {
      const adapter = createMockAdapter({
        platform: "telegram",
        send: vi.fn().mockRejectedValue(new Error("connection lost")),
      });
      engine.registerAdapter(adapter as unknown as PlatformAdapter);

      await engine.send("telegram", "user1", "Hello");

      const logPath = path.join(tmpDir, "delivery-log.jsonl");
      const lines = fs.readFileSync(logPath, "utf-8").trim().split("\n");
      const entry = JSON.parse(lines[0]);
      expect(entry.error).toBe("connection lost");
    });

    it("appends multiple log entries", async () => {
      const adapter = createMockAdapter({ platform: "telegram" });
      engine.registerAdapter(adapter);

      await engine.send("telegram", "user1", "First");
      await engine.send("telegram", "user2", "Second");

      const logPath = path.join(tmpDir, "delivery-log.jsonl");
      const lines = fs.readFileSync(logPath, "utf-8").trim().split("\n");
      expect(lines).toHaveLength(2);
    });
  });
});
