import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import crypto from "crypto";
import Database from "better-sqlite3";
import path from "path";
import { env } from "../config/env";

const PUBLIC_PATHS = new Set([
  "/health",
  "/auth/login",
  "/auth/status",
  "/auth/google",
  "/auth/google/callback",
  "/auth/google/status",
  "/calendar/export/ics",
  "/calendar/subscribe",
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
sessionDb.pragma("journal_mode = WAL");
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
  const provider = env.AI_PROVIDER;
  if (provider === "zai") return env.ZAI_API_KEY || "";
  if (provider === "ollama") return env.OLLAMA_API_KEY || "";
  return env.OPENCODE_API_KEY || "";
}

export function isAuthConfigured(): boolean {
  return !!getAuthPassword();
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

      if (
        request.url === "/" ||
        request.url.split("?")[0].match(/\.(html|css|js|ico|png|map)$/)
      ) {
        return;
      }

      const authPassword = getAuthPassword();
      const apiKey = getApiKeyForAuth();

      if (!authPassword && !apiKey) {
        return;
      }

      const authHeader = request.headers["authorization"];
      const token =
        authHeader?.replace("Bearer ", "") ||
        (request.headers["x-api-key"] as string | undefined) ||
        (request.query as Record<string, string>).apiKey;

      if (!token) {
        return reply.code(401).send({
          error: "Authentication required",
          message: "Provide Authorization: Bearer <token> or X-API-Key header.",
        });
      }

      const session = validateSessionToken(token);
      if (session) {
        request.userId = session.userId;
        return;
      }

      if (apiKey && timingSafeEqual(token, apiKey)) {
        request.userId = "api-key-user";
        return;
      }

      return reply.code(403).send({
        error: "Forbidden",
        message: "Invalid or expired credentials.",
      });
    },
  );
}
