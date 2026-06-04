import fs from "fs";
import path from "path";
import crypto from "crypto";
import { env } from "../config/env";
import { parseSchedule, shouldFireCron, nextFireTime, type ParsedSchedule } from "./cron-parser";
import { runJob, type JobRunnerDependencies } from "./job-runner";

export interface CronJob {
  id: string;
  name: string;
  schedule: ParsedSchedule;
  prompt: string;
  deliver?: string;
  context_from?: string;
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
  lastResult?: string;
  runCount: number;
  lastOutput?: string;
}

interface PersistedData {
  jobs: CronJob[];
}

export interface CronEngineDeps {
  runJobFn?: JobRunnerDependencies["runJobFn"];
  now?: () => Date;
}

export class CronEngine {
  private jobsPath: string;
  private lockPath: string;
  private tickIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private runningJobs = new Set<string>();
  private running = false;
  private deps: Required<CronEngineDeps>;

  constructor(tickIntervalMs: number = 60_000, deps?: CronEngineDeps) {
    this.tickIntervalMs = tickIntervalMs;
    const cronPath = env.CRON_PATH || "data/cron";
    this.jobsPath = path.join(process.cwd(), cronPath, "jobs.json");
    this.lockPath = path.join(process.cwd(), cronPath, ".tick.lock");
    this.deps = {
      runJobFn: deps?.runJobFn ?? runJob,
      now: deps?.now ?? (() => new Date()),
    };
  }

  start(): void {
    if (this.running) return;
    this.ensureDataDir();
    this.running = true;
    console.log(`[CronEngine] Starting with ${this.tickIntervalMs}ms tick interval`);
    this.timer = setInterval(() => this.tick(), this.tickIntervalMs);
    this.timer.unref();
    void this.tick();
  }

  stop(): Promise<void> {
    if (!this.running) return Promise.resolve();
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log(`[CronEngine] Stopped. Waiting for ${this.runningJobs.size} running job(s)...`);
    return new Promise((resolve) => {
      const check = () => {
        if (this.runningJobs.size === 0) {
          console.log("[CronEngine] All jobs completed.");
          resolve();
        } else {
          setTimeout(check, 1000);
        }
      };
      check();
    });
  }

  private ensureDataDir(): void {
    const dir = path.dirname(this.jobsPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(this.jobsPath)) {
      this.writeJobs([]);
    }
  }

  private readJobs(): CronJob[] {
    try {
      const data = fs.readFileSync(this.jobsPath, "utf-8");
      return (JSON.parse(data) as PersistedData).jobs ?? [];
    } catch {
      return [];
    }
  }

  private writeJobs(jobs: CronJob[]): void {
    const tmpPath = this.jobsPath + ".tmp";
    fs.writeFileSync(tmpPath, JSON.stringify({ jobs }, null, 2), "utf-8");
    fs.renameSync(tmpPath, this.jobsPath);
  }

  private acquireLock(): boolean {
    try {
      try {
        const fd = fs.openSync(this.lockPath, "wx");
        fs.writeSync(fd, this.deps.now().toISOString());
        fs.closeSync(fd);
        return true;
      } catch (err: unknown) {
        if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "EEXIST") {
          const lockContent = fs.readFileSync(this.lockPath, "utf-8").trim();
          const lockTime = new Date(lockContent).getTime();
          const lockAge = this.deps.now().getTime() - lockTime;
          if (lockAge < this.tickIntervalMs * 2) return false;
          fs.unlinkSync(this.lockPath);
          try {
            const fd = fs.openSync(this.lockPath, "wx");
            fs.writeSync(fd, this.deps.now().toISOString());
            fs.closeSync(fd);
            return true;
          } catch {
            return false;
          }
        }
        return false;
      }
    } catch {
      return false;
    }
  }

  private releaseLock(): void {
    try {
      if (fs.existsSync(this.lockPath)) fs.unlinkSync(this.lockPath);
    } catch { /* ignore */ }
  }

  async tick(): Promise<void> {
    if (!this.acquireLock()) return;
    try {
      const now = this.deps.now();
      const jobs = this.readJobs();

      for (const job of jobs) {
        if (!job.enabled) continue;
        if (this.runningJobs.has(job.id)) continue;
        if (!this.isDue(job, now)) continue;
        try {
          await this.executeJob(job, now, jobs);
        } catch (err) {
          console.error(`[CronEngine] Job ${job.id} failed:`, err);
        }
      }
    } finally {
      this.releaseLock();
    }
  }

  private isDue(job: CronJob, now: Date): boolean {
    const { schedule } = job;
    if (schedule.kind === "interval" && schedule.minutes) {
      const last = job.lastRunAt ? new Date(job.lastRunAt) : new Date(0);
      return now.getTime() - last.getTime() >= schedule.minutes * 60_000;
    }
    if (schedule.kind === "cron" && schedule.cronExpression) {
      return shouldFireCron(schedule.cronExpression, now);
    }
    if (schedule.kind === "oneshot" && schedule.timestamp) {
      const target = new Date(schedule.timestamp);
      const diff = Math.abs(now.getTime() - target.getTime());
      if (diff < this.tickIntervalMs * 1.5 && now >= target) return true;
      if (now >= target && (!job.lastRunAt || job.lastRunAt < schedule.timestamp)) return true;
      return false;
    }
    return false;
  }

  private async executeJob(job: CronJob, firedAt: Date, jobs: CronJob[]): Promise<void> {
    this.runningJobs.add(job.id);
    try {
      const chainedContext = job.context_from
        ? this.getChainedContext(job.context_from, jobs)
        : undefined;

      const result = await this.deps.runJobFn(job, chainedContext);

      const idx = jobs.findIndex((j) => j.id === job.id);
      if (idx !== -1) {
        jobs[idx].lastRunAt = firedAt.toISOString();
        jobs[idx].lastResult = result.success ? "success" : "failed";
        jobs[idx].lastOutput = result.output;
        jobs[idx].runCount = (jobs[idx].runCount || 0) + 1;

        if (jobs[idx].schedule.kind === "oneshot") {
          jobs[idx].enabled = false;
        }

        this.writeJobs(jobs);
      }
    } finally {
      this.runningJobs.delete(job.id);
    }
  }

  private getChainedContext(jobId: string, jobs: CronJob[]): string | undefined {
    const source = jobs.find((j) => j.id === jobId);
    return source?.lastOutput;
  }

  createJob(
    scheduleInput: string,
    prompt: string,
    options?: { name?: string; deliver?: string; context_from?: string },
  ): CronJob {
    const schedule = parseSchedule(scheduleInput);
    const job: CronJob = {
      id: `cron-${crypto.randomUUID().slice(0, 8)}`,
      name: options?.name || `Job (${scheduleInput})`,
      schedule,
      prompt,
      deliver: options?.deliver,
      context_from: options?.context_from,
      enabled: true,
      createdAt: this.deps.now().toISOString(),
      runCount: 0,
    };

    const jobs = this.readJobs();
    jobs.push(job);
    this.writeJobs(jobs);

    console.log(`[CronEngine] Created job ${job.id}: "${job.name}" (${scheduleInput})`);
    return job;
  }

  listJobs(): CronJob[] {
    return this.readJobs();
  }

  editJob(jobId: string, updates: Partial<Pick<CronJob, "name" | "prompt" | "deliver" | "enabled">> & { schedule?: string }): CronJob | null {
    const jobs = this.readJobs();
    const idx = jobs.findIndex((j) => j.id === jobId);
    if (idx === -1) return null;

    if (updates.schedule) {
      jobs[idx].schedule = parseSchedule(updates.schedule);
    }
    if (updates.name !== undefined) jobs[idx].name = updates.name;
    if (updates.prompt !== undefined) jobs[idx].prompt = updates.prompt;
    if (updates.deliver !== undefined) jobs[idx].deliver = updates.deliver;
    if (updates.enabled !== undefined) jobs[idx].enabled = updates.enabled;

    this.writeJobs(jobs);
    console.log(`[CronEngine] Updated job ${jobId}`);
    return jobs[idx];
  }

  deleteJob(jobId: string): boolean {
    const jobs = this.readJobs();
    const filtered = jobs.filter((j) => j.id !== jobId);
    if (filtered.length === jobs.length) return false;
    this.writeJobs(filtered);
    console.log(`[CronEngine] Deleted job ${jobId}`);
    return true;
  }

  getStatus(): { running: boolean; activeJobs: number; nextTick: Date | null; jobs: CronJob[] } {
    const jobs = this.readJobs();
    const now = this.deps.now();
    let nextTick: Date | null = null;

    for (const job of jobs) {
      if (!job.enabled) continue;
      const next = nextFireTime(job.schedule, now);
      if (next && (!nextTick || next < nextTick)) {
        nextTick = next;
      }
    }

    return {
      running: this.running,
      activeJobs: this.runningJobs.size,
      nextTick,
      jobs,
    };
  }

  getRunningJobCount(): number {
    return this.runningJobs.size;
  }

  isRunning(): boolean {
    return this.running;
  }
}

export const cronEngine = new CronEngine();
