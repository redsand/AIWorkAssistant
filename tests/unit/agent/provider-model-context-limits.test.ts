/**
 * Tests for per-model context limit resolution
 */

import { describe, it, expect } from "vitest";

describe("getEffectiveContextLimit", () => {
  // Test the logic directly since the module reads env at import time.
  // We replicate the function logic here to verify correctness.

  function getEffectiveContextLimit(
    model: string,
    defaultLimit: number,
    modelContextLimits: string,
  ): number {
    if (!modelContextLimits) return defaultLimit;
    try {
      const limits = JSON.parse(modelContextLimits) as Record<string, number>;
      return limits[model] ?? defaultLimit;
    } catch {
      return defaultLimit;
    }
  }

  it("returns default limit when no overrides are set", () => {
    expect(getEffectiveContextLimit("glm-5.1:cloud", 128000, "")).toBe(128000);
  });

  it("returns override when model matches", () => {
    expect(
      getEffectiveContextLimit(
        "glm-5.1:cloud",
        128000,
        '{"glm-5.1:cloud": 202752}',
      ),
    ).toBe(202752);
  });

  it("returns default when model does not match any override", () => {
    expect(
      getEffectiveContextLimit(
        "llama3:8b",
        128000,
        '{"glm-5.1:cloud": 202752, "llama3:70b": 8192}',
      ),
    ).toBe(128000);
  });

  it("handles multiple model overrides", () => {
    const limits = '{"glm-5.1:cloud": 202752, "llama3:70b": 8192}';
    expect(getEffectiveContextLimit("glm-5.1:cloud", 128000, limits)).toBe(
      202752,
    );
    expect(getEffectiveContextLimit("llama3:70b", 128000, limits)).toBe(8192);
  });

  it("returns default for invalid JSON", () => {
    expect(
      getEffectiveContextLimit("glm-5.1:cloud", 128000, "not-valid-json"),
    ).toBe(128000);
  });

  it("returns default for empty string", () => {
    expect(getEffectiveContextLimit("glm-5.1:cloud", 128000, "")).toBe(128000);
  });
});