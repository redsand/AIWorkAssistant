import { appendFile, mkdir, readFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { randomUUID, createHash } from "crypto";
import { env } from "../config/env";

export type ErrorSeverity = "info" | "warn" | "error" | "critical";

export interface ErrorLogEntry {
  id: string;
  timestamp: string;
  severity: ErrorSeverity;
  source: string;
  category: string;
  message: string;
  fingerprint: string;
  stack?: string;
  userId?: string;
  sessionId?: string | null;
  runId?: string | null;
  context?: Record<string, unknown>;
}

export interface ErrorLogInput {
  severity?: ErrorSeverity;
  source: string;
  category: string;
  message: string;
  error?: unknown;
  userId?: string;
  sessionId?: string | null;
  runId?: string | null;
  context?: Record<string, unknown>;
}

export interface ErrorLogQuery {
  severity?: ErrorSeverity;
  source?: string;
  category?: string;
  sessionId?: string;
  runId?: string;
  startTime?: Date;
  endTime?: Date;
  limit?: number;
}

const SEVERITY_ORDER: Record<ErrorSeverity, number> = {
  info: 0,
  warn: 1,
  error: 2,
  critical: 3,
};

function errorMessage(error: unknown): string | undefined {
  if (!error) return undefined;
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function errorStack(error: unknown): string | undefined {
  return error instanceof Error ? error.stack : undefined;
}

function fingerprintFor(source: string, category: string, message: string): string {
  const normalized = message
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "<uuid>")
    .replace(/\b\d+\b/g, "<n>")
    .slice(0, 500);
  return createHash("sha256")
    .update(`${source}:${category}:${normalized}`)
    .digest("hex")
    .slice(0, 16);
}

class ErrorLog {
  private readonly logFile = env.ERROR_LOG_FILE;

  async log(input: ErrorLogInput): Promise<ErrorLogEntry> {
    const message = input.message || errorMessage(input.error) || "Unknown error";
    const entry: ErrorLogEntry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      severity: input.severity ?? "error",
      source: input.source,
      category: input.category,
      message,
      fingerprint: fingerprintFor(input.source, input.category, message),
      stack: errorStack(input.error),
      userId: input.userId,
      sessionId: input.sessionId,
      runId: input.runId,
      context: input.context,
    };

    try {
      await mkdir(path.dirname(this.logFile), { recursive: true });
      await appendFile(this.logFile, `${JSON.stringify(entry)}\n`, "utf-8");
    } catch (error) {
      console.error("[ErrorLog] Failed to write error log:", error);
    }

    return entry;
  }

  async query(query: ErrorLogQuery = {}): Promise<ErrorLogEntry[]> {
    if (!existsSync(this.logFile)) return [];

    let content: string;
    try {
      content = await readFile(this.logFile, "utf-8");
    } catch {
      return [];
    }

    const minSeverity = query.severity
      ? SEVERITY_ORDER[query.severity]
      : SEVERITY_ORDER.info;
    const entries: ErrorLogEntry[] = [];

    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      let entry: ErrorLogEntry;
      try {
        entry = JSON.parse(line) as ErrorLogEntry;
      } catch {
        continue;
      }

      if ((SEVERITY_ORDER[entry.severity] ?? 0) < minSeverity) continue;
      if (query.source && entry.source !== query.source) continue;
      if (query.category && entry.category !== query.category) continue;
      if (query.sessionId && entry.sessionId !== query.sessionId) continue;
      if (query.runId && entry.runId !== query.runId) continue;

      const timestamp = new Date(entry.timestamp);
      if (query.startTime && timestamp < query.startTime) continue;
      if (query.endTime && timestamp > query.endTime) continue;

      entries.push(entry);
    }

    entries.sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );

    return entries.slice(0, query.limit ?? 100);
  }
}

export const errorLog = new ErrorLog();
