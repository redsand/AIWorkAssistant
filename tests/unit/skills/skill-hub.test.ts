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

  function hub(overrides?: {
    publisher?: HubPublisher;
    fetchImpl?: typeof fetch;
    publishEnabled?: boolean;
    timeoutMs?: number;
  }) {
    return new SkillHub({
      skillsBasePath: baseDir,
      hubUrl: HUB_URL,
      fetchImpl: overrides?.fetchImpl,
      publisher: overrides?.publisher,
      // Publishing is gated off by default; tests that exercise publish opt in.
      publishEnabled: overrides?.publishEnabled ?? true,
      timeoutMs: overrides?.timeoutMs,
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
      const h = hub({
        fetchImpl: makeFetch({ index: [manifestFor(SKILL_BODY)] }),
      });
      expect(await h.search("fix")).toHaveLength(1);
    });

    it("throws when the index cannot be fetched", async () => {
      const h = hub({ fetchImpl: makeFetch({ indexStatus: 500 }) });
      await expect(h.search("auth")).rejects.toThrow(
        /Failed to fetch hub index/,
      );
    });

    it("drops malformed entries from the remote index (schema validation)", async () => {
      const index = {
        skills: [
          manifestFor(SKILL_BODY), // valid
          { name: "no-fields" }, // missing required strings
          { ...manifestFor(SKILL_BODY), name: "../evil" }, // unsafe segment
          { ...manifestFor(SKILL_BODY), name: "good-cat", category: "../x" }, // unsafe category
          { ...manifestFor(SKILL_BODY), name: "bad-tags", tags: "notarray" }, // wrong type
          "not-an-object",
          null,
        ],
      };
      const h = hub({ fetchImpl: makeFetch({ index }) });
      const results = await h.search("");
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("fix-auth");
    });

    it("aborts the fetch after the configured timeout", async () => {
      const slowFetch = vi.fn(
        (_url: string | URL | Request, init?: { signal?: AbortSignal }) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            });
          }),
      ) as unknown as typeof fetch;
      const h = hub({ fetchImpl: slowFetch, timeoutMs: 10 });
      await expect(h.search("auth")).rejects.toThrow(/timed out after 10ms/);
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

    it("rejects an oversized download (size limit)", async () => {
      const huge = "x".repeat(1024 * 1024 + 1);
      const manifest = manifestFor(huge); // checksum matches the huge body
      const index = { skills: [manifest] };
      const h = hub({ fetchImpl: makeFetch({ index, skillBody: huge }) });

      const result = await h.install("fix-auth");
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/size limit/);
      expect(
        fs.existsSync(path.join(baseDir, ".hub", "quarantine", "fix-auth")),
      ).toBe(false);
    });

    it("refuses a manifest with no checksum (mandatory integrity)", async () => {
      // A blank checksum is also stripped by index validation, so test the
      // guard directly via installFromManifest.
      const manifest = manifestFor(SKILL_BODY);
      manifest.checksum = "";
      const h = hub({ fetchImpl: makeFetch({ skillBody: SKILL_BODY }) });

      const result = await h.installFromManifest(manifest);
      expect(result.success).toBe(false);
      expect(result.checksumVerified).toBe(false);
      expect(result.error).toMatch(/missing a checksum/);
      expect(
        fs.existsSync(path.join(baseDir, ".hub", "quarantine", "fix-auth")),
      ).toBe(false);
    });

    it("drops a blank-checksum entry from the index (install reports not found)", async () => {
      const manifest = manifestFor(SKILL_BODY);
      manifest.checksum = "";
      const index = { skills: [manifest] };
      const h = hub({ fetchImpl: makeFetch({ index, skillBody: SKILL_BODY }) });

      const result = await h.install("fix-auth");
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not found in hub registry/);
    });

    it("refuses a downloadUrl on a different origin (SSRF guard)", async () => {
      const manifest = manifestFor(SKILL_BODY);
      manifest.downloadUrl =
        "https://evil.example/skills/debugging/fix-auth/SKILL.md";
      const index = { skills: [manifest] };
      const fetchImpl = makeFetch({ index, skillBody: SKILL_BODY });
      const h = hub({ fetchImpl });

      const result = await h.install("fix-auth");
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/must be under hub URL/);
      // The off-origin URL must never be fetched.
      expect(fetchImpl).not.toHaveBeenCalledWith(manifest.downloadUrl);
    });

    it("refuses a downloadUrl that escapes the hub path prefix", async () => {
      const manifest = manifestFor(SKILL_BODY);
      manifest.downloadUrl = "https://hub.example/other/SKILL.md";
      const index = { skills: [manifest] };
      const h = hub({ fetchImpl: makeFetch({ index, skillBody: SKILL_BODY }) });

      const result = await h.install("fix-auth");
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/must be under hub URL/);
    });

    it("accepts a downloadUrl under the hub origin and path", async () => {
      const manifest = manifestFor(SKILL_BODY); // downloadUrl is `${HUB_URL}/skills/...`
      const index = { skills: [manifest] };
      const h = hub({ fetchImpl: makeFetch({ index, skillBody: SKILL_BODY }) });

      const result = await h.install("fix-auth");
      expect(result.success).toBe(true);
      expect(result.checksumVerified).toBe(true);
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
      await expect(h.promote("fix-auth")).rejects.toThrow(
        /No quarantined skill/,
      );
    });

    it("refuses to promote when the quarantined body fails checksum re-verification", async () => {
      const index = { skills: [manifestFor(SKILL_BODY)] };
      const h = hub({ fetchImpl: makeFetch({ index, skillBody: SKILL_BODY }) });
      await h.install("fix-auth");

      // Tamper with the quarantined file after install.
      const quarantined = path.join(
        baseDir,
        ".hub",
        "quarantine",
        "fix-auth",
        "SKILL.md",
      );
      fs.writeFileSync(
        quarantined,
        SKILL_BODY + "\n## injected\nmalicious",
        "utf-8",
      );

      await expect(h.promote("fix-auth")).rejects.toThrow(
        /failed checksum re-verification/,
      );
      // Must not have been activated.
      expect(fs.existsSync(path.join(baseDir, "debugging", "fix-auth"))).toBe(
        false,
      );
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

    it("rejects an absolute local_path (arbitrary file read)", async () => {
      const outside = path.join(os.tmpdir(), `outside-${Date.now()}.md`);
      fs.writeFileSync(outside, SKILL_BODY, "utf-8");
      try {
        const publisher = mockPublisher();
        const h = hub({ publisher });
        const result = await h.publish(outside);
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/escapes the skills directory/);
        expect(publisher.created).toEqual({});
      } finally {
        fs.rmSync(outside, { force: true });
      }
    });

    it("rejects a traversal local_path that escapes the base", async () => {
      const publisher = mockPublisher();
      const h = hub({ publisher });
      const result = await h.publish("../../../etc/passwd");
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/escapes the skills directory/);
      expect(publisher.created).toEqual({});
    });

    it("rejects a symlinked SKILL.md that points outside the base", async () => {
      const outside = path.join(os.tmpdir(), `secret-${Date.now()}.md`);
      fs.writeFileSync(outside, "TOP SECRET", "utf-8");
      const skillDir = path.join(baseDir, "debugging", "fix-auth");
      fs.mkdirSync(skillDir, { recursive: true });
      const link = path.join(skillDir, "SKILL.md");
      try {
        fs.symlinkSync(outside, link);
      } catch {
        // Symlink creation not permitted on this platform (e.g. Windows without
        // developer mode) — the realpath guard is still exercised on platforms
        // that allow it.
        fs.rmSync(outside, { force: true });
        return;
      }
      try {
        const publisher = mockPublisher();
        const h = hub({ publisher });
        const result = await h.publish("debugging/fix-auth/SKILL.md");
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/escapes the skills directory/);
        expect(publisher.created).toEqual({});
      } finally {
        fs.rmSync(outside, { force: true });
      }
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

    it("refuses to publish when publishing is disabled (authorization gate)", async () => {
      const skillDir = path.join(baseDir, "debugging", "fix-auth");
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), SKILL_BODY, "utf-8");

      const publisher = mockPublisher();
      const h = hub({ publisher, publishEnabled: false });
      const result = await h.publish("debugging/fix-auth/SKILL.md");
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/SKILLS_HUB_PUBLISH_ENABLED/);
      // Nothing must be pushed.
      expect(publisher.created).toEqual({});
    });

    it("aborts (does not clobber the index) when the index read fails transiently", async () => {
      const skillDir = path.join(baseDir, "debugging", "fix-auth");
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), SKILL_BODY, "utf-8");

      const created: Record<string, string> = {};
      const publisher: HubPublisher & { created: Record<string, string> } = {
        created,
        getFile: vi.fn(async (filePath: string) => {
          if (filePath === "index.json") {
            // Transient API failure — must NOT be swallowed.
            throw Object.assign(new Error("Server error"), { status: 500 });
          }
          // Skill file does not exist yet (404 → create).
          throw Object.assign(new Error("Not Found"), { status: 404 });
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

      const h = hub({ publisher });
      const result = await h.publish("debugging/fix-auth/SKILL.md");

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Aborting to avoid clobbering/);
      // The skill file may have been written, but the index must be untouched.
      expect(created["index.json"]).toBeUndefined();
    });

    it("publishes to the repo derived from the hub URL", async () => {
      const skillDir = path.join(baseDir, "debugging", "fix-auth");
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), SKILL_BODY, "utf-8");

      const publisher = mockPublisher();
      const h = new SkillHub({
        skillsBasePath: baseDir,
        hubUrl: "https://raw.githubusercontent.com/acme/my-skills/dev",
        publisher,
        publishEnabled: true,
      });
      const result = await h.publish("debugging/fix-auth/SKILL.md");
      expect(result.success).toBe(true);

      // createFile(filePath, content, message, branch, owner, repo)
      const call = (publisher.createFile as ReturnType<typeof vi.fn>).mock
        .calls[0];
      expect(call[3]).toBe("dev"); // branch
      expect(call[4]).toBe("acme"); // owner
      expect(call[5]).toBe("my-skills"); // repo
    });

    it("merges into an existing remote index without dropping entries", async () => {
      const skillDir = path.join(baseDir, "debugging", "fix-auth");
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, "SKILL.md"), SKILL_BODY, "utf-8");

      const existing = {
        skills: [
          { ...manifestFor(SKILL_BODY), name: "keep-me", category: "other" },
        ],
      };
      const created: Record<string, string> = {};
      const publisher: HubPublisher & { created: Record<string, string> } = {
        created,
        getFile: vi.fn(async (filePath: string) => {
          if (filePath === "index.json") {
            return {
              content: Buffer.from(JSON.stringify(existing)).toString("base64"),
              encoding: "base64",
              sha: "abc",
            };
          }
          throw Object.assign(new Error("Not Found"), { status: 404 });
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

      const h = hub({ publisher });
      const result = await h.publish("debugging/fix-auth/SKILL.md");

      expect(result.success).toBe(true);
      const indexJson = JSON.parse(created["index.json"]);
      const names = indexJson.skills.map((s: SkillManifest) => s.name).sort();
      expect(names).toEqual(["fix-auth", "keep-me"]);
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
  let audit: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    store = createMockStore();
    audit = vi.fn();
    handleSkillHub = createSkillHubHandler(store, audit);
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
      const result = await handleSkillHub({
        action: "install",
        name: "fix-auth",
      });
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
      const result = await handleSkillHub({
        action: "install",
        name: "fix-auth",
      });
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
      const result = await handleSkillHub({
        action: "promote",
        name: "fix-auth",
      });
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

    it("rejects an absolute local_path before forwarding to the hub", async () => {
      const result = await handleSkillHub({
        action: "publish",
        local_path: "/etc/passwd",
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/relative path within the skills directory/);
      expect(store.publish).not.toHaveBeenCalled();
    });

    it("rejects a traversal local_path before forwarding to the hub", async () => {
      const result = await handleSkillHub({
        action: "publish",
        local_path: "../../../etc/passwd",
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/relative path within the skills directory/);
      expect(store.publish).not.toHaveBeenCalled();
    });

    it("rejects a traversal segment embedded mid-path", async () => {
      const result = await handleSkillHub({
        action: "publish",
        local_path: "debugging/../../secret/SKILL.md",
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/relative path within the skills directory/);
      expect(store.publish).not.toHaveBeenCalled();
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
      const result = await handleSkillHub({
        action: "remove",
        name: "fix-auth",
      });
      expect(result.success).toBe(true);
      expect(store.remove).toHaveBeenCalledWith("fix-auth");
    });
  });

  describe("audit logging", () => {
    it("audits a successful install", async () => {
      await handleSkillHub({ action: "install", name: "fix-auth" });
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({ action: "install", outcome: "success" }),
      );
    });

    it("audits a failed install with the error", async () => {
      store.install = vi.fn(async (name: string) => ({
        success: false,
        name,
        error: "Checksum mismatch",
      }));
      await handleSkillHub({ action: "install", name: "fix-auth" });
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "install",
          outcome: "failure",
          details: expect.objectContaining({ error: "Checksum mismatch" }),
        }),
      );
    });

    it("audits promote, publish, and remove", async () => {
      await handleSkillHub({ action: "promote", name: "fix-auth" });
      await handleSkillHub({
        action: "publish",
        local_path: "debugging/fix-auth/SKILL.md",
      });
      await handleSkillHub({ action: "remove", name: "fix-auth" });
      const actions = audit.mock.calls.map((c) => c[0].action);
      expect(actions).toEqual(
        expect.arrayContaining(["promote", "publish", "remove"]),
      );
    });

    it("audits a thrown error as a failure", async () => {
      store.promote = vi.fn(async () => {
        throw new Error("boom");
      });
      const result = await handleSkillHub({ action: "promote", name: "x" });
      expect(result.success).toBe(false);
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({ action: "promote", outcome: "failure" }),
      );
    });

    it("does not audit read-only actions (search, list)", async () => {
      store.search = vi.fn(async () => []);
      await handleSkillHub({ action: "search", query: "auth" });
      await handleSkillHub({ action: "list" });
      expect(audit).not.toHaveBeenCalled();
    });
  });
});
