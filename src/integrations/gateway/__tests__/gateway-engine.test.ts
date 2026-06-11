import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "path";
import os from "os";
import fs from "fs/promises";
import { GatewayEngine, sanitizeMessage } from "../gateway-engine";
import type { PlatformAdapter, DeliveryResult } from "../platform-adapter";

function makeAdapter(platform: string, overrides?: Partial<PlatformAdapter>): PlatformAdapter {
  const sendFn = vi.fn<() => Promise<DeliveryResult>>().mockResolvedValue({
    success: true,
    messageId: "msg-1",
    platform,
    timestamp: new Date().toISOString(),
    suppressed: false,
  });

  return {
    platform,
    start: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    stop: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    send: sendFn,
    receive: vi.fn(),
    ...overrides,
  };
}

describe("GatewayEngine", () => {
  let engine: GatewayEngine;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-test-"));
    engine = new GatewayEngine(tmpDir);
  });

  describe("registerAdapter / getAdapter", () => {
    it("registers and retrieves an adapter", () => {
      const adapter = makeAdapter("telegram");
      engine.registerAdapter(adapter);
      expect(engine.getAdapter("telegram")).toBe(adapter);
    });

    it("lists registered platforms", () => {
      engine.registerAdapter(makeAdapter("telegram"));
      engine.registerAdapter(makeAdapter("slack"));
      expect(engine.getRegisteredPlatforms()).toEqual(["telegram", "slack"]);
    });

    it("returns undefined for unregistered platform", () => {
      expect(engine.getAdapter("discord")).toBeUndefined();
    });
  });

  describe("send", () => {
    it("delegates to the adapter and returns success", async () => {
      const adapter = makeAdapter("telegram");
      engine.registerAdapter(adapter);

      const result = await engine.send("telegram", "user-1", "Hello!");
      expect(result.success).toBe(true);
      expect(result.platform).toBe("telegram");
      expect(adapter.send).toHaveBeenCalledWith("user-1", "Hello!", undefined);
    });

    it("passes delivery options to adapter", async () => {
      const adapter = makeAdapter("slack");
      engine.registerAdapter(adapter);

      await engine.send("slack", "user-1", "Hello!", {
        parseMode: "markdown",
        silent: false,
      });
      expect(adapter.send).toHaveBeenCalledWith("user-1", "Hello!", {
        parseMode: "markdown",
        silent: false,
      });
    });

    it("returns suppressed result when message contains [SILENT]", async () => {
      const adapter = makeAdapter("telegram");
      engine.registerAdapter(adapter);

      const result = await engine.send("telegram", "user-1", "Hidden [SILENT]");
      expect(result.success).toBe(true);
      expect(result.suppressed).toBe(true);
      expect(adapter.send).not.toHaveBeenCalled();
    });

    it("returns suppressed result when silent option is true", async () => {
      const adapter = makeAdapter("telegram");
      engine.registerAdapter(adapter);

      const result = await engine.send("telegram", "user-1", "Hello", { silent: true });
      expect(result.suppressed).toBe(true);
      expect(adapter.send).not.toHaveBeenCalled();
    });

    it("returns failure when no adapter is registered", async () => {
      const result = await engine.send("discord", "user-1", "Hello");
      expect(result.success).toBe(false);
      expect(result.suppressed).toBe(false);
    });

    it("returns failure when adapter throws", async () => {
      const adapter = makeAdapter("telegram", {
        send: vi.fn().mockRejectedValue(new Error("network error")),
      });
      engine.registerAdapter(adapter);

      const result = await engine.send("telegram", "user-1", "Hello");
      expect(result.success).toBe(false);
    });

    it("returns failure when adapter reports failure", async () => {
      const adapter = makeAdapter("telegram", {
        send: vi.fn().mockResolvedValue({
          success: false,
          platform: "telegram",
          timestamp: new Date().toISOString(),
          suppressed: false,
        }),
      });
      engine.registerAdapter(adapter);

      const result = await engine.send("telegram", "user-1", "Hello");
      expect(result.success).toBe(false);
    });

    it("rejects messages exceeding platform limit", async () => {
      const adapter = makeAdapter("telegram");
      engine.registerAdapter(adapter);

      const longMsg = "x".repeat(5000); // telegram limit is 4096
      const result = await engine.send("telegram", "user-1", longMsg);
      expect(result.success).toBe(false);
      expect(adapter.send).not.toHaveBeenCalled();
    });
  });

  describe("broadcast", () => {
    it("sends to all registered platforms", async () => {
      const telegram = makeAdapter("telegram");
      const slack = makeAdapter("slack");
      engine.registerAdapter(telegram);
      engine.registerAdapter(slack);

      const results = await engine.broadcast("Announcement!", "user-1");
      expect(results).toHaveLength(2);
      expect(telegram.send).toHaveBeenCalledWith("user-1", "Announcement!", undefined);
      expect(slack.send).toHaveBeenCalledWith("user-1", "Announcement!", undefined);
    });

    it("sends to specified platforms only", async () => {
      const telegram = makeAdapter("telegram");
      const slack = makeAdapter("slack");
      engine.registerAdapter(telegram);
      engine.registerAdapter(slack);

      const results = await engine.broadcast("Announcement!", "user-1", ["telegram"]);
      expect(results).toHaveLength(1);
      expect(telegram.send).toHaveBeenCalled();
      expect(slack.send).not.toHaveBeenCalled();
    });

    it("suppresses broadcast to all platforms with [SILENT]", async () => {
      const telegram = makeAdapter("telegram");
      engine.registerAdapter(telegram);

      const results = await engine.broadcast("[SILENT] suppressed", "user-1");
      expect(results[0].suppressed).toBe(true);
    });
  });

  describe("session mapping", () => {
    it("maps and retrieves a session", () => {
      engine.mapSession("user-1", "telegram", "session-abc");
      expect(engine.getSession("user-1", "telegram")).toBe("session-abc");
    });

    it("returns undefined for unknown session", () => {
      expect(engine.getSession("user-1", "telegram")).toBeUndefined();
    });

    it("finds cross-platform session", () => {
      engine.mapSession("user-1", "telegram", "session-tg");
      engine.mapSession("user-1", "slack", "session-sl");

      const found = engine.findSessionCrossPlatform("user-1");
      expect(found).toBeDefined();
      expect(found!.userId).toBe("user-1");
    });

    it("returns undefined for unknown user in cross-platform search", () => {
      expect(engine.findSessionCrossPlatform("unknown")).toBeUndefined();
    });

    it("overwrites existing session for same key", () => {
      engine.mapSession("user-1", "telegram", "session-old");
      engine.mapSession("user-1", "telegram", "session-new");
      expect(engine.getSession("user-1", "telegram")).toBe("session-new");
    });
  });

  describe("delivery metrics", () => {
    it("tracks sent, failed, and suppressed counts", async () => {
      const adapter = makeAdapter("telegram");
      engine.registerAdapter(adapter);

      await engine.send("telegram", "user-1", "Hello"); // sent
      await engine.send("telegram", "user-1", "Hidden [SILENT]"); // suppressed
      await engine.send("discord", "user-1", "Hello"); // failed (no adapter)

      const metrics = engine.getMetrics();
      expect(metrics.totalSent).toBe(1);
      expect(metrics.totalSuppressed).toBe(1);
      expect(metrics.totalFailed).toBe(1);
      expect(metrics.byPlatform.telegram.sent).toBe(1);
      expect(metrics.byPlatform.telegram.suppressed).toBe(1);
      expect(metrics.byPlatform.discord.failed).toBe(1);
    });
  });

  describe("start / stop lifecycle", () => {
    it("starts all adapters", async () => {
      const telegram = makeAdapter("telegram");
      engine.registerAdapter(telegram);
      await engine.start();
      expect(telegram.start).toHaveBeenCalled();
      expect(engine.isRunning()).toBe(true);
    });

    it("stops all adapters", async () => {
      const telegram = makeAdapter("telegram");
      engine.registerAdapter(telegram);
      await engine.start();
      await engine.stop();
      expect(telegram.stop).toHaveBeenCalled();
      expect(engine.isRunning()).toBe(false);
    });

    it("does not double-start", async () => {
      const telegram = makeAdapter("telegram");
      engine.registerAdapter(telegram);
      await engine.start();
      await engine.start();
      expect(telegram.start).toHaveBeenCalledTimes(1);
    });
  });

  describe("delivery logging", () => {
    it("writes delivery log entries to file", async () => {
      const adapter = makeAdapter("telegram");
      engine.registerAdapter(adapter);
      await engine.start();
      await engine.send("telegram", "user-1", "Hello");
      await engine.stop();

      const logPath = path.join(tmpDir, "delivery-log.jsonl");
      const content = await fs.readFile(logPath, "utf-8");
      const lines = content.trim().split("\n");
      expect(lines.length).toBeGreaterThanOrEqual(1);

      const entry = JSON.parse(lines[lines.length - 1]);
      expect(entry.platform).toBe("telegram");
      expect(entry.userId).toBe("user-1");
      expect(entry.suppressed).toBe(false);
    });
  });

  describe("message sanitization", () => {
    it("strips @everyone mentions", () => {
      const result = sanitizeMessage("Hello @everyone look at this", "discord");
      expect(result).not.toContain("@everyone");
    });

    it("strips @here mentions", () => {
      const result = sanitizeMessage("Alert @here!", "discord");
      expect(result).not.toContain("@here");
    });

    it("strips Discord role mentions", () => {
      const result = sanitizeMessage("Ping <@&123456789>", "discord");
      expect(result).toContain("[removed-role-mention]");
      expect(result).not.toContain("<@&");
    });

    it("strips Discord channel mentions", () => {
      const result = sanitizeMessage("See <#123456789>", "discord");
      expect(result).toContain("[removed-channel-mention]");
    });

    it("strips Telegram script tags", () => {
      const result = sanitizeMessage('Hello <script>alert("xss")</script> world', "telegram");
      expect(result).not.toContain("<script>");
    });

    it("strips Telegram iframe tags", () => {
      const result = sanitizeMessage('<iframe src="evil.com"></iframe> hi', "telegram");
      expect(result).not.toContain("<iframe");
    });

    it("strips on-event handlers", () => {
      const result = sanitizeMessage('<img onerror="alert(1)" src=x>', "telegram");
      expect(result).not.toContain("onerror=");
    });

    it("strips javascript: URLs", () => {
      const result = sanitizeMessage('<a href="javascript:alert(1)">click</a>', "telegram");
      expect(result).not.toContain("javascript:");
    });

    it("leaves normal markdown intact", () => {
      const msg = "**bold** _italic_ [link](https://example.com)";
      expect(sanitizeMessage(msg, "slack")).toBe(msg);
    });

    it("sanitizes are applied before adapter.send", async () => {
      const sendFn = vi.fn<() => Promise<DeliveryResult>>().mockResolvedValue({
        success: true,
        messageId: "msg-1",
        platform: "discord",
        timestamp: new Date().toISOString(),
        suppressed: false,
      });
      const adapter: PlatformAdapter = {
        platform: "discord",
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        isConnected: vi.fn().mockReturnValue(true),
        send: sendFn,
        receive: vi.fn(),
      };
      engine.registerAdapter(adapter);

      await engine.send("discord", "user-1", "Alert @everyone!");
      expect(sendFn).toHaveBeenCalledWith("user-1", expect.not.stringContaining("@everyone"), undefined);
    });
  });
});
