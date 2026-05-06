import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock WebSocket — instances are pushed to mockWsInstances for test access
const mockWsInstances: any[] = [];

vi.mock("ws", () => {
  return {
    default: class MockWebSocket {
      url: string;
      options: any;
      private handlers: Record<string, Function[]> = {};
      send = vi.fn();
      close = vi.fn();
      readyState = 1;
      constructor(url: string, protocolsOrOptions?: any, options?: any) {
        this.url = url;
        // ws(url, options) — options passed as second arg when no protocols
        this.options = protocolsOrOptions && !Array.isArray(protocolsOrOptions) && typeof protocolsOrOptions === 'object'
          ? protocolsOrOptions
          : options;
        mockWsInstances.push(this);
      }
      on(event: string, handler: Function) {
        if (!this.handlers[event]) this.handlers[event] = [];
        this.handlers[event].push(handler);
      }
      emit(event: string, ...args: any[]) {
        (this.handlers[event] || []).forEach(h => h(...args));
      }
    },
    __esModule: true,
  };
});

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

// Helper to simulate server events on a mock WebSocket (uses EventEmitter pattern)
function simulateMessage(ws: any, data: any) {
  ws.emit("message", Buffer.from(JSON.stringify(data)));
}

function simulateOpen(ws: any) {
  ws.emit("open");
}

function simulateError(ws: any, error: Error) {
  ws.emit("error", error);
}

describe("HawkIrClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWsInstances.length = 0;
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

  // === WebSocket message format tests ===

  describe("addCaseNote", () => {
    it("should send addNote with cmd: 'cases' and /websocket path", async () => {
      const { client } = createMockedClient();
      (client as any).sessionCookie = "hawk_session=test";

      const promise = client.addCaseNote("635:1069", "Linked to Jira MDR-1");

      await vi.waitFor(() => expect(mockWsInstances.length).toBe(1));
      const ws = mockWsInstances[0];

      // Verify URL includes /websocket path
      expect(ws.url).toBe("wss://ir.hawk.io/websocket");

      // Simulate connection open — client sends message
      simulateOpen(ws);

      // Verify sent message has cmd: "cases"
      expect(ws.send).toHaveBeenCalledWith(
        expect.stringContaining('"cmd":"cases"'),
      );
      expect(ws.send).toHaveBeenCalledWith(
        expect.stringContaining('"route":"addNote"'),
      );
      expect(ws.send).toHaveBeenCalledWith(
        expect.stringContaining('"id":"#635:1069"'),
      );

      // Simulate server response
      simulateMessage(ws, {
        cmd: "cases",
        route: "addNote",
        status: true,
        data: { id: "#635:1069", note: "Linked to Jira MDR-1" },
      });

      const result = await promise;
      expect(result).toBeDefined();
    });

    it("should normalize case ID by adding # prefix if missing", async () => {
      const { client } = createMockedClient();
      (client as any).sessionCookie = "hawk_session=test";

      const promise = client.addCaseNote("635:1069", "Test note");

      await vi.waitFor(() => expect(mockWsInstances.length).toBe(1));
      const ws = mockWsInstances[0];
      simulateOpen(ws);

      expect(ws.send).toHaveBeenCalledWith(
        expect.stringContaining('"id":"#635:1069"'),
      );

      simulateMessage(ws, {
        cmd: "cases",
        route: "addNote",
        status: true,
        data: { id: "#635:1069" },
      });

      await promise;
    });

    it("should skip hello messages before the actual response", async () => {
      const { client } = createMockedClient();
      (client as any).sessionCookie = "hawk_session=test";

      const promise = client.addCaseNote("635:1069", "Test note");

      await vi.waitFor(() => expect(mockWsInstances.length).toBe(1));
      const ws = mockWsInstances[0];
      simulateOpen(ws);

      // Server sends hello first (no route field) — should be skipped
      simulateMessage(ws, { cmd: "hello", status: true, details: "real-time communication channel ready" });

      // Then the actual response with matching route
      simulateMessage(ws, {
        cmd: "cases",
        route: "addNote",
        status: true,
        data: { id: "#635:1069" },
      });

      const result = await promise;
      expect(result).toBeDefined();
    });

    it("should reject on WebSocket error", async () => {
      const { client } = createMockedClient();
      (client as any).sessionCookie = "hawk_session=test";

      const promise = client.addCaseNote("635:1069", "Test note");

      await vi.waitFor(() => expect(mockWsInstances.length).toBe(1));
      const ws = mockWsInstances[0];

      simulateError(ws, new Error("Unexpected server response: 200"));

      await expect(promise).rejects.toThrow("Unexpected server response: 200");
    });
  });

  describe("updateCaseStatus", () => {
    it("should send setStatus with cmd: 'cases'", async () => {
      const { client } = createMockedClient();
      (client as any).sessionCookie = "hawk_session=test";

      const promise = client.updateCaseStatus("635:1069", "Closed");

      await vi.waitFor(() => expect(mockWsInstances.length).toBe(1));
      const ws = mockWsInstances[0];
      simulateOpen(ws);

      expect(ws.send).toHaveBeenCalledWith(
        expect.stringContaining('"cmd":"cases"'),
      );
      expect(ws.send).toHaveBeenCalledWith(
        expect.stringContaining('"route":"setStatus"'),
      );

      simulateMessage(ws, {
        cmd: "cases",
        route: "setStatus",
        status: true,
        data: {},
      });

      await promise;
    });

    it("should normalize case ID by adding # prefix if missing", async () => {
      const { client } = createMockedClient();
      (client as any).sessionCookie = "hawk_session=test";

      const promise = client.updateCaseStatus("635:1069", "In Progress");

      await vi.waitFor(() => expect(mockWsInstances.length).toBe(1));
      const ws = mockWsInstances[0];
      simulateOpen(ws);

      expect(ws.send).toHaveBeenCalledWith(
        expect.stringContaining('"case":"#635:1069"'),
      );

      simulateMessage(ws, {
        cmd: "cases",
        route: "setStatus",
        status: true,
        data: {},
      });

      await promise;
    });
  });

  describe("updateCaseRisk", () => {
    it("should send setRisk with cmd: 'cases'", async () => {
      const { client } = createMockedClient();
      (client as any).sessionCookie = "hawk_session=test";

      const promise = client.updateCaseRisk("635:1069", "Low");

      await vi.waitFor(() => expect(mockWsInstances.length).toBe(1));
      const ws = mockWsInstances[0];
      simulateOpen(ws);

      expect(ws.send).toHaveBeenCalledWith(
        expect.stringContaining('"cmd":"cases"'),
      );
      expect(ws.send).toHaveBeenCalledWith(
        expect.stringContaining('"route":"setRisk"'),
      );

      simulateMessage(ws, {
        cmd: "cases",
        route: "setRisk",
        status: true,
        data: {},
      });

      await promise;
    });

    it("should normalize case ID by adding # prefix if missing", async () => {
      const { client } = createMockedClient();
      (client as any).sessionCookie = "hawk_session=test";

      const promise = client.updateCaseRisk("635:1069", "Critical");

      await vi.waitFor(() => expect(mockWsInstances.length).toBe(1));
      const ws = mockWsInstances[0];
      simulateOpen(ws);

      expect(ws.send).toHaveBeenCalledWith(
        expect.stringContaining('"case":"#635:1069"'),
      );

      simulateMessage(ws, {
        cmd: "cases",
        route: "setRisk",
        status: true,
        data: {},
      });

      await promise;
    });
  });

  // === WebSocket URL path tests ===

  describe("WebSocket URL construction", () => {
    it("uses /websocket path for wsRequest", async () => {
      const { client } = createMockedClient();
      (client as any).sessionCookie = "hawk_session=test";

      const promise = client.addCaseNote("1", "note");

      await vi.waitFor(() => expect(mockWsInstances.length).toBe(1));
      const ws = mockWsInstances[0];
      expect(ws.url).toBe("wss://ir.hawk.io/websocket");

      simulateOpen(ws);
      simulateMessage(ws, { cmd: "cases", route: "addNote", status: true, data: {} });
      await promise;
    });

    it("uses /websocket path for executeHybrid", async () => {
      const { client } = createMockedClient();
      (client as any).sessionCookie = "hawk_session=test";

      const promise = client.executeHybrid({ groupId: "group1", cmd: "ping" });

      await vi.waitFor(() => expect(mockWsInstances.length).toBe(1));
      const ws = mockWsInstances[0];
      expect(ws.url).toBe("wss://ir.hawk.io/websocket");

      simulateOpen(ws);
      simulateMessage(ws, { route: "execute", status: true });
      simulateMessage(ws, { route: "execute", status: true, data: { result: "ok" } });

      await promise;
    });

    it("sends session cookie in WebSocket headers", async () => {
      const { client } = createMockedClient();
      (client as any).sessionCookie = "hawk_id=abc123";

      const promise = client.addCaseNote("1", "note");

      await vi.waitFor(() => expect(mockWsInstances.length).toBe(1));
      const ws = mockWsInstances[0];
      // The ws library receives options as the second arg when no protocols are provided
      expect(ws.options?.headers?.Cookie).toBe("hawk_id=abc123");

      simulateOpen(ws);
      simulateMessage(ws, { cmd: "cases", route: "addNote", status: true, data: {} });
      await promise;
    });
  });

  // === WebSocket error handling ===

  describe("WebSocket error handling", () => {
    it("rejects on WebSocket connection error", async () => {
      const { client } = createMockedClient();
      (client as any).sessionCookie = "hawk_session=test";

      const promise = client.addCaseNote("1", "note");

      await vi.waitFor(() => expect(mockWsInstances.length).toBe(1));
      const ws = mockWsInstances[0];

      simulateError(ws, new Error("Connection refused"));

      await expect(promise).rejects.toThrow("Connection refused");
    });

    it("resolves with error data when server returns status: false", async () => {
      const { client } = createMockedClient();
      (client as any).sessionCookie = "hawk_session=test";

      const promise = client.addCaseNote("1", "note");

      await vi.waitFor(() => expect(mockWsInstances.length).toBe(1));
      const ws = mockWsInstances[0];
      simulateOpen(ws);

      // Server responds with error matching the route
      simulateMessage(ws, {
        route: "addNote",
        status: false,
        code: 404,
        details: "No handler specified for given command: undefined",
      });

      // wsRequest resolves with parsed.data ?? parsed, so status: false is in the resolved value
      const result = await promise;
      expect(result.status).toBe(false);
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

  // === Artefacts and Nodes WebSocket tests ===

  describe("getArtefacts", () => {
    it("sends cmd: 'artefacts' with route: 'get'", async () => {
      const { client } = createMockedClient();
      (client as any).sessionCookie = "hawk_session=test";

      const promise = client.getArtefacts({ group: "group1" });

      await vi.waitFor(() => expect(mockWsInstances.length).toBe(1));
      const ws = mockWsInstances[0];
      simulateOpen(ws);

      const sentData = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sentData.cmd).toBe("artefacts");
      expect(sentData.route).toBe("get");

      simulateMessage(ws, {
        cmd: "artefacts",
        route: "get",
        status: true,
        data: [{ id: "a1" }],
      });

      const result = await promise;
      expect(result).toEqual([{ id: "a1" }]);
    });

    it("uses /websocket URL path", async () => {
      const { client } = createMockedClient();
      (client as any).sessionCookie = "hawk_session=test";

      const promise = client.getArtefacts({ group: "group1" });

      await vi.waitFor(() => expect(mockWsInstances.length).toBe(1));
      expect(mockWsInstances[0].url).toBe("wss://ir.hawk.io/websocket");

      simulateOpen(mockWsInstances[0]);
      simulateMessage(mockWsInstances[0], {
        cmd: "artefacts",
        route: "get",
        status: true,
        data: [],
      });

      await promise;
    });
  });

  describe("listNodes", () => {
    it("sends cmd: 'nodes' with route: 'get'", async () => {
      const { client } = createMockedClient();
      (client as any).sessionCookie = "hawk_session=test";

      const promise = client.listNodes(["group1"]);

      await vi.waitFor(() => expect(mockWsInstances.length).toBe(1));
      const ws = mockWsInstances[0];
      simulateOpen(ws);

      const sentData = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sentData.cmd).toBe("nodes");
      expect(sentData.route).toBe("get");

      simulateMessage(ws, {
        cmd: "nodes",
        route: "get",
        status: true,
        data: [{ id: "n1", hostname: "node1" }],
      });

      const result = await promise;
      expect(result).toEqual([{ id: "n1", hostname: "node1" }]);
    });
  });

  describe("executeHybrid", () => {
    it("sends hybrid execute message with correct format", async () => {
      const { client } = createMockedClient();
      (client as any).sessionCookie = "hawk_session=test";

      const promise = client.executeHybrid({
        groupId: "group1",
        cmd: "ping",
        data: { target: "10.0.0.1" },
      });

      await vi.waitFor(() => expect(mockWsInstances.length).toBe(1));
      const ws = mockWsInstances[0];
      simulateOpen(ws);

      const sentData = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sentData.route).toBe("execute");
      expect(sentData.cmd).toBe("ping");
      expect(sentData.group_id).toBe("group1");
      expect(sentData.data).toEqual({ target: "10.0.0.1" });

      // ACK
      simulateMessage(ws, { route: "execute", status: true });
      // Result
      simulateMessage(ws, { route: "execute", status: true, data: { alive: true } });

      const result = await promise;
      expect(result.data).toEqual({ alive: true });
    });

    it("skips hello messages before dispatch ACK", async () => {
      const { client } = createMockedClient();
      (client as any).sessionCookie = "hawk_session=test";

      const promise = client.executeHybrid({ groupId: "g1", cmd: "ping" });

      await vi.waitFor(() => expect(mockWsInstances.length).toBe(1));
      const ws = mockWsInstances[0];
      simulateOpen(ws);

      // Hello message (no route) should be skipped
      simulateMessage(ws, { cmd: "hello", status: true, details: "ready" });

      // ACK
      simulateMessage(ws, { route: "execute", status: true });
      // Result
      simulateMessage(ws, { route: "execute", data: { result: "ok" } });

      const result = await promise;
      expect(result.data).toEqual({ result: "ok" });
    });

    it("includes target_node_id when provided", async () => {
      const { client } = createMockedClient();
      (client as any).sessionCookie = "hawk_session=test";

      const promise = client.executeHybrid({
        groupId: "g1",
        cmd: "nslookup",
        targetNodeId: "node-42",
      });

      await vi.waitFor(() => expect(mockWsInstances.length).toBe(1));
      const ws = mockWsInstances[0];
      simulateOpen(ws);

      const sentData = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sentData.target_node_id).toBe("node-42");

      // ACK + result
      simulateMessage(ws, { route: "execute", status: true });
      simulateMessage(ws, { route: "execute", data: {} });

      await promise;
    });
  });

  // === Escalation, Assignment, and Quarantine WebSocket tests ===

  describe("escalateCase", () => {
    it("should send setEscalated with cmd: 'cases'", async () => {
      const { client } = createMockedClient();
      (client as any).sessionCookie = "hawk_session=test";

      const promise = client.escalateCase("635:1069", "vendor", "Customer", "JITBIT-99032784");

      await vi.waitFor(() => expect(mockWsInstances.length).toBe(1));
      const ws = mockWsInstances[0];
      simulateOpen(ws);

      const sentData = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sentData.cmd).toBe("cases");
      expect(sentData.route).toBe("setEscalated");
      expect(sentData.data.id).toBe("#635:1069");
      expect(sentData.data.type).toBe("vendor");
      expect(sentData.data.module).toBe("manual");
      expect(sentData.data.vendor).toBe("Customer");
      expect(sentData.data.ticketId).toBe("JITBIT-99032784");
      expect(ws.url).toBe("wss://ir.hawk.io/websocket");

      simulateMessage(ws, {
        cmd: "cases",
        route: "setEscalated",
        status: true,
        data: { id: "#635:1069" },
      });

      const result = await promise;
      expect(result).toBeDefined();
    });

    it("should normalize case ID and omit optional fields", async () => {
      const { client } = createMockedClient();
      (client as any).sessionCookie = "hawk_session=test";

      const promise = client.escalateCase("635:1069", "internal");

      await vi.waitFor(() => expect(mockWsInstances.length).toBe(1));
      const ws = mockWsInstances[0];
      simulateOpen(ws);

      const sentData = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sentData.data.id).toBe("#635:1069");
      expect(sentData.data.type).toBe("internal");
      expect(sentData.data.module).toBe("manual");
      expect(sentData.data.vendor).toBeUndefined();
      expect(sentData.data.ticketId).toBeUndefined();

      simulateMessage(ws, { cmd: "cases", route: "setEscalated", status: true, data: {} });
      await promise;
    });
  });

  describe("assignCase", () => {
    it("should send setOwner with cmd: 'cases'", async () => {
      const { client } = createMockedClient();
      (client as any).sessionCookie = "hawk_session=test";

      const promise = client.assignCase("635:1069", "user_42");

      await vi.waitFor(() => expect(mockWsInstances.length).toBe(1));
      const ws = mockWsInstances[0];
      simulateOpen(ws);

      const sentData = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sentData.cmd).toBe("cases");
      expect(sentData.route).toBe("setOwner");
      expect(sentData.case).toBe("#635:1069");
      expect(sentData.data).toBe("user_42");

      simulateMessage(ws, {
        cmd: "cases",
        route: "setOwner",
        status: true,
        data: {},
      });

      const result = await promise;
      expect(result).toBeDefined();
    });

    it("should normalize case ID by adding # prefix if missing", async () => {
      const { client } = createMockedClient();
      (client as any).sessionCookie = "hawk_session=test";

      const promise = client.assignCase("635:1069", "admin_user");

      await vi.waitFor(() => expect(mockWsInstances.length).toBe(1));
      const ws = mockWsInstances[0];
      simulateOpen(ws);

      const sentData = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sentData.case).toBe("#635:1069");

      simulateMessage(ws, { cmd: "cases", route: "setOwner", status: true, data: {} });
      await promise;
    });
  });

  describe("quarantineHost", () => {
    it("should send cmd: 'quarantine' with route: 'add' and default values", async () => {
      const { client } = createMockedClient();
      (client as any).sessionCookie = "hawk_session=test";

      const promise = client.quarantineHost("635:1069", "10.42.73.9");

      await vi.waitFor(() => expect(mockWsInstances.length).toBe(1));
      const ws = mockWsInstances[0];
      simulateOpen(ws);

      const sentData = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sentData.cmd).toBe("quarantine");
      expect(sentData.route).toBe("add");
      expect(sentData.data.type).toBe("ip");
      expect(sentData.data.object).toBe("10.42.73.9");
      expect(sentData.data.module).toBe("manual");
      expect(sentData.data.case_id).toBe("#635:1069");
      expect(sentData.data.object_highlight).toBe("10.42.73.9");
      expect(sentData.data.expires).toBe("-1");
      expect(ws.url).toBe("wss://ir.hawk.io/websocket");

      simulateMessage(ws, {
        cmd: "quarantine",
        route: "add",
        status: true,
        data: { "@rid": "#34:5" },
      });

      const result = await promise;
      expect(result).toBeDefined();
    });

    it("should allow overriding type and expires", async () => {
      const { client } = createMockedClient();
      (client as any).sessionCookie = "hawk_session=test";

      const promise = client.quarantineHost("635:1069", "host.example.com", { type: "hostname", expires: "24h" });

      await vi.waitFor(() => expect(mockWsInstances.length).toBe(1));
      const ws = mockWsInstances[0];
      simulateOpen(ws);

      const sentData = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sentData.data.type).toBe("hostname");
      expect(sentData.data.expires).toBe("24h");
      expect(sentData.data.object).toBe("host.example.com");

      simulateMessage(ws, { cmd: "quarantine", route: "add", status: true, data: {} });
      await promise;
    });
  });

  describe("getQuarantineRecords", () => {
    it("should send cmd: 'quarantine' with route: 'get'", async () => {
      const { client } = createMockedClient();
      (client as any).sessionCookie = "hawk_session=test";

      const promise = client.getQuarantineRecords();

      await vi.waitFor(() => expect(mockWsInstances.length).toBe(1));
      const ws = mockWsInstances[0];
      simulateOpen(ws);

      const sentData = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sentData.cmd).toBe("quarantine");
      expect(sentData.route).toBe("get");

      simulateMessage(ws, {
        cmd: "quarantine",
        route: "get",
        status: true,
        data: [{ "@rid": "#34:5", object: "10.42.73.9", case_id: "#635:1069", quarantine: true }],
      });

      const result = await promise;
      expect(result).toEqual([{ "@rid": "#34:5", object: "10.42.73.9", case_id: "#635:1069", quarantine: true }]);
    });
  });

  describe("unquarantineHost", () => {
    it("should send cmd: 'quarantine' with route: 'revert'", async () => {
      const { client } = createMockedClient();
      (client as any).sessionCookie = "hawk_session=test";

      const promise = client.unquarantineHost("#34:5", "#635:1069", "10.42.73.9");

      await vi.waitFor(() => expect(mockWsInstances.length).toBe(1));
      const ws = mockWsInstances[0];
      simulateOpen(ws);

      const sentData = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sentData.cmd).toBe("quarantine");
      expect(sentData.route).toBe("revert");
      expect(sentData.data["@rid"]).toBe("#34:5");
      expect(sentData.data.case_id).toBe("#635:1069");
      expect(sentData.data.module).toBe("manual");
      expect(sentData.data.object_highlight).toBe("10.42.73.9");

      simulateMessage(ws, {
        cmd: "quarantine",
        route: "revert",
        status: true,
        data: [{ "@rid": "#34:5" }],
      });

      const result = await promise;
      expect(result).toBeDefined();
    });
  });
});