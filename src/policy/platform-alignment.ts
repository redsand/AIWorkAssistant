import type { PlatformIntent, PlatformValidation } from "./types";
import {
  getPlatformForToolName,
  getToolsByPlatform,
} from "../agent/tool-registry";

export function validatePlatformAlignment(
  toolName: string,
  intent: PlatformIntent,
  mode: string = "productivity",
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

  // Cross-contamination: tool platform differs from user intent
  const alternatives = getToolsByPlatform(mode, intent.platform).map(
    (t) => t.name,
  );

  return {
    result: "warning",
    toolPlatform,
    intentPlatform: intent.platform,
    reason: `User intent is "${intent.platform}" but tool "${toolName}" is on platform "${toolPlatform}" (${intent.source}: ${intent.evidence})`,
    suggestedAlternatives: alternatives.length > 0
      ? alternatives.slice(0, 5)
      : undefined,
  };
}