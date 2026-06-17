import dotenv from "dotenv";
import { IvantiClient } from "../src/integrations/ivanti/ivanti-client";

dotenv.config();

const PATCH_FIELDS = [
  "Name",
  "Title",
  "ReleaseDate",
  "Released",
  "Severity",
  "RiskScore",
  "PatchId",
  "Id",
  "KB",
  "CVE",
  "IsSecurityUpdate",
  "Criticality",
  "Impact",
];

const ENDPOINT_FIELDS = [
  "RiskScore",
  "DeviceName",
  "DeviceId",
  "DiscoveryId",
  "MissingPatches",
  "missingPatches",
  "Severity",
  "severity",
  "VulnerabilitiesCount",
  "vulnerabilitiesCount",
];

const GROUP_FIELDS = ["Name", "PatchGroupId", "Id", "CreatedDate", "Severity"];
const CVE_FIELDS = ["CVEId", "Name", "Severity", "PublishedDate", "ReleaseDate"];
const HISTORY_FIELDS = ["DeviceName", "PatchName", "DeploymentDate", "Status"];
const NOTIFICATION_FIELDS = ["Title", "PublishedDate", "Severity", "NotificationId"];

async function probeSortField(
  client: IvantiClient,
  method: string,
  field: string,
): Promise<{ field: string; ok: boolean; status?: number; message: string }> {
  try {
    const result = await (client as any)[method]({
      OrderBy: `${field} desc`,
      PageSize: 1,
    });
    return { field, ok: true, message: "ok", status: (result as any)?.status };
  } catch (err) {
    const message = (err as Error).message;
    const statusMatch = message.match(/\((\d+)\)/);
    return { field, ok: false, message, status: statusMatch ? Number(statusMatch[1]) : undefined };
  }
}

async function probeSection(
  client: IvantiClient,
  label: string,
  method: string,
  fields: string[],
) {
  console.log(`\n=== Probing ${label} sort fields ===`);
  for (const field of fields) {
    const r = await probeSortField(client, method, field);
    console.log(`${r.ok ? "✅" : "❌"} ${r.field}${r.status ? ` (${r.status})` : ""}: ${r.message.slice(0, 120)}`);
  }
}

async function main() {
  const client = new IvantiClient();
  if (!client.isConfigured()) {
    console.error("Ivanti not configured");
    process.exit(1);
  }

  await probeSection(client, "ivanti.patch.list_patches", "listPatches", PATCH_FIELDS);
  await probeSection(client, "ivanti.patch.list_patch_groups", "listPatchGroups", GROUP_FIELDS);
  await probeSection(client, "ivanti.patch.list_cves", "listCves", CVE_FIELDS);
  await probeSection(client, "ivanti.patch.list_endpoint_vulnerabilities", "listEndpointVulnerabilities", ENDPOINT_FIELDS);
  await probeSection(client, "ivanti.patch.list_deployment_history", "listDeploymentHistory", HISTORY_FIELDS);
  await probeSection(client, "ivanti.patch.list_notifications", "listNotifications", NOTIFICATION_FIELDS);
}

main().catch((err) => {
  console.error("[probe] fatal:", err);
  process.exit(1);
});
