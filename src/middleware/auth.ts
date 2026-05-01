import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import crypto from "crypto";
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

const activeSessions = new Map<string, Session>();

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
  activeSessions.set(token, {
    token,
    userId,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  });
  return token;
}

export function validateSessionToken(token: string): Session | null {
  const session = activeSessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    activeSessions.delete(token);
    return null;
  }
  return session;
}

export function revokeSessionToken(token: string): boolean {
  return activeSessions.delete(token);
}

export function getAuthPassword(): string {
  return env.AUTH_PASSWORD || process.env.AUTH_PASSWORD || "";
}

export function getOpenCodeApiKey(): string {
  return env.OPENCODE_API_KEY || process.env.OPENCODE_API_KEY || "";
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
        request.url.match(/\.(html|css|js|ico|png)$/)
      ) {
        return;
      }

      const authPassword = getAuthPassword();
      const apiKey = getOpenCodeApiKey();

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
