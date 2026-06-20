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
  "CLAIMKIT_INIT_TIMEOUT_MS",
  "CLAIMKIT_LLM_MODEL",
  "CLAIMKIT_OLLAMA_API_URL",
  "CLAIMKIT_OLLAMA_API_KEY",
  "CLAIMKIT_OLLAMA_MODEL",
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

    it("should default CLAIMKIT_LLM_PROVIDER to 'comparison'", () => {
      const env = loadEnv();
      expect(env.CLAIMKIT_LLM_PROVIDER).toBe("comparison");
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

    it("should default CLAIMKIT_QUERY_TIMEOUT_MS to 120000", () => {
      const env = loadEnv();
      expect(env.CLAIMKIT_QUERY_TIMEOUT_MS).toBe(120000);
    });

    it("should default CLAIMKIT_INIT_TIMEOUT_MS to 5000", () => {
      const env = loadEnv();
      expect(env.CLAIMKIT_INIT_TIMEOUT_MS).toBe(5000);
    });

    it("should default CLAIMKIT_LLM_MODEL to empty string", () => {
      const env = loadEnv();
      expect(env.CLAIMKIT_LLM_MODEL).toBe("");
    });

    it("should default CLAIMKIT_OLLAMA_API_URL to http://localhost:11434", () => {
      const env = loadEnv();
      expect(env.CLAIMKIT_OLLAMA_API_URL).toBe("http://localhost:11434");
    });

    it("should default CLAIMKIT_OLLAMA_API_KEY to empty string", () => {
      const env = loadEnv();
      expect(env.CLAIMKIT_OLLAMA_API_KEY).toBe("");
    });

    it("should default CLAIMKIT_OLLAMA_MODEL to empty (inherits OLLAMA_MODEL)", () => {
      // Changed 2026-06-18: an empty default lets the adapter fall back to the
      // user's main OLLAMA_MODEL instead of hard-failing with 'llama3 not found'
      // for users running anything else.
      const env = loadEnv();
      expect(env.CLAIMKIT_OLLAMA_MODEL).toBe("");
    });

    it("should default CLAIMKIT_REQUIRE_INIT to true (strict mode)", () => {
      const env = loadEnv();
      expect(env.CLAIMKIT_REQUIRE_INIT).toBe(true);
    });

    it("should default CLAIMKIT_BLOCK_ON_INGESTION to false (non-blocking startup)", () => {
      // Default was flipped to false: server.listen() should be responsive
      // immediately while background ingestion runs. CI / deterministic-
      // startup environments can still set CLAIMKIT_BLOCK_ON_INGESTION=true.
      const env = loadEnv();
      expect(env.CLAIMKIT_BLOCK_ON_INGESTION).toBe(false);
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

    it("should parse CLAIMKIT_INIT_TIMEOUT_MS as number", () => {
      process.env.CLAIMKIT_INIT_TIMEOUT_MS = "10000";
      const env = loadEnv();
      expect(env.CLAIMKIT_INIT_TIMEOUT_MS).toBe(10000);
    });

    it("should parse CLAIMKIT_LLM_MODEL", () => {
      process.env.CLAIMKIT_LLM_MODEL = "glm-5";
      const env = loadEnv();
      expect(env.CLAIMKIT_LLM_MODEL).toBe("glm-5");
    });

    it("should parse CLAIMKIT_OLLAMA_API_URL", () => {
      process.env.CLAIMKIT_OLLAMA_API_URL = "http://ollama.local:11434";
      const env = loadEnv();
      expect(env.CLAIMKIT_OLLAMA_API_URL).toBe("http://ollama.local:11434");
    });

    it("should parse CLAIMKIT_OLLAMA_API_KEY", () => {
      process.env.CLAIMKIT_OLLAMA_API_KEY = "secret";
      const env = loadEnv();
      expect(env.CLAIMKIT_OLLAMA_API_KEY).toBe("secret");
    });

    it("should parse CLAIMKIT_OLLAMA_MODEL", () => {
      process.env.CLAIMKIT_OLLAMA_MODEL = "mistral";
      const env = loadEnv();
      expect(env.CLAIMKIT_OLLAMA_MODEL).toBe("mistral");
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
