import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import {
  createSessionToken,
  validateSessionToken,
  revokeSessionToken,
  timingSafeEqual,
  isAuthConfigured,
} from "../../../src/middleware/auth";

const chatRequestSchema = z.object({
  message: z.string(),
  sessionId: z.string().nullable().optional(),
});

describe("Chat Request Schema", () => {
  it("should accept a valid sessionId string", () => {
    const result = chatRequestSchema.parse({
      message: "hello",
      sessionId: "abc-123",
    });
    expect(result.sessionId).toBe("abc-123");
  });

  it("should accept sessionId as undefined", () => {
    const result = chatRequestSchema.parse({
      message: "hello",
    });
    expect(result.sessionId).toBeUndefined();
  });

  it("should accept sessionId as null", () => {
    const result = chatRequestSchema.parse({
      message: "hello",
      sessionId: null,
    });
    expect(result.sessionId).toBeNull();
  });

  it("should accept sessionId as undefined explicitly", () => {
    const result = chatRequestSchema.parse({
      message: "hello",
      sessionId: undefined,
    });
    expect(result.sessionId).toBeUndefined();
  });

  it("should reject a non-string, non-null sessionId", () => {
    expect(() =>
      chatRequestSchema.parse({
        message: "hello",
        sessionId: 123,
      }),
    ).toThrow();
  });
});

describe("Auth Middleware", () => {
  describe("timingSafeEqual", () => {
    it("should return true for equal strings", () => {
      expect(timingSafeEqual("hello", "hello")).toBe(true);
    });

    it("should return false for different strings", () => {
      expect(timingSafeEqual("hello", "world")).toBe(false);
    });

    it("should return false for different length strings", () => {
      expect(timingSafeEqual("hello", "helloworld")).toBe(false);
    });

    it("should return false if either argument is not a string", () => {
      expect(timingSafeEqual(null as any, "hello")).toBe(false);
      expect(timingSafeEqual("hello", null as any)).toBe(false);
      expect(timingSafeEqual(undefined as any, undefined as any)).toBe(false);
    });

    it("should return true for empty strings", () => {
      expect(timingSafeEqual("", "")).toBe(true);
    });
  });

  describe("Session Token Management", () => {
    it("should create a session token", () => {
      const token = createSessionToken("testuser");
      expect(token).toBeDefined();
      expect(typeof token).toBe("string");
      expect(token.length).toBe(64);
    });

    it("should validate a created session token", () => {
      const token = createSessionToken("testuser");
      const session = validateSessionToken(token);

      expect(session).not.toBeNull();
      expect(session!.userId).toBe("testuser");
      expect(session!.token).toBe(token);
    });

    it("should return null for an invalid token", () => {
      const session = validateSessionToken("invalid-token");
      expect(session).toBeNull();
    });

    it("should revoke a session token", () => {
      const token = createSessionToken("testuser");
      expect(revokeSessionToken(token)).toBe(true);
      expect(validateSessionToken(token)).toBeNull();
    });

    it("should return false when revoking a non-existent token", () => {
      expect(revokeSessionToken("non-existent")).toBe(false);
    });

    it("should create unique tokens for different sessions", () => {
      const token1 = createSessionToken("user1");
      const token2 = createSessionToken("user2");
      expect(token1).not.toBe(token2);
    });

    it("should handle multiple sessions independently", () => {
      const token1 = createSessionToken("user1");
      const token2 = createSessionToken("user2");

      expect(validateSessionToken(token1)!.userId).toBe("user1");
      expect(validateSessionToken(token2)!.userId).toBe("user2");

      revokeSessionToken(token1);
      expect(validateSessionToken(token1)).toBeNull();
      expect(validateSessionToken(token2)!.userId).toBe("user2");
    });
  });

  describe("isAuthConfigured", () => {
    it("should reflect whether AUTH_PASSWORD is set", () => {
      const result = isAuthConfigured();
      expect(typeof result).toBe("boolean");
    });
  });
});
