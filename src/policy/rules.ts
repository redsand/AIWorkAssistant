/**
 * Policy engine rules and matching logic
 */

import { Action, PolicyDecision } from "./types";
import { DEFAULT_POLICIES, MODE_OVERRIDES } from "../config/policy";
import { env } from "../config/env";

/**
 * Match an action type against a policy pattern
 * Supports wildcards (e.g., "jira.*.read" matches "jira.issue.read")
 */
export function matchPattern(pattern: string, actionType: string): boolean {
  const patternParts = pattern.split(".");
  const actionParts = actionType.split(".");

  if (patternParts.length !== actionParts.length) {
    return false;
  }

  return patternParts.every(
    (part, i) => part === "*" || part === actionParts[i],
  );
}

/**
 * Find applicable policy for an action
 */
export function findApplicablePolicy(actionType: string) {
  // Find exact or pattern-matching policy
  let policy = DEFAULT_POLICIES.find((p) =>
    matchPattern(p.pattern, actionType),
  );

  // Apply mode overrides
  const mode = env.POLICY_APPROVAL_MODE;
  const overrides = MODE_OVERRIDES[mode as keyof typeof MODE_OVERRIDES] || [];

  for (const override of overrides) {
    if (
      override.pattern &&
      matchPattern(override.pattern, actionType) &&
      policy
    ) {
      policy = { ...policy, ...override };
    }
  }

  return policy;
}

/**
 * Evaluate policy for an action
 */
export function evaluatePolicy(action: Action): PolicyDecision {
  const policy = findApplicablePolicy(action.type);

  if (!policy) {
    return {
      action,
      result: "allow" as const,
      riskLevel: "low" as const,
      reason: "No matching policy - default allow",
    };
  }

  return {
    action,
    result: policy.defaultResult as PolicyDecision["result"],
    riskLevel: policy.riskLevel as PolicyDecision["riskLevel"],
    reason: policy.description,
    applicablePolicy: policy.pattern,
  };
}

/**
 * Check if an action is allowed
 */
export function isActionAllowed(actionType: string): boolean {
  const mockAction: Action = {
    id: "check",
    type: actionType,
    description: "Policy check",
    params: {},
    userId: "system",
    timestamp: new Date(),
  };

  const decision = evaluatePolicy(mockAction);
  return decision.result === "allow";
}

/**
 * Check if an action requires approval
 */
export function isApprovalRequired(actionType: string): boolean {
  const mockAction: Action = {
    id: "check",
    type: actionType,
    description: "Policy check",
    params: {},
    userId: "system",
    timestamp: new Date(),
  };

  const decision = evaluatePolicy(mockAction);
  return decision.result === "approval_required";
}

/**
 * Check if an action is blocked
 */
export function isActionBlocked(actionType: string): boolean {
  const mockAction: Action = {
    id: "check",
    type: actionType,
    description: "Policy check",
    params: {},
    userId: "system",
    timestamp: new Date(),
  };

  const decision = evaluatePolicy(mockAction);
  return decision.result === "blocked";
}
