import { FastifyInstance } from "fastify";
import { dailyPlanner } from "../productivity/daily-planner";
import { focusBlocks } from "../productivity/focus-blocks";
import { healthBreaks } from "../productivity/health-breaks";
import { fileCalendarService } from "../integrations/file/calendar-service";

export async function productivityRoutes(fastify: FastifyInstance) {
  fastify.get("/productivity/daily-plan", async (request, _reply) => {
    const { date, userId } = request.query as {
      date?: string;
      userId?: string;
    };

    const planDate = date ? new Date(date) : new Date();
    const plan = await dailyPlanner.generatePlan(planDate, userId || "user");

    return { success: true, plan };
  });

  fastify.get(
    "/productivity/focus-blocks/recommend",
    async (request, _reply) => {
      const { date, userId } = request.query as {
        date?: string;
        userId?: string;
      };

      const recDate = date ? new Date(date) : new Date();
      const recommendations = await focusBlocks.recommendFocusBlocks(
        recDate,
        userId || "user",
      );

      return { success: true, recommendations };
    },
  );

  fastify.post("/productivity/focus-blocks", async (request, _reply) => {
    const body = request.body as {
      title: string;
      startTime: string;
      duration: number;
      description?: string;
      userId?: string;
    };

    const event = await focusBlocks.createFocusBlock(
      {
        title: body.title,
        startTime: new Date(body.startTime),
        duration: body.duration,
        description: body.description,
      },
      body.userId || "user",
    );

    return { success: true, event };
  });

  fastify.get(
    "/productivity/health-breaks/recommend",
    async (request, _reply) => {
      const { date, userId } = request.query as {
        date?: string;
        userId?: string;
      };

      const recDate = date ? new Date(date) : new Date();
      const recommendations = await healthBreaks.recommendBreaks(
        recDate,
        userId || "user",
      );

      return { success: true, recommendations };
    },
  );

  fastify.post("/productivity/health-blocks", async (request, _reply) => {
    const body = request.body as {
      title: string;
      startTime: string;
      duration: number;
      type: "fitness" | "meal" | "mental_health";
      userId?: string;
    };

    const event = await healthBreaks.createHealthBlock(
      {
        title: body.title,
        startTime: new Date(body.startTime),
        duration: body.duration,
        type: body.type,
      },
      body.userId || "user",
    );

    return { success: true, event };
  });

  fastify.get("/productivity/calendar-summary", async (_request, _reply) => {
    const stats = fileCalendarService.getStats();
    return { success: true, stats };
  });
}
