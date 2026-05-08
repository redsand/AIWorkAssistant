/**
 * Parses Claude CLI stream-json output and renders readable summaries
 * instead of dumping raw JSON to the console.
 *
 * The Claude CLI with `--output-format stream-json` emits newline-delimited JSON.
 * Each line is a JSON object with a `type` field like "system", "assistant",
 * "tool_result", or "result". This module buffers incoming chunks, parses
 * complete JSON lines, and formats them for human consumption.
 */

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
  num_turns?: number;
  session_id?: string;
  [key: string]: unknown;
}

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
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
};

function toolDisplayName(name: string): string {
  return TOOL_DISPLAY_NAMES[name] || name;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + "…";
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

export function createStreamFormatter(agent: string): StreamFormatter {
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
          return `[agent] Session started`;
        }
        return "";
      }

      case "assistant": {
        const subtype = event.subtype ?? "";
        if (subtype === "text" || !subtype) {
          // Assistant text message
          let text = "";
          if (typeof event.content === "string") {
            text = event.content;
          } else if (Array.isArray(event.content)) {
            text = event.content
              .filter((b: ContentBlock) => b.type === "text" && b.text)
              .map((b: ContentBlock) => b.text ?? "")
              .join("\n");
          }
          if (text) {
            const firstLine = text.trim().split("\n")[0];
            return `[agent] ${truncate(firstLine, 120)}`;
          }
          return "";
        }
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
          return "";
        }
        return "";
      }

      case "tool_result": {
        const result = event.tool_result ?? event.result;
        if (typeof result === "string" && result.trim()) {
          const firstLine = result.trim().split("\n")[0];
          // Only show if it's a short, meaningful result
          if (firstLine.length < 150) {
            return `  < ${truncate(firstLine, 120)}`;
          }
          return `  < ${result.trim().split("\n").length} lines`;
        }
        return "";
      }

      case "result": {
        const resultText = event.result ?? event.message ?? "";
        const cost = event.cost_usd;
        const durationMs = event.duration_ms ?? event.duration_api_ms;
        const turns = event.num_turns ?? turnCount;

        const parts: string[] = ["[agent] ✓ Complete"];
        if (turns > 0) parts.push(`${turns} turn${turns !== 1 ? "s" : ""}`);
        if (durationMs) {
          const sec = (durationMs / 1000).toFixed(1);
          parts.push(`${sec}s`);
        }
        if (cost !== undefined && cost > 0) parts.push(`$${cost.toFixed(4)}`);

        const summary = parts.join(" · ");

        if (resultText && resultText.trim()) {
          const firstLine = resultText.trim().split("\n")[0];
          return `${summary}\n  ${truncate(firstLine, 200)}`;
        }
        return summary;
      }

      default: {
        // Unknown event type — skip
        return "";
      }
    }
  }
}