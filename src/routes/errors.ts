import { FastifyInstance } from "fastify";
import { z } from "zod";
import { errorLog, ErrorLogEntry, ErrorSeverity } from "../observability/error-log";
import { agentRunDatabase, AgentRunDatabase } from "../agent-runs/database";

const querySchema = z.object({
  severity: z.enum(["info", "warn", "error", "critical"]).optional(),
  source: z.string().optional(),
  category: z.string().optional(),
  sessionId: z.string().optional(),
  runId: z.string().optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export interface ErrorsRouteOptions {
  database?: AgentRunDatabase;
  log?: {
    query(params: {
      severity?: ErrorSeverity;
      source?: string;
      category?: string;
      sessionId?: string;
      runId?: string;
      startTime?: Date;
      endTime?: Date;
      limit?: number;
    }): Promise<ErrorLogEntry[]>;
  };
}

function classifyAgentRunError(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("model not found")) return "model_not_found";
  if (lower.includes("messages parameter is illegal")) return "provider_message_payload";
  if (lower.includes("timed out") || lower.includes("stale")) return "timeout";
  if (lower.includes("no fin signal")) return "agent_exit";
  if (lower.includes("output validation failed")) return "output_validation";
  return "agent_run_failed";
}

function severityRank(severity: ErrorSeverity): number {
  return { info: 0, warn: 1, error: 2, critical: 3 }[severity];
}

function agentRunEntry(run: ReturnType<AgentRunDatabase["listRuns"]>["runs"][number]): ErrorLogEntry {
  const message = run.errorMessage || "Agent run failed";
  return {
    id: `agent-run:${run.id}`,
    timestamp: run.completedAt || run.lastActivityAt || run.startedAt,
    severity: "error",
    source: "agent_runs",
    category: classifyAgentRunError(message),
    message,
    fingerprint: `agent-run:${classifyAgentRunError(message)}`,
    userId: run.userId,
    sessionId: run.sessionId,
    runId: run.id,
    context: {
      provider: run.provider,
      model: run.model,
      mode: run.mode,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
    },
  };
}

function summarize(entries: ErrorLogEntry[]) {
  const groups = new Map<string, {
    fingerprint: string;
    severity: ErrorSeverity;
    source: string;
    category: string;
    message: string;
    count: number;
    latestAt: string;
    latestId: string;
  }>();

  for (const entry of entries) {
    const key = `${entry.source}:${entry.category}:${entry.fingerprint}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        fingerprint: entry.fingerprint,
        severity: entry.severity,
        source: entry.source,
        category: entry.category,
        message: entry.message,
        count: 1,
        latestAt: entry.timestamp,
        latestId: entry.id,
      });
      continue;
    }
    existing.count++;
    if (new Date(entry.timestamp) > new Date(existing.latestAt)) {
      existing.latestAt = entry.timestamp;
      existing.latestId = entry.id;
      existing.message = entry.message;
    }
    if (severityRank(entry.severity) > severityRank(existing.severity)) {
      existing.severity = entry.severity;
    }
  }

  return Array.from(groups.values()).sort(
    (a, b) => new Date(b.latestAt).getTime() - new Date(a.latestAt).getTime(),
  );
}

export async function errorsRoutes(fastify: FastifyInstance, options?: ErrorsRouteOptions) {
  const db = options?.database || agentRunDatabase;
  const log = options?.log || errorLog;

  fastify.get("/errors", async (request, reply) => {
    if (!request.userId) {
      return reply.code(401).send({ error: "Authentication required" });
    }

    const query = querySchema.parse(request.query);
    const startTime = query.since ? new Date(query.since) : undefined;
    const endTime = query.until ? new Date(query.until) : undefined;

    const structured = await log.query({
      severity: query.severity,
      source: query.source,
      category: query.category,
      sessionId: query.sessionId,
      runId: query.runId,
      startTime,
      endTime,
      limit: query.limit,
    });

    const includeAgentRuns = !query.source || query.source === "agent_runs";
    const failedRuns = includeAgentRuns
      ? db.listRuns({ status: "failed", limit: query.limit }).runs
        .map(agentRunEntry)
        .filter((entry) => {
          if (query.severity && severityRank(entry.severity) < severityRank(query.severity)) return false;
          if (query.category && entry.category !== query.category) return false;
          if (query.sessionId && entry.sessionId !== query.sessionId) return false;
          if (query.runId && entry.runId !== query.runId) return false;
          const timestamp = new Date(entry.timestamp);
          if (startTime && timestamp < startTime) return false;
          if (endTime && timestamp > endTime) return false;
          return true;
        })
      : [];

    const items = [...structured, ...failedRuns]
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, query.limit);

    return {
      items,
      summary: summarize(items),
      total: items.length,
    };
  });

  fastify.get("/errors/summary", async (request, reply) => {
    if (!request.userId) {
      return reply.code(401).send({ error: "Authentication required" });
    }

    const query = querySchema.parse(request.query);
    const startTime = query.since ? new Date(query.since) : undefined;
    const endTime = query.until ? new Date(query.until) : undefined;
    const structured = await log.query({
      severity: query.severity,
      source: query.source,
      category: query.category,
      sessionId: query.sessionId,
      runId: query.runId,
      startTime,
      endTime,
      limit: query.limit,
    });
    const includeAgentRuns = !query.source || query.source === "agent_runs";
    const failedRuns = includeAgentRuns
      ? db.listRuns({ status: "failed", limit: query.limit }).runs.map(agentRunEntry)
      : [];
    return { summary: summarize([...structured, ...failedRuns]) };
  });
}
