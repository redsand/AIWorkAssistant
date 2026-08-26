import { mcpClient } from "./mcp-client";
import { mcpServerManager } from "./mcp-server-manager";
import { env } from "../../config/env";

export function initializeMCP(): void {
  // Legacy env-var servers — registered directly for backward compatibility.

  // Tavily (web search) MCP server
  if (env.TAVILY_API_KEY) {
    mcpClient.registerServer({
      name: "tavily",
      url: `https://mcp.tavily.com/mcp/?tavilyApiKey=${env.TAVILY_API_KEY}`,
      enabled: true,
    });
  }

  // HAWK IR MCP server — provides case management, event search, and
  // exploration tools via the Model Context Protocol.
  // Auth: Bearer <access_token>:<secret_key>
  if (env.HAWK_IR_ACCESS_TOKEN && env.HAWK_IR_SECRET_KEY) {
    mcpClient.registerServer({
      name: "hawk-ir",
      url: "https://ir.hawk.io/api/mcp",
      headers: {
        Authorization: `Bearer ${env.HAWK_IR_ACCESS_TOKEN}:${env.HAWK_IR_SECRET_KEY}`,
      },
      enabled: true,
    });
  }

  // Canva MCP server (design/flyer editing). OAuth-backed: only register when
  // enabled AND already authorized (tokens on disk from a prior /auth/canva).
  // A fresh authorization connects it live via the callback route.
  if (env.CANVA_MCP_ENABLED) {
    // Lazy import avoids a cycle (canva-oauth doesn't import mcp at module load).
    import("../canva/canva-oauth.js")
      .then(async ({ canvaOAuth }) => {
        if (canvaOAuth.isAuthorized()) {
          await mcpClient.addServer({
            name: "canva",
            url: canvaOAuth.resource(),
            enabled: true,
            getAuthHeader: () => canvaOAuth.getAuthHeader(),
          });
          console.log("[MCP] Canva server connected (authorized)");
        } else {
          console.log("[MCP] Canva enabled but not authorized — visit /auth/canva");
        }
      })
      .catch((err) => console.error("[MCP] Canva registration failed:", err));
  }

  mcpClient
    .initializeAll()
    .then((result) => {
      const connectedServers = Object.values(result.servers).filter(
        (s) => s.connected,
      );
      if (connectedServers.length > 0) {
        console.log(
          `[MCP] ${connectedServers.length} server(s) connected, ${result.totalTools} tools available`,
        );
      }
    })
    .catch((err) => {
      console.error(
        "[MCP] Initialization failed:",
        err instanceof Error ? err.message : "Unknown error",
      );
    });

  // Dynamic file/env-configured servers — loaded from config/mcp-servers.json
  // (falling back to MCP_SERVERS) and watched for runtime changes.
  mcpServerManager.initialize().catch((err) => {
    console.error(
      "[MCP] Dynamic server manager failed to initialize:",
      err instanceof Error ? err.message : "Unknown error",
    );
  });
}

export { mcpClient, mcpServerManager };
