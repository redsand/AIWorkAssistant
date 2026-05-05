import { describe, it, expect } from "vitest";
import { sanitizeValue } from "../../../src/agent-runs/sanitizer";

describe("sanitizeValue", () => {
  it("should pass through null", () => {
    expect(sanitizeValue(null)).toBeNull();
  });

  it("should pass through undefined", () => {
    expect(sanitizeValue(undefined)).toBeUndefined();
  });

  it("should pass through strings", () => {
    expect(sanitizeValue("hello")).toBe("hello");
  });

  it("should pass through numbers", () => {
    expect(sanitizeValue(42)).toBe(42);
  });

  it("should pass through booleans", () => {
    expect(sanitizeValue(true)).toBe(true);
    expect(sanitizeValue(false)).toBe(false);
  });

  it("should redact apikey", () => {
    expect(sanitizeValue({ apikey: "secret" })).toEqual({ apikey: "[REDACTED]" });
  });

  it("should redact api_key", () => {
    expect(sanitizeValue({ api_key: "secret" })).toEqual({ api_key: "[REDACTED]" });
  });

  it("should redact token", () => {
    expect(sanitizeValue({ token: "abc123" })).toEqual({ token: "[REDACTED]" });
  });

  it("should redact password", () => {
    expect(sanitizeValue({ password: "hunter2" })).toEqual({ password: "[REDACTED]" });
  });

  it("should redact authorization", () => {
    expect(sanitizeValue({ authorization: "Bearer xyz" })).toEqual({ authorization: "[REDACTED]" });
  });

  it("should redact secret", () => {
    expect(sanitizeValue({ secret: "shh" })).toEqual({ secret: "[REDACTED]" });
  });

  it("should redact access_token", () => {
    expect(sanitizeValue({ access_token: "at123" })).toEqual({ access_token: "[REDACTED]" });
  });

  it("should redact refresh_token", () => {
    expect(sanitizeValue({ refresh_token: "rt456" })).toEqual({ refresh_token: "[REDACTED]" });
  });

  it("should match secret field names case-insensitively", () => {
    expect(sanitizeValue({ Token: "abc" })).toEqual({ Token: "[REDACTED]" });
    expect(sanitizeValue({ PASSWORD: "abc" })).toEqual({ PASSWORD: "[REDACTED]" });
    expect(sanitizeValue({ Secret: "abc" })).toEqual({ Secret: "[REDACTED]" });
  });

  it("should leave non-secret fields unchanged", () => {
    expect(sanitizeValue({ name: "Alice", age: 30 })).toEqual({ name: "Alice", age: 30 });
  });

  it("should redact nested secret fields", () => {
    const input = {
      config: {
        host: "example.com",
        password: "nested-secret",
      },
    };
    expect(sanitizeValue(input)).toEqual({
      config: {
        host: "example.com",
        password: "[REDACTED]",
      },
    });
  });

  it("should redact secrets in arrays", () => {
    const input = [
      { name: "Alice", token: "t1" },
      { name: "Bob", token: "t2" },
    ];
    expect(sanitizeValue(input)).toEqual([
      { name: "Alice", token: "[REDACTED]" },
      { name: "Bob", token: "[REDACTED]" },
    ]);
  });

  it("should handle mixed objects with secrets and non-secrets", () => {
    const input = {
      username: "admin",
      password: "super-secret",
      apiUrl: "https://api.example.com",
      api_key: "key-123",
    };
    expect(sanitizeValue(input)).toEqual({
      username: "admin",
      password: "[REDACTED]",
      apiUrl: "https://api.example.com",
      api_key: "[REDACTED]",
    });
  });

  it("should handle deeply nested objects", () => {
    const input = {
      level1: {
        level2: {
          authorization: "deep-auth",
          data: "visible",
        },
      },
    };
    expect(sanitizeValue(input)).toEqual({
      level1: {
        level2: {
          authorization: "[REDACTED]",
          data: "visible",
        },
      },
    });
  });

  it("should pass through primitive arrays", () => {
    expect(sanitizeValue([1, 2, 3])).toEqual([1, 2, 3]);
  });
});