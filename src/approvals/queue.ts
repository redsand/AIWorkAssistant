/**
 * In-memory approval queue
 * TODO: Persist to database for production
 */

import { v4 as uuidv4 } from 'uuid';
import { ApprovalRequest, ApprovalFilter, ApprovalResponse, ApprovalActionResult } from './types';
import { auditLogger } from '../audit/logger';

class ApprovalQueue {
  private approvals: Map<string, ApprovalRequest> = new Map();

  /**
   * Add approval request to queue
   */
  async enqueue(request: ApprovalRequest): Promise<ApprovalRequest> {
    this.approvals.set(request.id, request);
    return request;
  }

  /**
   * Get approval by ID
   */
  async get(id: string): Promise<ApprovalRequest | undefined> {
    return this.approvals.get(id);
  }

  /**
   * List approvals with optional filters
   */
  async list(filter: ApprovalFilter = {}): Promise<ApprovalResponse> {
    let approvals = Array.from(this.approvals.values());

    // Filter by status
    if (filter.status) {
      approvals = approvals.filter(a => a.status === filter.status);
    }

    // Filter by user
    if (filter.userId) {
      approvals = approvals.filter(a => a.action.userId === filter.userId);
    }

    // Sort by requested date (newest first)
    approvals.sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime());

    const total = this.approvals.size;
    const filtered = approvals.length;

    // Apply pagination
    const offset = filter.offset || 0;
    const limit = filter.limit || 50;
    approvals = approvals.slice(offset, offset + limit);

    return {
      approvals,
      total,
      filtered,
    };
  }

  /**
   * Approve an approval request
   */
  async approve(id: string, userId: string): Promise<ApprovalActionResult> {
    const approval = this.approvals.get(id);

    if (!approval) {
      return {
        success: false,
        approval: null as unknown as ApprovalRequest,
        message: 'Approval request not found',
      };
    }

    if (approval.status !== 'pending') {
      return {
        success: false,
        approval,
        message: `Approval already ${approval.status}`,
      };
    }

    approval.status = 'approved';
    approval.respondedAt = new Date();
    approval.responseBy = userId;

    await auditLogger.log({
      id: uuidv4(),
      timestamp: new Date(),
      action: 'approved',
      actor: userId,
      details: {
        approvalId: id,
        actionType: approval.action.type,
      },
      severity: 'info',
    });

    return {
      success: true,
      approval,
    };
  }

  /**
   * Reject an approval request
   */
  async reject(id: string, userId: string): Promise<ApprovalActionResult> {
    const approval = this.approvals.get(id);

    if (!approval) {
      return {
        success: false,
        approval: null as unknown as ApprovalRequest,
        message: 'Approval request not found',
      };
    }

    if (approval.status !== 'pending') {
      return {
        success: false,
        approval,
        message: `Approval already ${approval.status}`,
      };
    }

    approval.status = 'rejected';
    approval.respondedAt = new Date();
    approval.responseBy = userId;

    await auditLogger.log({
      id: uuidv4(),
      timestamp: new Date(),
      action: 'rejected',
      actor: userId,
      details: {
        approvalId: id,
        actionType: approval.action.type,
      },
      severity: 'info',
    });

    return {
      success: true,
      approval,
    };
  }

  /**
   * Update approval after execution
   */
  async updateAfterExecution(approval: ApprovalRequest): Promise<void> {
    this.approvals.set(approval.id, approval);
  }

  /**
   * Remove old approvals (cleanup)
   */
  async cleanup(olderThanDays: number = 30): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - olderThanDays);

    let removed = 0;

    for (const [id, approval] of this.approvals.entries()) {
      if (
        (approval.status === 'approved' || approval.status === 'rejected') &&
        approval.respondedAt &&
        approval.respondedAt < cutoff
      ) {
        this.approvals.delete(id);
        removed++;
      }
    }

    return removed;
  }
}

export const approvalQueue = new ApprovalQueue();
