/**
 * Critical Action Guardrails System
 * Code-level safeguards for destructive and high-risk operations
 */

import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import path from "path";
import { guardrailsDatabase } from "./database";

export enum RiskLevel {
  LOW = "low",
  MEDIUM = "medium",
  HIGH = "high",
  CRITICAL = "critical",
}

export enum ActionCategory {
  DELETE = "delete",
  MASS_DELETE = "mass_delete",
  PRODUCTION_CHANGE = "production_change",
  DEPLOYMENT = "deployment",
  DATA_MODIFICATION = "data_modification",
  SYSTEM_CONFIG = "system_config",
  CALENDAR_MODIFICATION = "calendar_modification",
  INTEGRATION_MODIFICATION = "integration_modification",
  SECURITY_CHANGE = "security_change",
  DATABASE_CHANGE = "database_change",
}

export interface CriticalAction {
  id: string;
  category: ActionCategory;
  riskLevel: RiskLevel;
  operation: string;
  description: string;
  requiresApproval: boolean;
  requiresMFA: boolean;
  requiresDryRun: boolean;
  cooldownPeriod: number; // milliseconds
  rateLimits: {
    maxPerHour: number;
    maxPerDay: number;
  };
  allowedUsers: string[]; // empty means all users
  allowedRoles: string[];
  requiresConfirmation: boolean;
  requiresJustification: boolean;
  impacts: string[]; // systems/areas impacted
}

export interface ActionRequest {
  id: string;
  actionId: string;
  userId: string;
  timestamp: Date;
  params: Record<string, unknown>;
  justification?: string;
  environment: "development" | "staging" | "production";
  status: "pending" | "approved" | "rejected" | "executed" | "failed";
  approverId?: string;
  approvalTimestamp?: Date;
  executionResult?: {
    success: boolean;
    error?: string;
    data?: Record<string, unknown>;
  };
}

class GuardrailsRegistry {
  private actions: Map<string, CriticalAction> = new Map();
  private actionHistory: Map<string, ActionRequest[]> = new Map();
  private lastExecutionTimes: Map<string, Date> = new Map();
  private auditLogPath: string;

  constructor() {
    this.auditLogPath = path.join(
      process.cwd(),
      "data",
      "audit",
      "guardrails.log",
    );
    this.initializeAuditLog();
    this.registerDefaultActions();
    this.loadFromDatabase();
  }

  private initializeAuditLog() {
    const auditDir = path.dirname(this.auditLogPath);
    if (!fs.existsSync(auditDir)) {
      fs.mkdirSync(auditDir, { recursive: true });
    }
  }

  private loadFromDatabase() {
    try {
      const stats = guardrailsDatabase.getStats();
      if (stats.totalActions > 0) {
        console.log("[Guardrails] Loaded state from database");
      }
    } catch (error) {
      console.error("[Guardrails] Failed to load from database:", error);
    }
  }

  private persistAction(request: ActionRequest) {
    try {
      guardrailsDatabase.saveActionRequest({
        id: request.id,
        actionId: request.actionId,
        userId: request.userId,
        timestamp: request.timestamp,
        params: request.params,
        justification: request.justification,
        environment: request.environment,
        status: request.status,
        approverId: request.approverId,
        approvalTimestamp: request.approvalTimestamp,
        executionResult: request.executionResult,
      });
    } catch (error) {
      console.error(
        "[Guardrails] Failed to persist action to database:",
        error,
      );
    }
  }

  /**
   * Register default critical actions
   */
  private registerDefaultActions() {
    // File system operations
    this.registerAction({
      id: "fs.delete",
      category: ActionCategory.DELETE,
      riskLevel: RiskLevel.HIGH,
      operation: "filesystem.delete",
      description: "Delete files or directories",
      requiresApproval: true,
      requiresMFA: false,
      requiresDryRun: true,
      cooldownPeriod: 30000, // 30 seconds
      rateLimits: { maxPerHour: 10, maxPerDay: 50 },
      allowedUsers: [],
      allowedRoles: ["admin", "developer"],
      requiresConfirmation: true,
      requiresJustification: true,
      impacts: ["filesystem", "data"],
    });

    this.registerAction({
      id: "fs.mass_delete",
      category: ActionCategory.MASS_DELETE,
      riskLevel: RiskLevel.CRITICAL,
      operation: "filesystem.mass_delete",
      description: "Delete multiple files or directories at once",
      requiresApproval: true,
      requiresMFA: true,
      requiresDryRun: true,
      cooldownPeriod: 60000, // 1 minute
      rateLimits: { maxPerHour: 2, maxPerDay: 5 },
      allowedUsers: [],
      allowedRoles: ["admin"],
      requiresConfirmation: true,
      requiresJustification: true,
      impacts: ["filesystem", "data", "backup"],
    });

    // Database operations
    this.registerAction({
      id: "db.delete",
      category: ActionCategory.DELETE,
      riskLevel: RiskLevel.HIGH,
      operation: "database.delete",
      description: "Delete database records",
      requiresApproval: true,
      requiresMFA: false,
      requiresDryRun: true,
      cooldownPeriod: 10000, // 10 seconds
      rateLimits: { maxPerHour: 20, maxPerDay: 100 },
      allowedUsers: [],
      allowedRoles: ["admin", "developer"],
      requiresConfirmation: true,
      requiresJustification: false,
      impacts: ["database", "data"],
    });

    this.registerAction({
      id: "db.schema_change",
      category: ActionCategory.DATABASE_CHANGE,
      riskLevel: RiskLevel.CRITICAL,
      operation: "database.schema_change",
      description: "Modify database schema (migrations, DDL)",
      requiresApproval: true,
      requiresMFA: true,
      requiresDryRun: true,
      cooldownPeriod: 300000, // 5 minutes
      rateLimits: { maxPerHour: 1, maxPerDay: 5 },
      allowedUsers: [],
      allowedRoles: ["admin", "dba"],
      requiresConfirmation: true,
      requiresJustification: true,
      impacts: ["database", "production"],
    });

    this.registerAction({
      id: "db.mass_delete",
      category: ActionCategory.MASS_DELETE,
      riskLevel: RiskLevel.CRITICAL,
      operation: "database.mass_delete",
      description: "Delete multiple database records at once",
      requiresApproval: true,
      requiresMFA: true,
      requiresDryRun: true,
      cooldownPeriod: 60000, // 1 minute
      rateLimits: { maxPerHour: 2, maxPerDay: 10 },
      allowedUsers: [],
      allowedRoles: ["admin"],
      requiresConfirmation: true,
      requiresJustification: true,
      impacts: ["database", "data"],
    });

    // Production deployment
    this.registerAction({
      id: "deploy.production",
      category: ActionCategory.DEPLOYMENT,
      riskLevel: RiskLevel.CRITICAL,
      operation: "deployment.production",
      description: "Deploy to production environment",
      requiresApproval: true,
      requiresMFA: true,
      requiresDryRun: false,
      cooldownPeriod: 1800000, // 30 minutes
      rateLimits: { maxPerHour: 2, maxPerDay: 10 },
      allowedUsers: [],
      allowedRoles: ["admin", "devops"],
      requiresConfirmation: true,
      requiresJustification: true,
      impacts: ["production", "users", "revenue"],
    });

    this.registerAction({
      id: "deploy.staging",
      category: ActionCategory.DEPLOYMENT,
      riskLevel: RiskLevel.MEDIUM,
      operation: "deployment.staging",
      description: "Deploy to staging environment",
      requiresApproval: false,
      requiresMFA: false,
      requiresDryRun: false,
      cooldownPeriod: 300000, // 5 minutes
      rateLimits: { maxPerHour: 10, maxPerDay: 50 },
      allowedUsers: [],
      allowedRoles: ["admin", "developer", "devops"],
      requiresConfirmation: false,
      requiresJustification: false,
      impacts: ["staging"],
    });

    // Calendar operations
    this.registerAction({
      id: "calendar.delete",
      category: ActionCategory.CALENDAR_MODIFICATION,
      riskLevel: RiskLevel.MEDIUM,
      operation: "calendar.delete",
      description: "Delete calendar events",
      requiresApproval: false,
      requiresMFA: false,
      requiresDryRun: false,
      cooldownPeriod: 5000, // 5 seconds
      rateLimits: { maxPerHour: 30, maxPerDay: 100 },
      allowedUsers: [],
      allowedRoles: ["admin", "user"],
      requiresConfirmation: true,
      requiresJustification: false,
      impacts: ["calendar", "productivity"],
    });

    this.registerAction({
      id: "calendar.mass_delete",
      category: ActionCategory.CALENDAR_MODIFICATION,
      riskLevel: RiskLevel.HIGH,
      operation: "calendar.mass_delete",
      description: "Delete multiple calendar events",
      requiresApproval: true,
      requiresMFA: false,
      requiresDryRun: false,
      cooldownPeriod: 30000, // 30 seconds
      rateLimits: { maxPerHour: 5, maxPerDay: 20 },
      allowedUsers: [],
      allowedRoles: ["admin"],
      requiresConfirmation: true,
      requiresJustification: true,
      impacts: ["calendar", "productivity"],
    });

    // Jira operations
    this.registerAction({
      id: "jira.delete",
      category: ActionCategory.DELETE,
      riskLevel: RiskLevel.HIGH,
      operation: "jira.delete",
      description: "Delete Jira issues or tickets",
      requiresApproval: true,
      requiresMFA: false,
      requiresDryRun: true,
      cooldownPeriod: 30000, // 30 seconds
      rateLimits: { maxPerHour: 5, maxPerDay: 20 },
      allowedUsers: [],
      allowedRoles: ["admin", "project_lead"],
      requiresConfirmation: true,
      requiresJustification: true,
      impacts: ["jira", "project_management", "tracking"],
    });

    this.registerAction({
      id: "jira.transition",
      category: ActionCategory.DATA_MODIFICATION,
      riskLevel: RiskLevel.LOW,
      operation: "jira.transition",
      description: "Change Jira issue status",
      requiresApproval: false,
      requiresMFA: false,
      requiresDryRun: false,
      cooldownPeriod: 5000,
      rateLimits: { maxPerHour: 50, maxPerDay: 200 },
      allowedUsers: [],
      allowedRoles: ["admin", "user"],
      requiresConfirmation: false,
      requiresJustification: false,
      impacts: ["jira", "workflow"],
    });

    this.registerAction({
      id: "jira.project.create",
      category: ActionCategory.DATA_MODIFICATION,
      riskLevel: RiskLevel.MEDIUM,
      operation: "jira.project.create",
      description: "Create a new Jira project",
      requiresApproval: false,
      requiresMFA: false,
      requiresDryRun: false,
      cooldownPeriod: 10000,
      rateLimits: { maxPerHour: 3, maxPerDay: 10 },
      allowedUsers: [],
      allowedRoles: ["admin", "project_lead"],
      requiresConfirmation: false,
      requiresJustification: false,
      impacts: ["jira", "project_management"],
    });

    // GitLab operations
    this.registerAction({
      id: "gitlab.delete_branch",
      category: ActionCategory.DELETE,
      riskLevel: RiskLevel.MEDIUM,
      operation: "gitlab.delete_branch",
      description: "Delete GitLab branches",
      requiresApproval: false,
      requiresMFA: false,
      requiresDryRun: false,
      cooldownPeriod: 10000, // 10 seconds
      rateLimits: { maxPerHour: 20, maxPerDay: 100 },
      allowedUsers: [],
      allowedRoles: ["admin", "developer"],
      requiresConfirmation: true,
      requiresJustification: false,
      impacts: ["gitlab", "code", "version_control"],
    });

    this.registerAction({
      id: "gitlab.force_push",
      category: ActionCategory.SECURITY_CHANGE,
      riskLevel: RiskLevel.HIGH,
      operation: "gitlab.force_push",
      description: "Force push to GitLab repository",
      requiresApproval: true,
      requiresMFA: false,
      requiresDryRun: false,
      cooldownPeriod: 60000, // 1 minute
      rateLimits: { maxPerHour: 3, maxPerDay: 10 },
      allowedUsers: [],
      allowedRoles: ["admin", "senior_developer"],
      requiresConfirmation: true,
      requiresJustification: true,
      impacts: ["gitlab", "code", "version_control", "history"],
    });

    // Roadmap operations
    this.registerAction({
      id: "roadmap.delete",
      category: ActionCategory.DELETE,
      riskLevel: RiskLevel.HIGH,
      operation: "roadmap.delete",
      description: "Delete roadmap or milestones",
      requiresApproval: true,
      requiresMFA: false,
      requiresDryRun: true,
      cooldownPeriod: 30000, // 30 seconds
      rateLimits: { maxPerHour: 10, maxPerDay: 50 },
      allowedUsers: [],
      allowedRoles: ["admin", "project_manager"],
      requiresConfirmation: true,
      requiresJustification: true,
      impacts: ["roadmap", "planning", "projects"],
    });

    // System configuration
    this.registerAction({
      id: "system.config_change",
      category: ActionCategory.SYSTEM_CONFIG,
      riskLevel: RiskLevel.HIGH,
      operation: "system.config_change",
      description: "Modify system configuration",
      requiresApproval: true,
      requiresMFA: false,
      requiresDryRun: true,
      cooldownPeriod: 60000, // 1 minute
      rateLimits: { maxPerHour: 5, maxPerDay: 20 },
      allowedUsers: [],
      allowedRoles: ["admin", "devops"],
      requiresConfirmation: true,
      requiresJustification: true,
      impacts: ["system", "configuration", "security"],
    });

    console.log(
      "[Guardrails] Registered",
      this.actions.size,
      "critical actions",
    );
  }

  /**
   * Register a new critical action
   */
  registerAction(action: CriticalAction): void {
    this.actions.set(action.id, action);
  }

  /**
   * Get action by ID
   */
  getAction(actionId: string): CriticalAction | undefined {
    return this.actions.get(actionId);
  }

  /**
   * Get action history for user
   */
  getUserHistory(userId: string, limit = 50): ActionRequest[] {
    const inMemory = this.actionHistory.get(userId) || [];

    if (inMemory.length > 0) {
      return inMemory
        .sort(
          (a, b) =>
            new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
        )
        .slice(0, limit);
    }

    try {
      const fromDb = guardrailsDatabase.getActionsByUser(userId, limit);
      return fromDb.map((row) => ({
        id: row.id,
        actionId: row.actionId,
        userId: row.userId,
        timestamp: row.timestamp,
        params: row.params,
        justification: undefined,
        environment: row.status as ActionRequest["environment"],
        status: row.status as ActionRequest["status"],
      }));
    } catch (error) {
      console.error(
        "[Guardrails] Failed to load user history from database:",
        error,
      );
      return [];
    }
  }

  /**
   * Get pending approvals
   */
  getPendingApprovals(): ActionRequest[] {
    const inMemory: ActionRequest[] = [];

    for (const userRequests of this.actionHistory.values()) {
      for (const request of userRequests) {
        if (request.status === "pending") {
          inMemory.push(request);
        }
      }
    }

    if (inMemory.length > 0) {
      return inMemory.sort(
        (a, b) =>
          new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      );
    }

    try {
      const fromDb = guardrailsDatabase.getPendingApprovals();
      return fromDb.map((row) => ({
        id: row.id,
        actionId: row.actionId,
        userId: row.userId,
        timestamp: row.timestamp,
        params: {},
        justification: undefined,
        environment: "development" as const,
        status: row.status as ActionRequest["status"],
      }));
    } catch (error) {
      console.error(
        "[Guardrails] Failed to load pending approvals from database:",
        error,
      );
      return [];
    }
  }

  /**
   * Check if action requires approval
   */
  requiresApproval(actionId: string): boolean {
    const action = this.actions.get(actionId);
    return action?.requiresApproval || false;
  }

  /**
   * Check if action is allowed for user
   */
  isAllowedUser(
    actionId: string,
    userId: string,
    userRoles: string[],
  ): boolean {
    const action = this.actions.get(actionId);
    if (!action) return false;

    // Check explicit user allowlist
    if (
      action.allowedUsers.length > 0 &&
      !action.allowedUsers.includes(userId)
    ) {
      return false;
    }

    // Check role requirements
    if (action.allowedRoles.length > 0) {
      const hasRequiredRole = action.allowedRoles.some((role) =>
        userRoles.includes(role),
      );
      if (!hasRequiredRole) {
        return false;
      }
    }

    return true;
  }

  /**
   * Check rate limits
   */
  checkRateLimits(
    actionId: string,
    userId: string,
  ): { allowed: boolean; reason?: string } {
    const action = this.actions.get(actionId);
    if (!action) {
      return { allowed: false, reason: "Unknown action" };
    }

    const now = Date.now();
    const userHistory = this.actionHistory.get(userId) || [];

    // Filter actions from current time window
    const oneHourAgo = now - 60 * 60 * 1000;
    const oneDayAgo = now - 24 * 60 * 60 * 1000;

    const recentHour = userHistory.filter(
      (req) =>
        req.actionId === actionId &&
        new Date(req.timestamp).getTime() > oneHourAgo,
    );

    const recentDay = userHistory.filter(
      (req) =>
        req.actionId === actionId &&
        new Date(req.timestamp).getTime() > oneDayAgo,
    );

    // Check rate limits
    if (recentHour.length >= action.rateLimits.maxPerHour) {
      return {
        allowed: false,
        reason: `Hourly rate limit exceeded (${recentHour.length}/${action.rateLimits.maxPerHour})`,
      };
    }

    if (recentDay.length >= action.rateLimits.maxPerDay) {
      return {
        allowed: false,
        reason: `Daily rate limit exceeded (${recentDay.length}/${action.rateLimits.maxPerDay})`,
      };
    }

    return { allowed: true };
  }

  /**
   * Check cooldown period
   */
  checkCooldown(actionId: string): {
    allowed: boolean;
    remainingTime?: number;
  } {
    const action = this.actions.get(actionId);
    if (!action) {
      return { allowed: false };
    }

    const lastExecution = this.lastExecutionTimes.get(actionId);
    if (!lastExecution) {
      return { allowed: true };
    }

    const now = Date.now();
    const timeSinceLastExecution = now - lastExecution.getTime();

    if (timeSinceLastExecution < action.cooldownPeriod) {
      return {
        allowed: false,
        remainingTime: action.cooldownPeriod - timeSinceLastExecution,
      };
    }

    return { allowed: true };
  }

  /**
   * Validate action request
   */
  validateActionRequest(
    actionId: string,
    userId: string,
    userRoles: string[],
    params: Record<string, unknown>,
    environment: string,
  ): {
    allowed: boolean;
    reason?: string;
    requirements?: string[];
  } {
    const action = this.actions.get(actionId);
    if (!action) {
      return { allowed: false, reason: "Unknown action ID" };
    }

    const requirements: string[] = [];

    // Check user permissions
    if (!this.isAllowedUser(actionId, userId, userRoles)) {
      return { allowed: false, reason: "User not authorized for this action" };
    }

    // Check rate limits
    const rateLimitCheck = this.checkRateLimits(actionId, userId);
    if (!rateLimitCheck.allowed) {
      return { allowed: false, reason: rateLimitCheck.reason };
    }

    // Check cooldown
    const cooldownCheck = this.checkCooldown(actionId);
    if (!cooldownCheck.allowed) {
      const remainingSeconds = Math.ceil(
        (cooldownCheck.remainingTime || 0) / 1000,
      );
      return {
        allowed: false,
        reason: `Cooldown period active. ${remainingSeconds}s remaining`,
      };
    }

    // Check environment restrictions
    if (
      action.riskLevel === RiskLevel.CRITICAL &&
      environment === "production"
    ) {
      requirements.push("Production deployment requires explicit approval");
    }

    // Check if justification is required
    if (action.requiresJustification && !params.justification) {
      requirements.push("Justification required for this action");
    }

    // Check if confirmation is required
    if (action.requiresConfirmation) {
      requirements.push("User confirmation required");
    }

    // Check if dry run is required
    if (action.requiresDryRun && !params.dryRun) {
      requirements.push("Dry run required before execution");
    }

    // Check if MFA is required
    if (action.requiresMFA) {
      requirements.push("Multi-factor authentication required");
    }

    // Check if approval is required
    if (action.requiresApproval) {
      requirements.push("Manager approval required");
    }

    return {
      allowed: requirements.length === 0 || !action.requiresApproval,
      requirements: requirements.length > 0 ? requirements : undefined,
    };
  }

  /**
   * Create action request
   */
  createActionRequest(
    actionId: string,
    userId: string,
    params: Record<string, unknown>,
    environment: "development" | "staging" | "production",
    _userRoles: string[] = [],
  ): ActionRequest {
    const requestId = uuidv4();

    const request: ActionRequest = {
      id: requestId,
      actionId,
      userId,
      timestamp: new Date(),
      params,
      justification: params.justification as string,
      environment,
      status: params.autoApprove ? "approved" : "pending",
    };

    // Store in history
    if (!this.actionHistory.has(userId)) {
      this.actionHistory.set(userId, []);
    }
    this.actionHistory.get(userId)!.push(request);

    // Log to audit file
    this.logToAudit(request);

    // Persist to database
    this.persistAction(request);

    return request;
  }

  /**
   * Approve action request
   */
  approveAction(requestId: string, approverId: string): boolean {
    // Find request
    for (const userRequests of this.actionHistory.values()) {
      const request = userRequests.find((r) => r.id === requestId);
      if (request) {
        request.status = "approved";
        request.approverId = approverId;
        request.approvalTimestamp = new Date();

        this.logToAudit(request, "APPROVED");
        this.persistAction(request);
        return true;
      }
    }
    return false;
  }

  /**
   * Reject action request
   */
  rejectAction(
    requestId: string,
    approverId: string,
    reason?: string,
  ): boolean {
    for (const userRequests of this.actionHistory.values()) {
      const request = userRequests.find((r) => r.id === requestId);
      if (request) {
        request.status = "rejected";
        request.approverId = approverId;
        request.approvalTimestamp = new Date();

        this.logToAudit(request, "REJECTED", reason);
        this.persistAction(request);
        return true;
      }
    }
    return false;
  }

  /**
   * Mark action as executed
   */
  markAsExecuted(
    requestId: string,
    success: boolean,
    error?: string,
    data?: Record<string, unknown>,
  ): void {
    for (const userRequests of this.actionHistory.values()) {
      const request = userRequests.find((r) => r.id === requestId);
      if (request) {
        request.status = success ? "executed" : "failed";
        request.executionResult = { success, error, data };

        // Update last execution time for cooldown
        this.lastExecutionTimes.set(request.actionId, new Date());

        this.logToAudit(request, success ? "EXECUTED" : "FAILED", error);
        this.persistAction(request);
        return;
      }
    }
  }

  /**
   * Log action to audit file
   */
  private logToAudit(
    request: ActionRequest,
    status: string = "CREATED",
    additionalInfo?: string,
  ): void {
    const logEntry = {
      timestamp: new Date().toISOString(),
      requestId: request.id,
      actionId: request.actionId,
      userId: request.userId,
      environment: request.environment,
      status,
      approverId: request.approverId,
      justification: request.justification,
      additionalInfo,
    };

    const logLine = JSON.stringify(logEntry) + "\n";

    try {
      fs.appendFileSync(this.auditLogPath, logLine);
    } catch (error) {
      console.error("[Guardrails] Failed to write to audit log:", error);
    }
  }

  /**
   * Get statistics
   */
  getStats(): {
    totalActions: number;
    pendingApprovals: number;
    executionsLast24h: number;
    topUsers: Array<{ userId: string; count: number }>;
  } {
    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;

    let totalActions = 0;
    let pendingApprovals = 0;
    let executionsLast24h = 0;
    const userCounts: Map<string, number> = new Map();

    for (const [userId, userRequests] of this.actionHistory.entries()) {
      totalActions += userRequests.length;

      for (const request of userRequests) {
        if (request.status === "pending") {
          pendingApprovals++;
        }

        if (
          request.status === "executed" &&
          new Date(request.timestamp).getTime() > oneDayAgo
        ) {
          executionsLast24h++;
        }

        const count = userCounts.get(userId) || 0;
        userCounts.set(userId, count + 1);
      }
    }

    if (totalActions === 0) {
      try {
        const dbStats = guardrailsDatabase.getStats();
        return {
          totalActions: dbStats.totalActions,
          pendingApprovals: dbStats.pendingApprovals,
          executionsLast24h: dbStats.executionsLast24h,
          topUsers: [],
        };
      } catch (error) {
        // Fall through to return in-memory stats (which will be zero)
      }
    }

    const topUsers = Array.from(userCounts.entries())
      .map(([userId, count]) => ({ userId, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    return {
      totalActions,
      pendingApprovals,
      executionsLast24h,
      topUsers,
    };
  }
}

// Singleton instance
export const guardrailsRegistry = new GuardrailsRegistry();
