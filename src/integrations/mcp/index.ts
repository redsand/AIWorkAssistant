import { mcpClient } from "../mcp/mcp-client";
import { env } from "../../config/env";

export function initializeMCP(): void {
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
}

export { mcpClient };
