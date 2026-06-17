import { describe, it, expect, vi } from "vitest";

// Prevent dotenv from loading a real .env file during tests.
vi.mock("dotenv", () => ({
  config: vi.fn(),
}));

import { safeProfileName } from "../../../src/config/env";

describe("safeProfileName", () => {
  it("passes through plain identifiers", () => {
    expect(safeProfileName("default")).toBe("default");
    expect(safeProfileName("client-acme")).toBe("client-acme");
    expect(safeProfileName("work_2")).toBe("work_2");
    expect(safeProfileName("v1.2")).toBe("v1.2");
  });

  it("rejects '.' (would collapse out of the profile boundary)", () => {
    expect(safeProfileName(".")).toBe("default");
  });

  it("rejects '..' (parent-directory traversal)", () => {
    expect(safeProfileName("..")).toBe("default");
  });

  it("rejects traversal sequences with separators", () => {
    expect(safeProfileName("../escape")).toBe("default");
    expect(safeProfileName("../../etc/passwd")).toBe("default");
    expect(safeProfileName("a/b")).toBe("default");
    expect(safeProfileName("a\\b")).toBe("default");
  });

  it("rejects names with whitespace or other unsafe characters", () => {
    expect(safeProfileName("has space")).toBe("default");
    expect(safeProfileName("name;rm -rf")).toBe("default");
    expect(safeProfileName("")).toBe("default");
  });
});
