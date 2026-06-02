import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/work-items/database", () => ({
  workItemDatabase: {
    listWorkItems: vi.fn(),
  },
}));

vi.mock("../../../src/routes/kanban", () => ({
  invalidateBoardCache: vi.fn(),
}));

import { workItemRoutes } from "../../../src/routes/work-items";
import { workItemDatabase } from "../../../src/work-items/database";

describe("work-items route", () => {
  let server: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    server = Fastify();
    vi.mocked(workItemDatabase.listWorkItems).mockReset();
    await server.register(workItemRoutes, { prefix: "/api/work-items" });
  });

  afterEach(async () => {
    await server.close();
  });

  it("falls back to default pagination when limit and offset are invalid", async () => {
    vi.mocked(workItemDatabase.listWorkItems).mockReturnValue({ items: [], total: 0 });

    const res = await server.inject({
      method: "GET",
      url: "/api/work-items?limit=abc&offset=-1&includeArchived=true",
    });

    expect(res.statusCode).toBe(200);
    expect(vi.mocked(workItemDatabase.listWorkItems)).toHaveBeenCalledWith({
      status: undefined,
      type: undefined,
      priority: undefined,
      source: undefined,
      owner: undefined,
      search: undefined,
      includeArchived: true,
      limit: undefined,
      offset: undefined,
    });
  });
});
