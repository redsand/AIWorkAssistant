/**
 * Extract Jira keys from GitLab data (commits, branches, merge requests)
 */

import { env } from '../../config/env';

/**
 * Jira key pattern: PROJECT-123 (uppercase letters, hyphen, numbers)
 */
const JIRA_KEY_PATTERN = /\b([A-Z]+-\d+)\b/g;

/**
 * Extract Jira keys from text
 */
export function extractJiraKeys(text: string): string[] {
  if (!text) return [];

  const matches = text.match(JIRA_KEY_PATTERN);
  if (!matches) return [];

  // Remove duplicates first
  const uniqueMatches = Array.from(new Set(matches));

  // Filter by configured project keys if any
  const configuredKeys = env.JIRA_PROJECT_KEYS;
  if (configuredKeys.length > 0) {
    return uniqueMatches.filter(key => {
      const project = key.split('-')[0];
      return configuredKeys.includes(project);
    });
  }

  return uniqueMatches;
}

/**
 * Extract Jira keys from GitLab commit
 */
export function extractFromCommit(commit: {
  message?: string;
  title?: string;
}): string[] {
  const text = [commit.title, commit.message].filter(Boolean).join('\n');
  return extractJiraKeys(text);
}

/**
 * Extract Jira keys from GitLab branch name
 */
export function extractFromBranch(branchName: string): string[] {
  if (!branchName) return [];

  // Extract from branch name
  // Examples: feature/PROJ-123-something, PROJ-456/feature, bugfix/PROJ-789
  return extractJiraKeys(branchName);
}

/**
 * Extract Jira keys from GitLab merge request
 */
export function extractFromMergeRequest(mr: {
  title?: string;
  description?: string;
  source_branch?: string;
  target_branch?: string;
}): string[] {
  const text = [
    mr.title,
    mr.description,
    mr.source_branch,
    mr.target_branch,
  ].filter(Boolean).join('\n');

  return extractJiraKeys(text);
}

/**
 * Get primary Jira key (first one found)
 */
export function getPrimaryJiraKey(keys: string[]): string | undefined {
  return keys.length > 0 ? keys[0] : undefined;
}

/**
 * Validate Jira key format
 */
export function isValidJiraKey(key: string): boolean {
  // Use a non-global regex for validation to avoid state issues
  const VALIDATION_PATTERN = /\b([A-Z]+-\d+)\b/;
  return VALIDATION_PATTERN.test(key);
}

/**
 * Extract project key from Jira key
 */
export function extractProjectKey(jiraKey: string): string | undefined {
  const match = jiraKey.match(/^([A-Z]+)-\d+$/);
  return match ? match[1] : undefined;
}

/**
 * Extract issue number from Jira key
 */
export function extractIssueNumber(jiraKey: string): number | undefined {
  const match = jiraKey.match(/^[A-Z]+-(\d+)$/);
  return match ? parseInt(match[1], 10) : undefined;
}
