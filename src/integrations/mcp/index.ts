import { mcpClient } from "../mcp/mcp-client";
import { env } from "../../config/env";

export function initializeMCP(): void {
  if (env.TAVILY_API_KEY) {
    mcpClient.registerServer({
      name: "tavily",
      url: `https://mcp.tavily.com/mcp/?tavilyApiKey=${env.TAVILY_API_KEY}`,
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
