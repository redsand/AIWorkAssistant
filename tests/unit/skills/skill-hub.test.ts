import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  SkillHub,
  sha256,
  type HubPublisher,
} from "../../../src/skills/skill-hub";
import { createSkillHubHandler } from "../../../src/agent/handlers/skill-hub";
import type { SkillHubStore } from "../../../src/agent/handlers/skill-hub";
import type { SkillManifest } from "../../../src/skills/skill-types";

// ── Fixtures ────────────────────────────────────────────────────────

const SKILL_BODY = `---
name: fix-auth
description: "Fix authentication issues"
version: 1.0.0
category: debugging
tags:
  - auth
  - security
author: alice
license: MIT
status: active
---

## When to Use
When auth fails.

## Procedure
1. Check logs
`;

const HUB_URL = "https://hub.example/main";

function manifestFor(body: string): SkillManifest {
  return {
    name: "fix-auth",
    version: "1.0.0",
    author: "alice",
    description: "Fix authentication issues",
    category: "debugging",
    tags: ["auth", "security"],
    checksum: sha256(body),
    downloadUrl: `${HUB_URL}/skills/debugging/fix-auth/SKILL.md`,
    license: "MIT",
  };
}

interface MockResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}

function makeFetch(opts: {
  index?: unknown;
  indexStatus?: number;
  skillBody?: string;
  skillStatus?: number;
}): typeof fetch {
  return vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.endsWith("/index.json")) {
      const status = opts.indexStatus ?? 200;
      return {
        ok: status < 400,
        status,
        json: async () => opts.index ?? { skills: [] },
        text: async () => JSON.stringify(opts.index ?? { skills: [] }),
      } as MockResponse;
    }
    const status = opts.skillStatus ?? 200;
    return {
      ok: status < 400,
      status,
      json: async () => ({}),
      text: async () => opts.skillBody ?? "",
    } as MockResponse;
  }) as unknown as typeof fetch;
}

// ── SkillHub (real file ops, mocked network) ────────────────────────

describe("SkillHub", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = path.join(
      os.tmpdir(),
      `skill-hub-test-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`,
    );
    fs.mkdirSync(baseDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  function hub(overrides?: { publisher?: HubPublisher; fetchImpl?: typeof fetch }) {
    return new SkillHub({
      skillsBasePath: baseDir,
      hubUrl: HUB_URL,
      fetchImpl: overrides?.fetchImpl,
      publisher: overrides?.publisher,
    });
  }

  // ── search ────────────────────────────────────────────────────────

  describe("search", () => {
    it("filters the registry index by query", async () => {
      const index = {
        skills: [
          { ...manifestFor(SKILL_BODY), installs: 12, rating: 4.5 },
          {
            ...manifestFor(SKILL_BODY),
            name: "deploy-prod",
            description: "Deploy to production",
            category: "deployment",
            tags: ["deploy"],
          },
        ],
      };
      const h = hub({ fetchImpl: makeFetch({ index }) });
      const results = await h.search("auth");
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("fix-auth");
      expect(results[0].installs).toBe(12);
      expect(results[0].rating).toBe(4.5);
    });

    it("matches on category and tags too", async () => {
      const index = { skills: [manifestFor(SKILL_BODY)] };
      const h = hub({ fetchImpl: makeFetch({ index }) });
      expect(await h.search("debugging")).toHaveLength(1);
      expect(await h.search("security")).toHaveLength(1);
      expect(await h.search("nomatch")).toHaveLength(0);
    });

    it("accepts a bare array index", async () => {
      const h = hub({ fetchImpl: makeFetch({ index: [manifestFor(SKILL_BODY)] }) });
      expect(await h.search("fix")).toHaveLength(1);
    });

    it("throws when the index cannot be fetched", async () => {
      const h = hub({ fetchImpl: makeFetch({ indexStatus: 500 }) });
      await expect(h.search("auth")).rejects.toThrow(/Failed to fetch hub index/);
    });
  });

  // ── install / quarantine ──────────────────────────────────────────

  describe("install", () => {
    it("downloads to quarantine and verifies checksum", async () => {
      const index = { skills: [manifestFor(SKILL_BODY)] };
      const h = hub({ fetchImpl: makeFetch({ index, skillBody: SKILL_BODY }) });

      const result = await h.install("fix-auth");
      expect(result.success).toBe(true);
      expect(result.checksumVerified).toBe(true);
      expect(result.preview).toContain("## Procedure");

      const quarantined = path.join(
        baseDir,
        ".hub",
        "quarantine",
        "fix-auth",
        "SKILL.md",
      );
      expect(fs.existsSync(quarantined)).toBe(true);

      // Recorded in the hub index as quarantined.
      const idx = JSON.parse(
        fs.readFileSync(path.join(baseDir, ".hub", "index.json"), "utf-8"),
      );
      expect(idx.skills[0].name).toBe("fix-auth");
      expect(idx.skills[0].status).toBe("quarantined");

      // NOT activated in the skills directory.
      expect(fs.existsSync(path.join(baseDir, "debugging", "fix-auth"))).toBe(
        false,
      );
    });

    it("rejects on checksum mismatch and does not quarantine", async () => {
      const manifest = manifestFor(SKILL_BODY);
      manifest.checksum = "deadbeef";
      const index = { skills: [manifest] };
      const h = hub({ fetchImpl: makeFetch({ index, skillBody: SKILL_BODY }) });

      const result = await h.install("fix-auth");
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Checksum mismatch/);
      expect(
        fs.existsSync(path.join(baseDir, ".hub", "quarantine", "fix-auth")),
      ).toBe(false);
    });

    it("rejects unknown skill", async () => {
      const h = hub({ fetchImpl: makeFetch({ index: { skills: [] } }) });
      const result = await h.install("ghost");
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not found in hub registry/);
    });

    it("rejects invalid skill names (path traversal)", async () => {
      const h = hub({ fetchImpl: makeFetch({ index: { skills: [] } }) });
      const result = await h.install("../evil");
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Invalid name/);
    });

    it("fails when the skill download 404s", async () => {
      const index = { skills: [manifestFor(SKILL_BODY)] };
      const h = hub({ fetchImpl: makeFetch({ index, skillStatus: 404 }) });
      const result = await h.install("fix-auth");
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Failed to download/);
    });
  });

  // ── promote ───────────────────────────────────────────────────────

  describe("promote", () => {
    it("moves a quarantined skill to the active category dir", async () => {
      const index = { skills: [manifestFor(SKILL_BODY)] };
      const h = hub({ fetchImpl: makeFetch({ index, skillBody: SKILL_BODY }) });
      await h.install("fix-auth");

      await h.promote("fix-auth");

      const active = path.join(baseDir, "debugging", "fix-auth", "SKILL.md");
      expect(fs.existsSync(active)).toBe(true);
      expect(
        fs.existsSync(path.join(baseDir, ".hub", "quarantine", "fix-auth")),
      ).toBe(false);

      const entry = h.readIndex().skills.find((s) => s.name === "fix-auth");
      expect(entry?.status).toBe("promoted");
      expect(entry?.promotedPath).toBe("debugging/fix-auth/SKILL.md");
    });

    it("throws when there is nothing to promote", async () => {
      const h = hub({ fetchImpl: makeFetch({ index: { skills: [] } }) });
      await expect(h.promote("fix-auth")).rejects.toThrow(/No quarantined skill/);
    });
  });

  // ── listInstalled ─────────────────────────────────────────────────

  describe("listInstalled", () => {
    it("returns manifests for installed skills", async () => {
      const index = { skills: [manifestFor(SKILL_BODY)] };
      const h = hub({ fetchImpl: makeFetch({ index, skillBody: SKILL_BODY }) });
      await h.install("fix-auth");

      const installed = await h.listInstalled();
      expect(installed).toHaveLength(1);
      expect(installed[0].name).toBe("fix-auth");
      expect((installed[0] as Record<string, unknown>).status).toBeUndefined();
    });

    it("returns empty when nothing installed", async () => {
      const h = hub();
      expect(await h.listInstalled()).toEqual([]);
    });
  });

  // ── remove ────────────────────────────────────────────────────────

  describe("remove", () => {
    it("removes a quarantined skill and its index entry", async () => {
      const index = { skills: [manifestFor(SKILL_BODY)] };
      const h = hub({ fetchImpl: makeFetch({ index, skillBody: SKILL_BODY }) });
      await h.install("fix-auth");

      await h.remove("fix-auth");
      expect(
        fs.existsSync(path.join(baseDir, ".hub", "quarantine", "fix-auth")),
      ).toBe(false);
      expect(await h.listInstalled()).toHaveLength(0);
    });

    it("removes a promoted skill from the active dir", async () => {
      const index = { skills: [manifestFor(SKILL_BODY)] };
      const h = hub({ fetchImpl: makeFetch({ index, skillBody: SKILL_BODY }) });
      await h.install("fix-auth");
      await h.promote("fix-auth");

      await h.remove("fix-auth");
      expect(fs.existsSync(path.join(baseDir, "debugging", "fix-auth"))).toBe(
        false,
      );
      expect(await h.listInstalled()).toHaveLength(0);
    });
  });

  // ── publish ───────────────────────────────────────────────────────

  describe("publish", () => {
    function mockPublisher(): HubPublisher & {
      created: Record<string, string>;
    } {
      const created: Record<string, string> = {};
      return {
        created,
        getFile: vi.fn(async () => {
          throw new Error("404");
        }),
        createFile: vi.fn(async (filePath: string, content: string) => {
          created[filePath] = content;
          return { content: { html_url: `https://github.com/x/${filePath}` } };
        }),
        updateFile: vi.fn(async (filePath: string, content: string) => {
          created[filePath] = content;
          return { content: { html_url: `https://github.com/x/${filePath}` } };
        }),
      };
    }

    it("packages a local skill, pushes file + index, returns manifest", async () => {
      const skillDir = path.join(baseDir, "debugging", "fix-auth");
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), SKILL_BODY, "utf-8");

      const publisher = mockPublisher();
      const h = hub({ publisher });
      const result = await h.publish("debugging/fix-auth/SKILL.md");

      expect(result.success).toBe(true);
      expect(result.name).toBe("fix-auth");
      expect(result.manifest?.checksum).toBe(sha256(SKILL_BODY));
      expect(result.manifest?.category).toBe("debugging");
      expect(publisher.created["skills/debugging/fix-auth/SKILL.md"]).toBe(
        SKILL_BODY,
      );
      const indexJson = JSON.parse(publisher.created["index.json"]);
      expect(indexJson.skills[0].name).toBe("fix-auth");
    });

    it("accepts a directory path and appends SKILL.md", async () => {
      const skillDir = path.join(baseDir, "debugging", "fix-auth");
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), SKILL_BODY, "utf-8");

      const h = hub({ publisher: mockPublisher() });
      const result = await h.publish("debugging/fix-auth");
      expect(result.success).toBe(true);
    });

    it("fails when the local skill does not exist", async () => {
      const h = hub({ publisher: mockPublisher() });
      const result = await h.publish("nope/missing/SKILL.md");
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Skill not found/);
    });

    it("fails when no publisher is configured", async () => {
      const skillDir = path.join(baseDir, "debugging", "fix-auth");
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), SKILL_BODY, "utf-8");

      const h = hub();
      const result = await h.publish("debugging/fix-auth/SKILL.md");
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/No hub publisher/);
    });
  });
});

// ── Handler (mock store) ────────────────────────────────────────────

function createMockStore(overrides?: Partial<SkillHubStore>): SkillHubStore {
  return {
    search: vi.fn(async () => []),
    install: vi.fn(async (name: string) => ({
      success: true,
      name,
      quarantinePath: `.hub/quarantine/${name}/SKILL.md`,
      checksumVerified: true,
      preview: "body",
    })),
    promote: vi.fn(async () => undefined),
    publish: vi.fn(async (localPath: string) => ({
      success: true,
      name: localPath,
    })),
    listInstalled: vi.fn(async () => []),
    remove: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("handleSkillHub", () => {
  let store: ReturnType<typeof createMockStore>;
  let handleSkillHub: ReturnType<typeof createSkillHubHandler>;

  beforeEach(() => {
    store = createMockStore();
    handleSkillHub = createSkillHubHandler(store);
  });

  it("rejects missing action", async () => {
    const result = await handleSkillHub({});
    expect(result.success).toBe(false);
    expect(result.error).toContain("action is required");
  });

  it("rejects unknown action", async () => {
    const result = await handleSkillHub({ action: "frobnicate" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown action");
  });

  describe("search", () => {
    it("requires a query", async () => {
      const result = await handleSkillHub({ action: "search" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("query is required");
    });

    it("returns results", async () => {
      store.search = vi.fn(async () => [
        {
          name: "fix-auth",
          description: "d",
          category: "debugging",
          author: "a",
          version: "1.0.0",
          installs: 1,
          rating: 5,
        },
      ]);
      const result = await handleSkillHub({ action: "search", query: "auth" });
      expect(result.success).toBe(true);
      expect(store.search).toHaveBeenCalledWith("auth");
      expect(result.message).toContain("Found 1");
    });
  });

  describe("install", () => {
    it("requires a name", async () => {
      const result = await handleSkillHub({ action: "install" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("name is required");
    });

    it("quarantines and instructs to promote", async () => {
      const result = await handleSkillHub({ action: "install", name: "fix-auth" });
      expect(result.success).toBe(true);
      expect(store.install).toHaveBeenCalledWith("fix-auth");
      expect(result.message).toContain("promote");
    });

    it("propagates install failures", async () => {
      store.install = vi.fn(async (name: string) => ({
        success: false,
        name,
        error: "Checksum mismatch",
      }));
      const result = await handleSkillHub({ action: "install", name: "fix-auth" });
      expect(result.success).toBe(false);
      expect(result.error).toBe("Checksum mismatch");
    });
  });

  describe("promote", () => {
    it("requires a name", async () => {
      const result = await handleSkillHub({ action: "promote" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("name is required");
    });

    it("promotes a skill", async () => {
      const result = await handleSkillHub({ action: "promote", name: "fix-auth" });
      expect(result.success).toBe(true);
      expect(store.promote).toHaveBeenCalledWith("fix-auth");
    });
  });

  describe("publish", () => {
    it("requires local_path", async () => {
      const result = await handleSkillHub({ action: "publish" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("local_path is required");
    });

    it("publishes a skill", async () => {
      const result = await handleSkillHub({
        action: "publish",
        local_path: "debugging/fix-auth/SKILL.md",
      });
      expect(result.success).toBe(true);
      expect(store.publish).toHaveBeenCalledWith("debugging/fix-auth/SKILL.md");
    });
  });

  describe("list", () => {
    it("lists installed skills", async () => {
      const result = await handleSkillHub({ action: "list" });
      expect(result.success).toBe(true);
      expect(store.listInstalled).toHaveBeenCalled();
    });
  });

  describe("remove", () => {
    it("requires a name", async () => {
      const result = await handleSkillHub({ action: "remove" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("name is required");
    });

    it("removes a skill", async () => {
      const result = await handleSkillHub({ action: "remove", name: "fix-auth" });
      expect(result.success).toBe(true);
      expect(store.remove).toHaveBeenCalledWith("fix-auth");
    });
  });
});
