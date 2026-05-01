/**
 * Guardrails Enforcement Middleware
 * Enforces critical action guardrails at execution time
 */

import {
  guardrailsRegistry,
  RiskLevel,
  ActionCategory,
} from "./action-registry";
import axios from "axios";

export interface EnforcementResult {
  allowed: boolean;
  requestId?: string;
  reason?: string;
  requirements?: string[];
  estimatedImpact?: string[];
}

export interface ExecutionContext {
  userId: string;
  userRoles: string[];
  environment: "development" | "staging" | "production";
  sessionId?: string;
}

class GuardrailsEnforcer {
  private apiBaseUrl: string;

  constructor() {
    this.apiBaseUrl = process.env.API_BASE_URL || "http://localhost:3000";
  }

  /**
   * Pre-execution check for any potentially dangerous operation
   */
  async preExecutionCheck(
    operation: string,
    params: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<EnforcementResult> {
    console.log(`[Guardrails] Pre-execution check for operation: ${operation}`);

    // Map operations to action IDs
    const actionId = this.mapOperationToAction(operation, params);
    if (!actionId) {
      // Unknown operation - allow but log
      console.log(
        `[Guardrails] Unknown operation, allowing with caution: ${operation}`,
      );
      return { allowed: true };
    }

    const action = guardrailsRegistry.getAction(actionId);
    if (!action) {
      return { allowed: true };
    }

    // Calculate impact
    const estimatedImpact = this.estimateImpact(action, params);

    // Validate the request
    const validation = guardrailsRegistry.validateActionRequest(
      actionId,
      context.userId,
      context.userRoles,
      params,
      context.environment,
    );

    if (!validation.allowed) {
      console.log(`[Guardrails] Action BLOCKED: ${validation.reason}`);
      return {
        allowed: false,
        reason: validation.reason,
        estimatedImpact,
      };
    }

    // If approval is required, create request and return
    if (action.requiresApproval && validation.requirements) {
      const request = guardrailsRegistry.createActionRequest(
        actionId,
        context.userId,
        params,
        context.environment,
        context.userRoles,
      );

      console.log(
        `[Guardrails] Approval required for ${actionId}. Request ID: ${request.id}`,
      );

      return {
        allowed: false,
        requestId: request.id,
        reason: "Approval required",
        requirements: validation.requirements,
        estimatedImpact,
      };
    }

    // If all checks pass, allow execution
    console.log(`[Guardrails] Action ALLOWED: ${actionId}`);
    return {
      allowed: true,
      estimatedImpact,
    };
  }

  /**
   * Post-execution logging
   */
  async postExecutionLog(
    requestId: string,
    success: boolean,
    error?: string,
    result?: Record<string, unknown>,
  ): Promise<void> {
    guardrailsRegistry.markAsExecuted(requestId, success, error, result);
  }

  /**
   * Map generic operations to specific action IDs
   */
  private mapOperationToAction(
    operation: string,
    params: Record<string, unknown>,
  ): string | null {
    // File system operations
    if (operation === "fs.delete" || operation === "file.delete") {
      const files = (params.files as Array<unknown>) || [];
      if (files.length > 5) {
        return "fs.mass_delete";
      }
      return "fs.delete";
    }

    // Database operations
    if (operation === "db.delete" || operation === "database.delete") {
      const records = (params.records as Array<unknown>) || [];
      if (records.length > 10) {
        return "db.mass_delete";
      }
      return "db.delete";
    }

    if (operation === "db.migrate" || operation === "db.schema_change") {
      return "db.schema_change";
    }

    // Deployment operations
    if (operation === "deploy") {
      const environment = (params.environment as string) || "production";
      if (environment === "production") {
        return "deploy.production";
      }
      return "deploy.staging";
    }

    // Calendar operations
    if (operation === "calendar.delete") {
      const events = (params.events as Array<unknown>) || [];
      if (events.length > 3) {
        return "calendar.mass_delete";
      }
      return "calendar.delete";
    }

    // Jira operations
    if (operation === "jira.delete" || operation === "jira.delete_issue") {
      return "jira.delete";
    }

    if (operation === "jira.transition") {
      return "jira.transition";
    }

    if (
      operation === "jira.project.create" ||
      operation === "jira.create_project"
    ) {
      return "jira.project.create";
    }

    // GitLab operations
    if (operation === "gitlab.delete_branch") {
      return "gitlab.delete_branch";
    }

    if (operation === "gitlab.force_push") {
      return "gitlab.force_push";
    }

    // Roadmap operations
    if (
      operation === "roadmap.delete" ||
      operation === "roadmap.delete_roadmap"
    ) {
      return "roadmap.delete";
    }

    // System operations
    if (operation === "system.config" || operation === "config.change") {
      return "system.config_change";
    }

    return null;
  }

  /**
   * Estimate impact of an action
   */
  private estimateImpact(
    action: any,
    params: Record<string, unknown>,
  ): string[] {
    const impacts: string[] = [...action.impacts];

    // Add dynamic impacts based on parameters
    if (
      action.category === ActionCategory.DELETE ||
      action.category === ActionCategory.MASS_DELETE
    ) {
      const itemCount = (params.items as Array<unknown>) || [];
      const fileCount = (params.files as Array<unknown>) || [];
      const recordCount = (params.records as Array<unknown>) || [];

      const totalItems = Math.max(
        itemCount.length,
        fileCount.length,
        recordCount.length,
      );

      if (totalItems > 100) {
        impacts.push("mass_data_loss");
        impacts.push("extended_recovery_time");
      } else if (totalItems > 10) {
        impacts.push("significant_data_loss");
      }
    }

    if (action.riskLevel === RiskLevel.CRITICAL) {
      impacts.push("potential_downtime");
      impacts.push("user_impact");
    }

    if (params.environment === "production") {
      impacts.push("production_impact");
      impacts.push("customer_visible");
    }

    return [...new Set(impacts)]; // Remove duplicates
  }

  /**
   * Request approval for a blocked action
   */
  async requestApproval(
    requestId: string,
    justification: string,
  ): Promise<{ success: boolean; message: string }> {
    try {
      // Send to approval queue
      await axios.post(`${this.apiBaseUrl}/approvals/guardrails`, {
        requestId,
        type: "guardrails_action",
        justification,
      });

      return {
        success: true,
        message: "Approval request sent to queue",
      };
    } catch (error) {
      return {
        success: false,
        message: "Failed to request approval",
      };
    }
  }

  /**
   * Get guardrails statistics
   */
  getStats() {
    return guardrailsRegistry.getStats();
  }

  /**
   * Get pending approvals
   */
  getPendingApprovals() {
    return guardrailsRegistry.getPendingApprovals();
  }

  /**
   * Get user history
   */
  getUserHistory(userId: string, limit?: number) {
    return guardrailsRegistry.getUserHistory(userId, limit);
  }
}

// Singleton instance
export const guardrailsEnforcer = new GuardrailsEnforcer();
