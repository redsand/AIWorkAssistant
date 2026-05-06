import { describe, it, expect } from "vitest";
import { enforceMaxRange, todayRange } from "../../../src/integrations/hawk-ir/hawk-ir-service";

describe("HawkIrService helpers", () => {
  describe("todayRange", () => {
    it("returns start at midnight today", () => {
      const range = todayRange();
      const start = new Date(range.startDate);
      const now = new Date();

      expect(start.getFullYear()).toBe(now.getFullYear());
      expect(start.getMonth()).toBe(now.getMonth());
      expect(start.getDate()).toBe(now.getDate());
      expect(start.getHours()).toBe(0);
      expect(start.getMinutes()).toBe(0);
      expect(start.getSeconds()).toBe(0);
    });

    it("returns stop at current time", () => {
      const range = todayRange();
      const stop = new Date(range.stopDate);
      const now = new Date();

      expect(Math.abs(stop.getTime() - now.getTime())).toBeLessThan(5000);
    });
  });

  describe("enforceMaxRange", () => {
    it("allows ranges within 10 days", () => {
      const to = new Date("2025-06-15T12:00:00Z");
      const from = new Date("2025-06-10T12:00:00Z");

      const result = enforceMaxRange(from, to);
      expect(result.from).toBe(from.toISOString());
      expect(result.to).toBe(to.toISOString());
    });

    it("allows exactly 10 days", () => {
      const to = new Date("2025-06-15T12:00:00Z");
      const from = new Date("2025-06-05T12:00:00Z");

      const result = enforceMaxRange(from, to);
      expect(result.from).toBe(from.toISOString());
    });

    it("rejects ranges exceeding 10 days", () => {
      const to = new Date("2025-06-15T12:00:00Z");
      const from = new Date("2025-06-01T12:00:00Z"); // 14 days

      expect(() => enforceMaxRange(from, to)).toThrow("exceeds 10 days");
    });

    it("rejects 30-day ranges", () => {
      const to = new Date("2025-06-30T00:00:00Z");
      const from = new Date("2025-06-01T00:00:00Z");

      expect(() => enforceMaxRange(from, to)).toThrow("exceeds 10 days");
    });

    it("accepts string dates", () => {
      const result = enforceMaxRange(
        "2025-06-10T00:00:00Z",
        "2025-06-15T00:00:00Z",
      );
      expect(result.from).toContain("2025-06-10");
      expect(result.to).toContain("2025-06-15");
    });

    it("includes weekly/monthly suggestion in the error message", () => {
      try {
        enforceMaxRange("2025-05-01T00:00:00Z", "2025-06-01T00:00:00Z");
        expect.fail("Should have thrown");
      } catch (err) {
        expect((err as Error).message).toContain("weeklyReport() or monthlySummary()");
      }
    });
  });
});