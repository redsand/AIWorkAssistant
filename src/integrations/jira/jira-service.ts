/**
 * Jira service layer: business logic for Jira operations
 * TODO: Implement actual Jira operations
 */

import { jiraClient } from "./jira-client";
import { policyEngine } from "../../policy/engine";
import { Action } from "../../policy/types";

class JiraService {
  /**
   * Get issue details
   */
  async getIssue(key: string, userId: string) {
    const action: Action = {
      id: Date.now().toString(),
      type: "jira.issue.read",
      description: `Read Jira issue ${key}`,
      params: { key },
      userId,
      timestamp: new Date(),
    };

    const decision = await policyEngine.evaluate(action);

    if (!policyEngine.canProceed(decision)) {
      throw new Error(`Action not allowed: ${decision.reason}`);
    }

    return jiraClient.getIssue(key);
  }

  /**
   * Search issues
   */
  async searchIssues(jql: string, userId: string) {
    const action: Action = {
      id: Date.now().toString(),
      type: "jira.issue.search",
      description: `Search Jira issues: ${jql}`,
      params: { jql },
      userId,
      timestamp: new Date(),
    };

    const decision = await policyEngine.evaluate(action);

    if (!policyEngine.canProceed(decision)) {
      throw new Error(`Action not allowed: ${decision.reason}`);
    }

    return jiraClient.searchIssues(jql);
  }

  /**
   * Get assigned issues
   */
  async getAssignedIssues(userId: string, status?: string) {
    const action: Action = {
      id: Date.now().toString(),
      type: "jira.issue.search",
      description: "Get assigned Jira issues",
      params: { status },
      userId,
      timestamp: new Date(),
    };

    const decision = await policyEngine.evaluate(action);

    if (!policyEngine.canProceed(decision)) {
      throw new Error(`Action not allowed: ${decision.reason}`);
    }

    return jiraClient.getAssignedIssues(status);
  }

  /**
   * Add comment to issue
   */
  async addComment(key: string, body: string, userId: string) {
    const action: Action = {
      id: Date.now().toString(),
      type: "jira.comment.create",
      description: `Add comment to Jira issue ${key}`,
      params: { key, body },
      userId,
      timestamp: new Date(),
    };

    const decision = await policyEngine.evaluate(action);

    if (policyEngine.requiresApproval(decision)) {
      // Return approval request
      const approval = await policyEngine.createApprovalRequest(
        action,
        decision,
      );
      return { approval, decision };
    }

    if (policyEngine.isBlocked(decision)) {
      throw new Error(`Action blocked: ${decision.reason}`);
    }

    return jiraClient.addComment(key, body);
  }

  /**
   * Transition issue
   */
  async transitionIssue(
    key: string,
    transition: string,
    userId: string,
    comment?: string,
  ) {
    const action: Action = {
      id: Date.now().toString(),
      type: "jira.issue.transition",
      description: `Transition Jira issue ${key} to ${transition}`,
      params: { key, transition, comment },
      userId,
      timestamp: new Date(),
    };

    const decision = await policyEngine.evaluate(action);

    if (policyEngine.requiresApproval(decision)) {
      const approval = await policyEngine.createApprovalRequest(
        action,
        decision,
      );
      return { approval, decision };
    }

    if (policyEngine.isBlocked(decision)) {
      throw new Error(`Action blocked: ${decision.reason}`);
    }

    // Get transition ID from name
    const transitions = await jiraClient.getTransitions(key);
    const transitionObj = transitions.find((t) => t.name === transition);

    if (!transitionObj) {
      throw new Error(`Invalid transition: ${transition}`);
    }

    return jiraClient.transitionIssue(key, transitionObj.id, comment);
  }

  /**
   * Create issue
   */
  async createIssue(
    params: {
      project: string;
      summary: string;
      description?: string;
      issueType: string;
      assignee?: string;
    },
    userId: string,
  ) {
    const action: Action = {
      id: Date.now().toString(),
      type: "jira.issue.create",
      description: `Create Jira issue: ${params.summary}`,
      params,
      userId,
      timestamp: new Date(),
    };

    const decision = await policyEngine.evaluate(action);

    if (policyEngine.requiresApproval(decision)) {
      const approval = await policyEngine.createApprovalRequest(
        action,
        decision,
      );
      return { approval, decision };
    }

    if (policyEngine.isBlocked(decision)) {
      throw new Error(`Action blocked: ${decision.reason}`);
    }

    return jiraClient.createIssue(params);
  }

  /**
   * Create project
   */
  async createProject(
    params: {
      key: string;
      name: string;
      projectType?: string;
      description?: string;
    },
    userId: string,
  ) {
    const action: Action = {
      id: Date.now().toString(),
      type: "jira.project.create",
      description: `Create Jira project: ${params.key} - ${params.name}`,
      params,
      userId,
      timestamp: new Date(),
    };

    const decision = await policyEngine.evaluate(action);

    if (policyEngine.requiresApproval(decision)) {
      const approval = await policyEngine.createApprovalRequest(
        action,
        decision,
      );
      return { approval, decision };
    }

    if (policyEngine.isBlocked(decision)) {
      throw new Error(`Action blocked: ${decision.reason}`);
    }

    return jiraClient.createProject(params);
  }

  /**
   * Get project details
   */
  async getProject(key: string, userId: string) {
    const action: Action = {
      id: Date.now().toString(),
      type: "jira.project.read",
      description: `Read Jira project ${key}`,
      params: { key },
      userId,
      timestamp: new Date(),
    };

    const decision = await policyEngine.evaluate(action);

    if (!policyEngine.canProceed(decision)) {
      throw new Error(`Action not allowed: ${decision.reason}`);
    }

    return jiraClient.getProject(key);
  }
}

export const jiraService = new JiraService();
