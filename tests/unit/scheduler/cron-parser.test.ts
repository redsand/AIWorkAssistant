import { describe, it, expect } from "vitest";
import {
  parseSchedule,
  shouldFireCron,
  nextFireTime,
  type ParsedSchedule,
} from "../../../src/scheduler/cron-parser.js";

describe("parseSchedule", () => {
  describe("interval schedules", () => {
    it("parses 'every 30m'", () => {
      const result = parseSchedule("every 30m");
      expect(result.kind).toBe("interval");
      expect(result.minutes).toBe(30);
    });

    it("parses 'every 2h'", () => {
      const result = parseSchedule("every 2h");
      expect(result.kind).toBe("interval");
      expect(result.minutes).toBe(120);
    });

    it("parses 'every 1d'", () => {
      const result = parseSchedule("every 1d");
      expect(result.kind).toBe("interval");
      expect(result.minutes).toBe(1440);
    });

    it("parses 'every 30min' (long form)", () => {
      const result = parseSchedule("every 30min");
      expect(result.kind).toBe("interval");
      expect(result.minutes).toBe(30);
    });

    it("parses 'every 4hours' (long form)", () => {
      const result = parseSchedule("every 4hours");
      expect(result.kind).toBe("interval");
      expect(result.minutes).toBe(240);
    });
  });

  describe("interval with 'at' time", () => {
    it("parses 'every 1d at 09:00' as cron", () => {
      const result = parseSchedule("every 1d at 09:00");
      expect(result.kind).toBe("cron");
      expect(result.cronExpression).toBe("0 9 */1 * *");
    });
  });

  describe("natural language daily", () => {
    it("parses 'every day at 9am'", () => {
      const result = parseSchedule("every day at 9am");
      expect(result.kind).toBe("cron");
      expect(result.cronExpression).toBe("0 9 * * *");
    });

    it("parses 'every morning at 6:30am'", () => {
      const result = parseSchedule("every morning at 6:30am");
      expect(result.kind).toBe("cron");
      expect(result.cronExpression).toBe("30 6 * * *");
    });

    it("parses 'every evening at 5pm'", () => {
      const result = parseSchedule("every evening at 5pm");
      expect(result.kind).toBe("cron");
      expect(result.cronExpression).toBe("0 17 * * *");
    });

    it("parses 'every afternoon at 12pm'", () => {
      const result = parseSchedule("every afternoon at 12pm");
      expect(result.kind).toBe("cron");
      expect(result.cronExpression).toBe("0 12 * * *");
    });

    it("parses 'every night at 9pm'", () => {
      const result = parseSchedule("every night at 9pm");
      expect(result.kind).toBe("cron");
      expect(result.cronExpression).toBe("0 21 * * *");
    });
  });

  describe("natural language weekly", () => {
    it("parses 'every monday at 9am'", () => {
      const result = parseSchedule("every monday at 9am");
      expect(result.kind).toBe("cron");
      expect(result.cronExpression).toBe("0 9 * * 1");
    });

    it("parses 'every friday at 5pm'", () => {
      const result = parseSchedule("every friday at 5pm");
      expect(result.kind).toBe("cron");
      expect(result.cronExpression).toBe("0 17 * * 5");
    });

    it("parses 'every sunday at 10:30am'", () => {
      const result = parseSchedule("every sunday at 10:30am");
      expect(result.kind).toBe("cron");
      expect(result.cronExpression).toBe("30 10 * * 0");
    });
  });

  describe("cron expressions", () => {
    it("parses standard 5-field cron '0 9 * * 1'", () => {
      const result = parseSchedule("0 9 * * 1");
      expect(result.kind).toBe("cron");
      expect(result.cronExpression).toBe("0 9 * * 1");
    });

    it("parses '*/5 * * * *'", () => {
      const result = parseSchedule("*/5 * * * *");
      expect(result.kind).toBe("cron");
      expect(result.cronExpression).toBe("*/5 * * * *");
    });

    it("parses '30 14 * * *'", () => {
      const result = parseSchedule("30 14 * * *");
      expect(result.kind).toBe("cron");
      expect(result.cronExpression).toBe("30 14 * * *");
    });
  });

  describe("one-shot timestamps", () => {
    it("parses ISO timestamp '2026-06-15T14:00'", () => {
      const result = parseSchedule("2026-06-15T14:00");
      expect(result.kind).toBe("oneshot");
      expect(result.timestamp).toBe(new Date("2026-06-15T14:00").toISOString());
    });

    it("parses ISO timestamp with timezone '2026-06-15T14:00:00Z'", () => {
      const result = parseSchedule("2026-06-15T14:00:00Z");
      expect(result.kind).toBe("oneshot");
      expect(result.timestamp).toBeDefined();
    });
  });

  describe("error handling", () => {
    it("throws on empty input", () => {
      expect(() => parseSchedule("")).toThrow("cannot be empty");
    });

    it("throws on unrecognizable input", () => {
      expect(() => parseSchedule("whenever I feel like it")).toThrow("Cannot parse schedule");
    });
  });

  describe("original preservation", () => {
    it("preserves the original schedule string", () => {
      const result = parseSchedule("every 30m");
      expect(result.original).toBe("every 30m");
    });
  });
});

describe("shouldFireCron", () => {
  it("fires at the correct minute and hour", () => {
    const now = new Date("2026-06-03T09:00:00Z");
    expect(shouldFireCron("0 9 * * *", now)).toBe(true);
  });

  it("does not fire at wrong minute", () => {
    const now = new Date("2026-06-03T09:30:00Z");
    expect(shouldFireCron("0 9 * * *", now)).toBe(false);
  });

  it("does not fire at wrong hour", () => {
    const now = new Date("2026-06-03T10:00:00Z");
    expect(shouldFireCron("0 9 * * *", now)).toBe(false);
  });

  it("fires on correct day of week", () => {
    const monday = new Date("2026-06-01T09:00:00Z");
    expect(shouldFireCron("0 9 * * 1", monday)).toBe(true);
  });

  it("does not fire on wrong day of week", () => {
    const tuesday = new Date("2026-06-02T09:00:00Z");
    expect(shouldFireCron("0 9 * * 1", tuesday)).toBe(false);
  });

  it("handles wildcard fields", () => {
    const now = new Date("2026-06-03T14:30:00Z");
    expect(shouldFireCron("30 14 * * *", now)).toBe(true);
  });

  it("handles step expressions", () => {
    const now = new Date("2026-06-03T09:00:00Z");
    expect(shouldFireCron("*/15 * * * *", now)).toBe(true);
  });

  it("handles range expressions", () => {
    const now = new Date("2026-06-03T10:00:00Z");
    expect(shouldFireCron("0 9-17 * * *", now)).toBe(true);
  });

  it("rejects values outside range", () => {
    const now = new Date("2026-06-03T08:00:00Z");
    expect(shouldFireCron("0 9-17 * * *", now)).toBe(false);
  });
});

describe("nextFireTime", () => {
  it("returns the timestamp for one-shot schedules", () => {
    const schedule: ParsedSchedule = {
      kind: "oneshot",
      timestamp: "2026-06-15T14:00:00Z",
      original: "2026-06-15T14:00:00Z",
    };
    const result = nextFireTime(schedule);
    expect(result).toEqual(new Date("2026-06-15T14:00:00Z"));
  });

  it("returns a future time for interval schedules", () => {
    const schedule: ParsedSchedule = {
      kind: "interval",
      minutes: 30,
      original: "every 30m",
    };
    const after = new Date("2026-06-03T09:00:00Z");
    const result = nextFireTime(schedule, after);
    expect(result).toEqual(new Date("2026-06-03T09:30:00Z"));
  });

  it("returns the next matching time for cron schedules", () => {
    const schedule: ParsedSchedule = {
      kind: "cron",
      cronExpression: "0 9 * * *",
      original: "0 9 * * *",
    };
    const after = new Date("2026-06-03T08:00:00Z");
    const result = nextFireTime(schedule, after);
    expect(result).not.toBeNull();
    expect(result!.getUTCHours()).toBe(9);
    expect(result!.getUTCMinutes()).toBe(0);
  });

  it("returns null for invalid schedule", () => {
    const schedule: ParsedSchedule = {
      kind: "interval",
      original: "invalid",
    };
    const result = nextFireTime(schedule);
    expect(result).toBeNull();
  });
});
