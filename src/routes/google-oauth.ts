/**
 * Google OAuth2 Routes
 * Handles OAuth2 authorization flow for Google Calendar
 */

import { FastifyInstance } from "fastify";
import { googleCalendarClient } from "../integrations/google/calendar-client";

export async function googleOAuthRoutes(fastify: FastifyInstance) {
  /**
   * Check if user needs to authorize Google Calendar
   */
  fastify.get("/auth/google/status", async (_request, reply) => {
    try {
      const needsAuth = googleCalendarClient.needsAuthorization();

      return {
        success: true,
        authenticated: !needsAuth,
        needsAuthorization: needsAuth,
        message: needsAuth
          ? "Authorization required. Visit /auth/google to authorize."
          : "Google Calendar is authorized and ready.",
      };
    } catch (error) {
      reply.code(500);
      return {
        success: false,
        error: "Failed to check authorization status",
      };
    }
  });

  /**
   * Start Google OAuth2 flow
   */
  fastify.get("/auth/google", async (_request, reply) => {
    try {
      const authUrl = googleCalendarClient.getAuthorizationUrl();

      return {
        success: true,
        message: "Click the link below to authorize Google Calendar access:",
        authorizationUrl: authUrl,
        instructions: [
          "1. Click the authorization link above",
          "2. Sign in to your Google account",
          "3. Grant permission to access your calendar",
          "4. You will be redirected back to this app",
          "5. Your calendar will be ready to use!",
        ],
      };
    } catch (error) {
      reply.code(500);
      return {
        success: false,
        error: "Failed to generate authorization URL",
      };
    }
  });

  /**
   * Handle Google OAuth2 callback
   */
  fastify.get("/auth/google/callback", async (request, reply) => {
    try {
      const {
        code,
        state: _state,
        error,
      } = request.query as {
        code?: string;
        state?: string;
        error?: string;
      };

      // Handle authorization denial
      if (error) {
        return {
          success: false,
          error: "Authorization denied",
          message:
            "You denied access to Google Calendar. Please try again and grant permission.",
        };
      }

      // Handle missing authorization code
      if (!code) {
        return {
          success: false,
          error: "Missing authorization code",
          message: "Authorization failed. Please try again.",
        };
      }

      // Exchange code for tokens
      await googleCalendarClient.exchangeCodeForTokens(code);

      return {
        success: true,
        message: "🎉 Google Calendar authorization successful!",
        details: {
          calendar: "Ready to use",
          features: [
            "✅ View and create calendar events",
            "✅ Create focus blocks for deep work",
            "✅ Schedule health and wellness breaks",
            "✅ Generate daily plans with calendar integration",
            "✅ Syncs with your iPhone Calendar app",
          ],
        },
        nextSteps: [
          "Your Google Calendar is now connected!",
          'Try: "Help me plan my day" to see calendar integration',
          'Try: "Create a focus block for 2 hours" to schedule deep work',
          "All events will appear in your iPhone Calendar app",
        ],
      };
    } catch (error) {
      reply.code(500);
      return {
        success: false,
        error: "Failed to complete authorization",
        message: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  /**
   * Clear authorization (logout)
   */
  fastify.post("/auth/google/logout", async (_request, reply) => {
    try {
      // Clear tokens
      const { googleOAuthManager } =
        await import("../integrations/google/oauth-manager.js");
      googleOAuthManager.clearTokens();

      return {
        success: true,
        message:
          "Google Calendar authorization cleared. You can authorize again if needed.",
      };
    } catch (error) {
      reply.code(500);
      return {
        success: false,
        error: "Failed to clear authorization",
      };
    }
  });
}
