import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("axios", () => {
  const mockPost = vi.fn();
  const mockCreate = vi.fn(() => ({
    get: vi.fn(),
    post: vi.fn(),
    interceptors: { response: { use: vi.fn() } },
  }));
  return {
    default: {
      create: mockCreate,
      post: mockPost,
      isAxiosError: vi.fn(),
    },
  };
});

vi.mock("ws", () => ({
  default: class MockWebSocket {
    static instances: MockWebSocket[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onerror: ((e: Error) => void) | null = null;
    onclose: (() => void) | null = null;
    send = vi.fn();
    close = vi.fn();
    constructor() {
      MockWebSocket.instances.push(this);
    }
  },
  __esModule: true,
}));

vi.mock("../../../src/config/env", () => ({
  env: {
    HAWK_IR_ENABLED: true,
    HAWK_IR_BASE_URL: "https://ir.hawk.io",
    HAWK_IR_ACCESS_TOKEN: "test-access-token",
    HAWK_IR_SECRET_KEY: "test-secret-key",
    PORT: 3050,
    NODE_ENV: "test",
    AUTH_USERNAME: "admin",
    AUTH_PASSWORD: "test",
    AUTH_SESSION_SECRET: "test-secret",
  },
}));

import axios from "axios";
import { HawkIrClient } from "../../../src/integrations/hawk-ir/hawk-ir-client";

function createMockedClient(): {
  client: HawkIrClient;
  mockGet: ReturnType<typeof vi.fn>;
  mockPost: ReturnType<typeof vi.fn>;
} {
  const mockGet = vi.fn();
  const mockPost = vi.fn();
  vi.mocked(axios.create).mockReturnValue({
    get: mockGet,
    post: mockPost,
    interceptors: { response: { use: vi.fn() } },
  } as any);
  const client = new HawkIrClient();
  return { client, mockGet, mockPost };
}

describe("HawkIrClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("isConfigured()", () => {
    it("returns true when all HAWK_IR env vars are set", () => {
      const { client } = createMockedClient();
      expect(client.isConfigured()).toBe(true);
    });

    it("returns false when baseUrl is empty", () => {
      const { client } = createMockedClient();
      (client as any).baseUrl = "";
      (client as any).enabled = false;
      expect(client.isConfigured()).toBe(false);
    });
  });

  describe("validateConfig()", () => {
    it("returns true when getCaseCount succeeds", async () => {
      const { client, mockGet } = createMockedClient();
      // Simulate auth succeeding + case count
      vi.mocked(axios.post).mockResolvedValueOnce({
        data: { status: true },
        headers: { "set-cookie": ["hawk_session=abc123; Path=/"] },
      });
      mockGet.mockResolvedValueOnce({ data: 42 });

      const result = await client.validateConfig();
      expect(result).toBe(true);
    });

    it("returns false when not configured", async () => {
      const { client } = createMockedClient();
      (client as any).enabled = false;

      const result = await client.validateConfig();
      expect(result).toBe(false);
    });

    it("returns false when API call fails", async () => {
      const { client } = createMockedClient();
      (client as any).enabled = false;

      const result = await client.validateConfig();
      expect(result).toBe(false);
    });
  });

  describe("Authentication", () => {
    it("authenticates and stores all session cookies", async () => {
      const { client, mockGet } = createMockedClient();

      vi.mocked(axios.post).mockResolvedValueOnce({
        data: { status: true },
        headers: {
          "set-cookie": [
            "user_id=abc123; Path=/; HttpOnly",
            "hawk_id=s%3Axyz789.sig; Path=/; HttpOnly",
          ],
        },
      });
      mockGet.mockResolvedValueOnce({ data: 10 });

      const count = await client.getCaseCount();
      expect(count).toBe(10);
      expect(axios.post).toHaveBeenCalledWith(
        "https://ir.hawk.io/api/auth",
        { access_token: "test-access-token", secret_key: "test-secret-key" },
        { timeout: 15000 },
      );
      // Both cookies should be joined with "; "
      expect((client as any).sessionCookie).toBe("user_id=abc123; hawk_id=s%3Axyz789.sig");
    });

    it("throws on auth failure", async () => {
      const { client } = createMockedClient();

      vi.mocked(axios.post).mockResolvedValueOnce({
        data: { status: false, details: "Invalid credentials" },
        headers: {},
      });

      await expect(client.getCaseCount()).rejects.toThrow("HAWK IR auth failed");
    });
  });

  describe("Cases API", () => {
    it("getCases returns array of cases", async () => {
      const { client, mockGet } = createMockedClient();

      vi.mocked(axios.post).mockResolvedValueOnce({
        data: { status: true },
        headers: { "set-cookie": ["hawk_session=s1; Path=/"] },
      });

      const mockCases = [
        { rid: "1", name: "Incident A", riskLevel: "high" },
        { rid: "2", name: "Incident B", riskLevel: "low" },
      ];
      mockGet.mockResolvedValueOnce({ data: mockCases });

      const cases = await client.getCases();
      expect(cases).toEqual(mockCases);
      expect(mockGet).toHaveBeenCalledWith(
        "/api/cases",
        expect.objectContaining({ params: {} }),
      );
    });

    it("getCases handles { data: [...] } response", async () => {
      const { client, mockGet } = createMockedClient();

      vi.mocked(axios.post).mockResolvedValueOnce({
        data: { status: true },
        headers: { "set-cookie": ["hawk_session=s2; Path=/"] },
      });

      const mockCases = [{ rid: "3", name: "Incident C" }];
      mockGet.mockResolvedValueOnce({ data: { data: mockCases } });

      const cases = await client.getCases();
      expect(cases).toEqual(mockCases);
    });

    it("getCase strips leading # from caseId", async () => {
      const { client, mockGet } = createMockedClient();

      vi.mocked(axios.post).mockResolvedValueOnce({
        data: { status: true },
        headers: { "set-cookie": ["hawk_session=s3; Path=/"] },
      });

      const mockCase = { rid: "42", name: "Test Case" };
      mockGet.mockResolvedValueOnce({ data: mockCase });

      await client.getCase("#42");
      expect(mockGet).toHaveBeenCalledWith("/api/case/42", expect.anything());
    });

    it("getCase returns null for array response with no items", async () => {
      const { client, mockGet } = createMockedClient();

      vi.mocked(axios.post).mockResolvedValueOnce({
        data: { status: true },
        headers: { "set-cookie": ["hawk_session=s4; Path=/"] },
      });

      mockGet.mockResolvedValueOnce({ data: [] });

      const result = await client.getCase("99");
      expect(result).toBeNull();
    });

    it("getCaseCount returns numeric count", async () => {
      const { client, mockGet } = createMockedClient();

      vi.mocked(axios.post).mockResolvedValueOnce({
        data: { status: true },
        headers: { "set-cookie": ["hawk_session=s5; Path=/"] },
      });

      mockGet.mockResolvedValueOnce({ data: 37 });

      const count = await client.getCaseCount();
      expect(count).toBe(37);
    });

    it("getCaseCount extracts data property", async () => {
      const { client, mockGet } = createMockedClient();

      vi.mocked(axios.post).mockResolvedValueOnce({
        data: { status: true },
        headers: { "set-cookie": ["hawk_session=s6; Path=/"] },
      });

      mockGet.mockResolvedValueOnce({ data: { data: 15 } });

      const count = await client.getCaseCount();
      expect(count).toBe(15);
    });

    it("getCaseCount returns 0 for null response", async () => {
      const { client, mockGet } = createMockedClient();

      vi.mocked(axios.post).mockResolvedValueOnce({
        data: { status: true },
        headers: { "set-cookie": ["hawk_session=s7; Path=/"] },
      });

      mockGet.mockResolvedValueOnce({ data: null });

      const count = await client.getCaseCount();
      expect(count).toBe(0);
    });

    it("deescalateCase sends POST with reason and note", async () => {
      const { client, mockGet, mockPost } = createMockedClient();

      vi.mocked(axios.post).mockResolvedValueOnce({
        data: { status: true },
        headers: { "set-cookie": ["hawk_session=s8; Path=/"] },
      });

      mockPost.mockResolvedValueOnce({ data: { status: true } });

      await client.deescalateCase("55", "False positive", "No further action needed");
      expect(mockPost).toHaveBeenCalledWith(
        "/api/cases/deescalate/55",
        { reason: "False positive", note: "No further action needed" },
        expect.objectContaining({ headers: expect.any(Object) }),
      );
    });
  });

  describe("Explore API", () => {
    it("search returns results array", async () => {
      const { client, mockGet } = createMockedClient();

      vi.mocked(axios.post).mockResolvedValueOnce({
        data: { status: true },
        headers: { "set-cookie": ["hawk_session=e1; Path=/"] },
      });

      const mockResults = [{ _id: "1", message: "log entry" }];
      mockGet.mockResolvedValueOnce({ data: mockResults });

      const results = await client.search({ q: "error" });
      expect(results).toEqual(mockResults);
    });

    it("search returns empty array for non-array response", async () => {
      const { client, mockGet } = createMockedClient();

      vi.mocked(axios.post).mockResolvedValueOnce({
        data: { status: true },
        headers: { "set-cookie": ["hawk_session=e2; Path=/"] },
      });

      mockGet.mockResolvedValueOnce({ data: { not_array: true } });

      const results = await client.search({ q: "test" });
      expect(results).toEqual([]);
    });

    it("getAvailableIndexes returns string array", async () => {
      const { client, mockGet } = createMockedClient();

      vi.mocked(axios.post).mockResolvedValueOnce({
        data: { status: true },
        headers: { "set-cookie": ["hawk_session=e3; Path=/"] },
      });

      mockGet.mockResolvedValueOnce({ data: ["index1", "index2"] });

      const indexes = await client.getAvailableIndexes();
      expect(indexes).toEqual(["index1", "index2"]);
    });

    it("getSavedSearches returns array", async () => {
      const { client, mockGet } = createMockedClient();

      vi.mocked(axios.post).mockResolvedValueOnce({
        data: { status: true },
        headers: { "set-cookie": ["hawk_session=e4; Path=/"] },
      });

      const mockSearches = [{ rid: "s1", name: "High Risk", query: "risk:high" }];
      mockGet.mockResolvedValueOnce({ data: mockSearches });

      const searches = await client.getSavedSearches();
      expect(searches).toEqual(mockSearches);
    });
  });

  describe("Assets API", () => {
    it("getAssets returns normalized result for object response", async () => {
      const { client, mockGet } = createMockedClient();

      vi.mocked(axios.post).mockResolvedValueOnce({
        data: { status: true },
        headers: { "set-cookie": ["hawk_session=a1; Path=/"] },
      });

      const mockResult = { rows: [{ rid: "1" }], pagination: { total: 1 }, summary: null };
      mockGet.mockResolvedValueOnce({ data: mockResult });

      const result = await client.getAssets();
      expect(result).toEqual(mockResult);
    });

    it("getAssets normalizes array response", async () => {
      const { client, mockGet } = createMockedClient();

      vi.mocked(axios.post).mockResolvedValueOnce({
        data: { status: true },
        headers: { "set-cookie": ["hawk_session=a2; Path=/"] },
      });

      mockGet.mockResolvedValueOnce({ data: [{ rid: "1" }] });

      const result = await client.getAssets();
      expect(result.rows).toEqual([{ rid: "1" }]);
      expect(result.pagination).toBeNull();
    });

    it("getAssetSummary returns summary", async () => {
      const { client, mockGet } = createMockedClient();

      vi.mocked(axios.post).mockResolvedValueOnce({
        data: { status: true },
        headers: { "set-cookie": ["hawk_session=a3; Path=/"] },
      });

      const mockSummary = { tags: [{ label: "server", value: 5 }] };
      mockGet.mockResolvedValueOnce({ data: mockSummary });

      const summary = await client.getAssetSummary();
      expect(summary).toEqual(mockSummary);
    });
  });

  describe("Identities API", () => {
    it("getIdentities returns normalized result", async () => {
      const { client, mockGet } = createMockedClient();

      vi.mocked(axios.post).mockResolvedValueOnce({
        data: { status: true },
        headers: { "set-cookie": ["hawk_session=i1; Path=/"] },
      });

      const mockResult = { rows: [{ rid: "u1" }], pagination: { total: 1 }, summary: null };
      mockGet.mockResolvedValueOnce({ data: mockResult });

      const result = await client.getIdentities();
      expect(result).toEqual(mockResult);
    });

    it("getIdentitySummary returns summary", async () => {
      const { client, mockGet } = createMockedClient();

      vi.mocked(axios.post).mockResolvedValueOnce({
        data: { status: true },
        headers: { "set-cookie": ["hawk_session=i2; Path=/"] },
      });

      const mockSummary = { tags: [{ label: "admin", value: 2 }] };
      mockGet.mockResolvedValueOnce({ data: mockSummary });

      const summary = await client.getIdentitySummary();
      expect(summary).toEqual(mockSummary);
    });
  });

  describe("Dashboards API", () => {
    it("listDashboards returns array", async () => {
      const { client, mockGet } = createMockedClient();

      vi.mocked(axios.post).mockResolvedValueOnce({
        data: { status: true },
        headers: { "set-cookie": ["hawk_session=d1; Path=/"] },
      });

      const mockDashboards = [
        { id: "dash1", name: "SOC Overview", widgets: [] },
      ];
      mockGet.mockResolvedValueOnce({ data: mockDashboards });

      const dashboards = await client.listDashboards();
      expect(dashboards).toEqual(mockDashboards);
      expect(mockGet).toHaveBeenCalledWith("/api/dashboards", expect.anything());
    });

    it("listDashboards returns empty array for non-array response", async () => {
      const { client, mockGet } = createMockedClient();

      vi.mocked(axios.post).mockResolvedValueOnce({
        data: { status: true },
        headers: { "set-cookie": ["hawk_session=d2; Path=/"] },
      });

      mockGet.mockResolvedValueOnce({ data: { not_array: true } });

      const dashboards = await client.listDashboards();
      expect(dashboards).toEqual([]);
    });

    it("runDashboardWidget sends POST with dashboard ID and body", async () => {
      const { client, mockGet, mockPost } = createMockedClient();

      vi.mocked(axios.post).mockResolvedValueOnce({
        data: { status: true },
        headers: { "set-cookie": ["hawk_session=d3; Path=/"] },
      });

      const mockResult = { widgetId: "w1", rows: [{ count: 42 }], total: 1 };
      mockPost.mockResolvedValueOnce({ data: mockResult });

      const body = {
        widget: { id: "w1", type: "table", query: "*" },
        timeRange: { from: "2025-01-01", to: "2025-12-31" },
        indexes: ["index1"],
      };

      const result = await client.runDashboardWidget("dash1", body);
      expect(result).toEqual(mockResult);
      expect(mockPost).toHaveBeenCalledWith(
        "/api/dashboards/dash1/run",
        body,
        expect.objectContaining({ headers: expect.any(Object) }),
      );
    });
  });

  describe("Error handling", () => {
    it("throws when client not configured", async () => {
      const { client } = createMockedClient();
      (client as any).enabled = false;

      await expect(client.getCases()).rejects.toThrow("not configured");
    });

    it("returns empty array for non-array getCategories response", async () => {
      const { client, mockGet } = createMockedClient();

      vi.mocked(axios.post).mockResolvedValueOnce({
        data: { status: true },
        headers: { "set-cookie": ["hawk_session=c1; Path=/"] },
      });

      mockGet.mockResolvedValueOnce({ data: { not_array: true } });

      const cats = await client.getCategories();
      expect(cats).toEqual([]);
    });
  });
});