import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/extraction/extraction-service", () => ({
  extractionService: {
    extractWorkItems: vi.fn(),
    createExtractedItems: vi.fn(),
  },
}));

import { extractionRoutes } from "../../../src/routes/extraction";
import { extractionService } from "../../../src/extraction/extraction-service";

describe("extraction route", () => {
  let server: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    server = Fastify();
    vi.mocked(extractionService.extractWorkItems).mockReset();
    vi.mocked(extractionService.createExtractedItems).mockReset();
    await server.register(extractionRoutes, { prefix: "/api/extraction" });
  });

  afterEach(async () => {
    await server.close();
  });

  it("extracts work items from a conversation", async () => {
    vi.mocked(extractionService.extractWorkItems).mockResolvedValue({
      items: [
        {
          type: "task",
          title: "Fix bug",
          description: "We need to fix bug",
          priority: "medium",
          source: "chat",
        },
      ],
      confidence: 0.7,
      reasoning: "Extracted 1 work items from conversation",
    });

    const res = await server.inject({
      method: "POST",
      url: "/api/extraction/extract",
      payload: { conversationText: "We need to fix bug" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(1);
    expect(vi.mocked(extractionService.extractWorkItems)).toHaveBeenCalledWith({
      conversationText: "We need to fix bug",
    });
  });

  it("returns 400 when conversationText is missing", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/extraction/extract",
      payload: { context: "no text" },
    });

    expect(res.statusCode).toBe(400);
    expect(vi.mocked(extractionService.extractWorkItems)).not.toHaveBeenCalled();
  });

  it("creates work items and returns their ids", async () => {
    vi.mocked(extractionService.createExtractedItems).mockResolvedValue([
      "id-1",
    ]);

    const res = await server.inject({
      method: "POST",
      url: "/api/extraction/create",
      payload: [
        {
          type: "task",
          title: "Do it",
          description: "desc",
          priority: "medium",
          source: "chat",
        },
      ],
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ created: ["id-1"] });
  });

  it("returns 400 for invalid create payload", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/extraction/create",
      payload: [{ type: "not-a-type", title: "x" }],
    });

    expect(res.statusCode).toBe(400);
    expect(
      vi.mocked(extractionService.createExtractedItems),
    ).not.toHaveBeenCalled();
  });
});
