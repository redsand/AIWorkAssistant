import { describe, it, expect, vi, beforeEach } from "vitest";

const mockAxiosCreate = vi.hoisted(() => vi.fn());
const mockRequest = vi.hoisted(() => vi.fn());
const mockPost = vi.hoisted(() => vi.fn());
const mockGet = vi.hoisted(() => vi.fn());

vi.mock("axios", () => ({
  default: {
    create: mockAxiosCreate,
  },
  create: mockAxiosCreate,
}));

vi.mock("../../../src/config/env", () => ({
  env: {
    IVANTI_ENABLED: "true",
    IVANTI_HOST: "nvuprd-sfc.ivanticloud.com",
    IVANTI_TENANT_ID_OR_PATH: "huntcompanies.ivanticloud.com",
    IVANTI_CLIENT_ID: "test-client-id",
    IVANTI_CLIENT_SECRET: "test-client-secret",
    IVANTI_AUTH_URL: "",
    IVANTI_SCOPE: "",
    IVANTI_BOTS_HOST: "",
    IVANTI_PATCH_HOST: "",
    IVANTI_APPDIST_HOST: "",
    IVANTI_TIMEOUT: "60000",
    IVANTI_DEBUG: "false",
  },
}));

import { IvantiClient } from "../../../src/integrations/ivanti/ivanti-client";

function createMockHttp() {
  return {
    request: mockRequest,
    post: mockPost,
    get: mockGet,
  };
}

describe("IvantiClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAxiosCreate.mockReturnValue(createMockHttp());
  });

  describe("configuration", () => {
    it("isConfigured returns true when credentials are present", () => {
      const client = new IvantiClient();
      expect(client.isConfigured()).toBe(true);
    });

    it("isConfigured returns false when credentials are missing", () => {
      const client = new IvantiClient({
        hostname: "nvuprd-sfc.ivanticloud.com",
        tenantId: "huntcompanies.ivanticloud.com",
        clientId: "",
        clientSecret: "",
      });
      expect(client.isConfigured()).toBe(false);
    });
  });

  describe("token flows", () => {
    it("fetches OAuth token for bots API", async () => {
      mockPost.mockResolvedValueOnce({
        data: { access_token: "oauth-token", expires_in: 3600 },
      });
      mockRequest.mockResolvedValue({ data: { value: [] } });

      const client = new IvantiClient();
      await client.listBots();

      expect(mockPost).toHaveBeenCalledWith(
        "https://nvuprd-sfc.ivanticloud.com/huntcompanies.ivanticloud.com/connect/token",
        expect.stringContaining("grant_type=client_credentials"),
        expect.objectContaining({
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        }),
      );
      expect(mockRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: "Bearer oauth-token" }),
        }),
      );
    });

    it("fetches inventory token for inventory API", async () => {
      mockGet.mockResolvedValueOnce({ data: "inventory-token" });
      mockRequest.mockResolvedValue({ data: { value: [] } });

      const client = new IvantiClient();
      await client.listDevices();

      expect(mockGet).toHaveBeenCalledWith(
        "https://nvuprd-sfc.ivanticloud.com/api/apigatewaydataservices/v1/token",
        expect.objectContaining({
          headers: {
            "X-ClientSecret": "test-client-secret",
            "X-TenantId": "huntcompanies.ivanticloud.com",
            "X-ClientId": "test-client-id",
          },
        }),
      );
      expect(mockRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: "Bearer inventory-token" }),
        }),
      );
    });

    it("caches OAuth token and reuses it", async () => {
      mockPost.mockResolvedValueOnce({
        data: { access_token: "oauth-token", expires_in: 3600 },
      });
      mockRequest.mockResolvedValue({ data: { value: [] } });

      const client = new IvantiClient();
      await client.listBots();
      await client.listBots();

      expect(mockPost).toHaveBeenCalledTimes(1);
      expect(mockRequest).toHaveBeenCalledTimes(2);
    });
  });

  describe("inventory methods", () => {
    it("lookup searches devices and people", async () => {
      mockGet.mockResolvedValue({ data: "inventory-token" });
      mockRequest.mockImplementation((cfg: { url: string }) => {
        if (cfg.url.includes("/devices")) {
          return Promise.resolve({
            data: {
              value: [
                {
                  DiscoveryId: "dev-1",
                  DeviceName: "WORKSTATION-001",
                  ipAddress: "10.0.0.50",
                  lastSeen: "2026-01-01T00:00:00Z",
                },
              ],
            },
          });
        }
        if (cfg.url.includes("/people")) {
          return Promise.resolve({
            data: {
              value: [
                {
                  DiscoveryId: "person-1",
                  FullName: "Jane Doe",
                  Emails: [{ Email: "jane@example.com" }],
                },
              ],
            },
          });
        }
        return Promise.resolve({ data: { value: [] } });
      });

      const client = new IvantiClient();
      const result = await client.lookup({ scope: "all", limit: 10 });

      expect(result.devices).toHaveLength(1);
      expect(result.devices[0].hostname).toBe("WORKSTATION-001");
      expect(result.devices[0].raw).toBeUndefined();
      expect(result.people).toHaveLength(1);
      expect(result.people[0].email).toBe("jane@example.com");
      expect(result.people[0].raw).toBeUndefined();
    });

    it("lookup filters by query", async () => {
      mockGet.mockResolvedValue({ data: "inventory-token" });
      mockRequest.mockImplementation((cfg: { url: string }) => {
        if (cfg.url.includes("/devices")) {
          return Promise.resolve({
            data: {
              value: [
                { DiscoveryId: "dev-1", DeviceName: "WORKSTATION-001", ipAddress: "10.0.0.50" },
                { DiscoveryId: "dev-2", DeviceName: "WORKSTATION-002", ipAddress: "10.0.0.51" },
              ],
            },
          });
        }
        return Promise.resolve({ data: { value: [] } });
      });

      const client = new IvantiClient();
      const result = await client.lookup({ query: "10.0.0.50", scope: "devices", limit: 10 });

      expect(result.devices).toHaveLength(1);
      expect(result.devices[0].hostname).toBe("WORKSTATION-001");
    });

    it("lookup includes raw records when raw=true", async () => {
      mockGet.mockResolvedValue({ data: "inventory-token" });
      mockRequest.mockResolvedValue({
        data: { value: [{ DiscoveryId: "dev-1", DeviceName: "WORKSTATION-001" }] },
      });

      const client = new IvantiClient();
      const result = await client.lookup({ query: "WORKSTATION", scope: "devices", raw: true });

      expect(result.devices[0].raw).toBeDefined();
    });

    it("listDevices passes OData params", async () => {
      mockGet.mockResolvedValue({ data: "inventory-token" });
      mockRequest.mockResolvedValue({ data: { value: [] } });

      const client = new IvantiClient();
      await client.listDevices({ $top: 10, $filter: "contains(DeviceName,'test')" });

      expect(mockRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "GET",
          url: "https://nvuprd-sfc.ivanticloud.com/api/apigatewaydataservices/v1/devices",
          params: { $top: 10, $filter: "contains(DeviceName,'test')" },
        }),
      );
    });
  });

  describe("patch methods", () => {
    it("listPatches pages through results", async () => {
      mockPost.mockResolvedValue({ data: { access_token: "oauth-token" } });
      mockRequest.mockResolvedValue({
        data: Array.from({ length: 150 }, (_, i) => ({ patchId: `patch-${i}` })),
      });

      const client = new IvantiClient();
      const result = (await client.listPatches({ allPages: true })) as Array<{ patchId: string }>;

      expect(result.length).toBeGreaterThanOrEqual(150);
      expect(mockRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "GET",
          url: "https://nvuprd-sfc.ivanticloud.com/api/patch/content/v1/patch",
        }),
      );
    });

    it("createPatchGroupFromCves sends POST body", async () => {
      mockPost.mockResolvedValue({ data: { access_token: "oauth-token" } });
      mockRequest.mockResolvedValue({
        data: { patchGroupId: "pg-1", cvesToPatches: { "CVE-2025-0001": ["patch-1"] } },
      });

      const client = new IvantiClient();
      const result = await client.createPatchGroupFromCves({ cveIds: ["CVE-2025-0001"] });

      expect(mockRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "POST",
          url: "https://nvuprd-sfc.ivanticloud.com/api/patch/content/v1/cves-to-patch-group",
          data: { cveIds: ["CVE-2025-0001"] },
        }),
      );
      expect(result).toEqual({
        patchGroupId: "pg-1",
        cvesToPatches: { "CVE-2025-0001": ["patch-1"] },
      });
    });
  });

  describe("bots methods", () => {
    it("runBot sends agentIds and inputs", async () => {
      mockPost.mockResolvedValue({ data: { access_token: "oauth-token" } });
      mockRequest.mockResolvedValue({ data: { workflowInvocationId: "wf-1" } });

      const client = new IvantiClient();
      const result = await client.runBot({
        botDefinitionId: "bot-1",
        agentIds: ["agent-1"],
        inputs: [{ inputId: "input-1", inputValue: "value-1" }],
      });

      expect(mockRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "POST",
          url: "https://nvuprd-sfc.ivanticloud.com/api/external/runBot",
          data: {
            botDefinitionId: "bot-1",
            agentIds: ["agent-1"],
            inputs: [{ inputId: "input-1", inputValue: "value-1" }],
          },
        }),
      );
      expect(result).toEqual({ workflowInvocationId: "wf-1" });
    });
  });

  describe("app distribution methods", () => {
    it("createCatalog sends POST body", async () => {
      mockPost.mockResolvedValue({ data: { access_token: "oauth-token" } });
      mockRequest.mockResolvedValue({ data: { packageId: "pkg-1" } });

      const client = new IvantiClient();
      const result = await client.createCatalog({ packageName: "7-Zip", platform: "Windows" });

      expect(mockRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "POST",
          url: "https://nvuprd-sfc.ivanticloud.com/api/SwdPackage/catalog/external",
          data: { packageName: "7-Zip", platform: "Windows" },
        }),
      );
      expect(result).toEqual({ packageId: "pkg-1" });
    });

    it("onDemandInstall sends POST body", async () => {
      mockPost.mockResolvedValue({ data: { access_token: "oauth-token" } });
      mockRequest.mockResolvedValue({ data: { success: true } });

      const client = new IvantiClient();
      await client.onDemandInstall({ packageId: "pkg-1", discoveryId: "dev-1" });

      expect(mockRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "POST",
          url: "https://nvuprd-sfc.ivanticloud.com/api/SwdPackage/targetDevice/external",
          data: { packageId: "pkg-1", discoveryId: "dev-1" },
        }),
      );
    });
  });

  describe("proxy", () => {
    it("routes generic requests to the correct module", async () => {
      mockGet.mockResolvedValue({ data: "inventory-token" });
      mockRequest.mockResolvedValue({ data: { value: [] } });

      const client = new IvantiClient();
      await client.proxy("inventory", "GET", "/devices", { $top: 5 });

      expect(mockRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "GET",
          url: "https://nvuprd-sfc.ivanticloud.com/api/apigatewaydataservices/v1/devices",
          params: { $top: 5 },
        }),
      );
    });
  });
});
