import type { Platform, PlatformIntent } from "./types";
import type { ChatMessage } from "../agent/providers/types";

const EXPLICIT_PATTERNS: Array<{ pattern: RegExp; platform: Platform }> = [
  { pattern: /\b(?:on\s+)?github\b/i, platform: "github" },
  { pattern: /\b(?:on\s+)?gitlab\b/i, platform: "gitlab" },
  { pattern: /\b(?:in\s+)?jira\b/i, platform: "jira" },
  { pattern: /\b(?:on\s+)?calendar\b/i, platform: "calendar" },
];

const INFERENCE_PATTERNS: Array<{
  pattern: RegExp;
  platform: Platform;
  label: string;
}> = [
  { pattern: /\bpull\s*request\b|\bPR\b(?!\s*-)/i, platform: "github", label: "PR/pull request" },
  { pattern: /\bgithub\s+actions?\b/i, platform: "github", label: "GitHub Actions" },
  { pattern: /\bgithub\s+issue\b/i, platform: "github", label: "GitHub issue" },
  { pattern: /\bmerge\s*request\b|\bMR\b/i, platform: "gitlab", label: "MR/merge request" },
  { pattern: /\bgitlab\s+pipeline\b/i, platform: "gitlab", label: "GitLab pipeline" },
  { pattern: /\bgitlab\s+issue\b/i, platform: "gitlab", label: "GitLab issue" },
  { pattern: /\bjira\s+(?:ticket|issue|story|epic|bug|task)\b/i, platform: "jira", label: "Jira terminology" },
  { pattern: /\b[A-Z]{2,10}-\d{1,6}\b/, platform: "jira", label: "Jira key pattern" },
  { pattern: /\bfocus\s*block\b/i, platform: "calendar", label: "focus block" },
  { pattern: /\bhealth\s*block\b/i, platform: "calendar", label: "health block" },
];

const PLATFORM_PREFIXES = ["github", "gitlab", "jira", "calendar"] as const;

const DEFAULT_SCAN_DEPTH = 10;

export function detectPlatformIntent(
  messages: ChatMessage[],
  options?: { scanDepth?: number },
): PlatformIntent {
  const depth = options?.scanDepth ?? DEFAULT_SCAN_DEPTH;
  const recent = messages.slice(-depth);

  // Strategy 1: Explicit platform mentions in user messages (most recent wins)
  for (let i = recent.length - 1; i >= 0; i--) {
    const msg = recent[i];
    if (msg.role !== "user") continue;
    for (const { pattern, platform } of EXPLICIT_PATTERNS) {
      if (pattern.test(msg.content)) {
        return {
          platform,
          source: "explicit",
          evidence: `User mentioned "${platform}": "${msg.content.substring(0, 100)}"`,
        };
      }
    }
  }

  // Strategy 2: Inferred from domain terminology (most recent wins)
  for (let i = recent.length - 1; i >= 0; i--) {
    const msg = recent[i];
    if (msg.role !== "user") continue;
    for (const { pattern, platform, label } of INFERENCE_PATTERNS) {
      if (pattern.test(msg.content)) {
        return {
          platform,
          source: "inferred",
          evidence: `Inferred "${platform}" from "${label}": "${msg.content.substring(0, 100)}"`,
        };
      }
    }
  }

  // Strategy 3: Sticky context from prior tool calls
  const counts: Record<string, number> = {};
  for (const msg of recent) {
    if (msg.role !== "assistant" || !msg.tool_calls) continue;
    for (const tc of msg.tool_calls) {
      const prefix = tc.function.name.split(".")[0];
      if (
        PLATFORM_PREFIXES.includes(prefix as typeof PLATFORM_PREFIXES[number])
      ) {
        counts[prefix] = (counts[prefix] || 0) + 1;
      }
    }
  }

  if (Object.keys(counts).length > 0) {
    const [dominant] = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    return {
      platform: dominant[0] as Platform,
      source: "sticky",
      evidence: `Inferred from prior tool calls: ${dominant[0]} tools called ${dominant[1]} times`,
    };
  }

  return {
    platform: null,
    source: "none",
    evidence: "No platform intent detected in recent conversation",
  };
}