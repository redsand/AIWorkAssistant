import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("axios", () => ({
  default: {
    create: vi.fn(() => ({
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
      request: vi.fn(),
      interceptors: { response: { use: vi.fn() } },
    })),
    isAxiosError: vi.fn(),
  },
}));

vi.mock("../../../src/config/env", () => ({
  env: {
    IVANTI_ENABLED: true,
    IVANTI_HOST: "nvuprd-sfc.ivanticloud.com",
    IVANTI_TENANT_ID_OR_PATH: "huntcompanies.ivanticloud.com",
    IVANTI_CLIENT_ID: "test-client-id",
    IVANTI_CLIENT_SECRET: "test-client-secret",
    IVANTI_MDM_ENABLED: false,
    IVANTI_MDM_HOST: "",
    IVANTI_MDM_USERNAME: "",
    IVANTI_MDM_PASSWORD: "",
    IVANTI_MDM_PARTITION_ID: "",
    IVANTI_NZTA_ENABLED: false,
    IVANTI_NZTA_HOST: "",
    IVANTI_NZTA_DSID: "",
    JIRA_BASE_URL: "https://test.atlassian.net",
    JIRA_EMAIL: "test@example.com",
    JIRA_API_TOKEN: "test-token",
    GITLAB_BASE_URL: "https://gitlab.test.local",
    GITLAB_TOKEN: "test-token",
    GITHUB_TOKEN: "test-token",
    JITBIT_BASE_URL: "https://jitbit.test.local",
    JITBIT_API_TOKEN: "test-token",
    PORT: 3050,
    NODE_ENV: "test",
    AUTH_USERNAME: "admin",
    AUTH_PASSWORD: "test",
    AUTH_SESSION_SECRET: "test-secret",
    OPENCODE_API_URL: "https://api.opencode.com/v1",
    OPENCODE_API_KEY: "",
    ENABLE_CALENDAR_WRITE: false,
    ENABLE_JIRA_TRANSITIONS: true,
  },
  resolvePath: (rel: string) => rel,
}));

vi.mock("../../../src/integrations/ivanti/ivanti-service", () => {
  const mockIvantiService = {
    isConfigured: vi.fn(),
    mdmConfigured: vi.fn(),
    nztaConfigured: vi.fn(),
    lookup: vi.fn(),
    listDevices: vi.fn(),
    getDevice: vi.fn(),
    listPeople: vi.fn(),
    getPerson: vi.fn(),
    listBots: vi.fn(),
    getBotInputs: vi.fn(),
    runBot: vi.fn(),
    getBotResults: vi.fn(),
    getBotLogMessages: vi.fn(),
    listCves: vi.fn(),
    listPatches: vi.fn(),
    listNotifications: vi.fn(),
    listEndpointVulnerabilities: vi.fn(),
    listDeploymentHistory: vi.fn(),
    listPatchGroups: vi.fn(),
    listPatchGroupAudit: vi.fn(),
    createPatchGroupFromCves: vi.fn(),
    updatePatchGroupFromCves: vi.fn(),
    getPatchGroupMapping: vi.fn(),
    listAppCatalog: vi.fn(),
    listDevicePackageStatus: vi.fn(),
    listInstalledSoftware: vi.fn(),
    createCatalog: vi.fn(),
    updateCatalog: vi.fn(),
    deleteCatalog: vi.fn(),
    createDistribution: vi.fn(),
    updateDistribution: vi.fn(),
    getDistributions: vi.fn(),
    onDemandInstall: vi.fn(),
    listMdmGroups: vi.fn(),
    getMdmGroup: vi.fn(),
    proxy: vi.fn(),
  };
  return { ivantiService: mockIvantiService };
});

vi.mock("../../../src/integrations/jira/jira-client", () => ({
  jiraClient: {
    isConfigured: vi.fn(() => false),
    getProjects: vi.fn(),
    getProject: vi.fn(),
  },
}));

vi.mock("../../../src/integrations/jira/jira-service", () => ({
  jiraService: {
    getAssignedIssues: vi.fn(),
    getIssue: vi.fn(),
    addComment: vi.fn(),
    transitionIssue: vi.fn(),
    createProject: vi.fn(),
    getProject: vi.fn(),
  },
}));

vi.mock("../../../src/integrations/file/calendar-service", () => ({
  fileCalendarService: {
    listEvents: vi.fn(),
    createFocusBlock: vi.fn(),
    createHealthBlock: vi.fn(),
    createEvent: vi.fn(),
    updateEvent: vi.fn(),
    deleteEvent: vi.fn(),
    getEvent: vi.fn(),
  },
}));

vi.mock("../../../src/audit/logger", () => ({
  auditLogger: {
    log: vi.fn(async () => {}),
  },
}));

vi.mock("../../../src/policy/engine", () => ({
  policyEngine: {
    evaluate: vi.fn(async () => ({ result: "allow" })),
    canProceed: vi.fn(() => true),
  },
}));

vi.mock("../../../src/approvals/queue", () => ({
  approvalQueue: {
    enqueue: vi.fn(async () => ({ id: "approval-1" })),
    get: vi.fn(),
  },
}));

import { ivantiService } from "../../../src/integrations/ivanti/ivanti-service";
import { env } from "../../../src/config/env";
import { dispatchToolCall } from "../../../src/agent/tool-dispatcher";

describe("ivanti tool dispatcher", () => {
  const mockSvc = ivantiService as unknown as Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSvc.isConfigured.mockReturnValue(true);
  });

  it("returns error when ivanti is not configured", async () => {
    mockSvc.isConfigured.mockReturnValue(false);

    const result = await dispatchToolCall("ivanti.lookup", { query: "test" }, "user-1");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Ivanti Neurons not configured");
  });

  it("dispatches ivanti.lookup", async () => {
    mockSvc.lookup.mockResolvedValue({ devices: [], people: [] });

    const result = await dispatchToolCall("ivanti.lookup", { query: "10.0.0.50", scope: "devices" }, "user-1");

    expect(result.success).toBe(true);
    expect(mockSvc.lookup).toHaveBeenCalledWith({
      query: "10.0.0.50",
      scope: "devices",
      ip: undefined,
      hostname: undefined,
      email: undefined,
      user: undefined,
      limit: undefined,
      raw: undefined,
    });
  });

  it("dispatches ivanti.list_devices with OData params", async () => {
    mockSvc.listDevices.mockResolvedValue({ value: [] });

    const result = await dispatchToolCall("ivanti.list_devices", { $top: 10, allPages: true }, "user-1");

    expect(result.success).toBe(true);
    expect(mockSvc.listDevices).toHaveBeenCalledWith({
      $top: 10,
      $filter: undefined,
      $select: undefined,
      $skip: undefined,
      $orderby: undefined,
      allPages: true,
    });
  });

  it("dispatches ivanti.bots.run with agentIds array", async () => {
    mockSvc.runBot.mockResolvedValue({ workflowInvocationId: "wf-1" });

    const result = await dispatchToolCall(
      "ivanti.bots.run",
      { botDefinitionId: "bot-1", agentIds: ["agent-1", "agent-2"] },
      "user-1",
    );

    expect(result.success).toBe(true);
    expect(mockSvc.runBot).toHaveBeenCalledWith({
      botDefinitionId: "bot-1",
      agentIds: ["agent-1", "agent-2"],
      inputs: undefined,
    });
  });

  it("dispatches ivanti.patch.create_patch_group_from_cves", async () => {
    mockSvc.createPatchGroupFromCves.mockResolvedValue({ patchGroupId: "pg-1" });

    const result = await dispatchToolCall(
      "ivanti.patch.create_patch_group_from_cves",
      { cveIds: ["CVE-2025-0001"], patchGroupName: "Critical" },
      "user-1",
    );

    expect(result.success).toBe(true);
    expect(mockSvc.createPatchGroupFromCves).toHaveBeenCalledWith(
      { cveIds: ["CVE-2025-0001"], patchGroupName: "Critical", dataUpdateErrorPolicy: undefined },
      undefined,
    );
  });

  it("dispatches ivanti.appdist.create_catalog", async () => {
    mockSvc.createCatalog.mockResolvedValue({ packageId: "pkg-1" });

    const result = await dispatchToolCall("ivanti.appdist.create_catalog", { packageName: "7-Zip", platform: "Windows" }, "user-1");

    expect(result.success).toBe(true);
    expect(mockSvc.createCatalog).toHaveBeenCalledWith({
      packageName: "7-Zip",
      platform: "Windows",
      version: undefined,
      publisher: undefined,
      category: undefined,
      notes: undefined,
      showInAnalystView: undefined,
    });
  });

  it("dispatches ivanti.proxy with module/path", async () => {
    mockSvc.proxy.mockResolvedValue({ value: [] });

    const result = await dispatchToolCall(
      "ivanti.proxy",
      { module: "inventory", method: "GET", path: "/devices", params: { $top: 5 } },
      "user-1",
    );

    expect(result.success).toBe(true);
    expect(mockSvc.proxy).toHaveBeenCalledWith("inventory", "GET", "/devices", { $top: 5 }, undefined);
  });

  it("rejects invalid OrderBy field for ivanti.patch.list_patches", async () => {
    const result = await dispatchToolCall(
      "ivanti.patch.list_patches",
      { OrderBy: "RiskScore desc", PageSize: 10 },
      "user-1",
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid OrderBy field 'RiskScore'");
    expect(mockSvc.listPatches).not.toHaveBeenCalled();
  });

  it("allows valid OrderBy field for ivanti.patch.list_patches", async () => {
    mockSvc.listPatches.mockResolvedValue({ value: [] });

    const result = await dispatchToolCall(
      "ivanti.patch.list_patches",
      { OrderBy: "Severity desc", PageSize: 10 },
      "user-1",
    );

    expect(result.success).toBe(true);
    expect(mockSvc.listPatches).toHaveBeenCalledWith(
      expect.objectContaining({ OrderBy: "Severity desc", PageSize: 10 }),
    );
  });

  it("rejects invalid OrderBy field for ivanti.patch.list_endpoint_vulnerabilities", async () => {
    const result = await dispatchToolCall(
      "ivanti.patch.list_endpoint_vulnerabilities",
      { OrderBy: "severity desc", PageSize: 10 },
      "user-1",
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid OrderBy field 'severity'");
    expect(mockSvc.listEndpointVulnerabilities).not.toHaveBeenCalled();
  });

  it("dispatches ivanti.appdist.list_installed_software", async () => {
    mockSvc.listInstalledSoftware.mockResolvedValue({ value: [] });

    const result = await dispatchToolCall(
      "ivanti.appdist.list_installed_software",
      { deviceId: "dev-1", state: "Installed", allPages: true },
      "user-1",
    );

    expect(result.success).toBe(true);
    expect(mockSvc.listInstalledSoftware).toHaveBeenCalledWith({
      deviceId: "dev-1",
      deviceName: undefined,
      packageName: undefined,
      state: "Installed",
      $filter: undefined,
      $top: undefined,
      $select: undefined,
      $skip: undefined,
      $orderby: undefined,
      allPages: true,
    });
  });

  it("dispatches ivanti.mdm.list_groups when MDM is enabled", async () => {
    env.IVANTI_MDM_ENABLED = true;
    mockSvc.mdmConfigured.mockReturnValue(true);
    mockSvc.listMdmGroups.mockResolvedValue({ value: [] });

    const result = await dispatchToolCall("ivanti.mdm.list_groups", { type: "device", $top: 10 }, "user-1");

    expect(result.success).toBe(true);
    expect(mockSvc.listMdmGroups).toHaveBeenCalledWith({
      type: "device",
      $top: 10,
      $filter: undefined,
      $select: undefined,
      $skip: undefined,
      $orderby: undefined,
    });
  });

  it("returns error for ivanti.mdm.list_groups when MDM is disabled", async () => {
    env.IVANTI_MDM_ENABLED = false;

    const result = await dispatchToolCall("ivanti.mdm.list_groups", { type: "device" }, "user-1");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Ivanti MDM Cloud module is disabled");
    expect(mockSvc.listMdmGroups).not.toHaveBeenCalled();
  });

  it("dispatches ivanti.proxy for mdm module when configured", async () => {
    env.IVANTI_MDM_ENABLED = true;
    mockSvc.mdmConfigured.mockReturnValue(true);
    mockSvc.proxy.mockResolvedValue({ value: [] });

    const result = await dispatchToolCall(
      "ivanti.proxy",
      { module: "mdm", method: "GET", path: "/rule_group", params: { $top: 5 } },
      "user-1",
    );

    expect(result.success).toBe(true);
    expect(mockSvc.proxy).toHaveBeenCalledWith("mdm", "GET", "/rule_group", { $top: 5 }, undefined);
  });

  it("returns error for ivanti.proxy with nzta when nZTA is disabled", async () => {
    env.IVANTI_NZTA_ENABLED = false;

    const result = await dispatchToolCall(
      "ivanti.proxy",
      { module: "nzta", method: "GET", path: "/api/v1/policies" },
      "user-1",
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Ivanti nZTA module is disabled");
    expect(mockSvc.proxy).not.toHaveBeenCalled();
  });
});
