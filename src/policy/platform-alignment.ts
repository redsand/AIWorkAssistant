import type { PlatformIntent, PlatformValidation } from "./types";
import { getPlatformForToolName } from "../agent/tool-registry";

export function validatePlatformAlignment(
  toolName: string,
  intent: PlatformIntent,
): PlatformValidation {
  const toolPlatform = getPlatformForToolName(toolName);

  // Cross-platform tools are always allowed
  if (toolPlatform === "cross-platform") {
    return {
      result: "allowed",
      toolPlatform,
      intentPlatform: intent.platform,
      reason: "Cross-platform tool is always allowed",
    };
  }

  // No intent detected: allow
  if (intent.platform === null || intent.source === "none") {
    return {
      result: "allowed",
      toolPlatform,
      intentPlatform: null,
      reason: "No platform intent detected; tool allowed",
    };
  }

  // Platforms match
  if (toolPlatform === intent.platform) {
    return {
      result: "allowed",
      toolPlatform,
      intentPlatform: intent.platform,
      reason: `Tool platform "${toolPlatform}" matches user intent`,
    };
  }

  // Cross-platform: tool platform differs from detected user intent.
  // This is a legitimate multi-platform workflow (e.g., reviewing a GitLab commit
  // related to a Jira ticket). Log it but allow it — the user explicitly asked
  // for this tool, even if their recent messages focused on a different platform.
  return {
    result: "allowed",
    toolPlatform,
    intentPlatform: intent.platform,
    reason: `Cross-platform access: user intent is "${intent.platform}" but tool "${toolName}" is on platform "${toolPlatform}" (${intent.source}: ${intent.evidence})`,
  };
}