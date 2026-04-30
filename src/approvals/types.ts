/**
 * Approval queue types
 */

import { ApprovalRequest } from '../policy/types';

export type { ApprovalRequest };

/**
 * Filter options for listing approvals
 */
export interface ApprovalFilter {
  status?: ApprovalRequest['status'];
  userId?: string;
  limit?: number;
  offset?: number;
}

/**
 * Approval response with metadata
 */
export interface ApprovalResponse {
  approvals: ApprovalRequest[];
  total: number;
  filtered: number;
}

/**
 * Approval action result
 */
export interface ApprovalActionResult {
  success: boolean;
  approval: ApprovalRequest;
  message?: string;
}
