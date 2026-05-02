/**
 * Audit logger: records all actions, decisions, approvals, and executions
 */

import { appendFile, readFile } from "fs/promises";
import { existsSync } from "fs";
import { AuditEntry } from "../policy/types";
import { env } from "../config/env";

const SEVERITY_ORDER: Record<string, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

class AuditLogger {
  private logFile: string;

  constructor() {
    this.logFile = env.AUDIT_LOG_FILE;
  }

  async log(entry: AuditEntry): Promise<void> {
    const logLine = JSON.stringify(entry) + "\n";

    try {
      await appendFile(this.logFile, logLine);
    } catch (error) {
      console.error("Failed to write audit log:", error);
    }

    if (env.NODE_ENV === "development") {
      const emoji = this.getEmoji(entry.severity);
      console.log(`${emoji} [AUDIT] ${entry.action} - ${entry.actor}`);
    }
  }

  private getEmoji(severity: AuditEntry["severity"]): string {
    switch (severity) {
      case "debug":
        return "🔍";
      case "info":
        return "ℹ️";
      case "warn":
        return "⚠️";
      case "error":
        return "❌";
      default:
        return "📝";
    }
  }

  async query(filter: {
    action?: string;
    actor?: string;
    startTime?: Date;
    endTime?: Date;
    severity?: AuditEntry["severity"];
    limit?: number;
  }): Promise<AuditEntry[]> {
    if (!existsSync(this.logFile)) {
      return [];
    }

    let content: string;
    try {
      content = await readFile(this.logFile, "utf-8");
    } catch {
      return [];
    }

    const minSeverity = filter.severity
      ? (SEVERITY_ORDER[filter.severity] ?? 0)
      : 0;

    const entries: AuditEntry[] = [];
    const lines = content.split("\n");

    for (const line of lines) {
      if (!line.trim()) continue;

      let entry: AuditEntry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      if (filter.action && entry.action !== filter.action) continue;
      if (filter.actor && entry.actor !== filter.actor) continue;

      const ts = new Date(entry.timestamp);
      if (filter.startTime && ts < filter.startTime) continue;
      if (filter.endTime && ts > filter.endTime) continue;

      if (
        filter.severity &&
        (SEVERITY_ORDER[entry.severity] ?? 0) < minSeverity
      )
        continue;

      entries.push(entry);
    }

    entries.sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );

    return entries.slice(0, filter.limit ?? 100);
  }
}

export const auditLogger = new AuditLogger();
