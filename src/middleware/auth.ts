import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import crypto from "crypto";
import Database from "better-sqlite3";
import path from "path";
import { env } from "../config/env";
import { applyWalHygiene } from "../util/sqlite-hygiene";

const PUBLIC_PATHS = new Set([
  "/health",
  "/auth/login",
  "/auth/status",
  "/auth/google",
  "/auth/google/callback",
  "/auth/google/status",
  "/calendar/export/ics",
  "/calendar/subscribe",
  "/capabilities",
  "/musician",
  "/kanban",
  // Kanban board view — read-only display, no sensitive config
  "/api/kanban/board",
  "/api/kanban/stream",
  "/api/kanban/agents",
  "/api/tools",
  "/api/tools/categories",
  "/api/agents",
  "/api/push-vapid-key",
  "/acknowledge",
  "/manifest.json",
  // ClaimKit comparison dashboard — read-only stats, no sensitive config
  "/comparison",
  // Repository issue dashboard — HTML shell, data fetched via protected APIs
  "/dashboard",
  // Calibration eval dashboard — local dev tool
  "/eval",
  // Auto Runners management — HTML shell, data fetched via protected APIs
  "/runners",
]);

const SESSION_TOKEN_BYTES = 32;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

interface Session {
  token: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
}

// SQLite-backed session store — survives server restarts
const DB_PATH = path.join(process.cwd(), "data", "app.db");
const sessionDb = new Database(DB_PATH);
applyWalHygiene(sessionDb, { label: "auth-sessions" });
sessionDb.exec(`
  CREATE TABLE IF NOT EXISTS auth_sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )
`);
const stmtInsert = sessionDb.prepare(
  "INSERT INTO auth_sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
);
const stmtGet = sessionDb.prepare(
  "SELECT token, user_id, created_at, expires_at FROM auth_sessions WHERE token = ? AND expires_at > ?",
);
const stmtDelete = sessionDb.prepare(
  "DELETE FROM auth_sessions WHERE token = ?",
);
const stmtCleanExpired = sessionDb.prepare(
  "DELETE FROM auth_sessions WHERE expires_at <= ?",
);

// Clean expired sessions on startup
stmtCleanExpired.run(Date.now());

export function timingSafeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") {
    return false;
  }
  const bufA = Buffer.from(a, "utf-8");
  const bufB = Buffer.from(b, "utf-8");
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export function createSessionToken(userId: string): string {
  const token = crypto.randomBytes(SESSION_TOKEN_BYTES).toString("hex");
  const now = Date.now();
  stmtInsert.run(token, userId, now, now + SESSION_TTL_MS);
  return token;
}

export function validateSessionToken(token: string): Session | null {
  const row = stmtGet.get(token, Date.now()) as
    | {
        token: string;
        user_id: string;
        created_at: number;
        expires_at: number;
      }
    | undefined;
  if (!row) return null;
  return {
    token: row.token,
    userId: row.user_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export function revokeSessionToken(token: string): boolean {
  const result = stmtDelete.run(token);
  return result.changes > 0;
}

export function getAuthPassword(): string {
  return env.AUTH_PASSWORD || process.env.AUTH_PASSWORD || "";
}

export function getApiKeyForAuth(): string {
  // Dedicated loop key takes priority — used by aicoder + reviewer
  if (env.AIWORKASSISTANT_API_KEY) return env.AIWORKASSISTANT_API_KEY;
  const provider = process.env.AI_PROVIDER || env.AI_PROVIDER;
  if (provider === "zai") return env.ZAI_API_KEY || "";
  if (provider === "ollama") return env.OLLAMA_API_KEY || "";
  return env.OPENCODE_API_KEY || "";
}

export function isAuthConfigured(): boolean {
  return !!getAuthPassword();
}

/**
 * Verify credentials on a single request. Returns true if the request may
 * proceed; otherwise sends a 401/403 response and returns false. When neither
 * a password nor an API key is configured, the server runs unprotected and the
 * request is allowed through.
 *
 * Shared by the global onRequest hook and the per-route {@link requireAuth}
 * guard so both enforce identical credential checks.
 */
export function verifyRequestAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): boolean {
  const authPassword = getAuthPassword();
  const apiKey = getApiKeyForAuth();

  if (!authPassword && !apiKey) {
    return true;
  }

  const authHeader = request.headers["authorization"];
  const token =
    authHeader?.replace("Bearer ", "") ||
    (request.headers["x-api-key"] as string | undefined) ||
    (request.query as Record<string, string>).apiKey;

  if (!token) {
    reply.code(401).send({
      error: "Authentication required",
      message: "Provide Authorization: Bearer <token> or X-API-Key header.",
    });
    return false;
  }

  const session = validateSessionToken(token);
  if (session) {
    request.userId = session.userId;
    return true;
  }

  if (apiKey && timingSafeEqual(token, apiKey)) {
    request.userId = "api-key-user";
    return true;
  }

  reply.code(403).send({
    error: "Forbidden",
    message: "Invalid or expired credentials.",
  });
  return false;
}

/**
 * Per-route guard that enforces authentication on sensitive endpoints
 * regardless of the global middleware's path exemptions. Use on routes that
 * trigger side effects (e.g. external syncs) so the guard is explicit at the
 * route definition. Call as `if (!requireAuth(request, reply)) return;` at
 * the top of a handler — the boolean return is load-bearing.
 */
export function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): boolean {
  return verifyRequestAuth(request, reply);
}

/**
 * Adapts {@link requireAuth} to Fastify's `preHandler` hook shape, which
 * only inspects `reply.sent` to decide whether to short-circuit and doesn't
 * accept a boolean return value.
 */
export async function authPreHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  requireAuth(request, reply);
}

export async function authMiddleware(fastify: FastifyInstance) {
  fastify.addHook(
    "onRequest",
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (PUBLIC_PATHS.has(request.url.split("?")[0])) {
        return;
      }

      if (request.url.startsWith("/webhooks/")) {
        return;
      }

      if (request.url.startsWith("/api/comparison")) {
        return;
      }

      if (request.url.startsWith("/api/eval-calibration")) {
        return;
      }


      if (
        request.url === "/" ||
        request.url.split("?")[0].match(/\.(html|css|js|ico|png|map)$/)
      ) {
        return;
      }

      verifyRequestAuth(request, reply);
    },
  );
}
