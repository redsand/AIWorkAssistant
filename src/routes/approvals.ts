/**
 * Approval queue routes
 */

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { approvalQueue } from '../approvals/queue';
import { policyEngine } from '../policy/engine';
import { auditLogger } from '../audit/logger';
import { v4 as uuidv4 } from 'uuid';

const approveSchema = z.object({
  userId: z.string(),
});

export async function approvalRoutes(fastify: FastifyInstance) {
  /**
   * List pending approvals
   */
  fastify.get('/approvals', async (request, reply) => {
    try {
      const { status, userId, limit, offset } = request.query as Record<string, string>;

      const response = await approvalQueue.list({
        status: status as any,
        userId,
        limit: limit ? parseInt(limit, 10) : undefined,
        offset: offset ? parseInt(offset, 10) : undefined,
      });

      return response;
    } catch (error) {
      fastify.log.error(error);
      reply.code(500);
      return {
        error: 'Failed to list approvals',
        message: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  /**
   * Get approval by ID
   */
  fastify.get('/approvals/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const approval = await approvalQueue.get(id);

      if (!approval) {
        reply.code(404);
        return { error: 'Approval not found' };
      }

      return approval;
    } catch (error) {
      fastify.log.error(error);
      reply.code(500);
      return {
        error: 'Failed to get approval',
        message: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  /**
   * Approve an approval request
   */
  fastify.post('/approvals/:id/approve', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = approveSchema.parse(request.body);

      const result = await approvalQueue.approve(id, body.userId);

      if (!result.success) {
        reply.code(400);
        return result;
      }

      // TODO: Execute the approved action
      // For now, just return the approval
      await auditLogger.log({
        id: uuidv4(),
        timestamp: new Date(),
        action: 'approved',
        actor: body.userId,
        details: {
          approvalId: id,
          actionType: result.approval.action.type,
        },
        severity: 'info',
      });

      return result;
    } catch (error) {
      fastify.log.error(error);
      reply.code(500);
      return {
        error: 'Failed to approve request',
        message: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  /**
   * Reject an approval request
   */
  fastify.post('/approvals/:id/reject', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = approveSchema.parse(request.body);

      const result = await approvalQueue.reject(id, body.userId);

      if (!result.success) {
        reply.code(400);
        return result;
      }

      await auditLogger.log({
        id: uuidv4(),
        timestamp: new Date(),
        action: 'rejected',
        actor: body.userId,
        details: {
          approvalId: id,
          actionType: result.approval.action.type,
        },
        severity: 'info',
      });

      return result;
    } catch (error) {
      fastify.log.error(error);
      reply.code(500);
      return {
        error: 'Failed to reject request',
        message: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });
}
