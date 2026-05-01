/**
 * Roadmap REST API Endpoints
 * Provides REST API for roadmap management operations
 */

import { FastifyInstance } from "fastify";
import { roadmapDatabase } from "./database";
import { z } from "zod";

// Validation schemas
const createRoadmapSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["client", "internal"]),
  status: z.enum(["draft", "active", "completed", "archived"]).default("draft"),
  startDate: z.string(),
  endDate: z.string().nullable().optional().default(null),
  jiraProjectKey: z.string().nullable().optional().default(null),
  jiraProjectId: z.string().nullable().optional().default(null),
  description: z.string().nullable().optional().default(null),
  metadata: z.string().nullable().optional().default(null),
});

const createMilestoneSchema = z.object({
  roadmapId: z.string().uuid(),
  name: z.string().min(1),
  description: z.string().nullable(),
  targetDate: z.string(),
  status: z
    .enum(["pending", "in_progress", "completed", "blocked"])
    .default("pending"),
  order: z.number().int().min(0),
  jiraEpicKey: z.string().nullable(),
});

const createItemSchema = z.object({
  milestoneId: z.string().uuid(),
  title: z.string().min(1),
  description: z.string().nullable(),
  type: z.enum(["feature", "task", "bug", "technical_debt", "research"]),
  status: z.enum(["todo", "in_progress", "done", "blocked"]).default("todo"),
  priority: z.enum(["low", "medium", "high", "critical"]).default("medium"),
  estimatedHours: z.number().nonnegative().nullable(),
  actualHours: z.number().nonnegative().nullable(),
  assignee: z.string().nullable(),
  jiraKey: z.string().nullable(),
  order: z.number().int().min(0),
});

export async function roadmapRoutes(fastify: FastifyInstance) {
  // Health check
  fastify.get("/roadmap/health", async (_request, _reply) => {
    return {
      status: "ok",
      timestamp: new Date().toISOString(),
    };
  });

  // === Roadmap Endpoints ===

  // List all roadmaps
  fastify.get("/roadmaps", async (request, reply) => {
    try {
      const { type, status } = request.query as {
        type?: string;
        status?: string;
      };

      const roadmaps = roadmapDatabase.listRoadmaps({
        type: type as "client" | "internal" | undefined,
        status,
      });

      return {
        success: true,
        roadmaps,
        count: roadmaps.length,
      };
    } catch (error) {
      reply.code(500);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  // Get single roadmap with milestones and items
  fastify.get("/roadmaps/:id", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };

      const roadmap = roadmapDatabase.getRoadmap(id);

      if (!roadmap) {
        reply.code(404);
        return {
          success: false,
          error: "Roadmap not found",
        };
      }

      // Get milestones and items for this roadmap
      const milestones = roadmapDatabase.getMilestones(id);
      const roadmapWithDetails = {
        ...roadmap,
        milestones: milestones.map((milestone) => ({
          ...milestone,
          items: roadmapDatabase.getItems(milestone.id),
        })),
      };

      return {
        success: true,
        roadmap: roadmapWithDetails,
      };
    } catch (error) {
      reply.code(500);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  // Create roadmap
  fastify.post("/roadmaps", async (request, reply) => {
    try {
      const body = createRoadmapSchema.parse(request.body);

      const roadmap = roadmapDatabase.createRoadmap(body);

      reply.code(201);
      return {
        success: true,
        roadmap,
      };
    } catch (error) {
      if (error instanceof z.ZodError) {
        reply.code(400);
        return {
          success: false,
          error: "Validation error",
          details: error.errors,
        };
      }

      reply.code(500);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  // Update roadmap
  fastify.patch("/roadmaps/:id", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = request.body as Partial<z.infer<typeof createRoadmapSchema>>;

      const roadmap = roadmapDatabase.updateRoadmap(id, body);

      if (!roadmap) {
        reply.code(404);
        return {
          success: false,
          error: "Roadmap not found",
        };
      }

      return {
        success: true,
        roadmap,
      };
    } catch (error) {
      reply.code(500);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  // Delete roadmap
  fastify.delete("/roadmaps/:id", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };

      const deleted = roadmapDatabase.deleteRoadmap(id);

      if (!deleted) {
        reply.code(404);
        return {
          success: false,
          error: "Roadmap not found",
        };
      }

      return {
        success: true,
        message: "Roadmap deleted successfully",
      };
    } catch (error) {
      reply.code(500);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  // === Milestone Endpoints ===

  // Get milestones for roadmap
  fastify.get("/roadmaps/:roadmapId/milestones", async (request, reply) => {
    try {
      const { roadmapId } = request.params as { roadmapId: string };

      const milestones = roadmapDatabase.getMilestones(roadmapId);

      return {
        success: true,
        milestones,
        count: milestones.length,
      };
    } catch (error) {
      reply.code(500);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  // Create milestone
  fastify.post("/milestones", async (request, reply) => {
    try {
      const body = createMilestoneSchema.parse(request.body);

      const milestone = roadmapDatabase.createMilestone(body);

      reply.code(201);
      return {
        success: true,
        milestone,
      };
    } catch (error) {
      if (error instanceof z.ZodError) {
        reply.code(400);
        return {
          success: false,
          error: "Validation error",
          details: error.errors,
        };
      }

      reply.code(500);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  // Update milestone
  fastify.patch("/milestones/:id", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = request.body as Partial<
        z.infer<typeof createMilestoneSchema>
      >;

      const milestone = roadmapDatabase.updateMilestone(id, body);

      if (!milestone) {
        reply.code(404);
        return {
          success: false,
          error: "Milestone not found",
        };
      }

      return {
        success: true,
        milestone,
      };
    } catch (error) {
      reply.code(500);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  // Delete milestone
  fastify.delete("/milestones/:id", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };

      const deleted = roadmapDatabase.deleteMilestone(id);

      if (!deleted) {
        reply.code(404);
        return {
          success: false,
          error: "Milestone not found",
        };
      }

      return {
        success: true,
        message: "Milestone deleted successfully",
      };
    } catch (error) {
      reply.code(500);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  // === Roadmap Item Endpoints ===

  // Get items for milestone
  fastify.get("/milestones/:milestoneId/items", async (request, reply) => {
    try {
      const { milestoneId } = request.params as { milestoneId: string };

      const items = roadmapDatabase.getItems(milestoneId);

      return {
        success: true,
        items,
        count: items.length,
      };
    } catch (error) {
      reply.code(500);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  // Create item
  fastify.post("/items", async (request, reply) => {
    try {
      const body = createItemSchema.parse(request.body);

      const item = roadmapDatabase.createItem(body);

      reply.code(201);
      return {
        success: true,
        item,
      };
    } catch (error) {
      if (error instanceof z.ZodError) {
        reply.code(400);
        return {
          success: false,
          error: "Validation error",
          details: error.errors,
        };
      }

      reply.code(500);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  // Update item
  fastify.patch("/items/:id", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = request.body as Partial<z.infer<typeof createItemSchema>>;

      const item = roadmapDatabase.updateItem(id, body);

      if (!item) {
        reply.code(404);
        return {
          success: false,
          error: "Item not found",
        };
      }

      return {
        success: true,
        item,
      };
    } catch (error) {
      reply.code(500);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  // Delete item
  fastify.delete("/items/:id", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };

      const deleted = roadmapDatabase.deleteItem(id);

      if (!deleted) {
        reply.code(404);
        return {
          success: false,
          error: "Item not found",
        };
      }

      return {
        success: true,
        message: "Item deleted successfully",
      };
    } catch (error) {
      reply.code(500);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  // === Template Endpoints ===

  // List all templates
  fastify.get("/templates", async (request, reply) => {
    try {
      const { type, category } = request.query as {
        type?: string;
        category?: string;
      };

      const templates = roadmapDatabase.listTemplates({
        type: type as "client" | "internal" | undefined,
        category,
      });

      // Parse JSON fields
      const parsedTemplates = templates.map((template) => ({
        ...template,
        milestones: JSON.parse(template.milestones),
        items: JSON.parse(template.items),
      }));

      return {
        success: true,
        templates: parsedTemplates,
        count: parsedTemplates.length,
      };
    } catch (error) {
      reply.code(500);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  // Get single template
  fastify.get("/templates/:id", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };

      const template = roadmapDatabase.getTemplate(id);

      if (!template) {
        reply.code(404);
        return {
          success: false,
          error: "Template not found",
        };
      }

      // Parse JSON fields
      const parsedTemplate = {
        ...template,
        milestones: JSON.parse(template.milestones),
        items: JSON.parse(template.items),
      };

      return {
        success: true,
        template: parsedTemplate,
      };
    } catch (error) {
      reply.code(500);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  // Create roadmap from template
  fastify.post("/templates/:id/create-roadmap", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const { name, startDate, jiraProjectKey, jiraProjectId, description } =
        request.body as {
          name: string;
          startDate: string;
          jiraProjectKey?: string;
          jiraProjectId?: string;
          description?: string;
        };

      const template = roadmapDatabase.getTemplate(id);

      if (!template) {
        reply.code(404);
        return {
          success: false,
          error: "Template not found",
        };
      }

      // Parse template data
      const templateMilestones = JSON.parse(template.milestones);
      const templateItems = JSON.parse(template.items);

      // Calculate dates based on template
      const startDateObj = new Date(startDate);
      const milestonesData = templateMilestones.map((m: any) => {
        const targetDate = new Date(startDateObj);
        targetDate.setDate(targetDate.getDate() + m.targetDaysFromStart);
        return {
          ...m,
          targetDate: targetDate.toISOString(),
        };
      });

      // Create roadmap
      const roadmap = roadmapDatabase.createRoadmap({
        name,
        type: template.type,
        status: "active",
        startDate,
        endDate: null,
        jiraProjectKey: jiraProjectKey || null,
        jiraProjectId: jiraProjectId || null,
        description: description || null,
        metadata: JSON.stringify({ templateId: id }),
      });

      // Create milestones
      const createdMilestones = milestonesData.map((m: any) => {
        return roadmapDatabase.createMilestone({
          roadmapId: roadmap.id,
          name: m.name,
          description: m.description,
          targetDate: m.targetDate,
          status: "pending",
          order: m.order,
          jiraEpicKey: null,
        });
      });

      // Create items
      const createdItems = templateItems.map((item: any) => {
        const milestone = createdMilestones[item.milestoneIndex];
        return roadmapDatabase.createItem({
          milestoneId: milestone.id,
          title: item.title,
          description: item.description,
          type: item.type,
          status: "todo",
          priority: item.priority,
          estimatedHours: item.estimatedHours,
          actualHours: null,
          assignee: null,
          jiraKey: null,
          order: item.order,
        });
      });

      reply.code(201);
      return {
        success: true,
        roadmap: {
          ...roadmap,
          milestones: createdMilestones.map((m: any) => ({
            ...m,
            items: createdItems.filter((i: any) => i.milestoneId === m.id),
          })),
        },
      };
    } catch (error) {
      reply.code(500);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  console.log("[RoadmapAPI] Routes registered");
}
