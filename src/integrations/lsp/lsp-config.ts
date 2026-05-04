import * as fs from "fs";
import * as path from "path";
import type { LSPServerConfig } from "./lsp-client";

export interface LSPProjectConfig {
  servers: LSPServerConfig[];
}

export function loadProjectConfig(projectRoot: string): LSPProjectConfig | null {
  const configPath = path.join(projectRoot, ".lspconfig.json");
  if (!fs.existsSync(configPath)) return null;

  try {
    const content = fs.readFileSync(configPath, "utf-8");
    const config = JSON.parse(content) as LSPProjectConfig;
    for (const server of config.servers || []) {
      if (!server.command || !server.languageId) {
        console.warn(
          `[LSP] Invalid server config in .lspconfig.json: missing command or languageId`,
        );
        return null;
      }
      if (!server.extensions || server.extensions.length === 0) {
        console.warn(
          `[LSP] Server ${server.languageId} has no extensions defined, it won't be used`,
        );
      }
    }
    return config;
  } catch (err) {
    console.warn(`[LSP] Failed to parse .lspconfig.json:`, err);
    return null;
  }
}