/**
 * Audit logger: records all actions, decisions, approvals, and executions
 */

import { createWriteStream } from 'fs';
import { appendFile } from 'fs/promises';
import { AuditEntry } from '../policy/types';
import { env } from '../config/env';

class AuditLogger {
  private logFile: string;

  constructor() {
    this.logFile = env.AUDIT_LOG_FILE;
  }

  /**
   * Log an audit entry
   */
  async log(entry: AuditEntry): Promise<void> {
    const logLine = JSON.stringify(entry) + '\n';

    // Write to file
    try {
      await appendFile(this.logFile, logLine);
    } catch (error) {
      console.error('Failed to write audit log:', error);
    }

    // Also log to console in development
    if (env.NODE_ENV === 'development') {
      const emoji = this.getEmoji(entry.severity);
      console.log(`${emoji} [AUDIT] ${entry.action} - ${entry.actor}`);
    }
  }

  /**
   * Get emoji for severity level
   */
  private getEmoji(severity: AuditEntry['severity']): string {
    switch (severity) {
      case 'debug':
        return '🔍';
      case 'info':
        return 'ℹ️';
      case 'warn':
        return '⚠️';
      case 'error':
        return '❌';
      default:
        return '📝';
    }
  }

  /**
   * Query audit logs (stub for future implementation)
   * TODO: Implement proper log querying with database
   */
  async query(filter: {
    action?: string;
    actor?: string;
    startTime?: Date;
    endTime?: Date;
    severity?: AuditEntry['severity'];
    limit?: number;
  }): Promise<AuditEntry[]> {
    // Stub: Return empty array for now
    // In production, this would query a database or indexed log file
    return [];
  }
}

export const auditLogger = new AuditLogger();
