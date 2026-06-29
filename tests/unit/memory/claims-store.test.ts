// tests/unit/memory/claims-store.test.ts
//
// Covers the durable knowledge-claims store introduced in issue #247
// (SPRINT-3 active knowledge acquisition). Cascade resolutions from the
// context-packet are persisted here as claims so future similar queries can
// skip the expensive teacher-LLM / web-research cascade and reuse the prior
// resolution.
//
// The store is exercised against a real on-disk SQLite database in a temp
// directory — no network, no embedding provider, no mocking. The Thompson
// sampler is exercised through the public surface with a deterministic RNG.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";
import {
  ClaimsStore,
  claimsStore,
  formatClaimsSection,
  type KnowledgeClaim,
} from "../../../src/memory/claims-store";

function tmpDir(): string {
  return path.join(
    os.tmpdir(),
    `claims-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
}

// Deterministic linear-congruential RNG so Thompson-sampling-based retrieval
// is reproducible.
function seededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

describe("ClaimsStore", () => {
  let dir: string;
  let store: ClaimsStore;

  beforeEach(() => {
    dir = tmpDir();
    store = new ClaimsStore(dir);
  });

  afterEach(() => {
    store.close();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("persists a stored claim and reads it back by id", () => {
    const id = store.storeClaim({
      query: "how do I configure the cascade teacher model?",
      resolution: "Set CASCADE_TEACHER_MODEL in .env to override the default provider model.",
      cascadeLevel: "teacher_verify",
      confidence: 0.87,
      source: "teacher:glm-5.2",
    });
    expect(id).toBeTruthy();

    const all = store.allClaims();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(id);
    expect(all[0].query).toContain("configure the cascade");
    expect(all[0].cascadeLevel).toBe("teacher_verify");
    expect(all[0].confidence).toBeCloseTo(0.87, 5);
    expect(all[0].source).toBe("teacher:glm-5.2");
    expect(all[0].alpha).toBeGreaterThan(0);
    expect(all[0].createdAt).toBeInstanceOf(Date);
  });

  it("retrieveClaims returns claims ranked by SA-CTS and stamps lastRetrievedAt", () => {
    store.storeClaim({
      query: "configure ollama embedding provider",
      resolution: "Set EMBEDDING_PROVIDER=ollama and EMBEDDING_MODEL=nomic-embed-text.",
      cascadeLevel: "tool_research",
      confidence: 0.8,
      source: "web_search",
    });
    const matchId = store.storeClaim({
      query: "how do I configure the ollama embedding provider for embeddings?",
      resolution: "EMBEDDING_PROVIDER=ollama, EMBEDDING_MODEL=nomic-embed-text in .env.",
      cascadeLevel: "teacher_verify",
      confidence: 0.9,
      source: "teacher",
    });
    store.storeClaim({
      query: "completely unrelated topic about cooking pasta",
      resolution: "Boil water, add pasta, cook for 10 minutes.",
      cascadeLevel: "tool_research",
      confidence: 0.5,
      source: "web_search",
    });

    const results = store.retrieveClaims("how do I configure ollama embedding provider", 5, {
      rng: seededRng(42),
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe(matchId);
    expect(results[0].lastRetrievedAt).toBeInstanceOf(Date);
  });

  it("retrieveClaims returns an empty array when the store is empty", () => {
    expect(store.retrieveClaims("anything", 5)).toEqual([]);
  });

  it("updateClaimUtility increments alpha on success and beta on failure", () => {
    const id = store.storeClaim({
      query: "q1",
      resolution: "r1",
      cascadeLevel: "teacher_verify",
      confidence: 0.8,
      source: "teacher",
    });
    const before = store.allClaims()[0];
    const baseAlpha = before.alpha;
    const baseBeta = before.beta;

    store.updateClaimUtility(id, true);
    store.updateClaimUtility(id, true);
    store.updateClaimUtility(id, false);

    const after = store.allClaims()[0];
    expect(after.alpha).toBe(baseAlpha + 2);
    expect(after.beta).toBe(baseBeta + 1);
  });

  it("updateClaimUtility is a no-op for an unknown claim id", () => {
    expect(() => store.updateClaimUtility("does-not-exist", true)).not.toThrow();
    expect(store.allClaims()).toHaveLength(0);
  });

  it("pruneStaleClaims removes claims unretrieved past the max-age window", () => {
    const freshId = store.storeClaim({
      query: "fresh query",
      resolution: "fresh resolution",
      cascadeLevel: "teacher_verify",
      confidence: 0.85,
      source: "teacher",
    });
    const staleId = store.storeClaim({
      query: "stale query",
      resolution: "stale resolution",
      cascadeLevel: "tool_research",
      confidence: 0.6,
      source: "web_search",
    });

    // Push the stale claim's created/lastRetrieved timestamps back 60 days so
    // it's well past the 30-day max-age. The fresh claim retains its current
    // timestamp.
    const sixtyDaysAgo = Date.now() - 60 * 24 * 60 * 60 * 1000;
    store["db"]!.prepare(
      "UPDATE claims SET createdAt = ?, lastRetrievedAt = ? WHERE id = ?",
    ).run(sixtyDaysAgo, sixtyDaysAgo, staleId);

    const removed = store.pruneStaleClaims(30);
    expect(removed).toBe(1);

    const remaining = store.allClaims().map((c) => c.id);
    expect(remaining).toContain(freshId);
    expect(remaining).not.toContain(staleId);
  });

  it("pruneStaleClaims keeps claims retrieved recently regardless of creation date", () => {
    const id = store.storeClaim({
      query: "old query",
      resolution: "old resolution",
      cascadeLevel: "tool_research",
      confidence: 0.7,
      source: "web_search",
    });
    // Created 60 days ago, but retrieved today.
    const sixtyDaysAgo = Date.now() - 60 * 24 * 60 * 60 * 1000;
    store["db"]!.prepare(
      "UPDATE claims SET createdAt = ?, lastRetrievedAt = ? WHERE id = ?",
    ).run(sixtyDaysAgo, Date.now(), id);

    expect(store.pruneStaleClaims(30)).toBe(0);
    expect(store.allClaims().map((c) => c.id)).toContain(id);
  });

  it("persists claims across store instances on the same directory", () => {
    const id = store.storeClaim({
      query: "persistent query",
      resolution: "persistent resolution",
      cascadeLevel: "teacher_verify",
      confidence: 0.9,
      source: "teacher",
    });
    store.close();
    const reopened = new ClaimsStore(dir);
    try {
      const found = reopened.allClaims().find((c) => c.id === id);
      expect(found).toBeDefined();
      expect(found?.resolution).toBe("persistent resolution");
    } finally {
      reopened.close();
    }
  });
});

describe("claimsStore singleton", () => {
  it("exposes a module-level singleton", () => {
    expect(claimsStore).toBeInstanceOf(ClaimsStore);
  });
});

describe("formatClaimsSection", () => {
  it("returns null for an empty list", () => {
    expect(formatClaimsSection([])).toBeNull();
  });

  it("renders a prior-knowledge section with confidence and source", () => {
    const claim: KnowledgeClaim = {
      id: "c1",
      query: "how do I configure ollama?",
      resolution: "Set EMBEDDING_PROVIDER=ollama in .env.",
      cascadeLevel: "teacher_verify",
      confidence: 0.85,
      source: "teacher:glm-5.2",
      alpha: 4,
      beta: 1,
      createdAt: new Date(),
      lastRetrievedAt: new Date(),
    };
    const out = formatClaimsSection([claim]);
    expect(out).not.toBeNull();
    expect(out!).toContain("PRIOR KNOWLEDGE");
    expect(out!).toContain("Set EMBEDDING_PROVIDER=ollama in .env.");
    expect(out!).toContain("teacher:glm-5.2");
  });
});
