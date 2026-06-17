import { IvantiAuthManager } from "./ivanti-auth";
import type {
  IvantiClientConfig,
  IvantiHttpResponse,
  IvantiDeviceSummary,
  IvantiPersonSummary,
  IvantiLookupResult,
  IvantiLookupParams,
  IvantiODataParams,
  IvantiPatchParams,
  IvantiBotRunBody,
  IvantiCvesToPatchGroupBody,
  IvantiCatalogBody,
  IvantiDistributionBody,
  IvantiOnDemandInstallBody,
} from "./types";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pickFirst(obj: unknown, keys: string[]): string | null {
  if (!isPlainObject(obj)) return null;
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k) && obj[k] != null) {
      return String(obj[k]);
    }
  }
  return null;
}

function getNested(obj: unknown, path: string): unknown {
  return String(path || "")
    .split(".")
    .reduce((acc: unknown, key) => {
      if (acc == null) return null;
      if (Array.isArray(acc) && /^\d+$/.test(key)) return acc[Number(key)];
      if (isPlainObject(acc)) return acc[key] != null ? acc[key] : null;
      return null;
    }, obj);
}

function textIncludes(hay: unknown, needle: string): boolean {
  return String(hay || "").toLowerCase().includes(needle.toLowerCase());
}

function objectContainsValue(obj: unknown, target: string): boolean {
  const t = target.trim();
  if (!t) return false;
  function walk(v: unknown): boolean {
    if (v == null) return false;
    if (typeof v === "string") {
      const s = v.trim();
      if (s === t) return true;
      return s
        .split(/[,\s]+/)
        .map((x) => x.trim())
        .filter(Boolean)
        .includes(t);
    }
    if (Array.isArray(v)) return v.some(walk);
    if (isPlainObject(v)) return Object.values(v).some(walk);
    return false;
  }
  return walk(obj);
}

function summarizeDevice(rec: unknown): IvantiDeviceSummary {
  const raw = isPlainObject(rec) ? rec : {};
  const ip =
    pickFirst(raw, [
      "ipAddress",
      "ip",
      "lastKnownIPAddress",
      "publicIpAddress",
      "privateIpAddress",
      "ipv4",
    ]) || (getNested(raw, "Network.TCPIP.Address") as string | null);
  const os =
    (getNested(raw, "OS.Name") as string | null) ||
    pickFirst(raw, ["osType", "os", "operatingSystem", "osName"]);
  return {
    id: pickFirst(raw, ["DiscoveryId", "id", "deviceId", "agentId", "assetId"]),
    name: pickFirst(raw, [
      "DisplayName",
      "DeviceName",
      "name",
      "deviceName",
      "hostName",
      "hostname",
      "computerName",
    ]),
    hostname: pickFirst(raw, [
      "DeviceName",
      "hostName",
      "hostname",
      "computerName",
      "DisplayName",
      "name",
    ]),
    ip,
    owner:
      pickFirst(raw, ["owner", "primaryUser", "lastLoggedOnUser", "userName", "loggedOnUser"]) ||
      (getNested(raw, "Application.AzureAD.SamAccountName") as string | null),
    osType: os,
    osVersion:
      (getNested(raw, "OS.Version") as string | null) ||
      pickFirst(raw, ["osVersion", "operatingSystemVersion"]),
    model: pickFirst(raw, ["model", "deviceModel"]),
    manufacturer: pickFirst(raw, ["manufacturer", "vendor"]),
    lastSeen: pickFirst(raw, ["lastSeen", "lastCheckIn", "lastCheckinTime", "lastSeenDate"]),
    status: pickFirst(raw, ["status", "agentStatus", "deviceStatus"]),
    raw,
  };
}

function summarizePerson(rec: unknown): IvantiPersonSummary {
  const raw = isPlainObject(rec) ? rec : {};
  const emails = getNested(raw, "Emails");
  const email =
    Array.isArray(emails) && emails.length > 0
      ? pickFirst(emails[0] as Record<string, unknown>, ["Email", "email"]) ||
        String(emails[0])
      : pickFirst(raw, ["email", "mail", "emailAddress"]);
  return {
    id: pickFirst(raw, ["DiscoveryId", "id", "personId", "userId", "peopleId"]),
    name: pickFirst(raw, ["FullName", "DisplayName", "name", "displayName"]),
    email,
    userName:
      (getNested(raw, "Application.AzureAD.SamAccountName") as string | null) ||
      pickFirst(raw, ["userName", "loginName", "username", "upn"]),
    department: pickFirst(raw, ["Department", "department", "departmentName"]),
    title: pickFirst(raw, ["JobTitle", "title", "jobTitle"]),
    manager: pickFirst(raw, ["manager", "managerName"]),
    raw,
  };
}

function stripRaw<T extends { raw?: unknown }>(record: T): Omit<T, "raw"> {
  const { raw: _raw, ...rest } = record;
  return rest;
}

export class IvantiClient {
  private auth: IvantiAuthManager;
  private hostname: string;
  private inventoryBaseUrl: string;
  private botsBaseUrl: string;
  private patchBaseUrl: string;
  private appDistBaseUrl: string;

  constructor(config?: Partial<IvantiClientConfig>) {
    this.auth = new IvantiAuthManager(config);
    this.hostname = config?.hostname || this.auth["hostname"];
    const botsHost = config?.botsHost || this.hostname;
    const patchHost = config?.patchHost || this.hostname;
    const appDistHost = config?.appDistHost || this.hostname;

    this.inventoryBaseUrl = `https://${this.hostname}/api/apigatewaydataservices/v1`;
    this.botsBaseUrl = `https://${botsHost}`;
    this.patchBaseUrl = `https://${patchHost}/api/patch/content/v1`;
    this.appDistBaseUrl = `https://${appDistHost}/api/SwdPackage`;
  }

  isConfigured(): boolean {
    return this.auth.isConfigured();
  }

  private request<T = unknown>(
    method: string,
    path: string,
    baseUrl: string,
    options: {
      params?: Record<string, unknown>;
      data?: unknown;
      headers?: Record<string, string>;
    } = {},
  ): Promise<IvantiHttpResponse<T>> {
    return this.auth.request<T>(method, path, baseUrl, options);
  }

  async getAllPagesInventory(
    path: string,
    params: IvantiODataParams = {},
    { maxItems = 5000, maxPages = 100 } = {},
  ): Promise<unknown[]> {
    const items: unknown[] = [];
    let page = 0;
    let nextPath = path;
    let nextParams: Record<string, unknown> = { ...params };
    while (page < maxPages && items.length < maxItems) {
      const resp = await this.request("GET", nextPath, this.inventoryBaseUrl, {
        params: nextParams,
      });
      const batch = Array.isArray(resp.data) ? resp.data : (resp.data as { value?: unknown[] })?.value || [];
      items.push(...batch);
      const nextLink = (resp.data as { ["@odata.nextLink"]?: string })?.["@odata.nextLink"];
      if (!nextLink || items.length >= maxItems) break;
      try {
        const u = new URL(nextLink);
        nextPath = u.pathname.replace("/api/apigatewaydataservices/v1", "") || path;
        nextParams = {};
        u.searchParams.forEach((v, k) => {
          nextParams[k] = v;
        });
      } catch {
        break;
      }
      page += 1;
    }
    if (items.length > maxItems) items.length = maxItems;
    return items;
  }

  async getAllPagesPatch(
    path: string,
    params: IvantiPatchParams = {},
    { maxItems = 2000, pageSize = 150 } = {},
  ): Promise<unknown[]> {
    const items: unknown[] = [];
    let pageNumber = 1;
    while (items.length < maxItems) {
      const resp = await this.request("GET", path, this.patchBaseUrl, {
        params: { ...params, PageNumber: pageNumber, PageSize: pageSize },
      });
      const data = resp.data as { value?: unknown[]; items?: unknown[] } | unknown[];
      const batch = Array.isArray(data) ? data : data?.value || data?.items || [];
      items.push(...batch);
      if (!batch.length || batch.length < pageSize) break;
      pageNumber += 1;
    }
    if (items.length > maxItems) items.length = maxItems;
    return items;
  }

  async getAllPagesOData(
    baseUrl: string,
    path: string,
    params: Record<string, unknown> = {},
    { maxItems = 2000, maxPages = 100 } = {},
  ): Promise<unknown[]> {
    const items: unknown[] = [];
    let page = 0;
    let nextPath = path;
    let nextParams: Record<string, unknown> = { ...params };
    while (page < maxPages && items.length < maxItems) {
      const resp = await this.request("GET", nextPath, baseUrl, { params: nextParams });
      const data = resp.data as { value?: unknown[] } | unknown[];
      const batch = Array.isArray(data) ? data : data?.value || [];
      items.push(...batch);
      const nextLink = (resp.data as { ["@odata.nextLink"]?: string })?.["@odata.nextLink"];
      if (!nextLink || items.length >= maxItems) break;
      try {
        const u = new URL(nextLink);
        nextPath = u.pathname.replace(baseUrl.replace(/^https?:\/\/[^/]+/, ""), "") || path;
        nextParams = {};
        u.searchParams.forEach((v, k) => {
          nextParams[k] = v;
        });
      } catch {
        break;
      }
      page += 1;
    }
    if (items.length > maxItems) items.length = maxItems;
    return items;
  }

  // ── People & Device Inventory ─────────────────────────────────────────────

  async lookup(params: IvantiLookupParams = {}): Promise<IvantiLookupResult> {
    const scope = params.scope || "all";
    const includeDevices = scope === "all" || scope === "devices";
    const includePeople = scope === "all" || scope === "people";
    const limit = Math.max(1, Number(params.limit || 50));
    const raw = Boolean(params.raw);
    const result: IvantiLookupResult = { counts: {}, devices: [], people: [] };

    if (includeDevices) {
      const odata: IvantiODataParams = { $top: Math.max(limit, 200) };
      if (params.hostname)
        odata.$filter = `contains(DeviceName,'${params.hostname}') or contains(DisplayName,'${params.hostname}')`;
      else if (params.ip) odata.$filter = `contains(Network/TCPIP/Address,'${params.ip}')`;
      const items = await this.getAllPagesInventory("/devices", odata, { maxItems: 200 });
      let rows = this.filterRecords(items.map(summarizeDevice), params) as IvantiDeviceSummary[];
      rows = rows.slice(0, limit);
      result.devices = raw ? rows : rows.map(stripRaw);
      result.counts.devices = rows.length;
    }

    if (includePeople) {
      const odata: IvantiODataParams = { $top: Math.max(limit, 200) };
      if (params.email) odata.$filter = `contains(Emails/Email,'${params.email}')`;
      else if (params.user)
        odata.$filter = `contains(FullName,'${params.user}') or contains(Application/AzureAD/SamAccountName,'${params.user}')`;
      const items = await this.getAllPagesInventory("/people", odata, { maxItems: 200 });
      let rows = this.filterRecords(items.map(summarizePerson), params) as IvantiPersonSummary[];
      rows = rows.slice(0, limit);
      result.people = raw ? rows : rows.map(stripRaw);
      result.counts.people = rows.length;
    }

    return result;
  }

  private filterRecords(rows: unknown[], query: IvantiLookupParams): unknown[] {
    if (!Array.isArray(rows)) return rows;
    let out = rows.slice();
    const needle = String(query.query || "").trim();
    if (needle) {
      out = out.filter((r) => {
        const rec = isPlainObject(r) ? r : {};
        return ["id", "name", "hostname", "ip", "owner", "email", "userName", "department"].some(
          (k) => textIncludes(rec[k], needle),
        );
      });
    }
    if (query.ip) out = out.filter((r) => objectContainsValue((r as { raw?: unknown })?.raw ?? r, String(query.ip)));
    if (query.hostname)
      out = out.filter((r) => textIncludes((r as { hostname?: string; name?: string }).hostname || (r as { name?: string }).name, String(query.hostname)));
    if (query.email)
      out = out.filter((r) => textIncludes((r as { email?: string }).email, String(query.email)));
    if (query.user)
      out = out.filter((r) =>
        textIncludes(
          (r as { userName?: string; name?: string; email?: string }).userName ||
            (r as { name?: string }).name ||
            (r as { email?: string }).email,
          String(query.user),
        ),
      );
    return out;
  }

  async listDevices(params: IvantiODataParams & { allPages?: boolean } = {}): Promise<unknown> {
    const { allPages, ...odata } = params;
    if (allPages) return this.getAllPagesInventory("/devices", odata);
    const resp = await this.request("GET", "/devices", this.inventoryBaseUrl, { params: odata });
    return resp.data;
  }

  async getDevice(
    id?: string,
    hostname?: string,
    name?: string,
  ): Promise<IvantiDeviceSummary | IvantiDeviceSummary[] | null> {
    if (id) {
      const items = await this.getAllPagesInventory("/devices", {
        $top: 10,
        $filter: `contains(DiscoveryId,'${id}')`,
      });
      const rows = items.map(summarizeDevice);
      const exact = rows.find((r) => r.id === id);
      return exact || rows[0] || null;
    }
    if (hostname || name) {
      const term = hostname || name;
      const items = await this.getAllPagesInventory("/devices", {
        $top: 10,
        $filter: `contains(DeviceName,'${term}') or contains(DisplayName,'${term}')`,
      });
      return items.map(summarizeDevice);
    }
    throw new Error("getDevice requires id, hostname, or name");
  }

  async listPeople(params: IvantiODataParams & { allPages?: boolean } = {}): Promise<unknown> {
    const { allPages, ...odata } = params;
    if (allPages) return this.getAllPagesInventory("/people", odata);
    const resp = await this.request("GET", "/people", this.inventoryBaseUrl, { params: odata });
    return resp.data;
  }

  async getPerson(
    id?: string,
    email?: string,
    user?: string,
    name?: string,
  ): Promise<IvantiPersonSummary | IvantiPersonSummary[] | null> {
    if (id) {
      const items = await this.getAllPagesInventory("/people", {
        $top: 10,
        $filter: `contains(DiscoveryId,'${id}')`,
      });
      const rows = items.map(summarizePerson);
      const exact = rows.find((r) => r.id === id);
      return exact || rows[0] || null;
    }
    if (email || user || name) {
      const term = email || user || name;
      const items = await this.getAllPagesInventory("/people", {
        $top: 10,
        $filter: `contains(FullName,'${term}') or contains(Application/AzureAD/SamAccountName,'${term}') or contains(Emails/Email,'${term}')`,
      });
      return items.map(summarizePerson);
    }
    throw new Error("getPerson requires id, email, user, or name");
  }

  async getDevicesMetadata(): Promise<unknown> {
    const resp = await this.request("GET", "/devicesMetadata", this.inventoryBaseUrl);
    return resp.data;
  }

  async getPeopleMetadata(): Promise<unknown> {
    const resp = await this.request("GET", "/peopleMetadata", this.inventoryBaseUrl);
    return resp.data;
  }

  // ── Neurons Bots ───────────────────────────────────────────────────────────

  async listBots(): Promise<unknown> {
    const resp = await this.request("GET", "/api/external/on-demand-bots", this.botsBaseUrl);
    return resp.data;
  }

  async getBotInputs(botDefinitionId: string): Promise<unknown> {
    const resp = await this.request(
      "GET",
      `/api/external/getBotInputs/${encodeURIComponent(botDefinitionId)}`,
      this.botsBaseUrl,
    );
    return resp.data;
  }

  async runBot(body: IvantiBotRunBody): Promise<unknown> {
    const resp = await this.request("POST", "/api/external/runBot", this.botsBaseUrl, { data: body });
    return resp.data;
  }

  async getBotResults(workflowInvocationId: string): Promise<unknown> {
    const resp = await this.request(
      "GET",
      `/api/external/getResults/${encodeURIComponent(workflowInvocationId)}`,
      this.botsBaseUrl,
    );
    return resp.data;
  }

  async getBotLogMessages(workflowInvocationId: string, deviceId: string): Promise<unknown> {
    const resp = await this.request(
      "GET",
      `/api/external/getLogMessages/${encodeURIComponent(workflowInvocationId)}/${encodeURIComponent(deviceId)}`,
      this.botsBaseUrl,
    );
    return resp.data;
  }

  // ── Patch Management ───────────────────────────────────────────────────────

  async listPatches(params: IvantiPatchParams & { allPages?: boolean } = {}): Promise<unknown> {
    const { allPages, ...patchParams } = params;
    if (allPages) return this.getAllPagesPatch("/patch", patchParams);
    const resp = await this.request("GET", "/patch", this.patchBaseUrl, { params: patchParams });
    return resp.data;
  }

  async listPatchGroups(params: IvantiPatchParams & { allPages?: boolean } = {}): Promise<unknown> {
    const { allPages, ...patchParams } = params;
    if (allPages) return this.getAllPagesPatch("/patch-group", patchParams);
    const resp = await this.request("GET", "/patch-group", this.patchBaseUrl, { params: patchParams });
    return resp.data;
  }

  async listCves(params: IvantiPatchParams = {}): Promise<unknown> {
    const resp = await this.request("GET", "/cve", this.patchBaseUrl, { params });
    return resp.data;
  }

  async listEndpointVulnerabilities(params: IvantiPatchParams = {}): Promise<unknown> {
    const resp = await this.request("GET", "/endpoint-vulnerability", this.patchBaseUrl, { params });
    return resp.data;
  }

  async listDeploymentHistory(params: IvantiPatchParams = {}): Promise<unknown> {
    const resp = await this.request("GET", "/deployment-history", this.patchBaseUrl, { params });
    return resp.data;
  }

  async listNotifications(params: IvantiPatchParams = {}): Promise<unknown> {
    const resp = await this.request("GET", "/notification", this.patchBaseUrl, { params });
    return resp.data;
  }

  async createPatchGroupFromCves(
    body: IvantiCvesToPatchGroupBody,
    onBehalfOf?: string,
  ): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (onBehalfOf) headers["x-on-behalf-of"] = onBehalfOf;
    const resp = await this.request("POST", "/cves-to-patch-group", this.patchBaseUrl, {
      data: body,
      headers,
    });
    return resp.data;
  }

  async updatePatchGroupFromCves(
    patchGroupId: string,
    body: IvantiCvesToPatchGroupBody,
    onBehalfOf?: string,
  ): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (onBehalfOf) headers["x-on-behalf-of"] = onBehalfOf;
    const resp = await this.request(
      "PUT",
      `/cves-to-patch-group/${encodeURIComponent(patchGroupId)}`,
      this.patchBaseUrl,
      { data: body, headers },
    );
    return resp.data;
  }

  async getPatchGroupMapping(patchGroupId: string): Promise<unknown> {
    const resp = await this.request(
      "GET",
      `/cves-to-patch-group/${encodeURIComponent(patchGroupId)}`,
      this.patchBaseUrl,
    );
    return resp.data;
  }

  async listPatchGroupAudit(params: IvantiPatchParams & { allPages?: boolean } = {}): Promise<unknown> {
    const { allPages, ...patchParams } = params;
    if (allPages) return this.getAllPagesPatch("/patch-group-audit", patchParams);
    const resp = await this.request("GET", "/patch-group-audit", this.patchBaseUrl, { params: patchParams });
    return resp.data;
  }

  // ── App Distribution ─────────────────────────────────────────────────────────

  async listAppCatalog(params: Record<string, unknown> & { allPages?: boolean } = {}): Promise<unknown> {
    const { allPages, ...odata } = params;
    if (allPages) return this.getAllPagesOData(this.appDistBaseUrl, "/odata/catalogExternal", odata);
    const resp = await this.request("GET", "/odata/catalogExternal", this.appDistBaseUrl, {
      params: odata,
    });
    return resp.data;
  }

  async listDevicePackageStatus(params: Record<string, unknown> & { allPages?: boolean } = {}): Promise<unknown> {
    const { allPages, ...odata } = params;
    if (allPages)
      return this.getAllPagesOData(this.appDistBaseUrl, "/odata/devicePackageStatusExternal", odata);
    const resp = await this.request("GET", "/odata/devicePackageStatusExternal", this.appDistBaseUrl, {
      params: odata,
    });
    return resp.data;
  }

  async createCatalog(body: IvantiCatalogBody): Promise<unknown> {
    const resp = await this.request("POST", "/catalog/external", this.appDistBaseUrl, { data: body });
    return resp.data;
  }

  async updateCatalog(packageId: string, body: Partial<IvantiCatalogBody>): Promise<unknown> {
    const resp = await this.request(
      "PATCH",
      `/catalog/external/${encodeURIComponent(packageId)}`,
      this.appDistBaseUrl,
      { data: body },
    );
    return resp.data;
  }

  async deleteCatalog(packageId: string): Promise<unknown> {
    const resp = await this.request(
      "DELETE",
      `/catalog/external/${encodeURIComponent(packageId)}`,
      this.appDistBaseUrl,
    );
    return resp.data;
  }

  async createDistribution(body: IvantiDistributionBody): Promise<unknown> {
    const resp = await this.request("POST", "/distribution/external", this.appDistBaseUrl, {
      data: body,
    });
    return resp.data;
  }

  async updateDistribution(distributionId: string, body: Partial<IvantiDistributionBody>): Promise<unknown> {
    const resp = await this.request(
      "PUT",
      `/distribution/external/${encodeURIComponent(distributionId)}`,
      this.appDistBaseUrl,
      { data: body },
    );
    return resp.data;
  }

  async getDistributions(packageId: string): Promise<unknown> {
    const resp = await this.request(
      "GET",
      `/distribution/external/${encodeURIComponent(packageId)}`,
      this.appDistBaseUrl,
    );
    return resp.data;
  }

  async onDemandInstall(body: IvantiOnDemandInstallBody): Promise<unknown> {
    const resp = await this.request("POST", "/targetDevice/external", this.appDistBaseUrl, { data: body });
    return resp.data;
  }

  // ── Generic proxy ──────────────────────────────────────────────────────────

  async proxy(
    module: "inventory" | "bots" | "patch" | "appdist",
    method: string,
    path: string,
    params?: Record<string, unknown>,
    body?: unknown,
  ): Promise<unknown> {
    const upper = method.toUpperCase();
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(upper)) {
      throw new Error("proxy method must be GET, POST, PUT, PATCH, or DELETE");
    }
    if (!path.startsWith("/")) throw new Error("proxy path must start with /");
    const baseUrlMap: Record<"inventory" | "bots" | "patch" | "appdist", string> = {
      inventory: this.inventoryBaseUrl,
      bots: this.botsBaseUrl,
      patch: this.patchBaseUrl,
      appdist: this.appDistBaseUrl,
    };
    const resp = await this.request(upper, path, baseUrlMap[module], { params, data: body });
    return resp.data;
  }
}
