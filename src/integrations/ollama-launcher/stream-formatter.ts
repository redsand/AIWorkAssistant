/**
 * Parses Claude CLI stream-json output and renders readable summaries
 * instead of dumping raw JSON to the console.
 *
 * The Claude CLI with `--output-format stream-json` emits newline-delimited JSON.
 * Each line is a JSON object with a `type` field. This module buffers incoming
 * chunks, parses complete JSON lines, and formats them for human consumption.
 *
 * Design principle: show something for every event. Never silently drop activity.
 * Unknown event types get a brief summary line so the user always sees progress.
 *
 * Debug mode: set AICODER_STREAM_DEBUG=1 to log raw events to
 * .aicoder/logs/stream-debug.log for troubleshooting.
 */

import * as fs from "fs";
import * as path from "path";

export interface StreamFormatter {
  /** Feed raw bytes from the agent's stdout. Returns formatted text to write to console. */
  push(chunk: string): string;
  /** Flush any remaining buffered data. */
  flush(): string;
}

interface StreamEvent {
  type?: string;
  subtype?: string;
  content?: string | ContentBlock[];
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_result?: string;
  result?: string;
  message?: string;
  cost_usd?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  duration_api?: number;
  num_turns?: number;
  session_id?: string;
  model?: string;
  thinking?: string;
  reasoning_content?: string;
  reasoning?: string;
  progress?: number;
  total?: number;
  // Claude API streaming fields
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string; [key: string]: unknown };
  stop_reason?: string;
  // Content block fields
  partial_json?: string;
  index?: number;
  id?: string;
  [key: string]: unknown;
}

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  id?: string;
  partial_json?: string;
  thinking?: string;
  reasoning_content?: string;
  reasoning?: string;
}

const TOOL_DISPLAY_NAMES: Record<string, string> = {
  Read: "read",
  Write: "write",
  Edit: "edit",
  Bash: "run",
  Glob: "find",
  Grep: "grep",
  WebFetch: "fetch",
  WebSearch: "search",
  Create: "create",
  Delete: "delete",
  MultiEdit: "edit",
  NotebookEdit: "notebook-edit",
  TaskCreate: "task-create",
  TaskUpdate: "task-update",
  AskUserQuestion: "ask",
  EnterPlanMode: "plan",
  ExitPlanMode: "plan-done",
};

function toolDisplayName(name: string): string {
  return TOOL_DISPLAY_NAMES[name] || name;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + "…";
}

/**
 * Unescape a JSON-encoded string value. If the input looks like a JSON string
 * literal (starts and ends with `"`), parse it. Otherwise return as-is.
 */
function unescapeJsonString(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return raw;
    }
  }
  return raw;
}

/**
 * Format a raw string that may contain JSON into human-readable text.
 * Handles: JSON arrays, JSON objects, JSON-encoded strings, and plain text.
 */
function formatReadableValue(raw: string, maxLen: number = 200): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  // Try parsing as JSON (array or object)
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      const items = parsed.map(String);
      const joined = items.join(", ");
      return truncate(joined, maxLen);
    }
    if (typeof parsed === "object" && parsed !== null) {
      const pairs = Object.entries(parsed)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      return truncate(pairs, maxLen);
    }
    // Parsed to a primitive (string, number, boolean)
    return truncate(String(parsed), maxLen);
  } catch {
    // Not valid JSON — try unescaping as a JSON string literal
    const unescaped = unescapeJsonString(trimmed);
    return truncate(unescaped, maxLen);
  }
}

/**
 * Extract text content from a content block, checking multiple fields
 * that different providers use for thinking/reasoning content.
 */
function extractBlockText(block: ContentBlock): string | undefined {
  return block.text || block.thinking || block.reasoning_content || block.reasoning || undefined;
}

function formatToolUse(name: string, input?: Record<string, unknown>): string {
  const display = toolDisplayName(name);
  if (!input) return `  > ${display}`;

  switch (name) {
    case "Bash": {
      const cmd = String(input.command ?? input.cmd ?? "");
      return `  > ${display}: ${truncate(cmd, 100)}`;
    }
    case "Read": {
      const fp = String(input.file_path ?? input.filePath ?? "");
      return `  > ${display}: ${truncate(fp, 100)}`;
    }
    case "Write": {
      const fp = String(input.file_path ?? input.filePath ?? "");
      return `  > ${display}: ${truncate(fp, 100)}`;
    }
    case "Edit": {
      const fp = String(input.file_path ?? input.filePath ?? "");
      return `  > ${display}: ${truncate(fp, 100)}`;
    }
    case "Glob": {
      const pat = String(input.pattern ?? "");
      return `  > ${display}: ${truncate(pat, 80)}`;
    }
    case "Grep": {
      const pat = String(input.pattern ?? "");
      return `  > ${display}: ${truncate(pat, 80)}`;
    }
    default:
      return `  > ${display}`;
  }
}

/**
 * Extract the most useful display text from an event, checking all known fields.
 * This is the fallback for events that don't have a specific handler.
 */
function extractEventContent(event: StreamEvent): string | undefined {
  // Check top-level text fields in priority order
  const text = event.thinking || event.reasoning_content || event.reasoning
    || event.message || event.result || event.content;
  if (typeof text === "string" && text.trim()) {
    return text.trim();
  }
  // Check content array
  if (Array.isArray(event.content)) {
    for (const block of event.content) {
      const blockText = extractBlockText(block as ContentBlock);
      if (blockText) return blockText;
    }
  }
  // Check delta
  if (event.delta) {
    const delta = event.delta;
    if (typeof delta.text === "string" && delta.text.trim()) return delta.text.trim();
    if (typeof delta.thinking === "string" && delta.thinking.trim()) return delta.thinking.trim();
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content.trim()) return delta.reasoning_content.trim();
    if (typeof delta.partial_json === "string" && delta.partial_json.trim()) return delta.partial_json.trim();
  }
  return undefined;
}

/**
 * Summarize an unknown or partially-handled event for console visibility.
 */
function summarizeUnknownEvent(event: StreamEvent): string {
  const type = event.type ?? "unknown";
  const subtype = event.subtype;
  const parts: string[] = [`[${type}]`];

  if (subtype) parts.push(String(subtype));

  const content = extractEventContent(event);
  if (content) {
    parts.push(truncate(content.split("\n")[0], 80));
  }

  const toolName = event.tool_name;
  if (toolName) parts.push(`tool=${toolName}`);

  const model = event.model;
  if (model) parts.push(`model=${model}`);

  return `  ${parts.join(" ")}`;
}

// --- Debug logging ---
const STREAM_DEBUG = process.env.AICODER_STREAM_DEBUG === "1";

function debugLog(workspace: string, line: string): void {
  if (!STREAM_DEBUG) return;
  try {
    const logDir = path.join(workspace, ".aicoder", "logs");
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, "stream-debug.log");
    const ts = new Date().toISOString();
    fs.appendFileSync(logPath, `${ts} ${line}\n`, "utf-8");
  } catch {
    // Debug logging is best-effort
  }
}

export function createStreamFormatter(agent: string, workspace?: string): StreamFormatter {
  // For non-Claude agents, pass through raw output
  if (agent !== "claude") {
    return {
      push(chunk: string) { return chunk; },
      flush() { return ""; },
    };
  }

  let buffer = "";
  let turnCount = 0;

  return {
    push(chunk: string): string {
      buffer += chunk;
      const lines: string[] = [];
      let newlineIdx: number;

      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);

        if (!line) continue;

        let event: StreamEvent;
        try {
          event = JSON.parse(line);
        } catch {
          // Not valid JSON — pass through as plain text
          lines.push(line);
          continue;
        }

        if (STREAM_DEBUG && workspace) {
          debugLog(workspace, line.length > 500 ? line.slice(0, 500) + "..." : line);
        }

        const formatted = formatEvent(event);
        if (formatted) lines.push(formatted);
      }

      return lines.join("\n") + (lines.length > 0 ? "\n" : "");
    },

    flush(): string {
      if (buffer.trim()) {
        const remaining = buffer.trim();
        buffer = "";
        try {
          const event = JSON.parse(remaining);
          const formatted = formatEvent(event);
          return formatted ? formatted + "\n" : "";
        } catch {
          return remaining + "\n";
        }
      }
      buffer = "";
      return "";
    },
  };

  function formatEvent(event: StreamEvent): string {
    const type = event.type ?? "";

    switch (type) {
      case "system": {
        const subtype = event.subtype ?? "";
        if (subtype === "init") {
          const model = typeof event.model === "string" ? event.model : "";
          const sessionId = typeof event.session_id === "string" ? event.session_id.slice(0, 8) : "";
          const parts: string[] = ["[agent] Session started"];
          if (model) parts.push(`model=${model}`);
          if (sessionId) parts.push(`session=${sessionId}`);
          return parts.join(" · ");
        }
        // Show other system events (warnings, errors, task notifications)
        const msg = event.message;
        if (typeof msg === "string" && msg.trim()) {
          return `[system] ${subtype ? subtype + ": " : ""}${truncate(msg.trim(), 120)}`;
        }
        if (subtype) {
          return `[system] ${subtype}`;
        }
        return summarizeUnknownEvent(event);
      }

      case "assistant": {
        const subtype = event.subtype ?? "";

        // --- Thinking / reasoning content ---
        if (subtype === "thinking" || subtype === "thinking_delta") {
          const thinking = event.thinking || event.reasoning_content || event.reasoning;
          if (typeof thinking === "string" && thinking.trim()) {
            return `  [thinking] ${truncate(thinking.trim().split("\n")[0], 100)}`;
          }
          // Check content array for thinking blocks
          if (Array.isArray(event.content)) {
            for (const block of event.content) {
              const b = block as ContentBlock;
              if (b.type === "thinking" || b.type === "reasoning") {
                const blockText = extractBlockText(b);
                if (blockText) return `  [thinking] ${truncate(blockText.split("\n")[0], 100)}`;
              }
            }
          }
          return "  [thinking] …";
        }

        // --- Text content ---
        if (subtype === "text" || !subtype) {
          let text = "";
          if (typeof event.content === "string") {
            text = event.content;
          } else if (Array.isArray(event.content)) {
            // Extract text from content blocks, including thinking/reasoning blocks
            const parts: string[] = [];
            for (const block of event.content) {
              const b = block as ContentBlock;
              if (b.type === "thinking" || b.type === "reasoning") {
                const blockText = extractBlockText(b);
                if (blockText) parts.push(`[thinking] ${truncate(blockText, 80)}`);
              } else if (b.type === "text" || !b.type) {
                if (b.text) parts.push(b.text);
              }
            }
            text = parts.join("\n");
          }

          // Also check top-level thinking/reasoning fields
          const thinking = event.thinking || event.reasoning_content || event.reasoning;
          if (typeof thinking === "string" && thinking.trim()) {
            return `  [thinking] ${truncate(thinking.trim().split("\n")[0], 100)}`;
          }

          if (text) {
            const firstLine = text.trim().split("\n")[0];
            return `[agent] ${formatReadableValue(firstLine, 120)}`;
          }

          // Content is empty — check if there's a message field
          if (event.message && typeof event.message === "string" && event.message.trim()) {
            return `[agent] ${truncate(event.message.trim().split("\n")[0], 120)}`;
          }

          // Try to show something useful from content blocks
          if (Array.isArray(event.content) && event.content.length > 0) {
            return summarizeUnknownEvent(event);
          }

          return "[agent] …";
        }

        // --- Tool use ---
        if (subtype === "tool_use") {
          turnCount++;
          const toolName = event.tool_name ?? "";
          if (toolName) {
            return formatToolUse(toolName, event.tool_input as Record<string, unknown> | undefined);
          }
          // Try extracting from content blocks
          if (Array.isArray(event.content)) {
            const toolBlock = event.content.find(
              (b: ContentBlock) => b.type === "tool_use" && b.name,
            ) as ContentBlock | undefined;
            if (toolBlock?.name) {
              return formatToolUse(toolBlock.name, toolBlock.input);
            }
          }
          return "  > tool_use (unknown)";
        }

        // Any other assistant subtype — show what we can
        return summarizeUnknownEvent(event);
      }

      case "user": {
        // User messages sent back to the model (tool results, confirmations, etc.)
        const content = extractEventContent(event);
        if (content) {
          return `  [user] ${truncate(content.split("\n")[0], 100)}`;
        }
        return "  [user]";
      }

      case "tool_result": {
        const result = event.tool_result ?? event.result;
        if (typeof result === "string" && result.trim()) {
          const firstLine = result.trim().split("\n")[0];
          const formatted = formatReadableValue(firstLine, 120);
          if (formatted) {
            return `  < ${formatted}`;
          }
          const lineCount = result.trim().split("\n").length;
          return `  < ${lineCount} lines`;
        }
        // Non-string result (could be an object)
        if (result !== undefined && result !== null) {
          return summarizeUnknownEvent(event);
        }
        return "  < (empty result)";
      }

      case "result": {
        const resultText = event.result ?? event.message ?? "";
        const cost = event.cost_usd;
        const durationMs = event.duration_ms ?? event.duration_api_ms ?? (typeof event.duration_api === "number" ? event.duration_api : undefined);
        const turns = event.num_turns ?? turnCount;

        const parts: string[] = ["[agent] ✓ Complete"];
        if (turns > 0) parts.push(`${turns} turn${turns !== 1 ? "s" : ""}`);
        if (durationMs) {
          const sec = (durationMs / 1000).toFixed(1);
          parts.push(`${sec}s`);
        }
        if (cost !== undefined && cost > 0) parts.push(`$${cost.toFixed(4)}`);

        const summary = parts.join(" · ");

        if (resultText && typeof resultText === "string" && resultText.trim()) {
          const firstLine = resultText.trim().split("\n")[0];
          return `${summary}\n  ${formatReadableValue(firstLine, 200)}`;
        }
        return summary;
      }

      case "progress": {
        const current = event.progress;
        const total = event.total;
        if (current !== undefined && total !== undefined && total > 0) {
          const pct = Math.round((current / total) * 100);
          return `  … ${pct}% (${current}/${total})`;
        }
        if (current !== undefined) {
          return `  … step ${current}`;
        }
        return "  …";
      }

      case "thinking": {
        const thinking = event.thinking || event.reasoning_content || event.reasoning || event.content;
        if (typeof thinking === "string" && thinking.trim()) {
          return `  [thinking] ${truncate(thinking.trim().split("\n")[0], 100)}`;
        }
        if (Array.isArray(thinking)) {
          // Thinking content blocks
          for (const block of thinking) {
            const b = block as ContentBlock;
            const blockText = extractBlockText(b);
            if (blockText) return `  [thinking] ${truncate(blockText.split("\n")[0], 100)}`;
          }
        }
        return "  [thinking] …";
      }

      // Content block streaming events — show incremental progress
      case "content_block_start":
      case "content_block_delta":
      case "content_block_stop": {
        // Tool input deltas
        if (event.partial_json && typeof event.partial_json === "string" && event.partial_json.trim()) {
          return `  … ${truncate(event.partial_json.trim(), 80)}`;
        }
        // Text delta from content block
        if (event.content && typeof event.content === "string" && event.content.trim()) {
          return `  … ${truncate(event.content.trim(), 80)}`;
        }
        // Check delta object
        if (event.delta) {
          const delta = event.delta;
          if (typeof delta.text === "string" && delta.text.trim()) {
            return `  … ${truncate(delta.text.trim(), 80)}`;
          }
          if (typeof delta.thinking === "string" && delta.thinking.trim()) {
            return `  [thinking] ${truncate(delta.thinking.trim(), 80)}`;
          }
          if (typeof delta.reasoning_content === "string" && delta.reasoning_content.trim()) {
            return `  [thinking] ${truncate(delta.reasoning_content.trim(), 80)}`;
          }
          if (typeof delta.partial_json === "string" && delta.partial_json.trim()) {
            return `  … ${truncate(delta.partial_json.trim(), 80)}`;
          }
        }
        // Suppress empty streaming deltas to reduce noise
        return "";
      }

      // Message-level streaming events
      case "message_start": {
        const model = event.model;
        if (model) {
          return `[agent] model: ${model}`;
        }
        return "";
      }
      case "message_delta": {
        if (event.stop_reason) {
          return `[agent] stop: ${event.stop_reason}`;
        }
        return "";
      }
      case "message_stop": {
        return "";
      }

      default: {
        // Show every unknown event type so the user always sees activity.
        // Never silently drop events.
        return summarizeUnknownEvent(event);
      }
    }
  }
}