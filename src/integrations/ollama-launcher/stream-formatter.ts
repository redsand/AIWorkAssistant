/**
 * Parses Claude CLI stream-json output and renders readable summaries
 * with ANSI colors, markdown-aware formatting, and content accumulation
 * for streaming delta events.
 *
 * The Claude CLI with `--output-format stream-json` emits newline-delimited JSON.
 * Each line is a JSON object with a `type` field. This module buffers incoming
 * chunks, parses complete JSON lines, and formats them for terminal display.
 *
 * Design principle: show something for every event. Never silently drop activity.
 * Unknown event types get a brief summary line so the user always sees progress.
 *
 * When stdout is not a TTY (piped to file/log), ANSI colors are stripped.
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
  /** Whether the agent ran test commands during this session (e.g. pytest, vitest, jest). */
  ranTests: boolean;
}

export interface StreamFormatterOptions {
  /** When true, write raw stream events to .aicoder/logs/stream-debug.log */
  debug?: boolean;
  /** Workspace directory for debug log path */
  workspace?: string;
  /** Called when a session_id is received from the agent (Claude CLI init event). */
  onSessionId?: (sessionId: string) => void;
}

// ─── ANSI color codes ────────────────────────────────────────────────────────

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
  bgDark: "\x1b[48;5;236m",
} as const;

/** Strip all ANSI escape sequences from a string. */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

// ─── Event types ─────────────────────────────────────────────────────────────

interface StreamEvent {
  type?: string;
  subtype?: string;
  content?: string | ContentBlock[];
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_result?: string;
  result?: string;
  message?: string | { role?: string; content?: ContentBlock[]; model?: string; id?: string; [key: string]: unknown };
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
  content?: string;
  tool_use_id?: string;
}

// ─── Tool display names ──────────────────────────────────────────────────────

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

// ─── Text helpers ─────────────────────────────────────────────────────────────

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
    return truncate(String(parsed), maxLen);
  } catch {
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

// ─── Markdown-aware ANSI formatting ──────────────────────────────────────────

/**
 * Format a multi-line content string with ANSI styling applied to detected
 * markdown patterns. Returns an array of styled lines.
 */
function formatContentLines(text: string, color: (s: string) => string): string[] {
  if (!text.trim()) return [];

  const MAX_LINES = 50;
  const lines = text.split("\n");
  const result: string[] = [];
  let inCodeBlock = false;
  let codeBlockLines: string[] = [];

  for (let i = 0; i < Math.min(lines.length, MAX_LINES); i++) {
    const line = lines[i];

    // Fenced code block toggling
    if (line.trimStart().startsWith("```")) {
      if (inCodeBlock) {
        // End code block
        const border = `${ANSI.dim}──${"─".repeat(Math.max(0, Math.min(codeBlockLines.reduce((m, l) => Math.max(m, stripAnsi(l).length), 0), 60)))}──${ANSI.reset}`;
        result.push(border);
        for (const cl of codeBlockLines) {
          result.push(`  ${ANSI.cyan}${cl}${ANSI.reset}`);
        }
        result.push(border);
        codeBlockLines = [];
        inCodeBlock = false;
      } else {
        // Start code block
        const lang = line.trimStart().slice(3).trim();
        result.push(`${ANSI.dim}──${lang ? ` ${lang} ` : ""}${"─".repeat(Math.max(0, 40 - lang.length))}──${ANSI.reset}`);
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockLines.push(line);
      continue;
    }

    // Headings
    const h3Match = line.match(/^###\s+(.+)$/);
    if (h3Match) {
      result.push(`  ${ANSI.bold}${ANSI.underline}${h3Match[1]}${ANSI.reset}`);
      continue;
    }
    const h2Match = line.match(/^##\s+(.+)$/);
    if (h2Match) {
      result.push(`  ${ANSI.bold}${ANSI.cyan}${h2Match[1]}${ANSI.reset}`);
      continue;
    }
    const h1Match = line.match(/^#\s+(.+)$/);
    if (h1Match) {
      result.push(`  ${ANSI.bold}${ANSI.white}${ANSI.underline}${h1Match[1]}${ANSI.reset}`);
      continue;
    }

    // Unordered list items
    const ulMatch = line.match(/^(\s*)[-*+]\s+(.+)$/);
    if (ulMatch) {
      const indent = ulMatch[1].length + 2;
      const content = formatInlineMarkdown(ulMatch[2], color);
      result.push(`${" ".repeat(indent)}${ANSI.cyan}•${ANSI.reset} ${content}`);
      continue;
    }

    // Ordered list items
    const olMatch = line.match(/^(\s*)(\d+)\.\s+(.+)$/);
    if (olMatch) {
      const indent = olMatch[1].length + 2;
      const content = formatInlineMarkdown(olMatch[3], color);
      result.push(`${" ".repeat(indent)}${ANSI.dim}${olMatch[2]}.${ANSI.reset} ${content}`);
      continue;
    }

    // Blockquotes
    if (line.trimStart().startsWith("> ")) {
      const content = line.replace(/^\s*>\s*/, "");
      result.push(`  ${ANSI.magenta}│${ANSI.reset} ${formatInlineMarkdown(content, color)}`);
      continue;
    }

    // Horizontal rules
    if (/^---+$/.test(line.trim())) {
      result.push(`  ${ANSI.dim}────────────────────────────────${ANSI.reset}`);
      continue;
    }

    // Data-point lines (contain key: value or key=value)
    const dataMatch = line.match(/^(\s*)([-\w./]+)\s*[:=]\s*(.+)$/);
    if (dataMatch) {
      const indent = dataMatch[1].length + 2;
      result.push(`${" ".repeat(indent)}${ANSI.cyan}${dataMatch[2]}${ANSI.reset}: ${formatInlineMarkdown(dataMatch[3], color)}`);
      continue;
    }

    // Regular text line
    result.push(`  ${formatInlineMarkdown(line, color)}`);
  }

  // Truncated indicator
  if (lines.length > MAX_LINES) {
    result.push(`  ${ANSI.dim}… (${lines.length - MAX_LINES} more lines)${ANSI.reset}`);
  }

  // Unclosed code block
  if (inCodeBlock && codeBlockLines.length > 0) {
    for (const cl of codeBlockLines) {
      result.push(`  ${ANSI.cyan}${cl}${ANSI.reset}`);
    }
  }

  return result;
}

/**
 * Apply inline markdown formatting (bold, italic, inline code, links) to a string.
 */
function formatInlineMarkdown(text: string, color: (s: string) => string): string {
  let result = text;

  // Inline code: `code`
  result = result.replace(/`([^`]+)`/g, (_, code) => `${ANSI.yellow}${code}${ANSI.reset}`);

  // Bold: **text**
  result = result.replace(/\*\*(.+?)\*\*/g, (_, t) => `${ANSI.bold}${t}${ANSI.reset}`);

  // Italic: *text*
  result = result.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, (_, t) => `${ANSI.italic}${t}${ANSI.reset}`);

  // Links: [text](url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, linkText, url) => `${ANSI.underline}${linkText}${ANSI.reset} ${ANSI.dim}(${url})${ANSI.reset}`);

  // Apply base color to anything not already styled
  result = color(result);

  return result;
}

// ─── Tool use formatting ─────────────────────────────────────────────────────

function formatToolUse(name: string, input?: Record<string, unknown>, color?: (s: string) => string): string {
  const display = toolDisplayName(name);
  const c = color ?? ((s: string) => `${ANSI.green}${s}${ANSI.reset}`);
  const prefix = `  ${c("▶")} ${ANSI.green}${ANSI.bold}${display}${ANSI.reset}`;

  if (!input) return prefix;

  switch (name) {
    case "Bash": {
      const cmd = String(input.command ?? input.cmd ?? "");
      return `${prefix}\n    ${ANSI.dim}${truncate(cmd, 120)}${ANSI.reset}`;
    }
    case "Read": {
      const fp = String(input.file_path ?? input.filePath ?? "");
      return `${prefix}\n    ${ANSI.dim}${fp}${ANSI.reset}`;
    }
    case "Write": {
      const fp = String(input.file_path ?? input.filePath ?? "");
      return `${prefix}\n    ${ANSI.dim}${fp}${ANSI.reset}`;
    }
    case "Edit": {
      const fp = String(input.file_path ?? input.filePath ?? "");
      return `${prefix}\n    ${ANSI.dim}${fp}${ANSI.reset}`;
    }
    case "Glob": {
      const pat = String(input.pattern ?? "");
      return `${prefix}\n    ${ANSI.dim}${pat}${ANSI.reset}`;
    }
    case "Grep": {
      const pat = String(input.pattern ?? "");
      return `${prefix}\n    ${ANSI.dim}${pat}${ANSI.reset}`;
    }
    case "TodoWrite": {
      const rawTodos = input.todos;
      const todos = Array.isArray(rawTodos) ? rawTodos : undefined;
      if (todos && todos.length > 0) {
        const lines = todos.slice(0, 5).map((t: any) => {
          const status = t.status === "completed" ? "✓" : t.status === "in_progress" ? "→" : "○";
          const content = truncate(t.content || t.subject || "", 80);
          const form = t.activeForm ? ` (${truncate(t.activeForm, 40)})` : "";
          return `    ${ANSI.dim}${status}${ANSI.reset} ${content}${form}`;
        });
        const extra = todos.length > 5 ? `\n    ${ANSI.dim}… +${todos.length - 5} more${ANSI.reset}` : "";
        return `${prefix}\n${lines.join("\n")}${extra}`;
      }
      return prefix;
    }
    case "TaskCreate":
    case "TaskUpdate": {
      const subject = String(input.subject ?? "");
      const status = String(input.status ?? "");
      if (subject) {
        return `${prefix}\n    ${ANSI.dim}${subject}${status ? ` [${status}]` : ""}${ANSI.reset}`;
      }
      return prefix;
    }
    default:
      return prefix;
  }
}

// ─── Debug logging ───────────────────────────────────────────────────────────

const STREAM_DEBUG = process.env.AICODER_STREAM_DEBUG === "1";

// Module-level debug flag — set by createStreamFormatter when --debug is passed
let debugEnabled = STREAM_DEBUG;

function debugLog(workspace: string, line: string): void {
  if (!debugEnabled) return;
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

/** Clear the debug log at the start of a new session so each run starts fresh. */
function clearDebugLog(workspace: string): void {
  try {
    const logPath = path.join(workspace, ".aicoder", "logs", "stream-debug.log");
    if (fs.existsSync(logPath)) fs.writeFileSync(logPath, "", "utf-8");
  } catch {
    // Best-effort
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createStreamFormatter(agent: string, workspace?: string, options?: StreamFormatterOptions): StreamFormatter {
  const debugMode = options?.debug ?? (process.env.AICODER_STREAM_DEBUG === "1");
  const debugWorkspace = workspace ?? options?.workspace;

  // Enable module-level debug logging so debugLog() actually writes
  if (debugMode) {
    debugEnabled = true;
    // Clear the debug log at the start of each session so each run starts fresh
    if (debugWorkspace) clearDebugLog(debugWorkspace);
  }

  // For non-Claude agents, pass through raw output
  if (agent !== "claude") {
    return {
      ranTests: false,
      push(chunk: string) {
        if (debugMode && debugWorkspace) debugLog(debugWorkspace, chunk.trimEnd());
        return chunk;
      },
      flush() { return ""; },
    };
  }

  // Detect TTY for color support
  const useColor = process.stdout.isTTY && process.env.NO_COLOR !== "1" && process.env.FORCE_COLOR !== "0";

  // Color helper — applies color only when TTY supports it
  const c = {
    agent: (s: string) => useColor ? `${ANSI.cyan}${ANSI.bold}${s}${ANSI.reset}` : s,
    thinking: (s: string) => useColor ? `${ANSI.dim}${ANSI.gray}${s}${ANSI.reset}` : s,
    system: (s: string) => useColor ? `${ANSI.yellow}${s}${ANSI.reset}` : s,
    user: (s: string) => useColor ? `${ANSI.blue}${s}${ANSI.reset}` : s,
    tool: (s: string) => useColor ? `${ANSI.green}${ANSI.bold}${s}${ANSI.reset}` : s,
    toolDim: (s: string) => useColor ? `${ANSI.dim}${s}${ANSI.reset}` : s,
    result: (s: string) => useColor ? `${ANSI.dim}${ANSI.gray}${s}${ANSI.reset}` : s,
    success: (s: string) => useColor ? `${ANSI.green}${ANSI.bold}${s}${ANSI.reset}` : s,
    error: (s: string) => useColor ? `${ANSI.red}${ANSI.bold}${s}${ANSI.reset}` : s,
    progress: (s: string) => useColor ? `${ANSI.cyan}${s}${ANSI.reset}` : s,
    content: (s: string) => s, // base color applied via formatContentLines
  };

  let buffer = "";
  let turnCount = 0;
  let agentRanTests = false;

  // Test command patterns that indicate the agent ran tests
  const TEST_COMMAND_PATTERNS = [
    /\bpytest\b/,
    /\bvitest\b/,
    /\bjest\b/,
    /\bnpm\s+test\b/,
    /\bnpm\s+run\s+test/,
    /\bpnpm\s+test\b/,
    /\bpnpm\s+run\s+test/,
    /\byarn\s+test\b/,
    /\bcargo\s+test\b/,
    /\bdotnet\s+test\b/,
    /\bgo\s+test\b/,
    /\bmvn\s+test\b/,
    /\bgradle\s+.*test\b/,
    /\brake\s+test\b/,
    /\bpython\s+.*-m\s+pytest\b/,
    /\bpython\s+.*-m\s+unittest\b/,
  ];

  function detectTestCommand(toolName: string | undefined, input?: Record<string, unknown>): void {
    if (agentRanTests || toolName !== "Bash") return;
    const cmd = String(input?.command ?? input?.cmd ?? "");
    if (TEST_COMMAND_PATTERNS.some((p) => p.test(cmd))) {
      agentRanTests = true;
    }
  }

  // Content accumulator for streaming deltas
  let textAccumulator = "";
  let thinkingAccumulator = "";
  let lastEmittedTextLine = "";

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

        if (debugMode && debugWorkspace) {
          debugLog(debugWorkspace, line);
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

    get ranTests() { return agentRanTests; },
  };

  // ─── Event formatter ──────────────────────────────────────────────────────

  function formatEvent(event: StreamEvent): string {
    const type = event.type ?? "";

    switch (type) {
      case "system": {
        const subtype = event.subtype ?? "";
        if (subtype === "init") {
          const model = typeof event.model === "string" ? event.model : "";
          const fullSessionId = typeof event.session_id === "string" ? event.session_id : "";
          if (fullSessionId && options?.onSessionId) {
            options.onSessionId(fullSessionId);
          }
          const sessionId = fullSessionId.slice(0, 8);
          const parts: string[] = [c.agent("[agent]"), "Session started"];
          if (model) parts.push(`model=${model}`);
          if (sessionId) parts.push(`session=${sessionId}`);
          return parts.join(" · ");
        }
        const msg = event.message;
        if (typeof msg === "string" && msg.trim()) {
          return `${c.system("[system]")} ${subtype ? subtype + ": " : ""}${truncate(msg.trim(), 120)}`;
        }
        if (subtype) {
          return `${c.system("[system]")} ${subtype}`;
        }
        return summarizeUnknownEvent(event);
      }

      case "assistant": {
        const subtype = event.subtype ?? "";

        // Resolve content blocks from either event.content or event.message.content
        const contentBlocks = Array.isArray(event.content)
          ? (event.content as ContentBlock[])
          : (typeof event.message === "object" && Array.isArray(event.message?.content))
            ? (event.message.content as ContentBlock[])
            : [];

        // ── Thinking / reasoning content ──
        if (subtype === "thinking" || subtype === "thinking_delta") {
          const thinking = event.thinking || event.reasoning_content || event.reasoning;
          if (typeof thinking === "string" && thinking.trim()) {
            thinkingAccumulator += thinking;
            return formatAccumulatedThinking();
          }
          if (contentBlocks.length > 0) {
            for (const b of contentBlocks) {
              if (b.type === "thinking" || b.type === "reasoning") {
                const blockText = extractBlockText(b);
                if (blockText) {
                  thinkingAccumulator += blockText;
                  return formatAccumulatedThinking();
                }
              }
            }
          }
          return c.thinking("  [thinking] …");
        }

        // ── Text content ──
        if (subtype === "text" || !subtype) {
          let text = "";
          if (typeof event.content === "string") {
            text = event.content;
          } else if (contentBlocks.length > 0) {
            const parts: string[] = [];
            for (const b of contentBlocks) {
              if (b.type === "thinking" || b.type === "reasoning") {
                const blockText = extractBlockText(b);
                if (blockText) {
                  thinkingAccumulator += blockText;
                }
              } else if (b.type === "tool_use") {
                // Tool use blocks handled in their own section below
              } else if (b.type === "text" || !b.type) {
                if (b.text) parts.push(b.text);
              }
            }
            text = parts.join("\n");
          }

          // Top-level thinking/reasoning
          const thinking = event.thinking || event.reasoning_content || event.reasoning;
          if (typeof thinking === "string" && thinking.trim()) {
            thinkingAccumulator += thinking;
            return formatAccumulatedThinking();
          }

          // Flush any accumulated thinking first
          const thinkingOutput = flushThinkingAccumulator();

          if (text) {
            textAccumulator += text;
            const textOutput = flushTextAccumulator();
            return [thinkingOutput, textOutput].filter(Boolean).join("\n");
          }

          // If we accumulated thinking but no text, return the thinking output
          if (thinkingOutput) {
            return thinkingOutput;
          }

          // Content is empty — check message field as string
          if (event.message && typeof event.message === "string" && event.message.trim()) {
            textAccumulator += event.message;
            return flushTextAccumulator();
          }

          // Check for tool_use blocks in content — handle them here
          const toolBlock = contentBlocks.find((b) => b.type === "tool_use" && b.name);
          if (toolBlock) {
            turnCount++;
            detectTestCommand(toolBlock.name, toolBlock.input);
            return formatToolUse(toolBlock.name!, toolBlock.input);
          }

          // Try to show something from content blocks
          if (contentBlocks.length > 0) {
            return summarizeUnknownEvent(event);
          }

          return c.agent("[agent] …");
        }

        // ── Tool use ──
        if (subtype === "tool_use") {
          turnCount++;
          const toolName = event.tool_name ?? "";
          const toolInput = event.tool_input as Record<string, unknown> | undefined;
          if (toolName) {
            detectTestCommand(toolName, toolInput);
            return formatToolUse(toolName, toolInput);
          }
          if (contentBlocks.length > 0) {
            const toolBlock = contentBlocks.find(
              (b: ContentBlock) => b.type === "tool_use" && b.name,
            ) as ContentBlock | undefined;
            if (toolBlock?.name) {
              detectTestCommand(toolBlock.name, toolBlock.input);
              return formatToolUse(toolBlock.name, toolBlock.input);
            }
          }
          return `  ${c.tool("▶")} tool_use (unknown)`;
        }

        return summarizeUnknownEvent(event);
      }

      case "user": {
        // User events can contain tool_result blocks inside message.content[]
        const msgContent = (typeof event.message === "object" && event.message !== null)
          ? (event.message as { content?: ContentBlock[] }).content
          : undefined;

        // Check for tool_result blocks in the user message content
        if (Array.isArray(msgContent)) {
          const toolResults: string[] = [];
          for (const block of msgContent) {
            const b = block as ContentBlock;
            if (b.type === "tool_result") {
              const resultText = typeof b.content === "string" ? b.content : "";
              if (resultText.trim()) {
                const lineCount = resultText.trim().split("\n").length;
                if (lineCount <= 3) {
                  toolResults.push(`  ${c.result("◀")} ${formatReadableValue(resultText.trim(), 200)}`);
                } else {
                  toolResults.push(`  ${c.result("◀")} ${lineCount} lines`);
                }
              } else {
                toolResults.push(`  ${c.result("◀")} (empty)`);
              }
            }
          }
          if (toolResults.length > 0) {
            return toolResults.join("\n");
          }
        }

        const content = extractEventContent(event);
        if (content) {
          return `${c.user("  [user]")} ${truncate(content.split("\n")[0], 100)}`;
        }
        return c.user("  [user]");
      }

      case "tool_result": {
        const result = event.tool_result ?? event.result;
        if (typeof result === "string" && result.trim()) {
          const lineCount = result.trim().split("\n").length;
          if (lineCount <= 3) {
            const formatted = formatReadableValue(result.trim(), 200);
            if (formatted) {
              return `  ${c.result("◀")} ${formatted}`;
            }
          }
          return `  ${c.result("◀")} ${lineCount} lines`;
        }
        if (result !== undefined && result !== null) {
          return summarizeUnknownEvent(event);
        }
        return `  ${c.result("◀")} (empty)`;
      }

      case "result": {
        const resultText = event.result ?? event.message ?? "";
        const cost = event.cost_usd;
        const durationMs = event.duration_ms ?? event.duration_api_ms ?? (typeof event.duration_api === "number" ? event.duration_api : undefined);
        const turns = event.num_turns ?? turnCount;

        const parts: string[] = [c.success("✓ Complete")];
        if (turns > 0) parts.push(`${turns} turn${turns !== 1 ? "s" : ""}`);
        if (durationMs) {
          const sec = (durationMs / 1000).toFixed(1);
          parts.push(`${sec}s`);
        }
        if (cost !== undefined && cost > 0) parts.push(`$${cost.toFixed(4)}`);

        const summary = parts.join(" · ");

        if (resultText && typeof resultText === "string" && resultText.trim()) {
          const contentLines = formatContentLines(resultText, (s) => s);
          if (contentLines.length > 0) {
            return `${summary}\n${contentLines.join("\n")}`;
          }
          return summary;
        }
        return summary;
      }

      case "progress": {
        const current = event.progress;
        const total = event.total;
        if (current !== undefined && total !== undefined && total > 0) {
          const pct = Math.round((current / total) * 100);
          return c.progress(`  … ${pct}% (${current}/${total})`);
        }
        if (current !== undefined) {
          return c.progress(`  … step ${current}`);
        }
        return c.progress("  …");
      }

      case "thinking": {
        const thinking = event.thinking || event.reasoning_content || event.reasoning || event.content;
        if (typeof thinking === "string" && thinking.trim()) {
          thinkingAccumulator += thinking;
          return formatAccumulatedThinking();
        }
        if (Array.isArray(thinking)) {
          for (const block of thinking) {
            const b = block as ContentBlock;
            const blockText = extractBlockText(b);
            if (blockText) {
              thinkingAccumulator += blockText;
              return formatAccumulatedThinking();
            }
          }
        }
        return c.thinking("  [thinking] …");
      }

      // Content block streaming — accumulate text and show line-by-line
      case "content_block_start": {
        // New content block starting — just note it
        if (event.content && typeof event.content === "string") {
          textAccumulator += event.content;
          return formatAccumulatedText();
        }
        return "";
      }

      case "content_block_delta": {
        // Accumulate text deltas and emit complete lines
        if (event.delta) {
          const delta = event.delta;
          if (typeof delta.text === "string" && delta.text) {
            textAccumulator += delta.text;
            return formatAccumulatedText();
          }
          if (typeof delta.thinking === "string" && delta.thinking) {
            thinkingAccumulator += delta.thinking;
            return formatAccumulatedThinking();
          }
          if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
            thinkingAccumulator += delta.reasoning_content;
            return formatAccumulatedThinking();
          }
          if (typeof delta.partial_json === "string" && delta.partial_json.trim()) {
            return c.progress(`  … ${truncate(delta.partial_json.trim(), 80)}`);
          }
        }
        if (event.content && typeof event.content === "string" && event.content.trim()) {
          textAccumulator += event.content;
          return formatAccumulatedText();
        }
        return "";
      }

      case "content_block_stop": {
        // Flush remaining text from the accumulator
        const flushed = flushTextAccumulator();
        return flushed;
      }

      // Message-level streaming events
      case "message_start": {
        const model = event.model;
        if (model) {
          return `${c.agent("[agent]")} model: ${model}`;
        }
        return "";
      }
      case "message_delta": {
        if (event.stop_reason) {
          return `${c.agent("[agent]")} stop: ${event.stop_reason}`;
        }
        return "";
      }
      case "message_stop": {
        // Flush any remaining accumulated text
        return flushTextAccumulator() + flushThinkingAccumulator();
      }

      default: {
        return summarizeUnknownEvent(event);
      }
    }
  }

  // ─── Accumulator helpers ────────────────────────────────────────────────

  /**
   * Format accumulated text content, emitting only complete lines.
   * Incomplete lines are held in the accumulator for the next call.
   */
  function formatAccumulatedText(): string {
    if (!textAccumulator) return "";

    // Find the last newline — emit everything up to and including it
    const lastNewline = textAccumulator.lastIndexOf("\n");
    if (lastNewline === -1) {
      // No complete line yet — show a preview of what's being typed
      const preview = truncate(textAccumulator, 80);
      if (preview && preview !== lastEmittedTextLine) {
        lastEmittedTextLine = preview;
        // Render as a single preview line with inline formatting
        const contentLines = formatContentLines(preview, (s) => s);
        return contentLines.join("\n");
      }
      return "";
    }

    // Emit all complete lines
    const completeText = textAccumulator.slice(0, lastNewline + 1);
    textAccumulator = textAccumulator.slice(lastNewline + 1);

    const contentLines = formatContentLines(completeText, (s) => s);
    lastEmittedTextLine = "";
    return contentLines.join("\n");
  }

  function formatAccumulatedThinking(): string {
    if (!thinkingAccumulator) return c.thinking("  [thinking] …");

    // Show first 3 lines of thinking content
    const lines = thinkingAccumulator.split("\n").slice(0, 3);
    const preview = lines.join("\n");
    thinkingAccumulator = "";
    const contentLines = formatContentLines(preview, (s) => c.thinking(s));
    return `${c.thinking("  [thinking]")}\n${contentLines.join("\n")}`;
  }

  function flushTextAccumulator(): string {
    if (!textAccumulator.trim()) {
      textAccumulator = "";
      return "";
    }
    const contentLines = formatContentLines(textAccumulator, (s) => s);
    textAccumulator = "";
    lastEmittedTextLine = "";
    return contentLines.join("\n");
  }

  function flushThinkingAccumulator(): string {
    if (!thinkingAccumulator.trim()) {
      thinkingAccumulator = "";
      return "";
    }
    const contentLines = formatContentLines(thinkingAccumulator, (s) => c.thinking(s));
    thinkingAccumulator = "";
    const label = c.thinking("  [thinking]");
    return [label, ...contentLines].join("\n");
  }

  // ─── Unknown event summarizer ────────────────────────────────────────────

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
}

/**
 * Extract the most useful display text from an event, checking all known fields.
 */
function extractEventContent(event: StreamEvent): string | undefined {
  // Check top-level string fields first
  const topText = event.thinking || event.reasoning_content || event.reasoning
    || event.result || event.content;
  if (typeof topText === "string" && topText.trim()) {
    return topText.trim();
  }

  // Check message — can be a string or an object with content[]
  if (typeof event.message === "string" && event.message.trim()) {
    return event.message.trim();
  }
  if (typeof event.message === "object" && event.message !== null) {
    const msg = event.message as { content?: ContentBlock[]; [key: string]: unknown };
    if (Array.isArray(msg.content)) {
      const parts: string[] = [];
      for (const block of msg.content) {
        const b = block as ContentBlock;
        // For tool_result blocks in user messages, extract the result text
        if (b.type === "tool_result" && typeof b.content === "string") {
          parts.push(b.content);
        } else {
          const blockText = extractBlockText(b);
          if (blockText) parts.push(blockText);
        }
      }
      if (parts.length > 0) return parts.join("\n").trim();
    }
  }

  // Check event.content as array
  if (Array.isArray(event.content)) {
    for (const block of event.content) {
      const blockText = extractBlockText(block as ContentBlock);
      if (blockText) return blockText;
    }
  }

  if (event.delta) {
    const delta = event.delta;
    if (typeof delta.text === "string" && delta.text.trim()) return delta.text.trim();
    if (typeof delta.thinking === "string" && delta.thinking.trim()) return delta.thinking.trim();
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content.trim()) return delta.reasoning_content.trim();
    if (typeof delta.partial_json === "string" && delta.partial_json.trim()) return delta.partial_json.trim();
  }
  return undefined;
}