import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

vi.mock("../../../src/config/env", () => ({
  env: {
    CRON_ENABLED: true,
    CRON_PATH: "",
  },
}));

vi.mock("../../../src/observability/error-log", () => ({
  errorLog: {
    log: vi.fn().mockResolvedValue(undefined),
  },
}));

const { mockGatewaySend } = vi.hoisted(() => ({
  mockGatewaySend: vi.fn(),
}));

vi.mock("../../../src/integrations/gateway/gateway-engine", () => ({
  gatewayEngine: {
    send: mockGatewaySend,
  },
}));

import { CronEngine, MAX_UNDELIVERED_RESULTS, type CronJob } from "../../../src/scheduler/cron-engine.js";
import type { JobResult } from "../../../src/scheduler/job-runner.js";

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cron-delivery-test-"));
}

function createEngine(
  tempDir: string,
  opts: { runResult?: Partial<JobResult>; deliverToChat?: (sessionId: string, event: string, data: unknown) => boolean } = {},
) {
  const mockRunJob = vi.fn().mockResolvedValue<JobResult>({
    success: true,
    output: "test output",
    silent: false,
    ...opts.runResult,
  });

  const fixedNow = new Date("2026-06-03T09:00:00Z");
  let currentTime = fixedNow;

  const engine = new CronEngine(60_000, {
    runJobFn: mockRunJob,
    now: () => currentTime,
    deliverToChat: opts.deliverToChat,
  });

  (engine as any).jobsPath = path.join(tempDir, "jobs.json");
  (engine as any).lockPath = path.join(tempDir, ".tick.lock");

  return { engine, mockRunJob, setNow: (d: Date) => { currentTime = d; } };
}

describe("CronEngine delivery", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    mockGatewaySend.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("deliver: chat, active session", () => {
    it("calls deliverToChat with a cron_result event and marks lastDelivered", async () => {
      const deliverToChat = vi.fn().mockReturnValue(true);
      const { engine, setNow } = createEngine(tempDir, { deliverToChat });

      const job = engine.createJob("every 30m", "Do the thing", {
        deliver: "chat",
        sessionId: "session-abc",
        userId: "user-1",
      });

      setNow(new Date("2026-06-03T09:00:00Z"));
      await engine.tick();

      expect(deliverToChat).toHaveBeenCalledTimes(1);
      expect(deliverToChat).toHaveBeenCalledWith(
        "session-abc",
        "cron_result",
        expect.objectContaining({
          jobId: job.id,
          jobName: job.name,
          output: "test output",
          success: true,
        }),
      );

      const jobs = engine.listJobs();
      expect(jobs[0].lastDelivered).toBe(true);
      expect(jobs[0].undeliveredResults ?? []).toHaveLength(0);
    });
  });

  describe("deliver: chat, inactive session", () => {
    it("queues the result to undeliveredResults when deliverToChat returns false", async () => {
      const deliverToChat = vi.fn().mockReturnValue(false);
      const { engine, setNow } = createEngine(tempDir, { deliverToChat });

      const job = engine.createJob("every 30m", "Do the thing", {
        deliver: "chat",
        sessionId: "session-abc",
      });

      setNow(new Date("2026-06-03T09:00:00Z"));
      await engine.tick();

      const jobs = engine.listJobs();
      expect(jobs[0].lastDelivered).toBe(false);
      expect(jobs[0].undeliveredResults).toHaveLength(1);
      expect(jobs[0].undeliveredResults![0]).toMatchObject({
        output: "test output",
        success: true,
      });
      void job;
    });

    it("caps undeliveredResults at MAX_UNDELIVERED_RESULTS, dropping oldest first", async () => {
      const deliverToChat = vi.fn().mockReturnValue(false);
      const { engine, setNow } = createEngine(tempDir, { deliverToChat });

      engine.createJob("every 1m", "Repeats", {
        deliver: "chat",
        sessionId: "session-abc",
      });

      for (let i = 0; i < MAX_UNDELIVERED_RESULTS + 5; i++) {
        setNow(new Date(Date.UTC(2026, 5, 3, 9, i)));
        await engine.tick();
      }

      const jobs = engine.listJobs();
      expect(jobs[0].undeliveredResults).toHaveLength(MAX_UNDELIVERED_RESULTS);
    });
  });

  describe("deliver: chat, no sessionId", () => {
    it("does not deliver and does not default deliver to chat when sessionId is missing", async () => {
      const deliverToChat = vi.fn().mockReturnValue(true);
      const { engine, setNow } = createEngine(tempDir, { deliverToChat });

      engine.createJob("every 30m", "No session", { deliver: "chat" });

      setNow(new Date("2026-06-03T09:00:00Z"));
      await engine.tick();

      expect(deliverToChat).not.toHaveBeenCalled();
      const jobs = engine.listJobs();
      expect(jobs[0].lastDelivered).toBe(false);
      expect(jobs[0].undeliveredResults ?? []).toHaveLength(0);
    });

    it("does not deliver to chat for a job with no deliver target at all", async () => {
      const deliverToChat = vi.fn().mockReturnValue(true);
      const { engine, setNow } = createEngine(tempDir, { deliverToChat });

      engine.createJob("every 30m", "No deliver", { sessionId: "session-abc" });

      setNow(new Date("2026-06-03T09:00:00Z"));
      await engine.tick();

      expect(deliverToChat).not.toHaveBeenCalled();
    });
  });

  describe("deliver: external platforms", () => {
    it("delivers via gatewayEngine.send for discord/telegram/slack/whatsapp", async () => {
      mockGatewaySend.mockResolvedValue({
        success: true,
        platform: "discord",
        timestamp: new Date().toISOString(),
        suppressed: false,
      });
      const { engine, setNow } = createEngine(tempDir);

      engine.createJob("every 30m", "External delivery", {
        deliver: "discord",
        userId: "discord-user-1",
      });

      setNow(new Date("2026-06-03T09:00:00Z"));
      await engine.tick();

      expect(mockGatewaySend).toHaveBeenCalledWith("discord", "discord-user-1", "test output");
      const jobs = engine.listJobs();
      expect(jobs[0].lastDelivered).toBe(true);
    });

    it("marks lastDelivered false when gateway delivery fails", async () => {
      mockGatewaySend.mockResolvedValue({
        success: false,
        platform: "telegram",
        timestamp: new Date().toISOString(),
        suppressed: false,
      });
      const { engine, setNow } = createEngine(tempDir);

      engine.createJob("every 30m", "External delivery", {
        deliver: "telegram",
        userId: "telegram-user-1",
      });

      setNow(new Date("2026-06-03T09:00:00Z"));
      await engine.tick();

      const jobs = engine.listJobs();
      expect(jobs[0].lastDelivered).toBe(false);
    });

    it("does not attempt gateway delivery without a userId", async () => {
      const { engine, setNow } = createEngine(tempDir);

      engine.createJob("every 30m", "No user id", { deliver: "slack" });

      setNow(new Date("2026-06-03T09:00:00Z"));
      await engine.tick();

      expect(mockGatewaySend).not.toHaveBeenCalled();
    });
  });

  describe("[SILENT] suppression", () => {
    it("never delivers to chat when result is silent", async () => {
      const deliverToChat = vi.fn().mockReturnValue(true);
      const { engine, setNow } = createEngine(tempDir, {
        deliverToChat,
        runResult: { silent: true },
      });

      engine.createJob("every 30m", "Silent job", {
        deliver: "chat",
        sessionId: "session-abc",
      });

      setNow(new Date("2026-06-03T09:00:00Z"));
      await engine.tick();

      expect(deliverToChat).not.toHaveBeenCalled();
      const jobs = engine.listJobs();
      expect(jobs[0].lastDelivered).toBe(false);
      expect(jobs[0].undeliveredResults ?? []).toHaveLength(0);
    });

    it("never delivers to gateway when result is silent", async () => {
      const { engine, setNow } = createEngine(tempDir, { runResult: { silent: true } });

      engine.createJob("every 30m", "Silent job", {
        deliver: "discord",
        userId: "discord-user-1",
      });

      setNow(new Date("2026-06-03T09:00:00Z"));
      await engine.tick();

      expect(mockGatewaySend).not.toHaveBeenCalled();
    });
  });

  describe("flushUndelivered", () => {
    it("sends queued results and clears the queue on reconnect", async () => {
      const deliverToChat = vi.fn().mockReturnValue(false);
      const { engine, setNow } = createEngine(tempDir, { deliverToChat });

      engine.createJob("every 30m", "Queued job", {
        deliver: "chat",
        sessionId: "session-abc",
      });

      setNow(new Date("2026-06-03T09:00:00Z"));
      await engine.tick();

      let jobs = engine.listJobs();
      expect(jobs[0].undeliveredResults).toHaveLength(1);

      const send = vi.fn();
      engine.flushUndelivered("session-abc", send);

      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith(
        "cron_result",
        expect.objectContaining({ jobId: jobs[0].id, output: "test output", success: true }),
      );

      jobs = engine.listJobs();
      expect(jobs[0].undeliveredResults).toHaveLength(0);
      expect(jobs[0].lastDelivered).toBe(true);
    });

    it("is a no-op for sessions with nothing queued", () => {
      const { engine } = createEngine(tempDir);
      engine.createJob("every 30m", "No queue job", { sessionId: "session-xyz" });

      const send = vi.fn();
      expect(() => engine.flushUndelivered("session-xyz", send)).not.toThrow();
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe("setDeliverToChat", () => {
    it("allows post-construction injection of the delivery callback", async () => {
      const { engine, setNow } = createEngine(tempDir);
      const deliverToChat = vi.fn().mockReturnValue(true);
      engine.setDeliverToChat(deliverToChat);

      engine.createJob("every 30m", "Injected callback", {
        deliver: "chat",
        sessionId: "session-abc",
      });

      setNow(new Date("2026-06-03T09:00:00Z"));
      await engine.tick();

      expect(deliverToChat).toHaveBeenCalledTimes(1);
    });
  });
});
