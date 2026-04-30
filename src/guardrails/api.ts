/**
 * Guardrails API Routes
 * REST API for managing critical action guardrails
 */

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { guardrailsRegistry, RiskLevel, ActionCategory } from './action-registry';
import { guardrailsEnforcer } from './enforcement';

export async function guardrailsRoutes(fastify: FastifyInstance) {

  // Health check
  fastify.get('/guardrails/health', async (request, reply) => {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      guardrails: 'active',
    };
  });

  /**
   * Pre-execution check endpoint
   */
  fastify.post('/guardrails/check', async (request, reply) => {
    try {
      const schema = z.object({
        operation: z.string(),
        params: z.record(z.unknown()),
        userId: z.string(),
        userRoles: z.array(z.string()).default([]),
        environment: z.enum(['development', 'staging', 'production']).default('development'),
        sessionId: z.string().optional(),
      });

      const body = schema.parse(request.body);

      const result = await guardrailsEnforcer.preExecutionCheck(
        body.operation,
        body.params,
        {
          userId: body.userId,
          userRoles: body.userRoles,
          environment: body.environment,
          sessionId: body.sessionId,
        }
      );

      return {
        success: true,
        result,
      };
    } catch (error) {
      reply.code(400);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Invalid request',
      };
    }
  });

  /**
   * Get all registered actions
   */
  fastify.get('/guardrails/actions', async (request, reply) => {
    try {
      const { category: _category, riskLevel: _riskLevel } = request.query as {
        category?: string;
        riskLevel?: string;
      };

      // Get all actions (in a real implementation, you'd want to expose this properly)
      const stats = guardrailsRegistry.getStats();

      return {
        success: true,
        message: 'Guardrails system active',
        stats,
        registeredActions: stats.totalActions,
        categories: Object.values(ActionCategory),
        riskLevels: Object.values(RiskLevel),
      };
    } catch (error) {
      reply.code(500);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  /**
   * Get pending guardrails approvals
   */
  fastify.get('/guardrails/approvals/pending', async (request, reply) => {
    try {
      const pending = guardrailsRegistry.getPendingApprovals();

      return {
        success: true,
        approvals: pending.map(req => ({
          id: req.id,
          actionId: req.actionId,
          userId: req.userId,
          timestamp: req.timestamp,
          justification: req.justification,
          environment: req.environment,
        })),
        count: pending.length,
      };
    } catch (error) {
      reply.code(500);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  /**
   * Approve guardrails action
   */
  fastify.post('/guardrails/approvals/:requestId/approve', async (request, reply) => {
    try {
      const { requestId } = request.params as { requestId: string };
      const { approverId } = request.body as { approverId: string };

      if (!approverId) {
        reply.code(400);
        return {
          success: false,
          error: 'approverId is required',
        };
      }

      const approved = guardrailsRegistry.approveAction(requestId, approverId);

      if (!approved) {
        reply.code(404);
        return {
          success: false,
          error: 'Request not found',
        };
      }

      return {
        success: true,
        message: 'Action approved',
      };
    } catch (error) {
      reply.code(500);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  /**
   * Reject guardrails action
   */
  fastify.post('/guardrails/approvals/:requestId/reject', async (request, reply) => {
    try {
      const { requestId } = request.params as { requestId: string };
      const { approverId, reason } = request.body as { approverId: string; reason?: string };

      if (!approverId) {
        reply.code(400);
        return {
          success: false,
          error: 'approverId is required',
        };
      }

      const rejected = guardrailsRegistry.rejectAction(requestId, approverId, reason);

      if (!rejected) {
        reply.code(404);
        return {
          success: false,
          error: 'Request not found',
        };
      }

      return {
        success: true,
        message: 'Action rejected',
      };
    } catch (error) {
      reply.code(500);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  /**
   * Get user action history
   */
  fastify.get('/guardrails/history/:userId', async (request, reply) => {
    try {
      const { userId } = request.params as { userId: string };
      const { limit } = request.query as { limit?: string };

      const history = guardrailsRegistry.getUserHistory(
        userId,
        limit ? parseInt(limit) : 50
      );

      return {
        success: true,
        history: history.map(req => ({
          id: req.id,
          actionId: req.actionId,
          timestamp: req.timestamp,
          status: req.status,
          environment: req.environment,
          justification: req.justification,
          hasExecutionResult: !!req.executionResult,
        })),
        count: history.length,
      };
    } catch (error) {
      reply.code(500);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  /**
   * Get guardrails statistics
   */
  fastify.get('/guardrails/stats', async (request, reply) => {
    try {
      const stats = guardrailsRegistry.getStats();

      return {
        success: true,
        stats,
      };
    } catch (error) {
      reply.code(500);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  /**
   * Log execution result
   */
  fastify.post('/guardrails/log/:requestId', async (request, reply) => {
    try {
      const { requestId } = request.params as { requestId: string };
      const { success, error, result } = request.body as {
        success: boolean;
        error?: string;
        result?: Record<string, unknown>;
      };

      await guardrailsEnforcer.postExecutionLog(requestId, success, error, result);

      return {
        success: true,
        message: 'Execution logged',
      };
    } catch (error) {
      reply.code(500);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  console.log('[GuardrailsAPI] Routes registered');
}
