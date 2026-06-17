import { IvantiClient } from "../src/integrations/ivanti/ivanti-client";

async function smoke() {
  const client = new IvantiClient();

  if (!client.isConfigured()) {
    console.error("Ivanti not configured");
    process.exit(1);
  }

  console.log("[smoke] configuration OK");

  // 1. Token flow: inventory (read-only devices)
  try {
    const devices = await client.listDevices({ $top: 3 });
    console.log("[smoke] inventory token OK — devices:", JSON.stringify(devices).slice(0, 500));
  } catch (err) {
    console.error("[smoke] inventory/devices failed:", (err as Error).message);
  }

  // 2. Token flow: OAuth2 patch CVEs
  try {
    const cves = await client.listCves({ PageNumber: 1, PageSize: 3 });
    console.log("[smoke] patch OAuth2 OK — CVEs:", JSON.stringify(cves).slice(0, 500));
  } catch (err) {
    console.error("[smoke] patch/CVEs failed:", (err as Error).message);
  }

  // 3. OAuth2 bots list
  try {
    const bots = await client.listBots();
    console.log("[smoke] bots OAuth2 OK — bots:", JSON.stringify(bots).slice(0, 500));
  } catch (err) {
    console.error("[smoke] bots/list failed:", (err as Error).message);
  }

  // 4. OAuth2 app distribution catalog
  try {
    const catalog = await client.listAppCatalog({ $top: 3 });
    console.log("[smoke] appdist OAuth2 OK — catalog:", JSON.stringify(catalog).slice(0, 500));
  } catch (err) {
    console.error("[smoke] appdist/catalog failed:", (err as Error).message);
  }
}

smoke().catch((err) => {
  console.error("[smoke] fatal:", err);
  process.exit(1);
});
