/**
 * GitLab webhook handler
 * Processes push and merge request events from GitLab
 */

import { env } from '../../config/env';
import { extractFromCommit, extractFromMergeRequest } from './jira-key-extractor';
import { jiraService } from '../jira/jira-service';
import { policyEngine } from '../../policy/engine';
import { Action } from '../../policy/types';
import { v4 as uuidv4 } from 'uuid';

class WebhookHandler {
  /**
   * Verify GitLab webhook signature
   * TODO: Implement proper webhook signature verification
   */
  verifyWebhook(signature: string, body: string): boolean {
    if (!env.GITLAB_WEBHOOK_SECRET) {
      console.warn('[GitLab] No webhook secret configured - skipping verification');
      return true;
    }

    // TODO: Implement HMAC verification
    // GitLab uses X-Gitlab-Token header
    return signature === env.GITLAB_WEBHOOK_SECRET;
  }

  /**
   * Handle push event
   */
  async handlePush(event: {
    ref: string;
    project_id: number;
    project_name: string;
    user_name: string;
    commits: Array<{
      id: string;
      message: string;
      title: string;
    }>;
  }): Promise<void> {
    console.log(`[GitLab] Handling push event for ${event.project_name}`);

    // Extract Jira keys from commits
    for (const commit of event.commits) {
      const jiraKeys = extractFromCommit(commit);

      for (const key of jiraKeys) {
        await this.processCommitJiraLink(key, commit, event);
      }
    }
  }

  /**
   * Handle merge request event
   */
  async handleMergeRequest(event: {
    object_attributes: {
      iid: number;
      title: string;
      description: string;
      state: string;
      action: string;
      source_branch: string;
      target_branch: string;
      web_url: string;
    };
    project: {
      id: number;
      name: string;
    };
  }): Promise<void> {
    console.log(`[GitLab] Handling MR event for ${event.project.name}`);

    const mr = event.object_attributes;
    const jiraKeys = extractFromMergeRequest({
      title: mr.title,
      description: mr.description,
      source_branch: mr.source_branch,
      target_branch: mr.target_branch,
    });

    for (const key of jiraKeys) {
      await this.processMergeRequestJiraLink(key, mr, event);
    }
  }

  /**
   * Process Jira link from commit
   */
  private async processCommitJiraLink(
    jiraKey: string,
    commit: { id: string; message: string; title: string },
    event: { project_name: string; user_name: string }
  ): Promise<void> {
    const comment = `GitLab commit linked to this ticket:\n` +
      `- Project: ${event.project_name}\n` +
      `- Commit: ${commit.id.substring(0, 8)}\n` +
      `- Author: ${event.user_name}\n` +
      `- Message: ${commit.title}\n` +
      `- Link: [View commit] (TODO: add commit URL)`;

    const action: Action = {
      id: uuidv4(),
      type: 'gitlab.jira_link.auto_comment',
      description: `Auto-post comment to ${jiraKey} from GitLab commit`,
      params: { key: jiraKey, comment },
      userId: 'gitlab-webhook',
      timestamp: new Date(),
    };

    const decision = await policyEngine.evaluate(action);

    if (policyEngine.canProceed(decision)) {
      await jiraService.addComment(jiraKey, comment, 'gitlab-webhook');
    } else {
      console.log(`[GitLab] Skipping auto-comment to ${jiraKey}: ${decision.reason}`);
    }
  }

  /**
   * Process Jira link from merge request
   */
  private async processMergeRequestJiraLink(
    jiraKey: string,
    mr: {
      iid: number;
      title: string;
      state: string;
      action: string;
      web_url: string;
    },
    event: { project: { name: string } }
  ): Promise<void> {
    const comment = `GitLab merge request linked to this ticket:\n` +
      `- Project: ${event.project.name}\n` +
      `- MR: !${mr.iid}\n` +
      `- Title: ${mr.title}\n` +
      `- State: ${mr.state}\n` +
      `- Action: ${mr.action}\n` +
      `- Link: ${mr.web_url}`;

    const action: Action = {
      id: uuidv4(),
      type: 'gitlab.jira_link.auto_comment',
      description: `Auto-post comment to ${jiraKey} from GitLab MR`,
      params: { key: jiraKey, comment },
      userId: 'gitlab-webhook',
      timestamp: new Date(),
    };

    const decision = await policyEngine.evaluate(action);

    if (policyEngine.canProceed(decision)) {
      await jiraService.addComment(jiraKey, comment, 'gitlab-webhook');
    } else {
      console.log(`[GitLab] Skipping auto-comment to ${jiraKey}: ${decision.reason}`);
    }

    // Suggest transition if MR was merged
    if (mr.action === 'merge' && mr.state === 'merged') {
      await this.suggestTransitionOnMerge(jiraKey, mr);
    }
  }

  /**
   * Suggest Jira transition when MR is merged
   */
  private async suggestTransitionOnMerge(
    jiraKey: string,
    mr: { iid: number; web_url: string }
  ): Promise<void> {
    const action: Action = {
      id: uuidv4(),
      type: 'gitlab.jira_link.auto_transition',
      description: `Auto-transition ${jiraKey} after MR merge`,
      params: {
        key: jiraKey,
        transition: 'In Review',
        comment: `Merge request !${mr.iid} was merged. Ready for review: ${mr.web_url}`,
      },
      userId: 'gitlab-webhook',
      timestamp: new Date(),
    };

    const decision = await policyEngine.evaluate(action);

    if (policyEngine.canProceed(decision)) {
      // Auto-transition if allowed
      try {
        await jiraService.transitionIssue(jiraKey, 'In Review', 'gitlab-webhook');
      } catch (error) {
        console.error(`[GitLab] Failed to auto-transition ${jiraKey}:`, error);
      }
    } else {
      console.log(`[GitLab] Skipping auto-transition for ${jiraKey}: ${decision.reason}`);
    }
  }
}

export const webhookHandler = new WebhookHandler();
