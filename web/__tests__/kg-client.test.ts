/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ sessionId: "sess-1" as string | null }));

vi.mock("../js/state.js", () => ({
  API_BASE: "",
  get currentSessionId() {
    return state.sessionId;
  },
}));

vi.mock("../js/auth.js", () => ({
  authHeaders: () => ({ "Content-Type": "application/json", Authorization: "Bearer t" }),
}));

vi.mock("../js/messages.js", () => ({
  addMessage: vi.fn((content: string) => {
    const id = "m-" + Math.random().toString(36).slice(2);
    const div = document.createElement("div");
    div.id = id;
    const inner = document.createElement("div");
    inner.className = "message-content";
    inner.innerHTML = content;
    div.appendChild(inner);
    document.body.appendChild(div);
    return id;
  }),
  scrollChatToBottom: vi.fn(),
}));

describe("/kg slash command — parser", () => {
  beforeEach(async () => {
    document.body.innerHTML = "";
  });

  it("parses /kg with bare query terms", async () => {
    const { __test } = await import("../js/kg-client.js");
    expect(__test.parseKgCommand("/kg case closure")).toEqual({
      query: "case closure",
      filters: {},
      limit: 8,
    });
  });

  it("accepts /graph as an alias", async () => {
    const { __test } = await import("../js/kg-client.js");
    expect(__test.parseKgCommand("/graph adr")?.query).toBe("adr");
  });

  it("parses type=, status=, tag= filters", async () => {
    const { __test } = await import("../js/kg-client.js");
    expect(__test.parseKgCommand("/kg type=adr status=accepted auth")).toEqual({
      query: "auth",
      filters: { type: "adr", status: "accepted" },
      limit: 8,
    });
  });

  it("aggregates multiple tag= filters into a list", async () => {
    const { __test } = await import("../js/kg-client.js");
    expect(__test.parseKgCommand("/kg tag=ir-72 tag=urgent something")).toEqual({
      query: "something",
      filters: { tags: ["ir-72", "urgent"] },
      limit: 8,
    });
  });

  it("honors limit=N within bounds", async () => {
    const { __test } = await import("../js/kg-client.js");
    expect(__test.parseKgCommand("/kg limit=20 case")?.limit).toBe(20);
    // Out of bounds — fall back to default
    expect(__test.parseKgCommand("/kg limit=999 case")?.limit).toBe(8);
    expect(__test.parseKgCommand("/kg limit=-5 case")?.limit).toBe(8);
  });

  it("returns null for non-/kg messages", async () => {
    const { __test } = await import("../js/kg-client.js");
    expect(__test.parseKgCommand("hi there")).toBeNull();
    expect(__test.parseKgCommand("/help")).toBeNull();
  });
});

describe("/kg slash command — end-to-end with cache + REST fallback", () => {
  beforeEach(async () => {
    document.body.innerHTML = "";
    const { __test } = await import("../js/kg-cache.js");
    __test.reset();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns false for unrelated messages so chat stream still runs", async () => {
    const { handleKgSlashCommand } = await import("../js/kg-client.js");
    expect(await handleKgSlashCommand("explain this code")).toBe(false);
  });

  it("hits the cache fast path when titles match — no REST call", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      // Cache load: respond with seed nodes.
      if (url.includes("/chat/graph/nodes?limit=")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            nodes: [
              { id: "kg-1", title: "Case closure policy", type: "decision", status: "accepted", tags: [] },
              { id: "kg-2", title: "Authentication middleware", type: "component", status: "accepted", tags: [] },
            ],
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({ nodes: [] }) });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { handleKgSlashCommand } = await import("../js/kg-client.js");
    const handled = await handleKgSlashCommand("/kg case");
    expect(handled).toBe(true);

    // First fetch is the cache load; second fetch should NOT happen because
    // the cache had a hit.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(document.body.innerHTML).toContain("Case closure policy");
  });

  it("falls back to REST when the cache has no hits", async () => {
    let restHit = false;
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/chat/graph/nodes?limit=") && !url.includes("search=")) {
        return Promise.resolve({ ok: true, json: async () => ({ nodes: [] }) });
      }
      if (url.includes("search=")) {
        restHit = true;
        return Promise.resolve({
          ok: true,
          json: async () => ({
            nodes: [{ id: "kg-99", title: "Rare match", type: "note", status: "proposed", tags: [] }],
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({ nodes: [] }) });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { handleKgSlashCommand } = await import("../js/kg-client.js");
    await handleKgSlashCommand("/kg something obscure");
    expect(restHit).toBe(true);
    expect(document.body.innerHTML).toContain("Rare match");
  });

  it("renders a no-match bubble when both cache and REST are empty", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ nodes: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { handleKgSlashCommand } = await import("../js/kg-client.js");
    await handleKgSlashCommand("/kg nothingmatches");
    expect(document.body.innerHTML).toContain("No knowledge-graph nodes matched");
  });
});

describe("kg-cache — searchKgCache", () => {
  beforeEach(async () => {
    const { __test } = await import("../js/kg-cache.js");
    __test.reset();
  });

  it("ranks exact match > prefix > substring > tag > type", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        nodes: [
          { id: "a", title: "auth middleware", type: "component", status: "accepted", tags: [] },
          { id: "b", title: "auth", type: "decision", status: "accepted", tags: [] },
          { id: "c", title: "billing service", type: "component", status: "accepted", tags: ["auth"] },
          { id: "d", title: "schema migration", type: "auth", status: "accepted", tags: [] },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { loadKgCache, searchKgCache } = await import("../js/kg-cache.js");
    await loadKgCache(true);
    const results = searchKgCache("auth", {}, 10);
    expect(results.map((n) => n.id)).toEqual(["b", "a", "c", "d"]);
  });

  it("respects type filter", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        nodes: [
          { id: "a", title: "policy", type: "decision", status: "accepted", tags: [] },
          { id: "b", title: "policy doc", type: "adr", status: "accepted", tags: [] },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { loadKgCache, searchKgCache } = await import("../js/kg-cache.js");
    await loadKgCache(true);
    const adrs = searchKgCache("policy", { type: "adr" }, 10);
    expect(adrs.map((n) => n.id)).toEqual(["b"]);
  });

  it("returns nothing when the query is empty and no filters are supplied", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        nodes: [{ id: "a", title: "thing", type: "decision", status: "accepted", tags: [] }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { loadKgCache, searchKgCache } = await import("../js/kg-cache.js");
    await loadKgCache(true);
    expect(searchKgCache("", {}, 10)).toEqual([]);
  });
});
