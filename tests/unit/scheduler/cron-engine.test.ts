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

import { CronEngine, type CronJob } from "../../../src/scheduler/cron-engine.js";
import type { JobResult } from "../../../src/scheduler/job-runner.js";

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cron-test-"));
}

function createEngine(tempDir: string, tickMs = 60_000) {
  const mockRunJob = vi.fn().mockResolvedValue<JobResult>({
    success: true,
    output: "test output",
    silent: false,
  });

  const fixedNow = new Date("2026-06-03T09:00:00Z");
  let currentTime = fixedNow;

  const engine = new CronEngine(tickMs, {
    runJobFn: mockRunJob,
    now: () => currentTime,
  });

  (engine as any).jobsPath = path.join(tempDir, "jobs.json");
  (engine as any).lockPath = path.join(tempDir, ".tick.lock");

  return { engine, mockRunJob, setNow: (d: Date) => { currentTime = d; } };
}

describe("CronEngine", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("createJob", () => {
    it("creates a job and persists it", () => {
      const { engine } = createEngine(tempDir);
      const job = engine.createJob("every 30m", "Check Jira tickets");
      expect(job.id).toMatch(/^cron-/);
      expect(job.name).toContain("every 30m");
      expect(job.prompt).toBe("Check Jira tickets");
      expect(job.enabled).toBe(true);

      const jobs = engine.listJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].id).toBe(job.id);
    });

    it("creates a job with custom name and deliver target", () => {
      const { engine } = createEngine(tempDir);
      const job = engine.createJob("0 9 * * *", "Daily standup", {
        name: "Morning Check",
        deliver: "discord",
      });
      expect(job.name).toBe("Morning Check");
      expect(job.deliver).toBe("discord");
    });

    it("throws on invalid schedule", () => {
      const { engine } = createEngine(tempDir);
      expect(() => engine.createJob("invalid schedule!!", "test")).toThrow();
    });
  });

  describe("listJobs", () => {
    it("returns empty array when no jobs", () => {
      const { engine } = createEngine(tempDir);
      expect(engine.listJobs()).toEqual([]);
    });

    it("returns all created jobs", () => {
      const { engine } = createEngine(tempDir);
      engine.createJob("every 30m", "Task A");
      engine.createJob("every 1h", "Task B");
      expect(engine.listJobs()).toHaveLength(2);
    });
  });

  describe("editJob", () => {
    it("updates job fields", () => {
      const { engine } = createEngine(tempDir);
      const job = engine.createJob("every 30m", "Original");

      const updated = engine.editJob(job.id, {
        name: "Updated",
        prompt: "New prompt",
      });

      expect(updated).not.toBeNull();
      expect(updated!.name).toBe("Updated");
      expect(updated!.prompt).toBe("New prompt");
    });

    it("updates schedule", () => {
      const { engine } = createEngine(tempDir);
      const job = engine.createJob("every 30m", "Test");

      const updated = engine.editJob(job.id, { schedule: "0 9 * * *" });
      expect(updated).not.toBeNull();
      expect(updated!.schedule.kind).toBe("cron");
      expect(updated!.schedule.cronExpression).toBe("0 9 * * *");
    });

    it("returns null for non-existent job", () => {
      const { engine } = createEngine(tempDir);
      const result = engine.editJob("cron-nonexistent", { name: "X" });
      expect(result).toBeNull();
    });
  });

  describe("deleteJob", () => {
    it("deletes an existing job", () => {
      const { engine } = createEngine(tempDir);
      const job = engine.createJob("every 30m", "Test");
      expect(engine.deleteJob(job.id)).toBe(true);
      expect(engine.listJobs()).toHaveLength(0);
    });

    it("returns false for non-existent job", () => {
      const { engine } = createEngine(tempDir);
      expect(engine.deleteJob("cron-nonexistent")).toBe(false);
    });
  });

  describe("getStatus", () => {
    it("returns engine status", () => {
      const { engine } = createEngine(tempDir);
      const status = engine.getStatus();
      expect(status.running).toBe(false);
      expect(status.activeJobs).toBe(0);
      expect(status.jobs).toEqual([]);
    });
  });

  describe("start/stop lifecycle", () => {
    it("starts and stops the engine", async () => {
      const { engine } = createEngine(tempDir);
      engine.start();
      expect(engine.isRunning()).toBe(true);
      await engine.stop();
      expect(engine.isRunning()).toBe(false);
    });

    it("does not start twice", () => {
      const { engine } = createEngine(tempDir);
      engine.start();
      engine.start();
      expect(engine.isRunning()).toBe(true);
      engine.stop();
    });
  });

  describe("tick execution", () => {
    it("fires interval jobs that are due", async () => {
      const { engine, mockRunJob, setNow } = createEngine(tempDir);
      const job = engine.createJob("every 30m", "Test task");

      setNow(new Date("2026-06-03T09:00:00Z"));
      await engine.tick();

      expect(mockRunJob).toHaveBeenCalledTimes(1);
      expect(mockRunJob).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }), undefined);
    });

    it("does not fire jobs that are not due", async () => {
      const { engine, mockRunJob, setNow } = createEngine(tempDir);
      const job = engine.createJob("every 30m", "Test task");

      setNow(new Date("2026-06-03T09:00:00Z"));
      await engine.tick();

      setNow(new Date("2026-06-03T09:10:00Z"));
      await engine.tick();

      expect(mockRunJob).toHaveBeenCalledTimes(1);
    });

    it("fires cron jobs at matching time", async () => {
      const { engine, mockRunJob, setNow } = createEngine(tempDir);
      engine.createJob("0 9 * * *", "Daily morning task");

      setNow(new Date("2026-06-03T09:00:00Z"));
      await engine.tick();

      expect(mockRunJob).toHaveBeenCalledTimes(1);
    });

    it("does not fire cron jobs at non-matching time", async () => {
      const { engine, mockRunJob, setNow } = createEngine(tempDir);
      engine.createJob("0 9 * * *", "Daily morning task");

      setNow(new Date("2026-06-03T10:00:00Z"));
      await engine.tick();

      expect(mockRunJob).not.toHaveBeenCalled();
    });

    it("skips disabled jobs", async () => {
      const { engine, mockRunJob, setNow } = createEngine(tempDir);
      const job = engine.createJob("every 30m", "Disabled task");
      engine.editJob(job.id, { enabled: false });

      setNow(new Date("2026-06-03T09:00:00Z"));
      await engine.tick();

      expect(mockRunJob).not.toHaveBeenCalled();
    });

    it("updates lastRunAt and runCount after execution", async () => {
      const { engine, setNow } = createEngine(tempDir);
      engine.createJob("every 30m", "Test task");

      setNow(new Date("2026-06-03T09:00:00Z"));
      await engine.tick();

      const jobs = engine.listJobs();
      expect(jobs[0].lastRunAt).toBe("2026-06-03T09:00:00.000Z");
      expect(jobs[0].runCount).toBe(1);
      expect(jobs[0].lastResult).toBe("success");
    });

    it("stores job output for chaining", async () => {
      const { engine, setNow } = createEngine(tempDir);
      engine.createJob("every 30m", "Source job");

      setNow(new Date("2026-06-03T09:00:00Z"));
      await engine.tick();

      const jobs = engine.listJobs();
      expect(jobs[0].lastOutput).toBe("test output");
    });

    it("disables one-shot jobs after execution", async () => {
      const { engine, setNow } = createEngine(tempDir);
      engine.createJob("2026-06-03T09:00:00Z", "One-shot task");

      setNow(new Date("2026-06-03T09:00:00Z"));
      await engine.tick();

      const jobs = engine.listJobs();
      expect(jobs[0].enabled).toBe(false);
    });
  });

  describe("file lock", () => {
    it("prevents overlapping ticks", async () => {
      const { engine, setNow } = createEngine(tempDir);
      engine.createJob("every 30m", "Test");

      setNow(new Date("2026-06-03T09:00:00Z"));

      fs.writeFileSync(path.join(tempDir, ".tick.lock"), new Date().toISOString());
      await engine.tick();

      const jobs = engine.listJobs();
      expect(jobs[0].runCount).toBe(0);
    });

    it("allows tick after lock expires", async () => {
      const { engine, mockRunJob, setNow } = createEngine(tempDir);
      engine.createJob("every 30m", "Test");

      const oldLock = new Date("2026-06-03T08:00:00Z");
      fs.writeFileSync(path.join(tempDir, ".tick.lock"), oldLock.toISOString());

      setNow(new Date("2026-06-03T09:00:00Z"));
      await engine.tick();

      expect(mockRunJob).toHaveBeenCalledTimes(1);
    });
  });

  describe("job chaining with context_from", () => {
    it("passes previous output to chained job", async () => {
      const { engine, mockRunJob, setNow } = createEngine(tempDir);

      const sourceJob = engine.createJob("every 30m", "Source");
      const chainedJob = engine.createJob("every 1h", "Chained", {
        context_from: sourceJob.id,
      });

      setNow(new Date("2026-06-03T09:00:00Z"));
      await engine.tick();

      expect(mockRunJob).toHaveBeenCalledTimes(2);
      expect(mockRunJob).toHaveBeenCalledWith(expect.objectContaining({ id: sourceJob.id }), undefined);
      expect(mockRunJob).toHaveBeenCalledWith(expect.objectContaining({ id: chainedJob.id }), "test output");
    });
  });

  describe("isDue edge cases", () => {
    it("fires interval job with no lastRunAt (never run)", async () => {
      const { engine, mockRunJob, setNow } = createEngine(tempDir);
      engine.createJob("every 1h", "Fresh job");

      setNow(new Date("2026-06-03T09:00:00Z"));
      await engine.tick();

      expect(mockRunJob).toHaveBeenCalledTimes(1);
    });

    it("does not re-fire cron job within the same minute when lock is held", async () => {
      const { engine, mockRunJob, setNow } = createEngine(tempDir);
      engine.createJob("0 9 * * *", "Daily task");

      setNow(new Date("2026-06-03T09:00:00Z"));
      await engine.tick();

      // Simulate a concurrent tick attempt by placing a fresh lock
      fs.writeFileSync(path.join(tempDir, ".tick.lock"), new Date("2026-06-03T09:00:30Z").toISOString());
      setNow(new Date("2026-06-03T09:00:30Z"));
      await engine.tick();

      // Only one invocation because the lock prevented the second tick
      expect(mockRunJob).toHaveBeenCalledTimes(1);
    });

    it("fires one-shot job at exact timestamp", async () => {
      const { engine, mockRunJob, setNow } = createEngine(tempDir);
      engine.createJob("2026-06-03T09:00:00Z", "One-shot");

      setNow(new Date("2026-06-03T09:00:00Z"));
      await engine.tick();

      expect(mockRunJob).toHaveBeenCalledTimes(1);
    });

    it("does not fire one-shot job before its timestamp", async () => {
      const { engine, mockRunJob, setNow } = createEngine(tempDir);
      engine.createJob("2026-12-25T09:00:00Z", "Future one-shot");

      setNow(new Date("2026-06-03T09:00:00Z"));
      await engine.tick();

      expect(mockRunJob).not.toHaveBeenCalled();
    });

    it("does not fire already-run one-shot job", async () => {
      const { engine, mockRunJob, setNow } = createEngine(tempDir);
      engine.createJob("2026-06-03T09:00:00Z", "One-shot");

      setNow(new Date("2026-06-03T09:00:00Z"));
      await engine.tick();

      // Move forward — the job should now be disabled
      setNow(new Date("2026-06-04T09:00:00Z"));
      await engine.tick();

      expect(mockRunJob).toHaveBeenCalledTimes(1);
    });

    it("records failure result when runJobFn fails", async () => {
      const { engine, setNow } = createEngine(tempDir);
      (engine as any).deps.runJobFn = vi.fn().mockResolvedValue({
        success: false,
        output: "Something went wrong",
        silent: false,
      });

      engine.createJob("every 30m", "Failing job");

      setNow(new Date("2026-06-03T09:00:00Z"));
      await engine.tick();

      const jobs = engine.listJobs();
      expect(jobs[0].lastResult).toBe("failed");
      expect(jobs[0].lastOutput).toBe("Something went wrong");
      expect(jobs[0].runCount).toBe(1);
    });
  });
});
