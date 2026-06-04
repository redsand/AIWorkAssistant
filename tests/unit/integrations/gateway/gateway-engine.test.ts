import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { GatewayEngine } from "../../../../src/integrations/gateway/gateway-engine";
import type { PlatformAdapter, DeliveryResult, IncomingMessage } from "../../../../src/integrations/gateway/platform-adapter";

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
  });

  describe("session mapping", () => {
    it("maps and retrieves sessions", () => {
      engine.mapSession("user1", "telegram", "session-abc");
      expect(engine.getSession("user1", "telegram")).toBe("session-abc");
    });

    it("persists sessions to disk", () => {
      engine.mapSession("user1", "telegram", "session-abc");
      const filepath = path.join(tmpDir, "sessions.json");
      expect(fs.existsSync(filepath)).toBe(true);
      const data = JSON.parse(fs.readFileSync(filepath, "utf-8"));
      expect(data).toHaveLength(1);
      expect(data[0].sessionId).toBe("session-abc");
    });

    it("loads sessions from disk on start", async () => {
      engine.mapSession("user1", "telegram", "session-abc");
      await engine.stop();

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
  });
});
