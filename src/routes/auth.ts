import { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../config/env";
import {
  createSessionToken,
  revokeSessionToken,
  isAuthConfigured,
  getAuthPassword,
  validateSessionToken,
} from "../middleware/auth";
import { timingSafeEqual } from "../middleware/auth";

const loginSchema = z.object({
  username: z.string(),
  password: z.string(),
});

export async function authRoutes(fastify: FastifyInstance) {
  fastify.post("/auth/login", async (request, reply) => {
    if (!isAuthConfigured()) {
      reply.code(503);
      return {
        error: "Authentication not configured",
        message:
          "Set AUTH_USERNAME and AUTH_PASSWORD environment variables to enable authentication.",
      };
    }

    try {
      const body = loginSchema.parse(request.body);

      if (
        !timingSafeEqual(
          body.username,
          env.AUTH_USERNAME || process.env.AUTH_USERNAME || "admin",
        )
      ) {
        reply.code(401);
        return { error: "Invalid credentials" };
      }

      if (!timingSafeEqual(body.password, getAuthPassword())) {
        reply.code(401);
        return { error: "Invalid credentials" };
      }

      const token = createSessionToken(body.username);

      return {
        success: true,
        token,
        userId: body.username,
        expiresIn: 86400,
      };
    } catch (error) {
      reply.code(400);
      return {
        error: "Invalid request",
        message: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  fastify.post("/auth/logout", async (request, _reply) => {
    const authHeader = request.headers["authorization"];
    const token =
      authHeader?.replace("Bearer ", "") ||
      (request.headers["x-api-key"] as string | undefined);

    if (token) {
      revokeSessionToken(token);
    }

    return { success: true, message: "Logged out" };
  });

  fastify.get("/auth/status", async (_request, _reply) => {
    return {
      configured: isAuthConfigured(),
      method: isAuthConfigured() ? "credentials" : "none",
    };
  });

  fastify.get("/auth/verify", async (request, reply) => {
    if (!isAuthConfigured()) {
      return { valid: true, method: "none" };
    }

    const authHeader = request.headers["authorization"];
    const token =
      authHeader?.replace("Bearer ", "") ||
      (request.headers["x-api-key"] as string | undefined);

    if (!token) {
      reply.code(401);
      return { valid: false, error: "No token provided" };
    }

    const session = validateSessionToken(token);
    if (!session) {
      reply.code(401);
      return { valid: false, error: "Invalid or expired token" };
    }

    return { valid: true, userId: session.userId };
  });
}
