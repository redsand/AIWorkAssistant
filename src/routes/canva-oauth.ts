/**
 * Canva OAuth routes — self-contained Authorization Code + PKCE flow for the
 * Canva MCP server. The user hits /auth/canva, authorizes in the browser, and
 * Canva redirects to /auth/canva/callback where we exchange the code for
 * tokens. Once authorized, the Canva MCP server's tools become available.
 */
import { FastifyInstance } from "fastify";
import { canvaOAuth } from "../integrations/canva/canva-oauth";
import { mcpClient } from "../integrations/mcp/mcp-client";

export async function canvaOAuthRoutes(fastify: FastifyInstance) {
  fastify.get("/auth/canva/status", async () => {
    return { success: true, ...canvaOAuth.status() };
  });

  // Start the flow — returns the authorize URL (and redirects browsers to it).
  fastify.get("/auth/canva", async (request, reply) => {
    try {
      const authUrl = await canvaOAuth.getAuthorizeUrl();
      const accept = String(request.headers["accept"] || "");
      if (accept.includes("text/html")) {
        return reply.redirect(authUrl);
      }
      return {
        success: true,
        message: "Open this URL to authorize Canva, then you'll be redirected back.",
        authorizationUrl: authUrl,
      };
    } catch (err) {
      reply.code(500);
      return { success: false, error: err instanceof Error ? err.message : "Failed to start Canva OAuth" };
    }
  });

  fastify.get("/auth/canva/callback", async (request, reply) => {
    const { code, state, error, error_description } = request.query as {
      code?: string;
      state?: string;
      error?: string;
      error_description?: string;
    };
    if (error) {
      reply.code(400).type("text/html");
      return `<h2>Canva authorization failed</h2><p>${error}: ${error_description || ""}</p>`;
    }
    if (!code || !state) {
      reply.code(400).type("text/html");
      return `<h2>Canva authorization failed</h2><p>Missing code or state.</p>`;
    }
    try {
      await canvaOAuth.handleCallback(code, state);
      // Connect the Canva MCP server now that we have a token.
      try {
        await mcpClient.addServer({
          name: "canva",
          url: canvaOAuth.resource(),
          enabled: true,
          getAuthHeader: () => canvaOAuth.getAuthHeader(),
        });
      } catch (connErr) {
        console.error("[CanvaOAuth] MCP connect after auth failed:", connErr);
      }
      reply.type("text/html");
      return `<h2>Canva connected ✅</h2><p>You can close this tab and return to the assistant.</p>`;
    } catch (err) {
      reply.code(500).type("text/html");
      return `<h2>Canva authorization failed</h2><p>${err instanceof Error ? err.message : "token exchange failed"}</p>`;
    }
  });

  fastify.post("/auth/canva/logout", async () => {
    canvaOAuth.logout();
    try {
      mcpClient.removeServer("canva");
    } catch {
      /* not connected */
    }
    return { success: true, message: "Canva disconnected." };
  });
}
