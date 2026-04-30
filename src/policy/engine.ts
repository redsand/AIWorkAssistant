/**
 * Policy engine: evaluates actions against policies and manages approval flow
 */

import { v4 as uuidv4 } from 'uuid';
import { Action, PolicyDecision, ApprovalRequest, ExecutionResult } from './types';
import { evaluatePolicy } from './rules';
import { auditLogger } from '../audit/logger';

class PolicyEngine {
  /**
   * Evaluate an action against policy
   */
  async evaluate(action: Action): Promise<PolicyDecision> {
    const decision = evaluatePolicy(action);

    await auditLogger.log({
      id: uuidv4(),
      timestamp: new Date(),
      action: 'policy_evaluated',
      actor: action.userId,
      details: {
        actionType: action.type,
        result: decision.result,
        riskLevel: decision.riskLevel,
        reason: decision.reason,
      },
      severity: decision.result === 'blocked' ? 'warn' : 'info',
    });

    return decision;
  }

  /**
   * Check if action can proceed automatically
   */
  canProceed(decision: PolicyDecision): boolean {
    return decision.result === 'allow';
  }

  /**
   * Check if action requires approval
   */
  requiresApproval(decision: PolicyDecision): boolean {
    return decision.result === 'approval_required';
  }

  /**
   * Check if action is blocked
   */
  isBlocked(decision: PolicyDecision): boolean {
    return decision.result === 'blocked';
  }

  /**
   * Create approval request for action
   */
  async createApprovalRequest(action: Action, decision: PolicyDecision): Promise<ApprovalRequest> {
    const request: ApprovalRequest = {
      id: uuidv4(),
      action,
      decision,
      status: 'pending',
      requestedAt: new Date(),
    };

    await auditLogger.log({
      id: uuidv4(),
      timestamp: new Date(),
      action: 'approval_requested',
      actor: action.userId,
      details: {
        approvalId: request.id,
        actionType: action.type,
        riskLevel: decision.riskLevel,
      },
      severity: 'info',
    });

    return request;
  }

  /**
   * Execute an approved action
   * TODO: Integrate with actual execution logic
   */
  async executeApproval(
    request: ApprovalRequest,
    executor: () => Promise<ExecutionResult>
  ): Promise<ApprovalRequest> {
    try {
      const result = await executor();

      request.status = 'executed';
      request.executionResult = result;

      await auditLogger.log({
        id: uuidv4(),
        timestamp: new Date(),
        action: 'executed',
        actor: request.action.userId,
        details: {
          approvalId: request.id,
          actionType: request.action.type,
          success: result.success,
        },
        severity: result.success ? 'info' : 'error',
      });

      return request;
    } catch (error) {
      request.status = 'failed';

      await auditLogger.log({
        id: uuidv4(),
        timestamp: new Date(),
        action: 'failed',
        actor: request.action.userId,
        details: {
          approvalId: request.id,
          actionType: request.action.type,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        severity: 'error',
      });

      throw error;
    }
  }
}

export const policyEngine = new PolicyEngine();
