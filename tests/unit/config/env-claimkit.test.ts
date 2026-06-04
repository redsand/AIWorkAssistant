import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Prevent dotenv from loading .env file during tests
vi.mock("dotenv", () => ({
  config: vi.fn(),
}));

const CLAIMKIT_KEYS = [
  "CLAIMKIT_ENABLED",
  "CLAIMKIT_LLM_PROVIDER",
  "CLAIMKIT_REDIS_URL",
  "CLAIMKIT_REDIS_PREFIX",
  "CLAIMKIT_TOP_K",
  "CLAIMKIT_MIN_SCORE",
  "CLAIMKIT_MAX_EVIDENCE_ITEMS",
  "CLAIMKIT_QUERY_SEED_LIMIT",
  "CLAIMKIT_QUERY_TIMEOUT_MS",
  "CLAIMKIT_REQUIRE_INIT",
  "CLAIMKIT_BLOCK_ON_INGESTION",
];

describe("ClaimKit environment variables", () => {
  const savedValues: Record<string, string | undefined> = {};
  let loadEnv: (typeof import("../../../src/config/env"))["loadEnv"];

  beforeEach(async () => {
    for (const key of CLAIMKIT_KEYS) {
      savedValues[key] = process.env[key];
      delete process.env[key];
    }
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
    vi.resetModules();
    const mod = await import("../../../src/config/env");
    loadEnv = mod.loadEnv;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const key of CLAIMKIT_KEYS) {
      if (savedValues[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedValues[key];
      }
    }
  });

  describe("defaults", () => {
    it("should default CLAIMKIT_ENABLED to false", () => {
      const env = loadEnv();
      expect(env.CLAIMKIT_ENABLED).toBe(false);
    });

    it("should default CLAIMKIT_LLM_PROVIDER to 'memory'", () => {
      const env = loadEnv();
      expect(env.CLAIMKIT_LLM_PROVIDER).toBe("memory");
    });

    it("should default CLAIMKIT_REDIS_URL to empty string", () => {
      const env = loadEnv();
      expect(env.CLAIMKIT_REDIS_URL).toBe("");
    });

    it("should default CLAIMKIT_REDIS_PREFIX to 'aiworkassistant'", () => {
      const env = loadEnv();
      expect(env.CLAIMKIT_REDIS_PREFIX).toBe("aiworkassistant");
    });

    it("should default CLAIMKIT_TOP_K to 10", () => {
      const env = loadEnv();
      expect(env.CLAIMKIT_TOP_K).toBe(10);
    });

    it("should default CLAIMKIT_MIN_SCORE to 0.0", () => {
      const env = loadEnv();
      expect(env.CLAIMKIT_MIN_SCORE).toBe(0.0);
    });

    it("should default CLAIMKIT_MAX_EVIDENCE_ITEMS to 20", () => {
      const env = loadEnv();
      expect(env.CLAIMKIT_MAX_EVIDENCE_ITEMS).toBe(20);
    });

    it("should default CLAIMKIT_QUERY_SEED_LIMIT to 5", () => {
      const env = loadEnv();
      expect(env.CLAIMKIT_QUERY_SEED_LIMIT).toBe(5);
    });

    it("should default CLAIMKIT_QUERY_TIMEOUT_MS to 30000", () => {
      const env = loadEnv();
      expect(env.CLAIMKIT_QUERY_TIMEOUT_MS).toBe(30000);
    });

    it("should default CLAIMKIT_REQUIRE_INIT to true (strict mode)", () => {
      const env = loadEnv();
      expect(env.CLAIMKIT_REQUIRE_INIT).toBe(true);
    });

    it("should default CLAIMKIT_BLOCK_ON_INGESTION to true (strict mode)", () => {
      const env = loadEnv();
      expect(env.CLAIMKIT_BLOCK_ON_INGESTION).toBe(true);
    });
  });

  describe("custom values", () => {
    it("should parse CLAIMKIT_ENABLED=true", () => {
      process.env.CLAIMKIT_ENABLED = "true";
      const env = loadEnv();
      expect(env.CLAIMKIT_ENABLED).toBe(true);
    });

    it("should parse CLAIMKIT_ENABLED=false", () => {
      process.env.CLAIMKIT_ENABLED = "false";
      const env = loadEnv();
      expect(env.CLAIMKIT_ENABLED).toBe(false);
    });

    it("should parse CLAIMKIT_LLM_PROVIDER custom value", () => {
      process.env.CLAIMKIT_LLM_PROVIDER = "comparison";
      const env = loadEnv();
      expect(env.CLAIMKIT_LLM_PROVIDER).toBe("comparison");
    });

    it("should accept ollama provider", () => {
      process.env.CLAIMKIT_LLM_PROVIDER = "ollama";
      const env = loadEnv();
      expect(env.CLAIMKIT_LLM_PROVIDER).toBe("ollama");
    });

    it("should parse CLAIMKIT_REDIS_URL", () => {
      process.env.CLAIMKIT_REDIS_URL = "redis://localhost:6379";
      const env = loadEnv();
      expect(env.CLAIMKIT_REDIS_URL).toBe("redis://localhost:6379");
    });

    it("should parse CLAIMKIT_REDIS_PREFIX", () => {
      process.env.CLAIMKIT_REDIS_PREFIX = "myapp";
      const env = loadEnv();
      expect(env.CLAIMKIT_REDIS_PREFIX).toBe("myapp");
    });

    it("should parse CLAIMKIT_TOP_K as number", () => {
      process.env.CLAIMKIT_TOP_K = "25";
      const env = loadEnv();
      expect(env.CLAIMKIT_TOP_K).toBe(25);
    });

    it("should parse CLAIMKIT_MIN_SCORE as float", () => {
      process.env.CLAIMKIT_MIN_SCORE = "0.5";
      const env = loadEnv();
      expect(env.CLAIMKIT_MIN_SCORE).toBe(0.5);
    });

    it("should parse CLAIMKIT_MAX_EVIDENCE_ITEMS as number", () => {
      process.env.CLAIMKIT_MAX_EVIDENCE_ITEMS = "50";
      const env = loadEnv();
      expect(env.CLAIMKIT_MAX_EVIDENCE_ITEMS).toBe(50);
    });

    it("should parse CLAIMKIT_QUERY_SEED_LIMIT as number", () => {
      process.env.CLAIMKIT_QUERY_SEED_LIMIT = "3";
      const env = loadEnv();
      expect(env.CLAIMKIT_QUERY_SEED_LIMIT).toBe(3);
    });

    it("should parse CLAIMKIT_QUERY_TIMEOUT_MS as number", () => {
      process.env.CLAIMKIT_QUERY_TIMEOUT_MS = "90000";
      const env = loadEnv();
      expect(env.CLAIMKIT_QUERY_TIMEOUT_MS).toBe(90000);
    });

    it("should coerce non-'true' strings to false for CLAIMKIT_ENABLED", () => {
      process.env.CLAIMKIT_ENABLED = "notabool";
      const env = loadEnv();
      expect(env.CLAIMKIT_ENABLED).toBe(false);
    });

    it("should coerce CLAIMKIT_ENABLED=0 to false", () => {
      process.env.CLAIMKIT_ENABLED = "0";
      const env = loadEnv();
      expect(env.CLAIMKIT_ENABLED).toBe(false);
    });

    it("should parse CLAIMKIT_REQUIRE_INIT=false (lenient mode)", () => {
      process.env.CLAIMKIT_REQUIRE_INIT = "false";
      const env = loadEnv();
      expect(env.CLAIMKIT_REQUIRE_INIT).toBe(false);
    });

    it("should parse CLAIMKIT_REQUIRE_INIT=true (explicit)", () => {
      process.env.CLAIMKIT_REQUIRE_INIT = "true";
      const env = loadEnv();
      expect(env.CLAIMKIT_REQUIRE_INIT).toBe(true);
    });

    it("should parse CLAIMKIT_BLOCK_ON_INGESTION=false (lenient mode)", () => {
      process.env.CLAIMKIT_BLOCK_ON_INGESTION = "false";
      const env = loadEnv();
      expect(env.CLAIMKIT_BLOCK_ON_INGESTION).toBe(false);
    });

    it("should parse CLAIMKIT_BLOCK_ON_INGESTION=true (explicit)", () => {
      process.env.CLAIMKIT_BLOCK_ON_INGESTION = "true";
      const env = loadEnv();
      expect(env.CLAIMKIT_BLOCK_ON_INGESTION).toBe(true);
    });
  });
});
